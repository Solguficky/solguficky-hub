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
}
