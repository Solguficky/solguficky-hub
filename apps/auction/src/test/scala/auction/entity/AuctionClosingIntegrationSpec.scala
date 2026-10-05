package auction.entity

import auction.AuctionNode
import auction.aggregate.*
import auction.aggregate.AuctionFixtures.configInput
import auction.catalog.LotId
import auction.lot.*
import auction.lot.LotFixtures.participant
import auction.lot.LotFixtures.scheduleLot
import auction.persistence.DatabaseSettings
import auction.persistence.JournalSchema
import auction.telemetry.DeadlineMetrics
import auction.telemetry.ProjectionMetrics
import auction.testkit.PostgresFixture
import io.opentelemetry.api.OpenTelemetry
import io.opentelemetry.sdk.metrics.SdkMeterProvider
import io.opentelemetry.sdk.testing.exporter.InMemoryMetricReader
import org.apache.pekko.actor.testkit.typed.scaladsl.ActorTestKit
import org.apache.pekko.actor.typed.ActorSystem
import org.apache.pekko.cluster.sharding.typed.scaladsl.ClusterSharding
import org.apache.pekko.util.Timeout
import org.scalatest.concurrent.Eventually
import org.scalatest.concurrent.ScalaFutures
import org.scalatest.matchers.should.Matchers
import org.scalatest.time.Seconds
import org.scalatest.time.Span
import org.scalatest.wordspec.AnyWordSpec

import java.time.Clock
import java.time.Duration
import java.time.Instant
import java.util.UUID
import scala.concurrent.Future
import scala.concurrent.duration.*
import scala.jdk.CollectionConverters.*
import scala.util.Using

/**
 * Закрытие каталога по общему дедлайну (PER-292) на узле, собранном так же, как в `Main`: настоящие entity аукциона и
 * лотов под шардингом, журнал и read model на PostgreSQL, настоящие часы. L0 entity доказывает протокол закрытия на
 * подмене лотов; этот сьют — что помнящийся шардинг поднимает аукцион после рестарта процесса сам, без единого
 * сообщения ему, и что закрытый лот остаётся закрытым (ПП-1, ПП-2).
 */
final class AuctionClosingIntegrationSpec
    extends AnyWordSpec
    with Matchers
    with PostgresFixture
    with ScalaFutures
    with Eventually {

  implicit override val patienceConfig: PatienceConfig = PatienceConfig(timeout = Span(30, Seconds))

  private given Timeout = Timeout(20.seconds)

  private val person: ParticipantId = participant(1)

  private object Granted extends MeetupAuthority {
    def check(meetup: MeetupId, person: ParticipantId, correlation: Correlation): Future[Authority] =
      Future.successful(Authority.Granted)
  }

  private final case class Node(
      system: ActorSystem[?],
      sharding: ClusterSharding,
      commands: AuctionCommands,
      reader: InMemoryMetricReader
  )

  /** Узел на уже размеченной базе: второй вызов на той же базе — рестарт сервиса. Просрочка считается без допуска. */
  private def onDatabase[A](database: DatabaseSettings)(use: Node => A): A = {
    val kit = ActorTestKit(s"auction-closing-${UUID.randomUUID()}", nodeConfig(database))
    try {
      val clock = Clock.systemUTC()
      val sharding = AuctionNode.join(kit.system)
      AuctionNode.registerLots(sharding, clock, UuidV7.generator(clock))
      AuctionNode.registerAuctions(kit.system, sharding, clock, UuidV7.generator(clock), 10.seconds)
      AuctionNode.startProjection(
        kit.system,
        ProjectionMetrics(OpenTelemetry.noop().getMeter("auction"), clock),
        5.seconds
      )
      val reader = InMemoryMetricReader.create()
      val meter = SdkMeterProvider.builder().registerMetricReader(reader).build().get("auction")
      AuctionNode.watchDeadlines(kit.system, DeadlineMetrics(meter), clock, Duration.ZERO, 5.seconds)
      given scala.concurrent.ExecutionContext = kit.system.executionContext
      val commands = AuctionCommands(
        AuctionGateway.sharded(sharding, 10.seconds),
        LotGateway.sharded(sharding, 10.seconds),
        Granted
      )
      use(Node(kit.system, sharding, commands, reader))
    } finally kit.shutdownTestKit()
  }

  private def newId(): UUID = UuidV7.generator(Clock.systemUTC())()

  private def newOp(): OpId = OpId(newId())

  private def lotRef(node: Node, lot: LotId) = node.sharding.entityRefFor(LotEntity.TypeKey, lot.value.toString)

  private def lotState(node: Node, lot: LotId): LotState =
    lotRef(node, lot).ask[Lot](LotEntity.Get(_)).futureValue.state

  /** Неделя Ф-4, которая началась час назад и закрывается в `closesAt`. */
  private def weekUntil(closesAt: Instant): AuctionConfigInput =
    configInput(Some(OnlinePhase(Instant.now().minusSeconds(3600), Some(closesAt), closesLots = true)))

  /**
   * Анти-снайп с окном в секунду: ставка тестов за несколько секунд до дедлайна в него не попадает, и лот закрывается в
   * свой дедлайн. Продление проверяет отдельный тест.
   */
  private val quietAntiSnipe = AntiSnipe(Duration.ofSeconds(1), Duration.ofSeconds(1), 3)

  /** Аукцион сходки с `size` лотами, у каждого условия торгов; открыт с общим дедлайном `closesIn` от планирования. */
  private def opened(
      node: Node,
      size: Int,
      closesIn: java.time.Duration,
      antiSnipe: AntiSnipe = quietAntiSnipe
  ): (AuctionId, List[LotId], Instant) = {
    val terms = scheduleLot(opN = 2, input = _root_.auction.lot.LotFixtures.configInput().copy(antiSnipe = antiSnipe))
    val auction = node.commands
      .draft(MeetupId(newId()), newOp(), person)
      .futureValue
      .fold(denial => fail(s"the auction was not drafted: $denial"), _.auctionId)
    val lots = List.fill(size)(LotId(newId()))
    lots.foreach { lot =>
      node.commands.addLot(auction, lot, newOp(), person).futureValue shouldBe Right(())
      lotRef(node, lot)
        .ask[Either[ScheduleLotRejected, Envelope]](LotEntity.Plan(terms, Initiator.Operator(person), _))
        .futureValue
        .isRight shouldBe true
    }
    val closesAt = Instant.now().plus(closesIn)
    node.commands.schedule(auction, weekUntil(closesAt), newOp(), person).futureValue shouldBe Right(())
    node.commands.startPrebidding(auction, newOp(), person).futureValue shouldBe Right(())
    eventually(lots.map(lotState(node, _)).forall(_.isInstanceOf[LotState.Trading]) shouldBe true)
    (auction, lots, closesAt)
  }

  private def bid(node: Node, lot: LotId, who: ParticipantId): Unit = {
    val price = lotState(node, lot) match {
      case LotState.Trading(trading) => Lot.minRequired(trading)
      case other => fail(s"the lot is not trading: $other")
    }
    lotRef(node, lot)
      .ask[Either[PlaceBidRejected, Envelope]](
        LotEntity.Bid(PlaceBid(who, price, newOp(), BidSource.Bot), Initiator.Participant(who), _)
      )
      .futureValue
      .isRight shouldBe true
  }

  private def terminal(state: LotState): Boolean =
    state match {
      case LotState.Sold(_) | LotState.Unsold(_) => true
      case _ => false
    }

  private def journalRows(database: DatabaseSettings, lot: LotId): Int =
    withConnection(database) { connection =>
      Using.resource(connection.prepareStatement("SELECT count(*) FROM event_journal WHERE persistence_id = ?")) {
        statement =>
          statement.setString(1, s"lot|${lot.value}")
          Using.resource(statement.executeQuery()) { rows =>
            rows.next()
            rows.getInt(1)
          }
      }
    }

  private def overdue(node: Node): Option[Long] =
    node.reader
      .collectAllMetrics()
      .asScala
      .find(_.getName == "auction.lots.overdue")
      .flatMap(_.getLongGaugeData.getPoints.asScala.headOption.map(_.getValue))

  private def sleepUntil(moment: Instant): Unit = {
    val left = java.time.Duration.between(Instant.now(), moment).toMillis
    if (left > 0) Thread.sleep(left)
  }

  "closing the catalog by its common deadline" should {

    "close a salvo of twenty lots with one deadline, selling the lot with a leader to it" in {
      val database = freshDatabase()
      JournalSchema.migrate(database)
      onDatabase(database) { node =>
        val (_, lots, closesAt) = opened(node, size = 20, closesIn = java.time.Duration.ofSeconds(10))
        val leading = lots.head
        bid(node, leading, participant(2))
        Instant.now().isBefore(closesAt) shouldBe true
        eventually(lots.map(lotState(node, _)).filterNot(terminal) shouldBe empty)
        lotState(node, leading) match {
          case LotState.Sold(sale) =>
            sale.winner shouldBe participant(2)
            sale.at.isBefore(closesAt) shouldBe false
          case other => fail(s"the lot with a leader was not sold: $other")
        }
        lots.tail.map(lotState(node, _)).distinct shouldBe List(LotState.Unsold(UnsoldReason.NoBids))
        eventually(overdue(node) shouldBe Some(0L))
      }
    }

    "close after a service restart a lot whose deadline passed while the service was down, and keep it closed" in {
      val database = freshDatabase()
      JournalSchema.migrate(database)
      val (lot, closesAt) = onDatabase(database) { node =>
        val (_, lots, closesAt) = opened(node, size = 1, closesIn = java.time.Duration.ofSeconds(8))
        bid(node, lots.head, participant(2))
        Instant.now().isBefore(closesAt) shouldBe true
        (lots.head, closesAt)
      }
      sleepUntil(closesAt.plusSeconds(1))
      // Аукциону никто не пишет: поднять его после рестарта может только помнящийся шардинг.
      val rows = onDatabase(database) { node =>
        eventually(lotState(node, lot) should matchPattern { case LotState.Sold(_) => })
        journalRows(database, lot)
      }
      onDatabase(database) { node =>
        lotState(node, lot) should matchPattern { case LotState.Sold(sale) if sale.winner == participant(2) => }
        journalRows(database, lot) shouldBe rows
      }
    }

    "keep a deadline extended by a bid in the window over a restart and close the lot only after it (ПП-2)" in {
      val database = freshDatabase()
      JournalSchema.migrate(database)
      // Окно шире всего теста, продление — четыре секунды: ставка сразу после открытия продлевает дедлайн.
      val extending = AntiSnipe(Duration.ofSeconds(30), Duration.ofSeconds(4), 3)
      val (lot, extended) = onDatabase(database) { node =>
        val (_, lots, closesAt) = opened(node, size = 1, closesIn = java.time.Duration.ofSeconds(6), extending)
        bid(node, lots.head, participant(2))
        val extended = closesAt.plus(extending.extension)
        lotState(node, lots.head) should matchPattern {
          case LotState.Trading(trading) if trading.deadline.contains(extended) && trading.extensionsUsed == 1 =>
        }
        // Таймер старого дедлайна сработал, лот отказал закрытию, и аукцион взвёл таймер по продлённому.
        sleepUntil(closesAt.plusSeconds(1))
        lotState(node, lots.head) shouldBe a[LotState.Trading]
        (lots.head, extended)
      }
      sleepUntil(extended.plusSeconds(1))
      onDatabase(database) { node =>
        eventually(lotState(node, lot) should matchPattern {
          case LotState.Sold(sale) if sale.winner == participant(2) && !sale.at.isBefore(extended) =>
        })
      }
    }

    "show a trading lot past its deadline in the metric while nobody closes it, and drop it once it is closed" in {
      val database = freshDatabase()
      JournalSchema.migrate(database)
      onDatabase(database) { node =>
        // Лот без открытого аукциона: его дедлайн прошёл, а планировщика у него нет — это и есть молчащий планировщик.
        val lot = LotId(newId())
        val operator = Initiator.Operator(person)
        lotRef(node, lot)
          .ask[Either[DraftLotRejected, Envelope]](LotEntity.Draft(DraftLot(AuctionId(newId()), newOp()), operator, _))
          .futureValue
          .isRight shouldBe true
        lotRef(node, lot)
          .ask[Either[ScheduleLotRejected, Envelope]](LotEntity.Plan(scheduleLot(opN = 2), operator, _))
          .futureValue
          .isRight shouldBe true
        lotRef(node, lot)
          .ask[Either[OpenLotRejected, Envelope]](
            LotEntity.Open(OpenLot(Some(Instant.now().minusSeconds(60)), newOp()), operator, _)
          )
          .futureValue
          .isRight shouldBe true
        eventually(overdue(node) shouldBe Some(1L))
        lotRef(node, lot)
          .ask[Either[CloseLotRejected, Envelope]](
            LotEntity.Close(CloseLot(CloseReason.ByAuctioneer, newOp()), operator, _)
          )
          .futureValue
          .isRight shouldBe true
        eventually(overdue(node) shouldBe Some(0L))
      }
    }
  }
}
