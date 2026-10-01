package auction.grpc

import auction.catalog.CatalogRefusal
import auction.catalog.LotCard
import auction.catalog.LotId
import auction.catalog.LotTitle
import auction.lot.BidOrigin
import auction.lot.BidSource
import auction.lot.Envelope
import auction.lot.LotEvent
import auction.lot.LotFixtures.*
import auction.lot.PlaceBidRejected
import auction.v1.auction.Money as MoneyMessage
import auction.v1.auction_service as wire
import io.grpc.Status
import org.scalatest.EitherValues
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

import java.util.UUID

final class ResponseMappingSpec extends AnyWordSpec with Matchers with EitherValues {

  private def refused(rejected: PlaceBidRejected): wire.PlaceBidRefusal.Reason =
    ResponseMapping.placeBid(Left(rejected)).value.getRefused.reason

  "response mapping" should {

    "answers an accepted bid with the id of the placed bid" in {
      val placed = LotEvent.BidPlaced(bid(7), participant(1), money(150), None, BidOrigin.Manual, BidSource.Bot)
      val response = ResponseMapping.placeBid(Right(Envelope(4, op(1), placed))).value
      response.getAccepted.bidId shouldBe bid(7).value.toString
    }

    "carries the minimum price in a below-minimum refusal" in {
      refused(PlaceBidRejected.BidBelowMinimum(money(110))) shouldBe
        wire.PlaceBidRefusal.Reason.BidBelowMinimum(wire.BidBelowMinimum(Some(MoneyMessage(110, "RUB"))))
    }

    "carries the expected price in a not-at-next-price refusal" in {
      refused(PlaceBidRejected.BidNotAtNextPrice(money(120))).bidNotAtNextPrice.flatMap(_.expected) shouldBe
        Some(MoneyMessage(120, "RUB"))
    }

    "answers every named refusal of a bid as a value of the response" in {
      refused(PlaceBidRejected.LotNotOpen).isLotNotOpen shouldBe true
      refused(PlaceBidRejected.LotOnHold).isLotOnHold shouldBe true
      refused(PlaceBidRejected.CurrencyMismatch).isCurrencyMismatch shouldBe true
      refused(PlaceBidRejected.BidderIsLeader).isBidderIsLeader shouldBe true
    }

    "answers a bid to a lot that does not exist with NOT_FOUND rather than a refusal" in {
      ResponseMapping.placeBid(Left(PlaceBidRejected.LotNotFound)).left.value.getCode shouldBe Status.Code.NOT_FOUND
    }

    "answers catalog commands with the stored card or a named refusal" in {
      val card = LotCard(LotId(UUID.randomUUID()), LotTitle("Лот").value, "описание")
      ResponseMapping.createLotCard(Right(card)).getAccepted shouldBe wire.LotCard("Лот", "описание")
      ResponseMapping.createLotCard(Left(CatalogRefusal.NotAdmin)).getRefused.reason.isNotAdmin shouldBe true
      ResponseMapping.createLotCard(Left(CatalogRefusal.CardConflict)).getRefused.reason.isCardConflict shouldBe true
      ResponseMapping.editLotCard(Left(CatalogRefusal.EmptyTitle)).getRefused.reason.isEmptyTitle shouldBe true
      ResponseMapping.editLotCard(Left(CatalogRefusal.CardNotFound)).getRefused.reason.isCardNotFound shouldBe true
    }
  }
}
