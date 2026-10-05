package auction.entity

import auction.entity.JournalFixtures.lotScheduled
import auction.entity.JournalFixtures.opened
import auction.lot.Envelope
import auction.lot.LotFixtures.op
import auction.lot.OpenLotRejected
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

import scala.util.Success

final class AuctionLotsSpec extends AnyWordSpec with Matchers {

  "confirmation of an opening" should {

    "takes the envelope of an opened lot as the confirmation" in {
      AuctionLots.confirmation(Right(Envelope(3, op(3), opened))) shouldBe Success(Right(()))
    }

    "passes a refusal of the lot through as a refusal" in {
      AuctionLots.confirmation(Left(OpenLotRejected.LotNotScheduled)) shouldBe
        Success(Left(OpenLotRejected.LotNotScheduled))
    }

    "does not take the envelope of another event under the same op_id for an opening" in {
      AuctionLots.confirmation(Right(Envelope(2, op(3), lotScheduled))).isFailure shouldBe true
    }
  }
}
