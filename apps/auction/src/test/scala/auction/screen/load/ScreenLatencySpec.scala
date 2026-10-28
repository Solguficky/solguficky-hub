package auction.screen.load

import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

final class ScreenLatencySpec extends AnyWordSpec with Matchers {

  "applied" should {

    "takes the first price at or above the bid after it was sent" in {
      val bid = BidMark(amount = 500, sentAt = 1000, answeredAt = 1040)
      val seen = Seq(Seen(900, 600), Seen(1010, 400), Seen(1050, 500), Seen(1060, 700))
      ScreenLatency.applied(bid, seen) shouldBe Some(1050)
    }

    "counts a bid the viewer skipped once a higher price arrives" in {
      val bid = BidMark(amount = 500, sentAt = 1000, answeredAt = 1040)
      ScreenLatency.applied(bid, Seq(Seen(1010, 400), Seen(1200, 800))) shouldBe Some(1200)
    }

    "leaves a bid the viewer never reached unapplied" in {
      ScreenLatency.applied(BidMark(500, 1000, 1040), Seq(Seen(1010, 400))) shouldBe None
    }
  }

  "delays" should {

    "measures each bid from the send and from the answer and counts the missed ones" in {
      val bids = Seq(BidMark(500, 1000, 1040), BidMark(800, 2000, 2030), BidMark(900, 3000, 3020))
      val seen = Seq(Seen(2100, 800), Seen(1100, 500))
      val (delays, missed) = ScreenLatency.delays(bids, seen)
      delays shouldBe Vector(Delay(100, 60), Delay(100, 70))
      missed shouldBe 1
    }
  }

  "percentile" should {

    "returns the nearest-rank value" in {
      val values = (1L to 100L).reverse
      ScreenLatency.percentile(values, 0.95) shouldBe Some(95)
      ScreenLatency.percentile(values, 0.5) shouldBe Some(50)
      ScreenLatency.percentile(Seq(7L), 0.95) shouldBe Some(7)
      ScreenLatency.percentile(Seq.empty, 0.95) shouldBe None
    }
  }

  "pagePrice" should {

    "reads whole roubles and kopecks as the page writes them" in {
      ScreenLatency.pagePrice("1 234 ₽") shouldBe Some(123400)
      ScreenLatency.pagePrice("1 234,50 ₽") shouldBe Some(123450)
      ScreenLatency.pagePrice("—") shouldBe None
    }
  }

  "retryDelay" should {

    "doubles up to thirty seconds and adds up to half of the pause" in {
      ScreenLatency.retryDelay(0, 0) shouldBe 1000
      ScreenLatency.retryDelay(3, 0) shouldBe 8000
      ScreenLatency.retryDelay(3, 0.999) shouldBe 11996
      ScreenLatency.retryDelay(40, 0) shouldBe 30000
    }
  }

  "gaps" should {

    "measures the pauses between moments in time order" in {
      ScreenLatency.gaps(Seq(4000L, 0L, 1000L)) shouldBe Vector(1000L, 3000L)
      ScreenLatency.gaps(Seq(5L)) shouldBe empty
    }
  }
}
