package auction.entity

import auction.catalog.CardStanding
import auction.lot.LotFixtures.*
import auction.lot.LotState
import auction.lot.UnsoldReason
import auction.lot.WithdrawnReason
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

final class LotCardGateSpec extends AnyWordSpec with Matchers {

  "lot card gate" should {

    "closes the card of a sold lot and of a lot closed without a sale" in {
      LotCardGate.standing(sold(100, participant(1)).state) shouldBe CardStanding.Closed
      LotCardGate.standing(LotState.Unsold(UnsoldReason.NoBids)) shouldBe CardStanding.Closed
    }

    "leaves the card open before it is closed and after a withdrawal" in {
      LotCardGate.standing(LotState.Initial) shouldBe CardStanding.Open
      LotCardGate.standing(drafted.state) shouldBe CardStanding.Open
      LotCardGate.standing(scheduled().state) shouldBe CardStanding.Open
      LotCardGate.standing(trading(100).state) shouldBe CardStanding.Open
      LotCardGate.standing(held(100, participant(1)).state) shouldBe CardStanding.Open
      LotCardGate.standing(LotState.Withdrawn(WithdrawnReason.AuctionCancelled)) shouldBe CardStanding.Open
    }
  }
}
