package auction.grpc

import auction.aggregate.ConfigInvalid
import auction.aggregate.Denial
import auction.aggregate.DiscardRefusal
import auction.aggregate.LotSchedulingRefusal
import auction.aggregate.OpeningRefusal
import auction.aggregate.SchedulingRefusal
import auction.catalog.CatalogRefusal
import auction.catalog.ImageVersion
import auction.catalog.LotCard
import auction.catalog.LotId
import auction.catalog.LotTitle
import auction.lot.BidOrigin
import auction.lot.BidSource
import auction.lot.Envelope
import auction.lot.LotEvent
import auction.lot.LotFixtures.*
import auction.lot.PlaceBidRejected
import auction.lot.ScheduleLotRejected
import auction.lot.SetProxyLimitRejected
import auction.lot.StepPolicyInvalid
import auction.lot.WithdrawProxyLimitRejected
import auction.projection.LotImageView
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
      val placed = LotEvent.BidPlaced(bid(7), participant(1), money(150), None, BidOrigin.Manual(BidSource.Bot))
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
      refused(PlaceBidRejected.LotOnHold(money(300))).isLotOnHold shouldBe true
      refused(PlaceBidRejected.CurrencyMismatch).isCurrencyMismatch shouldBe true
      refused(PlaceBidRejected.BidderIsLeader(money(110))).isBidderIsLeader shouldBe true
    }

    "carries the current price in on-hold and leader refusals and the lowest limit in a low-limit refusal" in {
      refused(PlaceBidRejected.LotOnHold(money(300))).lotOnHold.flatMap(_.currentPrice) shouldBe
        Some(MoneyMessage(300, "RUB"))
      refused(PlaceBidRejected.BidderIsLeader(money(110))).bidderIsLeader.flatMap(_.currentPrice) shouldBe
        Some(MoneyMessage(110, "RUB"))
      ResponseMapping
        .setProxyLimit(Left(SetProxyLimitRejected.ProxyBelowCurrentPrice(money(150))))
        .value
        .getRefused
        .reason
        .proxyBelowCurrentPrice
        .flatMap(_.minLimit) shouldBe Some(MoneyMessage(150, "RUB"))
    }

    "answers a bid to a lot that does not exist with NOT_FOUND rather than a refusal" in {
      ResponseMapping.placeBid(Left(PlaceBidRejected.LotNotFound)).left.value.getCode shouldBe Status.Code.NOT_FOUND
    }

    "answers an accepted proxy limit and its withdrawal without data and every refusal as a value" in {
      val set = LotEvent.ProxyLimitSet(participant(1), money(200))
      ResponseMapping.setProxyLimit(Right(Envelope(5, op(1), set))).value.outcome.isAccepted shouldBe true
      val withdrawn = LotEvent.ProxyLimitWithdrawn(participant(1))
      ResponseMapping.withdrawProxyLimit(Right(Envelope(6, op(2), withdrawn))).value.outcome.isAccepted shouldBe true
      def limitRefused(rejected: SetProxyLimitRejected) =
        ResponseMapping.setProxyLimit(Left(rejected)).value.getRefused.reason
      limitRefused(SetProxyLimitRejected.LotNotOpen).isLotNotOpen shouldBe true
      limitRefused(SetProxyLimitRejected.ProxyBelowCurrentPrice(money(150))).isProxyBelowCurrentPrice shouldBe true
      limitRefused(SetProxyLimitRejected.ProxyDisabledForLot).isProxyDisabledForLot shouldBe true
      limitRefused(SetProxyLimitRejected.CurrencyMismatch).isCurrencyMismatch shouldBe true
      ResponseMapping
        .withdrawProxyLimit(Left(WithdrawProxyLimitRejected.NoActiveProxyLimit))
        .value
        .getRefused
        .reason
        .isNoActiveProxyLimit shouldBe true
    }

    "answers a proxy command to a lot that does not exist with NOT_FOUND rather than a refusal" in {
      ResponseMapping.setProxyLimit(Left(SetProxyLimitRejected.LotNotFound)).left.value.getCode shouldBe
        Status.Code.NOT_FOUND
      ResponseMapping.withdrawProxyLimit(Left(WithdrawProxyLimitRejected.LotNotFound)).left.value.getCode shouldBe
        Status.Code.NOT_FOUND
    }

    "answers an op_id taken by another command with ALREADY_EXISTS rather than a refusal or a bid_id" in {
      ResponseMapping.placeBid(Left(PlaceBidRejected.OpIdTaken)).left.value.getCode shouldBe
        Status.Code.ALREADY_EXISTS
      ResponseMapping.setProxyLimit(Left(SetProxyLimitRejected.OpIdTaken)).left.value.getCode shouldBe
        Status.Code.ALREADY_EXISTS
      ResponseMapping.withdrawProxyLimit(Left(WithdrawProxyLimitRejected.OpIdTaken)).left.value.getCode shouldBe
        Status.Code.ALREADY_EXISTS
    }

    "answers catalog commands with the stored card or a named refusal" in {
      val card = LotCard(LotId(UUID.randomUUID()), LotTitle("Лот").value, "описание", None)
      ResponseMapping.createLotCard(Right(card)).getAccepted shouldBe wire.LotCard("Лот", "описание")
      ResponseMapping.createLotCard(Left(CatalogRefusal.NotAdmin)).getRefused.reason.isNotAdmin shouldBe true
      ResponseMapping.createLotCard(Left(CatalogRefusal.CardConflict)).getRefused.reason.isCardConflict shouldBe true
      ResponseMapping.editLotCard(Left(CatalogRefusal.EmptyTitle)).getRefused.reason.isEmptyTitle shouldBe true
      ResponseMapping.editLotCard(Left(CatalogRefusal.CardNotFound)).getRefused.reason.isCardNotFound shouldBe true
    }

    "answers an accepted card with the version of its image and without the bytes" in {
      val card = LotCard(LotId(UUID.randomUUID()), LotTitle("Лот").value, "", Some(ImageVersion("v1")))
      ResponseMapping.editLotCard(Right(card)).getAccepted.image shouldBe Some(wire.LotImageRef("v1"))
    }

    "carries the limit in an image-too-large refusal of both catalog commands" in {
      val tooLarge = Left(CatalogRefusal.ImageTooLarge(2048))
      ResponseMapping.createLotCard(tooLarge).getRefused.reason.imageTooLarge shouldBe Some(wire.ImageTooLarge(2048))
      ResponseMapping.editLotCard(tooLarge).getRefused.reason.imageTooLarge shouldBe Some(wire.ImageTooLarge(2048))
      ResponseMapping
        .createLotCard(Left(CatalogRefusal.UnsupportedImage))
        .getRefused
        .reason
        .isUnsupportedImage shouldBe true
      ResponseMapping.editLotCard(Left(CatalogRefusal.UnsupportedImage)).getRefused.reason.isUnsupportedImage shouldBe
        true
    }

    "answers accepted conditions of a lot without data and every refusal of the right, the auction and the lot as a value" in {
      def reason(refusal: LotSchedulingRefusal): wire.ScheduleLotRefusal.Reason =
        ResponseMapping.scheduleLot(Left(refusal)).value.getRefused.reason
      ResponseMapping.scheduleLot(Right(())).value.outcome.isAccepted shouldBe true
      reason(LotSchedulingRefusal.Denied(Denial.NotAdministrator)).isNotMeetupAdministrator shouldBe true
      reason(LotSchedulingRefusal.Denied(Denial.MeetupNotFound)).isMeetupNotFound shouldBe true
      reason(LotSchedulingRefusal.Denied(Denial.LotsFrozen)).isLotsFrozen shouldBe true
      reason(LotSchedulingRefusal.LotNotInAuction).isLotNotInAuction shouldBe true
      reason(LotSchedulingRefusal.ByLot(ScheduleLotRejected.SchedulingClosed)).isSchedulingClosed shouldBe true
      reason(
        LotSchedulingRefusal.ByLot(ScheduleLotRejected.StepPolicyInvalid(StepPolicyInvalid.StepNotPositive))
      ).isStepPolicyInvalid shouldBe true
      reason(LotSchedulingRefusal.ByLot(ScheduleLotRejected.CurrencyMismatch)).isCurrencyMismatch shouldBe true
    }

    "answers conditions of a lot with a status when the refusal is not a decision to show" in {
      def code(refusal: LotSchedulingRefusal): Status.Code =
        ResponseMapping.scheduleLot(Left(refusal)).left.value.getCode
      code(LotSchedulingRefusal.Denied(Denial.Unavailable)) shouldBe Status.Code.UNAVAILABLE
      code(LotSchedulingRefusal.Denied(Denial.AuctionNotFound)) shouldBe Status.Code.NOT_FOUND
      code(LotSchedulingRefusal.ByLot(ScheduleLotRejected.OpIdTaken)) shouldBe Status.Code.ALREADY_EXISTS
    }

    "answers a scheduled auction without data and every refusal of the right and of the configuration as a value" in {
      def reason(refusal: SchedulingRefusal): wire.ScheduleAuctionRefusal.Reason =
        ResponseMapping.scheduleAuction(Left(refusal)).value.getRefused.reason
      def invalid(reason: ConfigInvalid): wire.ConfigInvalid.Reason =
        ResponseMapping
          .scheduleAuction(Left(SchedulingRefusal.ConfigInvalid(reason)))
          .value
          .getRefused
          .getConfigInvalid
          .reason
      ResponseMapping.scheduleAuction(Right(())).value.outcome.isAccepted shouldBe true
      reason(SchedulingRefusal.Denied(Denial.NotAdministrator)).isNotMeetupAdministrator shouldBe true
      reason(SchedulingRefusal.Denied(Denial.MeetupNotFound)).isMeetupNotFound shouldBe true
      reason(SchedulingRefusal.AuctionAlreadyStarted).isAuctionAlreadyStarted shouldBe true
      invalid(ConfigInvalid.ClosesAtMissing).isClosesAtMissing shouldBe true
      invalid(ConfigInvalid.ClosesAtNotAfterOpensAt).isClosesAtNotAfterOpensAt shouldBe true
      invalid(ConfigInvalid.FinalBlocksOutOfRange).isFinalBlocksOutOfRange shouldBe true
      invalid(ConfigInvalid.LotDefaults(StepPolicyInvalid.StepNotPositive)).isLotDefaultsStepPolicyInvalid shouldBe true
      invalid(ConfigInvalid.StepWindowWithoutClosesAt(0)).stepWindowWithoutClosesAt shouldBe
        Some(wire.StepWindowWithoutClosesAt(0))
      invalid(ConfigInvalid.StepWindowOutsideOnlinePhase(2)).stepWindowOutsideOnlinePhase shouldBe
        Some(wire.StepWindowOutsideOnlinePhase(2))
      invalid(ConfigInvalid.StepWindowsOverlap(1, 3)).stepWindowsOverlap shouldBe Some(wire.StepWindowsOverlap(1, 3))
      invalid(ConfigInvalid.StepWindowStepInvalid(1)).stepWindowStepInvalid shouldBe Some(wire.StepWindowStepInvalid(1))
      invalid(ConfigInvalid.StepWindowLotsEmpty(4)).stepWindowLotsEmpty shouldBe Some(wire.StepWindowLotsEmpty(4))
    }

    "answers a started prebidding without data and every refusal of the right and of the state as a value" in {
      def reason(refusal: OpeningRefusal): wire.StartPrebiddingRefusal.Reason =
        ResponseMapping.startPrebidding(Left(refusal)).value.getRefused.reason
      ResponseMapping.startPrebidding(Right(())).value.outcome.isAccepted shouldBe true
      reason(OpeningRefusal.Denied(Denial.NotAdministrator)).isNotMeetupAdministrator shouldBe true
      reason(OpeningRefusal.Denied(Denial.MeetupNotFound)).isMeetupNotFound shouldBe true
      reason(OpeningRefusal.AuctionNotScheduled).isAuctionNotScheduled shouldBe true
    }

    "answers a discard without data and every refusal of the right and of the state as a value" in {
      def reason(refusal: DiscardRefusal): wire.DiscardAuctionRefusal.Reason =
        ResponseMapping.discardAuction(Left(refusal)).value.getRefused.reason
      ResponseMapping.discardAuction(Right(())).value.outcome.isAccepted shouldBe true
      reason(DiscardRefusal.Denied(Denial.NotAdministrator)).isNotMeetupAdministrator shouldBe true
      reason(DiscardRefusal.Denied(Denial.MeetupNotFound)).isMeetupNotFound shouldBe true
      reason(DiscardRefusal.AuctionAlreadyStarted).isAuctionAlreadyStarted shouldBe true
      ResponseMapping.discardAuction(Left(DiscardRefusal.Denied(Denial.Unavailable))).left.value.getCode shouldBe
        Status.Code.UNAVAILABLE
      ResponseMapping.discardAuction(Left(DiscardRefusal.Denied(Denial.AuctionNotFound))).left.value.getCode shouldBe
        Status.Code.NOT_FOUND
    }

    "answers auction commands with a status when the authority is unavailable or the auction does not exist" in {
      ResponseMapping.scheduleAuction(Left(SchedulingRefusal.Denied(Denial.Unavailable))).left.value.getCode shouldBe
        Status.Code.UNAVAILABLE
      ResponseMapping
        .scheduleAuction(Left(SchedulingRefusal.Denied(Denial.AuctionNotFound)))
        .left
        .value
        .getCode shouldBe
        Status.Code.NOT_FOUND
      ResponseMapping.startPrebidding(Left(OpeningRefusal.Denied(Denial.Unavailable))).left.value.getCode shouldBe
        Status.Code.UNAVAILABLE
      ResponseMapping.startPrebidding(Left(OpeningRefusal.Denied(Denial.AuctionNotFound))).left.value.getCode shouldBe
        Status.Code.NOT_FOUND
    }

    "answers an image read with the stored bytes, their type and their own version" in {
      val bytes = Array[Byte](0xff.toByte, 0xd8.toByte, 0xff.toByte, 1)
      val image = ResponseMapping.lotImage(LotImageView(IArray.from(bytes), "image/jpeg", "v2"))
      image.content.toByteArray shouldBe bytes
      image.mediaType shouldBe "image/jpeg"
      image.version shouldBe "v2"
    }
  }
}
