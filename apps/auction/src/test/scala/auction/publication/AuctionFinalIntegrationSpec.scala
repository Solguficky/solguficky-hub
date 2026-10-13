package auction.publication

import auction.AuctionNode
import auction.aggregate.*
import auction.aggregate.AuctionFixtures.configInput
import auction.catalog.LotId
import auction.entity.AuctionEntity
import auction.entity.AuctionGateway
import auction.entity.Initiator
import auction.entity.LotEntity
import auction.entity.LotGateway
import auction.entity.UuidV7
import auction.lot.AntiSnipe
import auction.lot.AuctionId
import auction.lot.Envelope
import auction.lot.Lot
import auction.lot.LotFixtures.participant
import auction.lot.LotFixtures.scheduleLot
import auction.lot.LotState
import auction.lot.OpId
import auction.lot.ParticipantId
import auction.lot.ScheduleLotRejected
import auction.lot.Phase
import auction.persistence.DatabaseSettings
import auction.persistence.JournalSchema
import auction.telemetry.ProjectionMetrics
import auction.telemetry.PublicationMetrics
import auction.testkit.NatsFixture
import auction.testkit.PostgresFixture
import auction.v1.auction_events as bus
import io.opentelemetry.api.OpenTelemetry
import org.apache.pekko.actor.testkit.typed.scaladsl.ActorTestKit
import org.apache.pekko.cluster.sharding.typed.scaladsl.ClusterSharding
import org.apache.pekko.util.Timeout
import org.scalatest.concurrent.Eventually
import org.scalatest.concurrent.ScalaFutures
import org.scalatest.matchers.should.Matchers
import org.scalatest.time.Millis
import org.scalatest.time.Seconds
import org.scalatest.time.Span
import org.scalatest.wordspec.AnyWordSpec

import java.time.Clock
import java.time.Duration
import java.time.Instant
import java.util.UUID
import scala.concurrent.Future
import scala.concurrent.duration.*

/**
 * Перерыв и финал аукциона (PER-334) на узле, собранном так же, как в `Main`: настоящие entity аукциона и лотов под
 * шардингом, журнал на PostgreSQL, настоящие часы и публикация фактов в настоящий JetStream. L0 entity доказывает
 * протокол на подмене лотов; этот сьют — что удержание настоящего лота доходит до аукциона подтверждением закрытия,
 * `ResumeLot` возвращает настоящий лот в живой финал, а анонс состава и старта финала выходит на шину.
 */
final class AuctionFinalIntegrationSpec
    extends AnyWordSpec
    with Matchers
    with PostgresFixture
    with NatsFixture
    with ScalaFutures
    with Eventually {

  implicit override val patienceConfig: PatienceConfig =
    PatienceConfig(timeout = Span(30, Seconds), interval = Span(100, Millis))

  private given Timeout = Timeout(20.seconds)

  private val person: ParticipantId = participant(1)

  private object Granted extends MeetupAuthority {
    def check(meetup: MeetupId, person: ParticipantId, correlation: Correlation): Future[Authority] =
      Future.successful(Authority.Granted)
  }

  private final case class Node(sharding: ClusterSharding, commands: AuctionCommands)

  private def onDatabase[A](database: DatabaseSettings)(use: Node => A): A = {
    val kit = ActorTestKit(s"auction-final-${UUID.randomUUID()}", nodeConfig(database))
    try {
      val clock = Clock.systemUTC()
      val sharding = AuctionNode.join(kit.system)
      AuctionNode.registerLots(sharding, clock, UuidV7.generator(clock))
      AuctionNode.registerAuctions(kit.system, sharding, clock, UuidV7.generator(clock), 10.seconds)
      val meter = OpenTelemetry.noop().getMeter("auction")
      AuctionNode.startPublication(
        kit.system,
        ProjectionMetrics(meter, clock),
        PublicationMetrics(meter),
        PublicationSettings(Some(natsUrl), interval = 100.millis, batch = 100, ackTimeout = 1.second),
        5.seconds
      )
      given scala.concurrent.ExecutionContext = kit.system.executionContext
      val commands = AuctionCommands(
        AuctionGateway.sharded(sharding, 10.seconds),
        LotGateway.sharded(sharding, 10.seconds),
        Granted
      )
      use(Node(sharding, commands))
    } finally kit.shutdownTestKit()
  }

  private def newId(): UUID = UuidV7.generator(Clock.systemUTC())()

  private def newOp(): OpId = OpId(newId())

  private def lotRef(node: Node, lot: LotId) = node.sharding.entityRefFor(LotEntity.TypeKey, lot.value.toString)

  private def lotState(node: Node, lot: LotId): LotState =
    lotRef(node, lot).ask[Lot](LotEntity.Get(_)).futureValue.state

  private def auctionState(node: Node, auction: AuctionId): AuctionState =
    node.sharding
      .entityRefFor(AuctionEntity.TypeKey, auction.value.toString)
      .ask[Auction](AuctionEntity.Get(_))
      .futureValue
      .state

  /** Факты аукциона в стриме: тип сообщения называет subject, поэтому факты лота отбираются по нему же. */
  private def auctionFacts(): List[(String, bus.AuctionEvent)] =
    streamMessages().flatMap { message =>
      val name = message.getSubject.stripPrefix(LotFacts.SubjectPrefix)
      Option.when(bus.AuctionEvent.scalaDescriptor.fields.exists(_.name == name))(
        message.getSubject -> bus.AuctionEvent.parseFrom(message.getData)
      )
    }

  "the break and the final of an auction" should {

    "hold the marked lot at the common deadline, freeze it as the lineup, return it to a live final and announce it" in {
      val database = freshDatabase()
      JournalSchema.migrate(database)
      freshStream()
      onDatabase(database) { node =>
        val auction = node.commands
          .draft(MeetupId(newId()), newOp(), person)
          .futureValue
          .fold(denial => fail(s"the auction was not drafted: $denial"), _.auctionId)
        val finalist = LotId(newId())
        val other = LotId(newId())
        val quiet = _root_.auction.lot.LotFixtures
          .configInput()
          .copy(antiSnipe = AntiSnipe(Duration.ofSeconds(1), Duration.ofSeconds(1), 3))
        List(finalist, other).foreach { lot =>
          node.commands.addLot(auction, lot, newOp(), person).futureValue shouldBe Right(())
          lotRef(node, lot)
            .ask[Either[ScheduleLotRejected, Envelope]](
              LotEntity.Plan(scheduleLot(opN = 2, input = quiet), Initiator.Operator(person), _)
            )
            .futureValue
            .isRight shouldBe true
        }
        val closesAt = Instant.now().plusSeconds(8)
        val week = OnlinePhase(Instant.now().minusSeconds(3600), Some(closesAt), closesLots = true)
        node.commands.schedule(auction, configInput(Some(week)), newOp(), person).futureValue shouldBe Right(())
        node.commands.startPrebidding(auction, newOp(), person).futureValue shouldBe Right(())
        eventually(List(finalist, other).map(lotState(node, _)).forall(_.isInstanceOf[LotState.Trading]) shouldBe true)
        node.commands.selectForFinal(auction, finalist, newOp(), person).futureValue shouldBe Right(())

        // Т-46: до заморозки финал не начинается.
        node.commands.startFinal(auction, newOp(), person).futureValue shouldBe Left(FinalStartRefusal.LineupNotFrozen)

        eventually(auctionState(node, auction) shouldBe a[AuctionState.Break])
        lotState(node, finalist) shouldBe a[LotState.Held]
        lotState(node, other) shouldBe a[LotState.Unsold]
        node.commands.selectForFinal(auction, other, newOp(), person).futureValue shouldBe
          Left(FinalChoiceRefusal.NotInPrebidding)

        // Т-47: лот, не подтвердивший удержание, в состав не входит.
        node.commands.freezeFinalLineup(auction, List(finalist, other), newOp(), person).futureValue shouldBe
          Left(LineupRefusal.LineupMismatch(Set(finalist)))
        node.commands.freezeFinalLineup(auction, List(finalist), newOp(), person).futureValue shouldBe Right(())
        node.commands.startFinal(auction, newOp(), person).futureValue shouldBe Right(())
        val next = newOp()
        node.commands.startNextLot(auction, next, person).futureValue shouldBe Right(finalist)
        node.commands.startNextLot(auction, next, person).futureValue shouldBe Right(finalist)
        lotState(node, finalist) match {
          case LotState.Trading(trading) =>
            trading.phase shouldBe Phase.Live
            trading.deadline shouldBe None
          case state => fail(s"the finalist did not return to trading: $state")
        }
        auctionState(node, auction) shouldBe a[AuctionState.Final]

        eventually {
          auctionFacts().map(_._1.stripPrefix(LotFacts.SubjectPrefix)) shouldBe List(
            "auction_drafted",
            "lot_added",
            "lot_added",
            "auction_scheduled",
            "prebidding_started",
            "prebidding_deadline_reached",
            "prebidding_ended",
            "final_lineup_frozen",
            "final_started",
            "final_lot_activated"
          )
        }
        val facts = auctionFacts().map(_._2)
        facts.map(_.auctionId).distinct shouldBe List(auction.value.toString)
        facts.map(_.version) shouldBe (1L to 10L).toList
        facts(7).getState.getLineupFrozen.order shouldBe List(finalist.value.toString)
        facts(8).getState.status.isInFinal shouldBe true
        facts(9).getState.getInFinal.activeLotId shouldBe Some(finalist.value.toString)
      }
    }

    // ADR-047, дополнение 2026-10-12: «Факт отмены» и «Факт удаления».
    "publish the discard of an unstarted auction and the cancel of a started one with their lots withdrawn" in {
      val database = freshDatabase()
      JournalSchema.migrate(database)
      freshStream()
      onDatabase(database) { node =>
        def drafted(): AuctionId =
          node.commands
            .draft(MeetupId(newId()), newOp(), person)
            .futureValue
            .fold(denial => fail(s"the auction was not drafted: $denial"), _.auctionId)
        val week =
          OnlinePhase(Instant.now().minusSeconds(3600), Some(Instant.now().plusSeconds(3600)), closesLots = true)

        val discarded = drafted()
        node.commands.schedule(discarded, configInput(Some(week)), newOp(), person).futureValue shouldBe Right(())
        node.commands.discard(discarded, newOp(), person).futureValue shouldBe Right(())

        val cancelled = drafted()
        val lot = LotId(newId())
        node.commands.addLot(cancelled, lot, newOp(), person).futureValue shouldBe Right(())
        lotRef(node, lot)
          .ask[Either[ScheduleLotRejected, Envelope]](
            LotEntity.Plan(scheduleLot(opN = 2), Initiator.Operator(person), _)
          )
          .futureValue
          .isRight shouldBe true
        node.commands.schedule(cancelled, configInput(Some(week)), newOp(), person).futureValue shouldBe Right(())
        node.commands.startPrebidding(cancelled, newOp(), person).futureValue shouldBe Right(())
        eventually(lotState(node, lot) shouldBe a[LotState.Trading])
        node.commands.cancel(cancelled, newOp(), person).futureValue shouldBe Right(())

        eventually {
          val names =
            auctionFacts().map((subject, fact) => fact.auctionId -> subject.stripPrefix(LotFacts.SubjectPrefix))
          names should contain(discarded.value.toString -> "auction_discarded")
          names should contain(cancelled.value.toString -> "auction_cancelled")
          streamMessages().map(_.getSubject) should contain(LotFacts.SubjectPrefix + "lot_withdrawn")
        }
        val facts = auctionFacts().map(_._2)
        val discard =
          facts.find(fact => fact.auctionId == discarded.value.toString && fact.occasion.isAuctionDiscarded).get
        discard.getState.status.isDiscarded shouldBe true
        discard.getState.config shouldBe defined
        val cancel =
          facts.find(fact => fact.auctionId == cancelled.value.toString && fact.occasion.isAuctionCancelled).get
        cancel.getState.status.isCancelled shouldBe true
        cancel.getState.lotIds shouldBe List(lot.value.toString)
      }
    }
  }
}
