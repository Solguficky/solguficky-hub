package auction.aggregate

import auction.aggregate.AuctionFixtures.*
import auction.catalog.LotId
import auction.lot.LotFixtures
import auction.lot.LotFixtures.op
import auction.lot.LotFixtures.participant
import auction.lot.LotState
import auction.lot.OpenLot
import auction.lot.OpenLotRejected
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
      val led = auctionIn(AuctionState.Prebidding(config(byAuctioneer), op(3)))
      LotRoster.observed(led, asked, first, LotFixtures.scheduled().state)._2 shouldBe
        List(LotInstruction.Open(first, OpenLot(None, op(3))))
    }

    "counts a lot that is already trading active without opening it again" in {
      val (roster, instructions) = LotRoster.observed(prebidding, asked, first, LotFixtures.trading(price = 100).state)
      roster.active shouldBe Set(first)
      instructions shouldBe empty
    }

    "does not count a held or a sold lot active and does not open it" in {
      val held = LotRoster.observed(prebidding, asked, first, LotFixtures.held(100, participant(1)).state)
      held._1.lots(first) shouldBe LotStanding.Held
      val sold = LotRoster.observed(prebidding, asked, first, LotFixtures.sold(100, participant(1)).state)
      sold._1.lots(first) shouldBe LotStanding.Closed
      held._2 ++ sold._2 shouldBe empty
    }

    "counts a lot active only after it confirmed the opening" in {
      LotRoster.opened(opening(first), first, Right(())).active shouldBe Set(first)
    }

    "leaves a lot that refused the opening inactive and the other lots untouched" in {
      val refused = LotRoster.opened(opening(first), first, Left(OpenLotRejected.LotNotScheduled))
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
      val refused = LotRoster.opened(opening(first), first, Left(OpenLotRejected.LotNotScheduled))
      val active = LotRoster.observed(prebidding, refused, second, LotFixtures.trading(price = 100).state)._1
      LotRoster.resume(prebidding, active) shouldBe (active, Nil)
    }

    "ignores an answer it is not waiting for" in {
      val active = LotRoster.observed(prebidding, asked, first, LotFixtures.trading(price = 100).state)._1
      // Опоздавшее наблюдение «не открыт» подтверждённый лот не понижает и второго `OpenLot` не вызывает.
      LotRoster.observed(prebidding, active, first, LotFixtures.scheduled().state) shouldBe (active, Nil)
      LotRoster.opened(active, first, Left(OpenLotRejected.LotNotScheduled)) shouldBe active
      LotRoster.unanswered(active, first) shouldBe active
      LotRoster.opened(asked, first, Right(())) shouldBe asked
    }
  }
}
