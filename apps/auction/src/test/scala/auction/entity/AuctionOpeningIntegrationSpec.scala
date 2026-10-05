package auction.entity

import auction.AuctionNode
import auction.aggregate.*
import auction.aggregate.AuctionFixtures.closesAt
import auction.aggregate.AuctionFixtures.configInput
import auction.catalog.LotId
import auction.lot.AuctionId
import auction.lot.Envelope
import auction.lot.Lot
import auction.lot.LotFixtures.money
import auction.lot.LotFixtures.participant
import auction.lot.LotFixtures.scheduleLot
import auction.lot.LotState
import auction.lot.OpId
import auction.lot.OpenLotRejected
import auction.lot.ParticipantId
import auction.lot.ScheduleLotRejected
import auction.lot.StepPolicyInput
import auction.persistence.DatabaseSettings
import auction.persistence.JournalSchema
import auction.persistence.SlickAuctionViews
import auction.projection.AuctionListing
import auction.telemetry.ProjectionMetrics
import auction.testkit.PostgresFixture
import io.opentelemetry.api.OpenTelemetry
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
import java.util.UUID
import scala.concurrent.Future
import scala.concurrent.duration.*
import scala.util.Using

/**
 * Открытие онлайн-торгов на узле, собранном так же, как в `Main`: настоящие entity аукциона и лотов под шардингом,
 * журнал и read model на PostgreSQL. Команды идут через [[AuctionCommands]] — gRPC-метода у них нет (integration.md,
 * «Auction gRPC»). Рестарт здесь — рестарт `ActorSystem` на той же базе: L0 entity доказывает протокол на подмене лотов
 * и то, что открытый лот не получает второго `OpenLot`, а этот сьют — что после рестарта сервиса аукцион приходит к
 * фактическому состоянию настоящих лотов.
 */
final class AuctionOpeningIntegrationSpec
    extends AnyWordSpec
    with Matchers
    with PostgresFixture
    with ScalaFutures
    with Eventually {

  implicit override val patienceConfig: PatienceConfig = PatienceConfig(timeout = Span(30, Seconds))

  private given Timeout = Timeout(20.seconds)

  private val person: ParticipantId = participant(1)

  private val step = StepPolicyInput.Fixed(money(10))

  private final class StubAuthority extends MeetupAuthority {
    @volatile var answer: Authority = Authority.Granted
    def check(meetup: MeetupId, person: ParticipantId, correlation: Correlation): Future[Authority] =
      Future.successful(answer)
  }

  private final case class Node(
      system: ActorSystem[?],
      sharding: ClusterSharding,
      commands: AuctionCommands,
      authority: StubAuthority
  )

  /** Узел на уже размеченной базе: второй вызов на той же базе — рестарт сервиса. */
  private def onDatabase[A](database: DatabaseSettings)(use: Node => A): A = {
    val kit = ActorTestKit(s"auction-opening-${UUID.randomUUID()}", nodeConfig(database))
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
      val authority = StubAuthority()
      given scala.concurrent.ExecutionContext = kit.system.executionContext
      val commands = AuctionCommands(
        AuctionGateway.sharded(sharding, 10.seconds),
        LotGateway.sharded(sharding, 10.seconds),
        authority
      )
      use(Node(kit.system, sharding, commands, authority))
    } finally kit.shutdownTestKit()
  }

  private def newId(): UUID = UuidV7.generator(Clock.systemUTC())()

  private def newOp(): OpId = OpId(newId())

  private def lotState(node: Node, lot: LotId): LotState =
    node.sharding.entityRefFor(LotEntity.TypeKey, lot.value.toString).ask[Lot](LotEntity.Get(_)).futureValue.state

  private def roster(node: Node, auction: AuctionId): LotRoster =
    node.sharding
      .entityRefFor(AuctionEntity.TypeKey, auction.value.toString)
      .ask[LotRoster](AuctionEntity.Roster(_))
      .futureValue

  /** Аукцион сходки с двумя лотами в реестре: `planned` получил условия торгов, `bare` — нет. */
  private final case class Scheduled(meetup: MeetupId, auction: AuctionId, planned: LotId, bare: LotId)

  private def scheduled(node: Node): Scheduled = {
    val meetup = MeetupId(newId())
    val auction = node.commands
      .draft(meetup, newOp(), person)
      .futureValue
      .fold(denial => fail(s"the auction was not drafted: $denial"), _.auctionId)
    val planned = LotId(newId())
    val bare = LotId(newId())
    for (lot <- List(planned, bare))
      node.commands.addLot(auction, lot, newOp(), person).futureValue shouldBe Right(())
    node.sharding
      .entityRefFor(LotEntity.TypeKey, planned.value.toString)
      .ask[Either[ScheduleLotRejected, Envelope]](LotEntity.Plan(scheduleLot(opN = 2), Initiator.Operator(person), _))
      .futureValue
      .isRight shouldBe true
    node.commands.schedule(auction, configInput(), newOp(), person).futureValue shouldBe Right(())
    Scheduled(meetup, auction, planned, bare)
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

  "auction opening" should {

    "refuses a person meetups does not confirm and opens nothing" in {
      val database = freshDatabase()
      JournalSchema.migrate(database)
      onDatabase(database) { node =>
        val auction = scheduled(node)
        node.authority.answer = Authority.NotAdministrator
        node.commands.startPrebidding(auction.auction, newOp(), person).futureValue shouldBe
          Left(OpeningRefusal.Denied(Denial.NotAdministrator))
        roster(node, auction.auction) shouldBe LotRoster.empty
        lotState(node, auction.planned) shouldBe a[LotState.Scheduled]
      }
    }

    "opens the lot that has trading conditions with the common deadline and is not held up by the lot that has none" in {
      val database = freshDatabase()
      JournalSchema.migrate(database)
      onDatabase(database) { node =>
        val auction = scheduled(node)
        val op = newOp()
        node.commands.startPrebidding(auction.auction, op, person).futureValue shouldBe Right(())
        eventually {
          roster(node, auction.auction).lots shouldBe Map(
            auction.planned -> LotStanding.Active,
            auction.bare -> LotStanding.Declined(OpenLotRejected.LotNotScheduled)
          )
        }
        lotState(node, auction.planned) match {
          case LotState.Trading(trading) => trading.deadline shouldBe Some(closesAt)
          case other => fail(s"the planned lot is not trading: $other")
        }
        lotState(node, auction.bare) shouldBe LotState.Draft
        // Повтор того же op_id аукцион второй раз не открывает; новый op_id получает отказ.
        node.commands.startPrebidding(auction.auction, op, person).futureValue shouldBe Right(())
        node.commands.startPrebidding(auction.auction, newOp(), person).futureValue shouldBe
          Left(OpeningRefusal.AuctionNotScheduled)
        node.commands.addLot(auction.auction, LotId(newId()), newOp(), person).futureValue shouldBe
          Left(Denial.LotsFrozen)
        journalRows(database, auction.planned) shouldBe 3
        val views = SlickAuctionViews(node.system)
        eventually {
          views.byMeetup(auction.meetup).futureValue.map(_.auction.state) should matchPattern {
            case Some(AuctionState.Prebidding(_, started)) if started == op =>
          }
          views.page(AuctionListing.Active, None, 10).futureValue.map(_.auctionId) should contain(auction.auction.value)
        }
      }
    }

    "refuses new conditions of a lot after the start and leaves the journal of the lot as it was" in {
      val database = freshDatabase()
      JournalSchema.migrate(database)
      onDatabase(database) { node =>
        val auction = scheduled(node)
        node.commands.startPrebidding(auction.auction, newOp(), person).futureValue shouldBe Right(())
        eventually(roster(node, auction.auction).active shouldBe Set(auction.planned))
        for (lot <- List(auction.planned, auction.bare))
          node.commands.scheduleLot(auction.auction, lot, money(900), step, newOp(), person).futureValue shouldBe
            Left(LotSchedulingRefusal.Denied(Denial.LotsFrozen))
        journalRows(database, auction.planned) shouldBe 3
        lotState(node, auction.bare) shouldBe LotState.Draft
      }
    }

    // Обе команды уходят entity подряд, без ожидания ответа на первую: условия обязаны дойти до лота раньше вопроса
    // и `OpenLot`, которые аукцион шлёт ему после старта.
    "opens a lot whose conditions reached the auction right before the start" in {
      val database = freshDatabase()
      JournalSchema.migrate(database)
      onDatabase(database) { node =>
        val auction = scheduled(node)
        val entity = node.sharding.entityRefFor(AuctionEntity.TypeKey, auction.auction.value.toString)
        val operator = Initiator.Operator(person)
        val planned = entity.ask[Either[ScheduleAuctionLotRejected, Unit]](
          AuctionEntity.PlanLot(ScheduleAuctionLot(auction.bare, money(900), step, newOp()), operator, _)
        )
        val started = entity.ask[Either[StartPrebiddingRejected, AuctionAnswer]](
          AuctionEntity.Start(StartPrebidding(newOp()), operator, _)
        )
        planned.futureValue shouldBe Right(())
        started.futureValue.isRight shouldBe true
        eventually(roster(node, auction.auction).active shouldBe Set(auction.planned, auction.bare))
        lotState(node, auction.bare) match {
          case LotState.Trading(trading) => trading.currentPrice shouldBe money(900)
          case other => fail(s"the lot planned before the start is not trading: $other")
        }
      }
    }

    "comes to the actual state of its lots after a service restart" in {
      val database = freshDatabase()
      JournalSchema.migrate(database)
      val auction = onDatabase(database) { node =>
        val auction = scheduled(node)
        node.commands.startPrebidding(auction.auction, newOp(), person).futureValue shouldBe Right(())
        eventually(roster(node, auction.auction).active shouldBe Set(auction.planned))
        auction
      }
      onDatabase(database) { node =>
        eventually {
          roster(node, auction.auction).lots shouldBe Map(
            auction.planned -> LotStanding.Active,
            auction.bare -> LotStanding.Declined(OpenLotRejected.LotNotScheduled)
          )
        }
        lotState(node, auction.planned) shouldBe a[LotState.Trading]
        // Журнал лота не вырос. Что открытый лот не получает второго `OpenLot`, доказывает L0 entity: здесь повтор
        // с тем же `op_id` строки бы тоже не написал.
        journalRows(database, auction.planned) shouldBe 3
      }
    }
  }
}
