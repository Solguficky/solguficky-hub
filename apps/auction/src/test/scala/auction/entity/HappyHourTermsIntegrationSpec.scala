package auction.entity

import auction.AuctionNode
import auction.aggregate.*
import auction.aggregate.AuctionFixtures.configInput
import auction.catalog.LotId
import auction.lot.*
import auction.lot.LotFixtures.money
import auction.lot.LotFixtures.participant
import auction.lot.LotFixtures.scheduleLot
import auction.persistence.DatabaseSettings
import auction.persistence.JournalSchema
import auction.testkit.PostgresFixture
import org.apache.pekko.actor.testkit.typed.scaladsl.ActorTestKit
import org.apache.pekko.cluster.sharding.typed.scaladsl.ClusterSharding
import org.apache.pekko.cluster.sharding.typed.scaladsl.Entity
import org.apache.pekko.util.Timeout
import org.scalatest.concurrent.Eventually
import org.scalatest.concurrent.ScalaFutures
import org.scalatest.matchers.should.Matchers
import org.scalatest.time.Seconds
import org.scalatest.time.Span
import org.scalatest.wordspec.AnyWordSpec

import java.time.Clock
import java.time.Instant
import java.time.temporal.ChronoUnit
import java.util.UUID
import scala.concurrent.Future
import scala.concurrent.Promise
import scala.concurrent.duration.*

/**
 * Условия лота в периоде «Счастливых часов» (PER-786) на настоящих entity аукциона и лотов под шардингом, с журналом на
 * PostgreSQL. Рестарт — рестарт `ActorSystem` на той же базе. Первый узел записывает условия, а команда лоту теряется:
 * так выглядит падение сервиса между записью аукциона и подтверждением лота. Второй узел обязан довести доставку сам.
 */
final class HappyHourTermsIntegrationSpec
    extends AnyWordSpec
    with Matchers
    with PostgresFixture
    with ScalaFutures
    with Eventually {

  implicit override val patienceConfig: PatienceConfig = PatienceConfig(timeout = Span(30, Seconds))

  private given Timeout = Timeout(20.seconds)

  private val person: ParticipantId = participant(1)

  private val closesAt: Instant = Instant.now().plus(30, ChronoUnit.DAYS).truncatedTo(ChronoUnit.SECONDS)

  private val week: OnlinePhase = OnlinePhase(Instant.now().minusSeconds(3600), Some(closesAt), closesLots = true)

  private val granted: MeetupAuthority = (_, _, _) => Future.successful(Authority.Granted(Standings.published))

  /** Лоты, до которых условия периода не доходят: аукцион их отправил, а лот не получил и не ответил. */
  private final class Dropping(lots: AuctionLots) extends AuctionLots {
    def stateOf(lot: LotId) = lots.stateOf(lot)
    def open(lot: LotId, command: OpenLot) = lots.open(lot, command)
    def close(lot: LotId, command: CloseLot) = lots.close(lot, command)
    def closeByAuctioneer(lot: LotId, command: CloseLot, initiator: Initiator) =
      lots.closeByAuctioneer(lot, command, initiator)
    def resume(lot: LotId, command: ResumeLot) = lots.resume(lot, command)
    def schedule(lot: LotId, command: ScheduleLot, initiator: Initiator) = lots.schedule(lot, command, initiator)
    def mark(lot: LotId, command: MarkForFinal, initiator: Initiator) = lots.mark(lot, command, initiator)
    def unmark(lot: LotId, command: UnmarkForFinal, initiator: Initiator) = lots.unmark(lot, command, initiator)
    def advanceAsk(lot: LotId, command: AdvanceAsk, initiator: Initiator) = lots.advanceAsk(lot, command, initiator)
    def removeParticipant(lot: LotId, command: RemoveParticipant, initiator: Initiator) =
      lots.removeParticipant(lot, command, initiator)
    def previewRemoval(lot: LotId, participant: ParticipantId) = lots.previewRemoval(lot, participant)
    def withdraw(lot: LotId, command: WithdrawLot) = lots.withdraw(lot, command)
    def addWindow(lot: LotId, command: AddStepWindow) = lots.addWindow(lot, command)
    def setPeriodWindow(lot: LotId, command: SetPeriodWindow): Future[Either[PeriodWindowRejected, Unit]] =
      Promise[Either[PeriodWindowRejected, Unit]]().future
    def clearPeriodWindow(lot: LotId, command: ClearPeriodWindow) = lots.clearPeriodWindow(lot, command)
  }

  private final case class Node(sharding: ClusterSharding, commands: AuctionCommands)

  /**
   * Узел на уже размеченной базе: второй вызов на той же базе — рестарт сервиса. `dropping` — аукцион собран с лотами,
   * до которых условия периода не доходят, и без запоминания: следующий узел поднимет его первым же вопросом.
   */
  private def onDatabase[A](database: DatabaseSettings, dropping: Boolean)(use: Node => A): A = {
    val kit = ActorTestKit(s"auction-happy-hours-${UUID.randomUUID()}", nodeConfig(database))
    try {
      val clock = Clock.systemUTC()
      val sharding = AuctionNode.join(kit.system)
      AuctionNode.registerLots(sharding, clock, UuidV7.generator(clock))
      if (dropping) {
        val lots = Dropping(AuctionLots.sharded(sharding, 10.seconds))
        sharding.init(
          Entity(AuctionEntity.TypeKey)(context =>
            AuctionEntity(context.entityId, clock, UuidV7.generator(clock), lots, shard = Some(context.shard))
          )
        )
      } else AuctionNode.registerAuctions(kit.system, sharding, clock, UuidV7.generator(clock), 10.seconds)
      given scala.concurrent.ExecutionContext = kit.system.executionContext
      val commands = AuctionCommands(
        AuctionGateway.sharded(sharding, 10.seconds),
        LotGateway.sharded(sharding, 10.seconds),
        granted
      )
      use(Node(sharding, commands))
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

  private def windowsOf(node: Node, lot: LotId): List[StepWindow] =
    lotState(node, lot) match {
      case LotState.Trading(trading) => trading.stepWindows
      case other => fail(s"the lot is not trading: $other")
    }

  "terms of a lot in a happy hour period" should {

    "reach the lot after a restart between the record of the auction and the answer of the lot" in {
      val database = freshDatabase()
      JournalSchema.migrate(database)
      val from = Instant.now().plus(1, ChronoUnit.DAYS).truncatedTo(ChronoUnit.SECONDS)
      val until = from.plus(2, ChronoUnit.HOURS)
      val (auction, lot, period) = onDatabase(database, dropping = true) { node =>
        val auction = node.commands
          .draft(MeetupId(newId()), newOp(), person)
          .futureValue
          .fold(denial => fail(s"the auction was not drafted: $denial"), _.auctionId)
        val lot = LotId(newId())
        node.commands.addLot(auction, lot, newOp(), person).futureValue shouldBe Right(())
        val plan = LotEntity.Plan(scheduleLot(opN = 2), Initiator.Operator(person), _)
        node.sharding
          .entityRefFor(LotEntity.TypeKey, lot.value.toString)
          .ask[Either[ScheduleLotRejected, Envelope]](plan)
          .futureValue
          .isRight shouldBe true
        node.commands.schedule(auction, configInput(Some(week)), newOp(), person).futureValue shouldBe Right(())
        node.commands.startPrebidding(auction, newOp(), person).futureValue shouldBe Right(())
        eventually(roster(node, auction).active shouldBe Set(lot))
        val period = node.commands
          .createHappyHourPeriod(auction, CreateHappyHourPeriod(from, until, newOp()), person)
          .futureValue
          .fold(refusal => fail(s"the period was not created: $refusal"), _.id)
        val command = SetHappyHourLotTerms(period, lot, None, Some(money(60)), newOp())
        node.commands.setHappyHourLotTerms(auction, command, person).futureValue shouldBe
          Right(lot -> HappyHourTerms(None, Some(money(60))))
        windowsOf(node, lot) shouldBe empty
        (auction, lot, period)
      }
      onDatabase(database, dropping = false) { node =>
        val window = StepWindow(from, until, None, Some(money(60)), Some(WindowPeriod(period.value)))
        eventually {
          roster(node, auction).deliveries.values.toSet shouldBe Set(WindowDelivery.Delivered)
          windowsOf(node, lot) shouldBe List(window)
        }
      }
    }
  }
}
