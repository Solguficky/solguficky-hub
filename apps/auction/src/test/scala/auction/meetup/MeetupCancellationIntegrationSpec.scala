package auction.meetup

import auction.AuctionNode
import auction.aggregate.*
import auction.aggregate.AuctionFixtures.configInput
import auction.catalog.LotId
import auction.entity.*
import auction.lot.*
import auction.lot.LotFixtures.participant
import auction.lot.LotFixtures.scheduleLot
import auction.persistence.DatabaseSettings
import auction.persistence.JournalSchema
import auction.telemetry.MeetupFactsMetrics
import auction.testkit.NatsFixture
import auction.testkit.PostgresFixture
import io.opentelemetry.api.OpenTelemetry
import meetups.v1.meetups_events.MeetupCancelled
import meetups.v1.meetups_events.MeetupEvent
import org.apache.pekko.actor.testkit.typed.scaladsl.ActorTestKit
import org.apache.pekko.cluster.sharding.typed.scaladsl.ClusterSharding
import org.apache.pekko.util.Timeout
import org.scalatest.concurrent.Eventually
import org.scalatest.concurrent.ScalaFutures
import org.scalatest.matchers.should.Matchers
import org.scalatest.time.Seconds
import org.scalatest.time.Span
import org.scalatest.wordspec.AnyWordSpec

import java.time.Clock
import java.time.Instant
import java.util.UUID
import java.util.concurrent.atomic.AtomicInteger
import scala.concurrent.Future
import scala.concurrent.Promise
import scala.concurrent.duration.*
import scala.util.Using

/**
 * Наследование отмены сходки (ADR-047, дополнение 2026-10-12) на узле, собранном так же, как в `Main`, с настоящим
 * JetStream: факт `events.meetups.meetup_cancelled` из durable доходит до аукциона сходки, повторная доставка второго
 * события не пишет, а без durable узел не работает молча.
 */
final class MeetupCancellationIntegrationSpec
    extends AnyWordSpec
    with Matchers
    with PostgresFixture
    with NatsFixture
    with ScalaFutures
    with Eventually {

  implicit override val patienceConfig: PatienceConfig = PatienceConfig(timeout = Span(30, Seconds))

  private given Timeout = Timeout(20.seconds)

  private val person: ParticipantId = participant(1)

  private val withdrawn = LotState.Withdrawn(WithdrawnReason.AuctionCancelled)

  private object Granted extends MeetupAuthority {
    def check(meetup: MeetupId, person: ParticipantId, correlation: Correlation): Future[Authority] =
      Future.successful(Authority.Granted(Standings.published))
  }

  private final case class Node(sharding: ClusterSharding, commands: AuctionCommands)

  // Короче секунды выборку jnats не принимает: `expiresIn` отказывает `IllegalArgumentException`.
  private def settings(url: Option[String]): MeetupFactsSettings =
    MeetupFactsSettings(url, fetchWait = 1.second, answerTimeout = 10.seconds, 200.millis, 200.millis)

  private def onDatabase[A](database: DatabaseSettings)(use: Node => A): A = {
    val kit = ActorTestKit(s"auction-meetup-facts-${UUID.randomUUID()}", nodeConfig(database))
    try {
      val clock = Clock.systemUTC()
      val sharding = AuctionNode.join(kit.system)
      AuctionNode.registerLots(sharding, clock, UuidV7.generator(clock))
      AuctionNode.registerAuctions(kit.system, sharding, clock, UuidV7.generator(clock), 10.seconds)
      given scala.concurrent.ExecutionContext = kit.system.executionContext
      val commands = AuctionCommands(
        AuctionGateway.sharded(sharding, 10.seconds),
        LotGateway.sharded(sharding, 10.seconds),
        Granted
      )
      use(Node(sharding, commands))
    } finally kit.shutdownTestKit()
  }

  /** Потребитель, собранный так же, как в `Main`; `missing` — что узел делает без durable. */
  private def consuming[A](node: Node, missing: String => Unit = reason => fail(reason))(use: => A): A = {
    val consumer = new MeetupCancellationConsumer(
      natsUrl,
      settings(Some(natsUrl)),
      inheritance =>
        node.sharding
          .entityRefFor(AuctionEntity.TypeKey, inheritance.auctionId.value.toString)
          .ask(AuctionEntity.InheritCancellation(inheritance.command, _)),
      missing
    ).start()
    try use
    finally consumer.close()
  }

  private def newId(): UUID = UuidV7.generator(Clock.systemUTC())()

  private def newOp(): OpId = OpId(newId())

  private def lotState(node: Node, lot: LotId): LotState =
    node.sharding.entityRefFor(LotEntity.TypeKey, lot.value.toString).ask[Lot](LotEntity.Get(_)).futureValue.state

  private def auctionState(node: Node, auction: AuctionId): AuctionState =
    node.sharding
      .entityRefFor(AuctionEntity.TypeKey, auction.value.toString)
      .ask[Auction](AuctionEntity.Get(_))
      .futureValue
      .state

  /** Аукцион сходки `meetup` с одним лотом с условиями, запланированный на неделю, которая закрывается через час. */
  private def scheduled(node: Node, meetup: MeetupId): (AuctionId, LotId) = {
    val auction = node.commands
      .draft(meetup, newOp(), person)
      .futureValue
      .fold(denial => fail(s"the auction was not drafted: $denial"), _.auctionId)
    val lot = LotId(newId())
    node.commands.addLot(auction, lot, newOp(), person).futureValue shouldBe Right(())
    node.sharding
      .entityRefFor(LotEntity.TypeKey, lot.value.toString)
      .ask[Either[ScheduleLotRejected, Envelope]](LotEntity.Plan(scheduleLot(opN = 2), Initiator.Operator(person), _))
      .futureValue
      .isRight shouldBe true
    val now = Instant.now()
    val week = OnlinePhase(now.minusSeconds(3600), Some(now.plusSeconds(3600)), closesLots = true, None)
    node.commands.schedule(auction, configInput(Some(week)), newOp(), person).futureValue shouldBe Right(())
    (auction, lot)
  }

  private def cancellation(meetup: MeetupId, eventId: UUID = newId()): (UUID, Array[Byte]) =
    eventId -> MeetupEvent(
      eventId = eventId.toString,
      meetupId = meetup.value.toString,
      version = 2,
      occasion = MeetupEvent.Occasion.MeetupCancelled(MeetupCancelled())
    ).toByteArray

  private def publish(fact: (UUID, Array[Byte]), messageId: Option[String] = None): Unit =
    publishMeetupFact(MeetupCancellationConsumer.Subject, messageId.getOrElse(fact._1.toString), fact._2)

  private def journalRows(database: DatabaseSettings, auction: AuctionId): Int =
    withConnection(database) { connection =>
      Using.resource(connection.prepareStatement("SELECT count(*) FROM event_journal WHERE persistence_id = ?")) {
        statement =>
          statement.setString(1, s"auction|${auction.value}")
          Using.resource(statement.executeQuery()) { rows =>
            rows.next()
            rows.getInt(1)
          }
      }
    }

  "the meetup facts consumer" should {

    "discards a scheduled auction, cancels a trading one and leaves a meetup without an auction untouched" in {
      freshMeetupsStream()
      val database = freshDatabase()
      JournalSchema.migrate(database)
      onDatabase(database) { node =>
        val (draftOnly, _) = scheduled(node, MeetupId(newId()))
        val tradingMeetup = MeetupId(newId())
        val (trading, tradingLot) = scheduled(node, tradingMeetup)
        // Торги открылись уже после отмены сходки, но до доставки факта: факт застаёт аукцион идущим.
        node.commands.startPrebidding(trading, newOp(), person).futureValue shouldBe Right(())
        eventually(lotState(node, tradingLot) shouldBe a[LotState.Trading])
        val withoutAuction = MeetupId(newId())
        // Факты, опубликованные до старта потребителя, durable выдаёт с начала стрима.
        val draftMeetup = node.commands.current(draftOnly).futureValue.flatMap(_.meetup).getOrElse(fail("no meetup"))
        publish(cancellation(draftMeetup))
        publish(cancellation(tradingMeetup))
        publish(cancellation(withoutAuction))
        consuming(node) {
          eventually {
            auctionState(node, draftOnly) shouldBe AuctionState.Initial
            auctionState(node, trading) shouldBe a[AuctionState.Cancelled]
            lotState(node, tradingLot) shouldBe withdrawn
            meetupsDurablePending() shouldBe (0L, 0L)
          }
          journalRows(database, Auction.idOf(withoutAuction)) shouldBe 0
        }
      }
    }

    "writes no second event for a redelivered fact and keeps the auction discarded" in {
      freshMeetupsStream()
      val database = freshDatabase()
      JournalSchema.migrate(database)
      onDatabase(database) { node =>
        val meetup = MeetupId(newId())
        val (auction, _) = scheduled(node, meetup)
        val fact = cancellation(meetup)
        publish(fact)
        consuming(node) {
          eventually(auctionState(node, auction) shouldBe AuctionState.Initial)
          val rows = journalRows(database, auction)
          // Тот же факт под другим `Nats-Msg-Id` окно дедупликации шины не ловит: его ловит окно `seen` аукциона.
          publish(fact, messageId = Some(s"${fact._1}-again"))
          eventually(meetupsDurablePending() shouldBe (0L, 0L))
          Thread.sleep(500)
          journalRows(database, auction) shouldBe rows
          auctionState(node, auction) shouldBe AuctionState.Initial
        }
      }
    }

    "delivers a fact again after the auction did not answer and applies it once" in {
      freshMeetupsStream()
      val database = freshDatabase()
      JournalSchema.migrate(database)
      onDatabase(database) { node =>
        val meetup = MeetupId(newId())
        val (auction, _) = scheduled(node, meetup)
        publish(cancellation(meetup))
        val attempts = AtomicInteger(0)
        val consumer = new MeetupCancellationConsumer(
          natsUrl,
          settings(Some(natsUrl)),
          inheritance =>
            if (attempts.getAndIncrement() == 0) Future.failed(new java.util.concurrent.TimeoutException("silent"))
            else
              node.sharding
                .entityRefFor(AuctionEntity.TypeKey, inheritance.auctionId.value.toString)
                .ask(AuctionEntity.InheritCancellation(inheritance.command, _)),
          reason => fail(reason)
        ).start()
        try {
          eventually(auctionState(node, auction) shouldBe AuctionState.Initial)
          eventually(meetupsDurablePending() shouldBe (0L, 0L))
          attempts.get shouldBe 2
          consumer.backlog() shouldBe Some(DurableBacklog(0, 0))
        } finally consumer.close()
      }
    }

    "stops the node instead of running without the durable" in {
      freshMeetupsStream(withDurable = false)
      val database = freshDatabase()
      JournalSchema.migrate(database)
      onDatabase(database) { node =>
        val missing = Promise[String]()
        consuming(node, reason => missing.trySuccess(reason)) {
          missing.future.futureValue should include("auction-meetups-events")
        }
      }
    }

    "starts without a consumer when no bus address is set" in {
      val database = freshDatabase()
      JournalSchema.migrate(database)
      onDatabase(database) { node =>
        val kit = ActorTestKit(s"auction-no-bus-${UUID.randomUUID()}", nodeConfig(database))
        try
          AuctionNode.startMeetupFacts(
            kit.system,
            node.sharding,
            settings(None),
            MeetupFactsMetrics(OpenTelemetry.noop().getMeter("auction")),
            reason => fail(reason)
          ) shouldBe None
        finally kit.shutdownTestKit()
      }
    }
  }
}
