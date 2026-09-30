package auction.entity

import auction.entity.JournalFixtures.*
import auction.lot.*
import auction.lot.LotFixtures.*
import org.apache.pekko.actor.testkit.typed.scaladsl.ActorTestKit
import org.apache.pekko.persistence.testkit.scaladsl.EventSourcedBehaviorTestKit
import org.apache.pekko.persistence.testkit.scaladsl.EventSourcedBehaviorTestKit.SerializationSettings
import org.scalatest.BeforeAndAfterAll
import org.scalatest.BeforeAndAfterEach
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

/**
 * Синхронная часть entity лота на in-memory журнале: команда → событие → состояние → ответ и `restart()`.
 *
 * Каждое записанное событие проходит настоящий `jackson-json` туда и обратно с проверкой равенства, так что тест заодно
 * доказывает, что строка журнала читается в то же значение. Команды несут `ActorRef` и узел не покидают — их
 * сериализация не проверяется; snapshot проверяет `LotJournalSpec` и L1.
 */
final class LotEntitySpec extends AnyWordSpec with Matchers with BeforeAndAfterAll with BeforeAndAfterEach {

  private val kit = ActorTestKit("lot-entity", EventSourcedBehaviorTestKit.config.withFallback(localConfig))

  private val serialization =
    SerializationSettings.enabled.withVerifyEquality(true).withVerifyCommands(false).withVerifyState(false)

  private var entity: EventSourcedBehaviorTestKit[LotEntity.Command, StoredLotEvent, LotEntity.State] =
    scala.compiletime.uninitialized

  override protected def beforeEach(): Unit =
    entity = EventSourcedBehaviorTestKit(
      kit.system,
      LotEntity("lot-1", clock, sequentialIds()),
      serialization
    )

  override protected def afterAll(): Unit = kit.shutdownTestKit()

  private val bidder: Initiator = Initiator.Participant(participant(1))

  private val organizer: Initiator = Initiator.Operator(participant(9))

  private def draft(opN: Int = 1) =
    entity.runCommand[Either[DraftLotRejected, Envelope]](LotEntity.Draft(draftLot(opN), Initiator.Scheduler, _))

  private def plan(command: ScheduleLot) =
    entity.runCommand[Either[ScheduleLotRejected, Envelope]](LotEntity.Plan(command, organizer, _))

  private def open(opN: Int) =
    entity.runCommand[Either[OpenLotRejected, Envelope]](LotEntity.Open(openLot(opN), Initiator.Scheduler, _))

  /** Лот аукциона `auctionId(1)`, открытый по полному пути: `op(1)`–`op(3)` заняты, журнал — три строки. */
  private def openThrough() = {
    draft(opN = 1)
    plan(scheduleLot(opN = 2))
    open(opN = 3)
  }

  private def bidOf(who: Int, amount: Long, opN: Int) =
    entity.runCommand[Either[PlaceBidRejected, Envelope]](
      LotEntity.Bid(placeBid(who, amount, opN), Initiator.Participant(participant(who)), _)
    )

  "lot entity" should {

    "number the events of the lot by their position in the journal" in {
      val drafted = draft(opN = 1)
      val planned = plan(scheduleLot(opN = 2))
      val opening = open(opN = 3)
      val placed = bidOf(who = 1, amount = 110, opN = 4)

      List(drafted.reply, planned.reply, opening.reply, placed.reply).map(_.map(_.sequence)) shouldBe
        List(Right(1L), Right(2L), Right(3L), Right(4L))
      placed.state.sequence shouldBe 4L
      placed.state.lot.seen.values.map(envelope => envelope.opId -> envelope.sequence).toMap shouldBe
        Map(op(1) -> 1L, op(2) -> 2L, op(3) -> 3L, op(4) -> 4L)
    }

    "write one event per accepted command with the op id, the auction, the decision time and the initiator" in {
      val drafted = draft(opN = 1)
      val planned = plan(scheduleLot(opN = 2))
      open(opN = 3)
      val placed = bidOf(who = 1, amount = 110, opN = 4)

      List(drafted, planned, placed).flatMap(_.events).map { row =>
        (row.opId, row.auctionId, row.occurredAt, row.actor, row.event.kind)
      } shouldBe List(
        (
          op(1).value,
          Some(auctionId(1).value),
          decidedAt,
          LotJournal.storeInitiator(Initiator.Scheduler),
          "LotDrafted"
        ),
        (op(2).value, Some(auctionId(1).value), decidedAt, LotJournal.storeInitiator(organizer), "LotScheduled"),
        (op(4).value, Some(auctionId(1).value), decidedAt, LotJournal.storeInitiator(bidder), "BidPlaced")
      )
      placed.events.map(_.eventId) should not contain placed.events.head.transactionId
    }

    "keep the last of two schedules and the auction of the lot after a restart" in {
      draft(opN = 1)
      plan(scheduleLot(opN = 2, startingPrice = 100))
      val second = plan(scheduleLot(opN = 3, startingPrice = 200))

      val restarted = entity.restart().state

      restarted shouldBe second.state
      restarted.lot.state shouldBe LotState.Scheduled(schedule(startingPrice = 200))
      restarted.lot.auction shouldBe Some(auctionId(1))
    }

    "refuse to schedule an opened lot, write nothing and keep its config (Т-20, Т-52)" in {
      val before = openThrough().state

      val late = plan(scheduleLot(opN = 4, startingPrice = 900))

      late.reply shouldBe Left(ScheduleLotRejected.SchedulingClosed)
      late.events shouldBe Nil
      late.state shouldBe before
      tradingOf(late.state.lot).config shouldBe config()
    }

    "restore price, leader and deadline after a restart from the journal alone (Т-16)" in {
      openThrough()
      bidOf(who = 1, amount = 110, opN = 4)
      val beforeRestart = bidOf(who = 2, amount = 120, opN = 5).state

      val restarted = entity.restart().state

      restarted shouldBe beforeRestart
      val trading = tradingOf(restarted.lot)
      (trading.currentPrice, trading.leader, trading.deadline) shouldBe (
        money(120),
        Some(participant(2)),
        Some(deadline)
      )
    }

    "answer a repeated command with the original response and write nothing, even after a restart (Т-14)" in {
      openThrough()
      val first = bidOf(who = 1, amount = 110, opN = 4)

      val repeated = bidOf(who = 1, amount = 110, opN = 4)
      entity.restart()
      val repeatedAfterRestart = bidOf(who = 1, amount = 110, opN = 4)

      repeated.events shouldBe Nil
      repeatedAfterRestart.events shouldBe Nil
      repeated.reply shouldBe first.reply
      repeatedAfterRestart.reply shouldBe first.reply
    }

    "answer a refused command with its refusal and write nothing" in {
      val beforeDraft = plan(scheduleLot(opN = 1))
      draft(opN = 2)
      val secondDraft = draft(opN = 3)
      val beforeSchedule = open(opN = 4)

      beforeDraft.reply shouldBe Left(ScheduleLotRejected.LotNotFound)
      secondDraft.reply shouldBe Left(DraftLotRejected.LotAlreadyExists)
      beforeSchedule.reply shouldBe Left(OpenLotRejected.LotNotScheduled)
      List(beforeDraft.events, secondDraft.events, beforeSchedule.events) shouldBe List(Nil, Nil, Nil)
    }

    "reply to a read with the state of the lot" in {
      openThrough()

      val read = entity.runCommand[Lot](LotEntity.Get(_))

      read.reply shouldBe read.state.lot
      tradingOf(read.reply).currentPrice shouldBe money(100)
    }
  }
}
