package auction.entity

import auction.entity.JournalFixtures.lotScheduled
import auction.entity.JournalFixtures.opened
import auction.lot.CloseLotRejected
import auction.lot.Envelope
import auction.lot.LotEvent
import auction.lot.LotFixtures.bid
import auction.lot.LotFixtures.deadline
import auction.lot.LotFixtures.money
import auction.lot.LotFixtures.op
import auction.lot.LotFixtures.participant
import auction.lot.OpenLotRejected
import auction.lot.UnsoldReason
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

import scala.util.Success

final class AuctionLotsSpec extends AnyWordSpec with Matchers {

  "confirmation of an opening" should {

    "takes the envelope of an opened lot as the confirmation with the deadline the lot opened with" in {
      AuctionLots.confirmation(Right(Envelope(3, op(3), opened))) shouldBe Success(Right(Some(deadline)))
      AuctionLots.confirmation(Right(Envelope(3, op(3), opened.copy(deadline = None)))) shouldBe Success(Right(None))
    }

    "passes a refusal of the lot through as a refusal" in {
      AuctionLots.confirmation(Left(OpenLotRejected.LotNotScheduled)) shouldBe
        Success(Left(OpenLotRejected.LotNotScheduled))
    }

    "does not take the envelope of another event under the same op_id for an opening" in {
      AuctionLots.confirmation(Right(Envelope(2, op(3), lotScheduled))).isFailure shouldBe true
    }
  }

  "confirmation of a closing" should {

    "takes the envelope of a sold or an unsold lot as the confirmation" in {
      val sold = LotEvent.LotSold(participant(2), money(500), bid(1), deadline)
      AuctionLots.closure(Right(Envelope(5, op(9), sold))) shouldBe Success(Right(()))
      AuctionLots.closure(Right(Envelope(5, op(9), LotEvent.LotUnsold(UnsoldReason.NoBids)))) shouldBe
        Success(Right(()))
    }

    "passes a refusal of the lot through as a refusal" in {
      AuctionLots.closure(Left(CloseLotRejected.DeadlineNotReached)) shouldBe
        Success(Left(CloseLotRejected.DeadlineNotReached))
    }

    "does not take the envelope of another event under the same op_id for a closing" in {
      AuctionLots.closure(Right(Envelope(3, op(9), opened))).isFailure shouldBe true
    }
  }
}
