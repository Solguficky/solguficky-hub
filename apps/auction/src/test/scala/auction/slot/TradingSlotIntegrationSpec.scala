package auction.slot

import auction.AuctionNode
import auction.SlotSettings
import auction.aggregate.*
import auction.aggregate.AuctionFixtures.configInput
import auction.catalog.LotId
import auction.entity.AuctionGateway
import auction.entity.Initiator
import auction.entity.LotEntity
import auction.entity.LotGateway
import auction.entity.UuidV7
import auction.lot.*
import auction.lot.LotFixtures.participant
import auction.lot.LotFixtures.scheduleLot
import auction.persistence.DatabaseSettings
import auction.persistence.JournalSchema
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

/**
 * Слот торгов сообщества (ADR-047, дополнение 2026-10-12) на узле, собранном так же, как в `Main`: настоящие entity
 * слота, аукционов и лотов под шардингом, журнал на PostgreSQL. L0 доказывает протоколы слота и аукциона на подменах;
 * этот сьют — что открытие двух аукционов через шлюз даёт одно открытие, что слот переходит к следующему после конца и
 * отмены первого и что рестарт процесса не теряет держателя и не держит слот за аукционом, чьё открытие не записалось.
 */
final class TradingSlotIntegrationSpec
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
      Future.successful(Authority.Granted(Standings.published))
  }

  private final case class Node(sharding: ClusterSharding, commands: AuctionCommands)

  /** Узел на уже размеченной базе: второй вызов на той же базе — рестарт сервиса. */
  private def onDatabase[A](database: DatabaseSettings)(use: Node => A): A = {
    val kit = ActorTestKit(s"trading-slot-${UUID.randomUUID()}", nodeConfig(database))
    try {
      val clock = Clock.systemUTC()
      val sharding = AuctionNode.join(kit.system)
      AuctionNode.registerLots(sharding, clock, UuidV7.generator(clock))
      val slot = AuctionNode.registerSlot(sharding, clock, UuidV7.generator(clock), SlotSettings(5.seconds, 8.seconds))
      AuctionNode.registerAuctions(kit.system, sharding, clock, UuidV7.generator(clock), 10.seconds, slot = slot)
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

  private def stateOf(node: Node, auction: AuctionId): AuctionState =
    node.commands.current(auction).futureValue.map(_.state).getOrElse(fail(s"the auction $auction has no journal"))

  /**
   * Аукцион сходки с одним лотом с условиями торгов, запланированный на неделю, которая закрывается через `closesIn`.
   */
  private def scheduled(node: Node, closesIn: java.time.Duration = java.time.Duration.ofHours(1)): AuctionId = {
    val auction = node.commands
      .draft(MeetupId(newId()), newOp(), person)
      .futureValue
      .fold(denial => fail(s"the auction was not drafted: $denial"), _.auctionId)
    val lot = LotId(newId())
    node.commands.addLot(auction, lot, newOp(), person).futureValue shouldBe Right(())
    lotRef(node, lot)
      .ask[Either[ScheduleLotRejected, Envelope]](LotEntity.Plan(scheduleLot(opN = 2), Initiator.Operator(person), _))
      .futureValue
      .isRight shouldBe true
    val now = Instant.now()
    val week = OnlinePhase(now.minusSeconds(3600), Some(now.plus(closesIn)), closesLots = true, None)
    node.commands.schedule(auction, configInput(Some(week)), newOp(), person).futureValue shouldBe Right(())
    auction
  }

  private def start(node: Node, auction: AuctionId): Either[OpeningRefusal, Unit] =
    node.commands.startPrebidding(auction, newOp(), person).futureValue

  private def claimDirectly(node: Node, auction: AuctionId): TradingSlotEntity.Claimed =
    node.sharding
      .entityRefFor(TradingSlotEntity.TypeKey, TradingSlotEntity.CommunityId)
      .ask[TradingSlotEntity.Claimed](TradingSlotEntity.Claim(auction, _))
      .futureValue

  "the trading slot" should {

    "refuses a second opening with the trading auction while letting it be scheduled, and opens it after the cancel" in {
      val database = freshDatabase()
      JournalSchema.migrate(database)
      onDatabase(database) { node =>
        val first = scheduled(node)
        start(node, first) shouldBe Right(())
        val second = scheduled(node)
        stateOf(node, second) shouldBe a[AuctionState.Scheduled]
        start(node, second) shouldBe Left(OpeningRefusal.AnotherAuctionActive(first))
        stateOf(node, second) shouldBe a[AuctionState.Scheduled]
        node.commands.cancel(first, newOp(), person).futureValue shouldBe Right(())
        eventually(start(node, second) shouldBe Right(()))
        stateOf(node, second) shouldBe a[AuctionState.Prebidding]
      }
    }

    "passes to the next auction once the first finished without a final" in {
      val database = freshDatabase()
      JournalSchema.migrate(database)
      onDatabase(database) { node =>
        val first = scheduled(node, closesIn = java.time.Duration.ofSeconds(3))
        start(node, first) shouldBe Right(())
        val second = scheduled(node)
        start(node, second) shouldBe Left(OpeningRefusal.AnotherAuctionActive(first))
        eventually(stateOf(node, first) shouldBe a[AuctionState.Finished])
        start(node, second) shouldBe Right(())
      }
    }

    "gives one of two simultaneous openings of different auctions and refuses the other with the winner" in {
      val database = freshDatabase()
      JournalSchema.migrate(database)
      onDatabase(database) { node =>
        val first = scheduled(node)
        val second = scheduled(node)
        val openings =
          List(first, second).map(auction => auction -> node.commands.startPrebidding(auction, newOp(), person))
        val answers = openings.map((auction, answer) => auction -> answer.futureValue)
        val winners = answers.collect { case (auction, Right(())) => auction }
        winners should have size 1
        answers.collect { case (_, Left(refusal)) => refusal } shouldBe
          List(OpeningRefusal.AnotherAuctionActive(winners.head))
      }
    }

    "keeps its holder over a restart and gives the slot away from an auction whose opening was never written" in {
      val database = freshDatabase()
      JournalSchema.migrate(database)
      val (stuck, trading, waiting) = onDatabase(database) { node =>
        val stuck = scheduled(node)
        claimDirectly(node, stuck) shouldBe TradingSlotEntity.Claimed.Granted
        val trading = scheduled(node)
        start(node, trading) shouldBe Right(())
        (stuck, trading, scheduled(node))
      }
      onDatabase(database) { node =>
        start(node, waiting) shouldBe Left(OpeningRefusal.AnotherAuctionActive(trading))
        stateOf(node, stuck) shouldBe a[AuctionState.Scheduled]
      }
    }
  }
}
