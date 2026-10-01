package auction.grpc

import auction.access.GlobalRole
import auction.lot.BidSource
import auction.lot.CurrencyCode
import auction.lot.Money
import auction.v1.auction.Money as MoneyMessage
import auction.v1.auction_service.PlaceBidRequest
import auction.v1.auction_service.SetProxyLimitRequest
import auction.v1.auction_service.WithdrawProxyLimitRequest
import auction.v1.auction_service.Viewer as ViewerMessage
import identity.v1.roles.GlobalRole as GlobalRoleMessage
import org.scalatest.EitherValues
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

import java.util.UUID

final class RequestMappingSpec extends AnyWordSpec with Matchers with EitherValues {

  import RequestMappingSpec.*

  "request mapping" should {

    "maps a well-formed bid to the viewer's own command from the bot" in {
      val command = RequestMapping.placeBid(validBid).value
      command.lotId shouldBe UUID.fromString(lot)
      command.bid.participant.value shouldBe UUID.fromString(identity)
      command.bid.amount shouldBe Money(150, CurrencyCode("RUB"))
      command.bid.opId.value shouldBe UUID.fromString(op)
      command.bid.source shouldBe BidSource.Bot
      command.acting.viewer.globalRoles shouldBe Set(GlobalRole.Public)
    }

    "names viewer as the invalid field when the request has no viewer" in {
      RequestMapping.placeBid(validBid.clearViewer).left.value shouldBe FormError("viewer")
    }

    "names the field whose identifier is not a canonical UUIDv7" in {
      val uuidV4 = "3b241101-e2bb-4255-8caf-4136c566a962"
      RequestMapping.placeBid(validBid.withLotId(uuidV4)).left.value shouldBe FormError("lot_id")
      RequestMapping.placeBid(validBid.withLotId(lot.toUpperCase)).left.value shouldBe FormError("lot_id")
      RequestMapping.placeBid(validBid.withOpId("")).left.value shouldBe FormError("op_id")
      RequestMapping.placeBid(validBid.withViewer(viewer.withIdentityId("x"))).left.value shouldBe
        FormError("viewer.identity_id")
    }

    "names amount as the invalid field when it is missing or its currency is not an upper-case ISO code" in {
      RequestMapping.placeBid(validBid.clearAmount).left.value shouldBe FormError("amount")
      RequestMapping.placeBid(validBid.withAmount(MoneyMessage(150, "rub"))).left.value shouldBe FormError("amount")
      RequestMapping.placeBid(validBid.withAmount(MoneyMessage(150, ""))).left.value shouldBe FormError("amount")
    }

    "rejects an unspecified or unknown role instead of treating the viewer as ordinary" in {
      val unspecified = viewer.withGlobalRoles(Seq(GlobalRoleMessage.GLOBAL_ROLE_UNSPECIFIED))
      val unknown = viewer.withGlobalRoles(Seq(GlobalRoleMessage.GLOBAL_ROLE_PUBLIC, GlobalRoleMessage.Unrecognized(9)))
      RequestMapping.placeBid(validBid.withViewer(unspecified)).left.value shouldBe FormError("viewer.global_roles")
      RequestMapping.placeBid(validBid.withViewer(unknown)).left.value shouldBe FormError("viewer.global_roles")
    }

    "keeps every known role of the viewer" in {
      val all = viewer.withGlobalRoles(
        Seq(
          GlobalRoleMessage.GLOBAL_ROLE_ADMIN,
          GlobalRoleMessage.GLOBAL_ROLE_MAINTAINER,
          GlobalRoleMessage.GLOBAL_ROLE_MEMBER,
          GlobalRoleMessage.GLOBAL_ROLE_PUBLIC
        )
      )
      RequestMapping.acting(Some(all)).value.viewer.globalRoles shouldBe GlobalRole.values.toSet
    }

    "maps a well-formed proxy limit and its withdrawal to the viewer's own commands" in {
      val limit = RequestMapping.setProxyLimit(validLimit).value
      limit.lotId shouldBe UUID.fromString(lot)
      limit.limit.participant.value shouldBe UUID.fromString(identity)
      limit.limit.max shouldBe Money(200, CurrencyCode("RUB"))
      limit.limit.opId.value shouldBe UUID.fromString(op)
      val withdrawal = RequestMapping.withdrawProxyLimit(validWithdrawal).value
      withdrawal.lotId shouldBe UUID.fromString(lot)
      withdrawal.withdrawal.participant.value shouldBe UUID.fromString(identity)
      withdrawal.withdrawal.opId.value shouldBe UUID.fromString(op)
    }

    "names the invalid field of a proxy limit and its withdrawal" in {
      RequestMapping.setProxyLimit(validLimit.clearMax).left.value shouldBe FormError("max")
      RequestMapping.setProxyLimit(validLimit.withMax(MoneyMessage(200, "rub"))).left.value shouldBe FormError("max")
      RequestMapping.setProxyLimit(validLimit.withLotId("")).left.value shouldBe FormError("lot_id")
      RequestMapping.withdrawProxyLimit(validWithdrawal.clearViewer).left.value shouldBe FormError("viewer")
      RequestMapping.withdrawProxyLimit(validWithdrawal.withOpId("")).left.value shouldBe FormError("op_id")
    }

    "maps a catalog command with its text as entered" in {
      val card = RequestMapping.card(Some(viewer), lot, "  Лот  ", "").value
      card.lotId.value shouldBe UUID.fromString(lot)
      card.title shouldBe "  Лот  "
      card.description shouldBe ""
    }
  }
}

object RequestMappingSpec {

  val identity = "01890a5d-ac96-774b-bcce-b302099a8057"
  val lot = "01890a5d-ac97-7c2b-9f3a-0d1b2c3d4e5f"
  val op = "01890a5d-ac98-7aaa-8bbb-cccccccccccc"

  val viewer: ViewerMessage = ViewerMessage(identity, Seq(GlobalRoleMessage.GLOBAL_ROLE_PUBLIC))

  val validBid: PlaceBidRequest = PlaceBidRequest(Some(viewer), lot, Some(MoneyMessage(150, "RUB")), op)

  val validLimit: SetProxyLimitRequest = SetProxyLimitRequest(Some(viewer), lot, Some(MoneyMessage(200, "RUB")), op)

  val validWithdrawal: WithdrawProxyLimitRequest = WithdrawProxyLimitRequest(Some(viewer), lot, op)
}
