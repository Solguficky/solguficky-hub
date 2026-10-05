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
      val (roster, instructions) = LotRoster.opened(opening(first), first, Right(Some(closesAt)))
      roster.active shouldBe Set(first)
      instructions shouldBe List(LotInstruction.Arm(first, closesAt))
      LotRoster.opened(opening(first), first, Right(None))._2 shouldBe empty
    }

    "leaves a lot that refused the opening inactive and the other lots untouched" in {
      val (refused, instructions) = LotRoster.opened(opening(first), first, Left(OpenLotRejected.LotNotScheduled))
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
      val refused = LotRoster.opened(opening(first), first, Left(OpenLotRejected.LotNotScheduled))._1
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
      LotRoster.opened(active, first, Left(OpenLotRejected.LotNotScheduled)) shouldBe (active, Nil)
      LotRoster.unanswered(active, first) shouldBe active
      LotRoster.opened(asked, first, Right(Some(closesAt))) shouldBe (asked, Nil)
      LotRoster.closed(active, first, Right(())) shouldBe (active, Nil)
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
      val (roster, instructions) = LotRoster.closed(closing, first, Right(()))
      roster.lots(first) shouldBe LotStanding.Closed
      instructions shouldBe empty
    }

    "asks a lot that refused the closing for its state instead of guessing why" in {
      for (refusal <- List(CloseLotRejected.DeadlineNotReached, CloseLotRejected.LotNotOpen)) {
        val (roster, instructions) = LotRoster.closed(closing, first, Left(refusal))
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
  }
}
