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
import auction.raffle.Beacon
import auction.raffle.Raffle
import auction.raffle.RaffleAccess
import auction.raffle.RaffleEntity
import auction.raffle.RaffleState
import auction.raffle.RaffleTickets
import auction.raffle.Randomness
import auction.testkit.PostgresFixture
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
import scala.concurrent.Future
import scala.concurrent.duration.*
import scala.util.Using

/**
 * Отмена аукциона после старта торгов (ADR-047, дополнение 2026-10-12) на узле, собранном так же, как в `Main`:
 * настоящие entity аукциона, лотов и розыгрыша под шардингом, журнал на PostgreSQL. L0 entity доказывает протокол
 * снятия на подмене лотов; этот сьют — что снятие доходит до настоящих лотов, переживает рестарт процесса без второго
 * события и не даёт запоздавшему открытию открыть снятый лот.
 */
final class AuctionCancellingIntegrationSpec
    extends AnyWordSpec
    with Matchers
    with PostgresFixture
    with ScalaFutures
    with Eventually {

  implicit override val patienceConfig: PatienceConfig = PatienceConfig(timeout = Span(30, Seconds))

  private given Timeout = Timeout(20.seconds)

  private val person: ParticipantId = participant(1)

  private val withdrawn = LotState.Withdrawn(WithdrawnReason.AuctionCancelled)

  private object Granted extends MeetupAuthority {
    def check(meetup: MeetupId, person: ParticipantId, correlation: Correlation): Future[Authority] =
      Future.successful(Authority.Granted)
  }

  /** Розыгрышу из сьюта не нужны ни Identity, ни маяк, ни имена: до закрытия регистрации дело не доходит. */
  private object Everyone extends RaffleAccess {
    def holdsRight(participant: ParticipantId): Future[Boolean] = Future.successful(true)
  }

  private object Silent extends Beacon {
    def randomness(round: Long): Future[Option[Randomness]] = Future.successful(None)
  }

  private object NoNames extends RaffleTickets {
    def record(auction: AuctionId, tickets: Vector[ParticipantId]): Future[Unit] = Future.unit
    def names(auction: AuctionId): Future[Map[Int, String]] = Future.successful(Map.empty)
    def expireAt(auction: AuctionId, at: Instant): Future[Unit] = Future.unit
  }

  private final case class Node(sharding: ClusterSharding, commands: AuctionCommands)

  /** Узел на уже размеченной базе: второй вызов на той же базе — рестарт сервиса. */
  private def onDatabase[A](database: DatabaseSettings)(use: Node => A): A = {
    val kit = ActorTestKit(s"auction-cancelling-${UUID.randomUUID()}", nodeConfig(database))
    try {
      val clock = Clock.systemUTC()
      val sharding = AuctionNode.join(kit.system)
      AuctionNode.registerLots(sharding, clock, UuidV7.generator(clock))
      AuctionNode.registerRaffles(
        kit.system,
        sharding,
        clock,
        UuidV7.generator(clock),
        Everyone,
        Silent,
        NoNames,
        RaffleEntity.Settings(5.seconds, 1.second, java.time.Duration.ofDays(30))
      )
      AuctionNode.registerAuctions(
        kit.system,
        sharding,
        clock,
        UuidV7.generator(clock),
        10.seconds,
        AuctionRaffle.sharded(sharding, 10.seconds)
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

  private def raffle(node: Node, auction: AuctionId): Raffle =
    node.sharding
      .entityRefFor(RaffleEntity.TypeKey, auction.value.toString)
      .ask[Raffle](RaffleEntity.Get(_))
      .futureValue

  /**
   * Аукцион сходки с `size` лотами, у каждого условия торгов, запланированный на неделю, которая закрывается через час,
   * с розыгрышем, чья регистрация закрывается через полчаса. Торги не открыты: открывает их тест.
   */
  private def scheduled(node: Node, size: Int): (AuctionId, List[LotId]) = {
    val auction = node.commands
      .draft(MeetupId(newId()), newOp(), person)
      .futureValue
      .fold(denial => fail(s"the auction was not drafted: $denial"), _.auctionId)
    val lots = List.fill(size)(LotId(newId()))
    lots.foreach { lot =>
      node.commands.addLot(auction, lot, newOp(), person).futureValue shouldBe Right(())
      lotRef(node, lot)
        .ask[Either[ScheduleLotRejected, Envelope]](LotEntity.Plan(scheduleLot(opN = 2), Initiator.Operator(person), _))
        .futureValue
        .isRight shouldBe true
    }
    val now = Instant.now()
    val week =
      OnlinePhase(now.minusSeconds(3600), Some(now.plusSeconds(3600)), closesLots = true, Some(now.plusSeconds(1800)))
    node.commands.schedule(auction, configInput(Some(week)), newOp(), person).futureValue shouldBe Right(())
    (auction, lots)
  }

  private def opened(node: Node, size: Int): (AuctionId, List[LotId]) = {
    val (auction, lots) = scheduled(node, size)
    node.commands.startPrebidding(auction, newOp(), person).futureValue shouldBe Right(())
    eventually(lots.map(lotState(node, _)).forall(_.isInstanceOf[LotState.Trading]) shouldBe true)
    (auction, lots)
  }

  private def bid(node: Node, lot: LotId, who: ParticipantId): Either[PlaceBidRejected, LotEntity.Recorded] = {
    val price = lotState(node, lot) match {
      case LotState.Trading(trading) => Lot.minRequired(trading, Instant.now())
      case _ => LotFixtures.money(1_000_000)
    }
    lotRef(node, lot)
      .ask[Either[PlaceBidRejected, LotEntity.Recorded]](
        LotEntity.Bid(PlaceBid(who, price, newOp(), BidSource.Bot), Initiator.Participant(who), _)
      )
      .futureValue
  }

  private def journalRows(database: DatabaseSettings, persistenceId: String): Int =
    withConnection(database) { connection =>
      Using.resource(connection.prepareStatement("SELECT count(*) FROM event_journal WHERE persistence_id = ?")) {
        statement =>
          statement.setString(1, persistenceId)
          Using.resource(statement.executeQuery()) { rows =>
            rows.next()
            rows.getInt(1)
          }
      }
    }

  "cancelling an auction" should {

    "keep the sold lot sold, withdraw the open ones so that a bid on them is refused, and cancel the raffle" in {
      val database = freshDatabase()
      JournalSchema.migrate(database)
      onDatabase(database) { node =>
        val (auction, lots) = opened(node, size = 3)
        eventually(raffle(node, auction).state shouldBe a[RaffleState.Open])
        val sold = lots.head
        bid(node, sold, participant(2)).isRight shouldBe true
        lotRef(node, sold)
          .ask[Either[CloseLotRejected, Envelope]](
            LotEntity.Close(CloseLot(CloseReason.ByAuctioneer, newOp()), Initiator.Operator(person), _)
          )
          .futureValue
          .isRight shouldBe true

        node.commands.cancel(auction, newOp(), person).futureValue shouldBe Right(())

        eventually(lots.tail.map(lotState(node, _)) shouldBe List(withdrawn, withdrawn))
        lotState(node, sold) should matchPattern { case LotState.Sold(sale) if sale.winner == participant(2) => }
        lots.tail.foreach(lot => bid(node, lot, participant(3)) shouldBe Left(PlaceBidRejected.LotNotOpen))
        eventually(raffle(node, auction).state shouldBe a[RaffleState.Cancelled])
      }
    }

    "refuse a cancel before trading and answer a second cancel of a cancelled auction without a second event" in {
      val database = freshDatabase()
      JournalSchema.migrate(database)
      onDatabase(database) { node =>
        val (auction, _) = scheduled(node, size = 1)
        node.commands.cancel(auction, newOp(), person).futureValue shouldBe Left(CancellationRefusal.AuctionNotStarted)
        node.commands.startPrebidding(auction, newOp(), person).futureValue shouldBe Right(())
        node.commands.cancel(auction, newOp(), person).futureValue shouldBe Right(())
        val rows = journalRows(database, s"auction|${auction.value}")
        node.commands.cancel(auction, newOp(), person).futureValue shouldBe Right(())
        journalRows(database, s"auction|${auction.value}") shouldBe rows
      }
    }

    "finish the withdrawal after a restart right after the cancel without a second event" in {
      val database = freshDatabase()
      JournalSchema.migrate(database)
      val (auction, lots, auctionRows) = onDatabase(database) { node =>
        val (auction, lots) = opened(node, size = 5)
        node.commands.cancel(auction, newOp(), person).futureValue shouldBe Right(())
        // Узел гаснет сразу после ответа: часть лотов может ещё не получить `WithdrawLot`.
        (auction, lots, journalRows(database, s"auction|${auction.value}"))
      }
      onDatabase(database) { node =>
        // Аукциону никто не пишет: доснимает лоты помнящийся шардинг, поднявший его после рестарта.
        eventually(lots.map(lotState(node, _)).distinct shouldBe List(withdrawn))
      }
      onDatabase(database) { node =>
        lots.map(lotState(node, _)).distinct shouldBe List(withdrawn)
        Thread.sleep(1000)
        journalRows(database, s"auction|${auction.value}") shouldBe auctionRows
        // Рождение, условия, открытие и одно снятие: повтор снятия после рестарта второй строки не пишет.
        lots.map(lot => journalRows(database, s"lot|${lot.value}")).distinct shouldBe List(4)
      }
    }

    "not open by a late opening a lot withdrawn by a cancel that came right after the start" in {
      val database = freshDatabase()
      JournalSchema.migrate(database)
      onDatabase(database) { node =>
        val (auction, lots) = scheduled(node, size = 5)
        node.commands.startPrebidding(auction, newOp(), person).futureValue shouldBe Right(())
        node.commands.cancel(auction, newOp(), person).futureValue shouldBe Right(())
        eventually(lots.map(lotState(node, _)).distinct shouldBe List(withdrawn))
        Thread.sleep(1000)
        lots.map(lotState(node, _)).distinct shouldBe List(withdrawn)
      }
    }
  }
}
