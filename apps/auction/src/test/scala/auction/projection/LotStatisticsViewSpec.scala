package auction.projection

import auction.lot.CurrencyCode
import auction.lot.LotFixtures.*
import auction.lot.LotState
import auction.lot.Money
import auction.lot.UnsoldReason
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

import java.util.UUID

final class LotStatisticsViewSpec extends AnyWordSpec with Matchers {

  private def growth(lot: auction.lot.Lot, start: Option[Long]): Option[Money] =
    LotStatisticsView(new UUID(9L, 9L), lot, start.map(money), 0, 0, None).priceGrowth

  private def finalGrowth(lot: auction.lot.Lot, held: Option[Long]): Option[Money] =
    LotStatisticsView(new UUID(9L, 9L), lot, None, 0, 0, None, held.map(money)).finalGrowth

  "price growth" should {

    "is absent for a lot without trading conditions" in {
      growth(drafted, None) shouldBe None
    }

    "is zero for a scheduled lot whose conditions name the starting price" in {
      growth(scheduled(startingPrice = 300), None) shouldBe Some(money(0))
    }

    "is zero for a trading lot before the first bid" in {
      growth(trading(price = 300), Some(300)) shouldBe Some(money(0))
    }

    "is the current price minus the starting price of a trading lot" in {
      growth(trading(price = 450), Some(300)) shouldBe Some(money(150))
    }

    "stays defined when the lot opened at a zero starting price" in {
      growth(trading(price = 40), Some(0)) shouldBe Some(money(40))
    }

    "is the price of the sale minus the starting price of a sold lot" in {
      growth(sold(price = 700, winner = participant(1)), Some(300)) shouldBe Some(money(400))
    }

    "is the current price minus the starting price of a lot held for the final" in {
      growth(held(price = 500, leader = participant(1)), Some(300)) shouldBe Some(money(200))
    }

    "is zero for a lot closed without bids" in {
      growth(lotIn(LotState.Unsold(UnsoldReason.NoBids)), Some(300)) shouldBe Some(money(0))
    }

    "is absent for an opened lot whose starting price the read model does not know" in {
      growth(trading(price = 450), None) shouldBe None
    }

    "refuses a starting price in another currency than the lot" in {
      an[IllegalStateException] should be thrownBy
        LotStatisticsView(
          new UUID(9L, 9L),
          trading(price = 450),
          Some(Money(300, CurrencyCode("EUR"))),
          0,
          0,
          None
        ).priceGrowth
    }
  }

  "final growth" should {

    "is absent for a lot outside the lineup" in {
      val outside =
        LotStatisticsView(new UUID(9L, 9L), sold(price = 700, winner = participant(1)), None, 0, 0, None)
      outside.finalGrowth shouldBe None
      outside.finalBidCount shouldBe None
    }

    "is the price of the sale minus the price the lot was held at" in {
      finalGrowth(sold(price = 700, winner = participant(1)), Some(500)) shouldBe Some(money(200))
    }

    "is zero for a lot without bids in the final" in {
      finalGrowth(held(price = 500, leader = participant(1)), Some(500)) shouldBe Some(money(0))
      finalGrowth(sold(price = 500, winner = participant(1)), Some(500)) shouldBe Some(money(0))
    }

    "is zero for a lineup lot closed without a sale" in {
      finalGrowth(lotIn(LotState.Unsold(UnsoldReason.NoBids)), Some(500)) shouldBe Some(money(0))
    }

    "is the current price minus the hold price of a lot returned to trading" in {
      finalGrowth(trading(price = 620), Some(500)) shouldBe Some(money(120))
    }
  }
}
