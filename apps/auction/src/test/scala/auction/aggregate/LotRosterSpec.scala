package auction.aggregate

import auction.aggregate.AuctionFixtures.*
import auction.catalog.LotId
import auction.lot.LotFixtures
import auction.lot.CloseLot
import auction.lot.CloseLotRejected
import auction.lot.CloseReason
import auction.lot.LotFixtures.op
import auction.lot.LotFixtures.participant
import auction.lot.LotState
import auction.lot.OpenLot
import auction.lot.OpenLotRejected
import auction.lot.UnsoldReason
import auction.lot.WithdrawLotRejected
import auction.lot.WithdrawnReason
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

import java.util.UUID

/** Протокол И-14 как таблица переходов: без акторов, шардинга и журнала. */
final class LotRosterSpec extends AnyWordSpec with Matchers {

  private val meetup = MeetupId(new UUID(6L, 1L))
  private val first = LotId(new UUID(5L, 1L))
  private val second = LotId(new UUID(5L, 2L))

  private def auctionIn(state: AuctionState): Auction = Auction(state, Some(meetup), Set(first, second), Map.empty)

  private val prebidding = auctionIn(AuctionState.Prebidding(config(), op(3)))

  private def asked: LotRoster = LotRoster.survey(prebidding)._1

  private def opening(lot: LotId): LotRoster =
    LotRoster.observed(prebidding, asked, lot, LotFixtures.scheduled().state)._1

  private val trading = LotFixtures.trading(price = 100)

  private val ledByPerson = LotState.Trading(LotFixtures.tradingOf(trading).copy(deadline = None))

  private def active: LotRoster = LotRoster.observed(prebidding, asked, first, trading.state)._1

  private def closing: LotRoster = LotRoster.due(prebidding, active, first)._1

  "lot roster" should {

    "asks every lot of the registry for its state once prebidding started" in {
      val (roster, instructions) = LotRoster.survey(prebidding)
      roster.lots shouldBe Map(first -> LotStanding.Asked, second -> LotStanding.Asked)
      instructions should contain theSameElementsAs List(LotInstruction.Ask(first), LotInstruction.Ask(second))
      roster.active shouldBe empty
    }

    "asks no lot before prebidding" in {
      for (state <- List(AuctionState.Draft, AuctionState.Scheduled(config())))
        LotRoster.survey(auctionIn(state)) shouldBe (LotRoster.empty, Nil)
    }

    "opens a lot that is not open yet with the op_id of the start and the deadline of the config" in {
      for (state <- List(LotState.Initial, LotState.Draft, LotFixtures.scheduled().state)) {
        val (roster, instructions) = LotRoster.observed(prebidding, asked, first, state)
        roster.lots(first) shouldBe LotStanding.Opening
        instructions shouldBe List(LotInstruction.Open(first, OpenLot(Some(closesAt), op(3))))
        roster.active shouldBe empty
      }
    }

    // Т-71: окна выводятся из конфигурации аукциона, поэтому повторный OpenLot после рестарта несёт те же.
    "opens a lot with the step windows it is named in and none of the others" in {
      val windows = config(configInput(stepWindows = List(window(1, 2, Set(first)), window(3, 4, Set(second)))))
      val withWindows = auctionIn(AuctionState.Prebidding(windows, op(3)))

      LotRoster
        .observed(withWindows, LotRoster.survey(withWindows)._1, first, LotFixtures.scheduled().state)
        ._2 shouldBe
        List(LotInstruction.Open(first, OpenLot(Some(closesAt), op(3), windows.windowsOf(first))))
      windows.windowsOf(first).map(_.from) shouldBe List(opensAt.plusSeconds(3600))
    }

    "opens a lot without a deadline when the config does not close lots" in {
      val ledByPerson = auctionIn(AuctionState.Prebidding(config(byAuctioneer), op(3)))
      LotRoster.observed(ledByPerson, asked, first, LotFixtures.scheduled().state)._2 shouldBe
        List(LotInstruction.Open(first, OpenLot(None, op(3))))
    }

    "counts a lot that is already trading active without opening it again and arms its deadline" in {
      val (roster, instructions) = LotRoster.observed(prebidding, asked, first, trading.state)
      roster.active shouldBe Set(first)
      instructions shouldBe List(LotInstruction.Arm(first, LotFixtures.deadline))
    }

    "arms no deadline for a trading lot that a person closes" in {
      val (roster, instructions) = LotRoster.observed(prebidding, asked, first, ledByPerson)
      roster.active shouldBe Set(first)
      instructions shouldBe empty
    }

    "does not count a held, a sold or an unsold lot active and does not open it" in {
      val held = LotRoster.observed(prebidding, asked, first, LotFixtures.held(100, participant(1)).state)
      held._1.lots(first) shouldBe LotStanding.Held
      val sold = LotRoster.observed(prebidding, asked, first, LotFixtures.sold(100, participant(1)).state)
      sold._1.lots(first) shouldBe LotStanding.Closed
      val unsold = LotRoster.observed(prebidding, asked, first, LotState.Unsold(UnsoldReason.NoBids))
      unsold._1.lots(first) shouldBe LotStanding.Closed
      held._2 ++ sold._2 ++ unsold._2 shouldBe empty
    }

    "counts a lot active only after it confirmed the opening and arms the deadline the lot opened with" in {
      val (roster, instructions) = LotRoster.opened(prebidding, opening(first), first, Right(Some(closesAt)))
      roster.active shouldBe Set(first)
      instructions shouldBe List(LotInstruction.Arm(first, closesAt))
      LotRoster.opened(prebidding, opening(first), first, Right(None))._2 shouldBe empty
    }

    "leaves a lot that refused the opening inactive and the other lots untouched" in {
      val (refused, instructions) =
        LotRoster.opened(prebidding, opening(first), first, Left(OpenLotRejected.LotNotScheduled))
      instructions shouldBe empty
      refused.lots shouldBe Map(
        first -> LotStanding.Declined(OpenLotRejected.LotNotScheduled),
        second -> LotStanding.Asked
      )
      refused.active shouldBe empty
    }

    "marks a lot whose answer never came unanswered and asks it again on a repeated start" in {
      val silent = LotRoster.unanswered(opening(first), first)
      silent.lots(first) shouldBe LotStanding.Unanswered
      val (resumed, instructions) = LotRoster.resume(prebidding, silent)
      instructions shouldBe List(LotInstruction.Ask(first))
      resumed.lots shouldBe Map(first -> LotStanding.Asked, second -> LotStanding.Asked)
    }

    "leaves answered lots alone on a repeated start" in {
      val refused = LotRoster.opened(prebidding, opening(first), first, Left(OpenLotRejected.LotNotScheduled))._1
      val active = LotRoster.observed(prebidding, refused, second, trading.state)._1
      LotRoster.resume(prebidding, active) shouldBe (active, Nil)
    }

    "asks lots again only on a repeat of the start itself, not of another accepted command" in {
      val silent = LotRoster.unanswered(opening(first), first)
      val start = AuctionDecision.Repeated(AuctionEnvelope(3, op(3), AuctionEvent.PrebiddingStarted))
      LotRoster.started(prebidding, silent, start)._2 shouldBe List(LotInstruction.Ask(first))
      val another = AuctionDecision.Repeated(AuctionEnvelope(2, op(2), AuctionEvent.LotAdded(first)))
      LotRoster.started(prebidding, silent, another) shouldBe (silent, Nil)
      LotRoster.started(prebidding, silent, AuctionDecision.Accepted(AuctionEvent.PrebiddingStarted))._1 shouldBe asked
    }

    "ignores an answer it is not waiting for" in {
      // Опоздавшее наблюдение «не открыт» подтверждённый лот не понижает и второго `OpenLot` не вызывает.
      LotRoster.observed(prebidding, active, first, LotFixtures.scheduled().state) shouldBe (active, Nil)
      LotRoster.opened(prebidding, active, first, Left(OpenLotRejected.LotNotScheduled)) shouldBe (active, Nil)
      LotRoster.unanswered(active, first) shouldBe active
      LotRoster.opened(prebidding, asked, first, Right(Some(closesAt))) shouldBe (asked, Nil)
      LotRoster.closed(prebidding, active, first, Right(Closure.Closed)) shouldBe (active, Nil)
    }

    "closes an active lot by its deadline with an op_id that stays the same after any restart" in {
      val (roster, instructions) = LotRoster.due(prebidding, active, first)
      roster.lots(first) shouldBe LotStanding.Closing
      instructions shouldBe List(
        LotInstruction.Close(first, CloseLot(CloseReason.DeadlineReached, LotRoster.closeOpId(op(3), first)))
      )
      LotRoster.closeOpId(op(3), first) shouldBe LotRoster.closeOpId(op(3), first)
      LotRoster.closeOpId(op(3), first) should not be LotRoster.closeOpId(op(3), second)
    }

    "does not close a lot that is not active when its timer fires" in {
      LotRoster.due(prebidding, asked, first) shouldBe (asked, Nil)
      LotRoster.due(prebidding, closing, first) shouldBe (closing, Nil)
      val sold = LotRoster.observed(prebidding, asked, first, LotFixtures.sold(100, participant(1)).state)._1
      LotRoster.due(prebidding, sold, first) shouldBe (sold, Nil)
      LotRoster.due(auctionIn(AuctionState.Scheduled(config())), active, first) shouldBe (active, Nil)
    }

    "counts a lot closed once it accepted the closing" in {
      val (roster, instructions) = LotRoster.closed(prebidding, closing, first, Right(Closure.Closed))
      roster.lots(first) shouldBe LotStanding.Closed
      instructions shouldBe empty
    }

    "asks a lot that refused the closing for its state instead of guessing why" in {
      for (refusal <- List(CloseLotRejected.DeadlineNotReached, CloseLotRejected.LotNotOpen)) {
        val (roster, instructions) = LotRoster.closed(prebidding, closing, first, Left(refusal))
        roster.lots(first) shouldBe LotStanding.Asked
        instructions shouldBe List(LotInstruction.Ask(first))
      }
    }

    "asks again on a recheck exactly the lots whose question or command went unanswered" in {
      val silent = LotRoster.unanswered(closing, first)
      silent.lots(first) shouldBe LotStanding.Unanswered
      val (rechecked, instructions) = LotRoster.recheck(prebidding, silent)
      instructions shouldBe List(LotInstruction.Ask(first))
      rechecked.lots shouldBe Map(first -> LotStanding.Asked, second -> LotStanding.Asked)
      LotRoster.recheck(prebidding, active) shouldBe (active, Nil)
      LotRoster.recheck(auctionIn(AuctionState.Scheduled(config())), silent) shouldBe (silent, Nil)
    }
    "waits after the common deadline until every opened lot is closed or held and then settles" in {
      val settling = auctionIn(AuctionState.Settling(config(), op(3)))
      val (asked, questions) = LotRoster.survey(settling)
      questions should contain theSameElementsAs List(LotInstruction.Ask(first), LotInstruction.Ask(second))
      val (open, armed) = LotRoster.observed(settling, asked, first, trading.state)
      armed shouldBe List(LotInstruction.Arm(first, LotFixtures.deadline))
      val (held, waiting) = LotRoster.observed(settling, open, second, LotFixtures.held(100, participant(1)).state)
      waiting shouldBe empty
      val (closing, close) = LotRoster.due(settling, held, first)
      close shouldBe List(
        LotInstruction.Close(first, CloseLot(CloseReason.DeadlineReached, LotRoster.closeOpId(op(3), first)))
      )
      LotRoster.closed(settling, closing, first, Right(Closure.Closed))._2 shouldBe
        List(LotInstruction.Settle(Set(second)))
    }

    "counts a lot that answered its closing with the hold as held" in {
      val settling = auctionIn(AuctionState.Settling(config(), op(3)))
      val closing = LotRoster.due(settling, LotRoster.observed(settling, asked, first, trading.state)._1, first)._1
      LotRoster.closed(settling, closing, first, Right(Closure.Held))._1.lots(first) shouldBe LotStanding.Held
    }

    "does not open a lot after the common deadline and does not wait for it" in {
      val settling = auctionIn(AuctionState.Settling(config(), op(3)))
      val asked = LotRoster.survey(settling)._1
      val (notOpened, instructions) = LotRoster.observed(settling, asked, first, LotFixtures.scheduled().state)
      notOpened.lots(first) shouldBe LotStanding.NotOpened
      instructions shouldBe empty
      LotRoster.observed(settling, notOpened, second, LotState.Unsold(UnsoldReason.NoBids))._2 shouldBe
        List(LotInstruction.Settle(Set.empty))
    }

    "keeps waiting for a lot that did not answer and asks it again on a recheck" in {
      val settling = auctionIn(AuctionState.Settling(config(), op(3)))
      val asked = LotRoster.survey(settling)._1
      val closed = LotRoster.observed(settling, asked, second, LotState.Unsold(UnsoldReason.NoBids))._1
      val silent = LotRoster.unanswered(closed, first)
      LotRoster.settling(settling, (silent, Nil)) shouldBe (silent, Nil)
      LotRoster.recheck(settling, silent)._2 shouldBe List(LotInstruction.Ask(first))
    }

    "settles at once on a survey when the registry is empty" in {
      val empty = Auction(AuctionState.Settling(config(), op(3)), Some(meetup), Set.empty, Map.empty)
      LotRoster.survey(empty)._2 shouldBe List(LotInstruction.Settle(Set.empty))
    }

    "knows the lineup in the break only once every lot of the registry answered" in {
      val break = auctionIn(AuctionState.Break(config(), op(3)))
      val asked = LotRoster.survey(break)._1
      LotRoster.lineup(break, asked) shouldBe None
      val held = LotRoster.observed(break, asked, first, LotFixtures.held(100, participant(1)).state)._1
      LotRoster.lineup(break, held) shouldBe None
      val known = LotRoster.observed(break, held, second, LotFixtures.sold(100, participant(1)).state)._1
      LotRoster.lineup(break, known) shouldBe Some(Set(first))
      LotRoster.lineup(prebidding, known) shouldBe None
    }

    "neither closes nor settles in the break" in {
      val break = auctionIn(AuctionState.Break(config(), op(3)))
      val active = LotRoster.observed(break, LotRoster.survey(break)._1, first, trading.state)._1
      LotRoster.due(break, active, first) shouldBe (active, Nil)
      LotRoster.settling(break, (active, Nil)) shouldBe (active, Nil)
    }

    "asks no lot once the lineup is frozen: the final knows its lots from the journal" in {
      val frozen = auctionIn(AuctionState.LineupFrozen(config(), op(3), List(first)))
      LotRoster.survey(frozen) shouldBe (LotRoster.empty, Nil)
      val final_ = auctionIn(AuctionState.Final(config(), op(3), List(first), Nil))
      LotRoster.survey(final_) shouldBe (LotRoster.empty, Nil)
    }

    "derives the op_id of the resume and of its own steps so that they stay the same after any restart" in {
      LotRoster.resumeOf(op(3), first) shouldBe LotRoster.resumeOf(op(3), first)
      LotRoster.resumeOf(op(3), first) should not be LotRoster.resumeOf(op(3), second)
      LotRoster.resumeOf(op(3), first).opId should not be LotRoster.closeOpId(op(3), first)
      LotRoster.stepOpId(op(3), "prebidding-deadline") shouldBe LotRoster.stepOpId(op(3), "prebidding-deadline")
      LotRoster.stepOpId(op(3), "prebidding-deadline") should not be LotRoster.stepOpId(op(3), "prebidding-ended")
    }

    "withdraws every lot of the registry of a cancelled auction with an op_id of the cancel and the lot" in {
      val cancelled = auctionIn(AuctionState.Cancelled(config(), op(3), op(9)))
      val (roster, instructions) = LotRoster.survey(cancelled)
      roster.lots shouldBe Map(first -> LotStanding.Withdrawing, second -> LotStanding.Withdrawing)
      instructions should contain theSameElementsAs List(
        LotInstruction.Withdraw(first, LotRoster.withdrawalOf(op(9), first)),
        LotInstruction.Withdraw(second, LotRoster.withdrawalOf(op(9), second))
      )
      LotRoster.withdrawalOf(op(9), first).reason shouldBe WithdrawnReason.AuctionCancelled
      LotRoster.withdrawalOf(op(9), first) shouldBe LotRoster.withdrawalOf(op(9), first)
      LotRoster.withdrawalOf(op(9), first).opId should not be LotRoster.withdrawalOf(op(9), second).opId
      LotRoster.withdrawalOf(op(9), first).opId should not be LotRoster.closeOpId(op(9), first)
    }

    "starts the withdrawal over the knowledge of the prebidding and sends no opening or closing after it" in {
      val cancelled = auctionIn(AuctionState.Cancelled(config(), op(3), op(9)))
      val (roster, instructions) =
        LotRoster.cancelled(cancelled, closing, AuctionDecision.Accepted(AuctionEvent.AuctionCancelled))
      roster.lots.values.toSet shouldBe Set(LotStanding.Withdrawing)
      instructions.collect { case withdraw: LotInstruction.Withdraw => withdraw.lot }.toSet shouldBe Set(first, second)
      LotRoster.observed(cancelled, roster, first, LotFixtures.scheduled().state) shouldBe (roster, Nil)
      LotRoster.opened(cancelled, roster, first, Right(Some(closesAt))) shouldBe (roster, Nil)
      LotRoster.due(cancelled, roster, first) shouldBe (roster, Nil)
      LotRoster.closed(cancelled, roster, first, Right(Closure.Closed)) shouldBe (roster, Nil)
    }

    "counts a withdrawn lot and one that answered it had already ended as settled" in {
      val cancelled = auctionIn(AuctionState.Cancelled(config(), op(3), op(9)))
      val withdrawing = LotRoster.survey(cancelled)._1
      val answered = LotRoster.withdrawn(
        LotRoster.withdrawn(withdrawing, first, Right(())),
        second,
        Left(WithdrawLotRejected.LotAlreadyClosed)
      )
      answered.lots shouldBe Map(first -> LotStanding.Withdrawn, second -> LotStanding.Closed)
      answered.lots.values.forall(_.settled) shouldBe true
      LotRoster.withdrawn(answered, first, Left(WithdrawLotRejected.LotAlreadyClosed)) shouldBe answered
    }

    "withdraws again on a recheck exactly the lots whose answer did not come" in {
      val cancelled = auctionIn(AuctionState.Cancelled(config(), op(3), op(9)))
      val withdrawing = LotRoster.survey(cancelled)._1
      val silent = LotRoster.unanswered(LotRoster.withdrawn(withdrawing, first, Right(())), second)
      silent.lots(second) shouldBe LotStanding.Unanswered
      LotRoster.recheck(cancelled, silent) shouldBe (
        silent.copy(lots = silent.lots.updated(second, LotStanding.Withdrawing)),
        List(LotInstruction.Withdraw(second, LotRoster.withdrawalOf(op(9), second)))
      )
    }

    "withdraws the unanswered lots again on a repeat of the cancel itself, not of another command or cancel" in {
      val cancelled = auctionIn(AuctionState.Cancelled(config(), op(3), op(9)))
      val silent = LotRoster.unanswered(LotRoster.withdrawn(LotRoster.survey(cancelled)._1, first, Right(())), second)
      val repeated = AuctionDecision.Repeated(AuctionEnvelope(6, op(9), AuctionEvent.AuctionCancelled))
      LotRoster.cancelled(cancelled, silent, repeated)._2 shouldBe
        List(LotInstruction.Withdraw(second, LotRoster.withdrawalOf(op(9), second)))
      val other = AuctionDecision.Repeated(AuctionEnvelope(5, op(3), AuctionEvent.PrebiddingStarted))
      LotRoster.cancelled(cancelled, silent, other) shouldBe (silent, Nil)
      LotRoster.cancelled(cancelled, silent, AuctionDecision.Unchanged) shouldBe (silent, Nil)
    }
  }
}
