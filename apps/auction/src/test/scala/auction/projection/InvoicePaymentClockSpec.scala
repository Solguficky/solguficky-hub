package auction.projection

import auction.aggregate.*
import auction.aggregate.AuctionFixtures.*
import auction.lot.LotFixtures.op
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec
import java.time.Duration

final class InvoicePaymentClockSpec extends AnyWordSpec with Matchers {
  "the payment clock" should {
    "starts only when the entire auction ends, including an auction without a final" in {
      InvoicePaymentClock.ended(AuctionEvent.PrebiddingDeadlineReached) shouldBe false
      InvoicePaymentClock.ended(AuctionEvent.PrebiddingEnded(false)) shouldBe false
      InvoicePaymentClock.ended(AuctionEvent.FinalStarted) shouldBe false
      InvoicePaymentClock.ended(AuctionEvent.AuctionFinished) shouldBe true
      InvoicePaymentClock.ended(AuctionEvent.PrebiddingEnded(true)) shouldBe true
      InvoicePaymentClock.ended(AuctionEvent.AuctionCancelled) shouldBe true
    }

    "gives every sale the same deadline from the actual end and the configured term" in {
      val auction = Auction.initial.copy(state =
        AuctionState.Finished(config(configInput().copy(paymentTerm = Some(Duration.ofDays(1)))), op(1))
      )
      val endedAt = closesAt.plus(Duration.ofDays(1))
      InvoicePaymentClock.deadline(auction, endedAt) shouldBe endedAt.plus(Duration.ofDays(1))
    }
  }
}
