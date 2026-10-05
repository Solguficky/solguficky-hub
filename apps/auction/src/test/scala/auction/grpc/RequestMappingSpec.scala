package auction.grpc

import auction.access.GlobalRole
import auction.aggregate.AuctionConfigInput
import auction.aggregate.ClosingPolicy
import auction.aggregate.OnlinePhase
import auction.catalog.ImageChange
import auction.lot.AntiSnipe
import auction.lot.BidSource
import auction.lot.CurrencyCode
import auction.lot.LotConfigInput
import auction.lot.Money
import auction.lot.StepPolicy
import auction.lot.StepPolicyInput
import auction.v1.auction.AntiSnipe as AntiSnipeMessage
import auction.v1.auction.AuctionConfig as AuctionConfigMessage
import auction.v1.auction.ClosingPolicy as ClosingPolicyMessage
import auction.v1.auction.LotDefaults as LotDefaultsMessage
import auction.v1.auction.MixedClosing
import auction.v1.auction.Money as MoneyMessage
import auction.v1.auction.OnlinePhase as OnlinePhaseMessage
import auction.v1.auction.StepPolicy as StepPolicyMessage
import auction.v1.auction.StepTier
import auction.v1.auction.TieredSteps
import auction.v1.auction_service.CreateLotCardRequest
import auction.v1.auction_service.EditLotCardRequest
import auction.v1.auction_service.GetLotImageRequest
import auction.v1.auction_service.LotImageRemoval
import auction.v1.auction_service.LotImageUpload
import auction.v1.auction_service.PlaceBidRequest
import auction.v1.auction_service.ScheduleAuctionRequest
import auction.v1.auction_service.ScheduleLotRequest
import auction.v1.auction_service.SetProxyLimitRequest
import auction.v1.auction_service.StartPrebiddingRequest
import auction.v1.auction_service.WithdrawProxyLimitRequest
import auction.v1.auction_service.Viewer as ViewerMessage
import com.google.protobuf.ByteString
import identity.v1.roles.GlobalRole as GlobalRoleMessage
import org.scalatest.EitherValues
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

import java.time.Duration
import java.time.Instant
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
      val card = RequestMapping.createCard(CreateLotCardRequest(Some(viewer), lot, "  Лот  ", "")).value
      card.lotId.value shouldBe UUID.fromString(lot)
      card.title shouldBe "  Лот  "
      card.description shouldBe ""
      card.image shouldBe None
    }

    "passes the bytes of a created image on unchecked" in {
      val bytes = Array[Byte](1, 2, 3)
      val request = CreateLotCardRequest(Some(viewer), lot, "Лот", "", Some(LotImageUpload(ByteString.copyFrom(bytes))))
      RequestMapping.createCard(request).value.image.map(_.toSeq) shouldBe Some(bytes.toSeq)
    }

    "keeps the stored image when an edit names no image change" in {
      RequestMapping.editCard(EditLotCardRequest(Some(viewer), lot, "Лот", "")).value.image shouldBe ImageChange.Keep
    }

    "maps a replaced and a removed image of an edit" in {
      val edit = EditLotCardRequest(Some(viewer), lot, "Лот", "")
      val bytes = Array[Byte](1, 2, 3)
      RequestMapping.editCard(edit.withReplaceImage(LotImageUpload(ByteString.copyFrom(bytes)))).value.image match {
        case ImageChange.Replace(replacement) => replacement.toSeq shouldBe bytes.toSeq
        case other => fail(s"expected a replaced image, got $other")
      }
      RequestMapping.editCard(edit.withRemoveImage(LotImageRemoval())).value.image shouldBe ImageChange.Remove
    }

    "names the invalid field of a catalog command and of an image read" in {
      RequestMapping.editCard(EditLotCardRequest(None, lot, "Лот", "")).left.value shouldBe FormError("viewer")
      RequestMapping.createCard(CreateLotCardRequest(Some(viewer), "", "Лот", "")).left.value shouldBe
        FormError("lot_id")
      RequestMapping.getLotImage(GetLotImageRequest(Some(viewer), "")).left.value shouldBe FormError("lot_id")
      RequestMapping.getLotImage(GetLotImageRequest(Some(viewer), lot)).value.lotId shouldBe UUID.fromString(lot)
    }

    "maps the conditions of a lot with the price and a fixed step as sent" in {
      val command = RequestMapping.scheduleLot(validSchedule).value
      command.auctionId.value shouldBe UUID.fromString(meetupAuction)
      command.lotId.value shouldBe UUID.fromString(lot)
      command.startingPrice shouldBe Money(500000, CurrencyCode("RUB"))
      command.stepPolicy shouldBe StepPolicyInput.Fixed(Money(25000, CurrencyCode("RUB")))
      command.opId.value shouldBe UUID.fromString(op)
    }

    // И-15 проверяет домен: порядок и пустоту порогов форма не трогает.
    "passes the tiers of a step policy on in their order, unchecked" in {
      val tiers = TieredSteps(
        Seq(
          StepTier(Some(MoneyMessage(100, "RUB")), Some(MoneyMessage(10, "RUB"))),
          StepTier(Some(MoneyMessage(0, "RUB")), Some(MoneyMessage(0, "RUB")))
        )
      )
      val rub = CurrencyCode("RUB")
      RequestMapping
        .scheduleLot(validSchedule.withStepPolicy(StepPolicyMessage().withTiered(tiers)))
        .value
        .stepPolicy shouldBe
        StepPolicyInput.Tiered(
          List(StepPolicy.Tier(Money(100, rub), Money(10, rub)), StepPolicy.Tier(Money(0, rub), Money(0, rub)))
        )
      RequestMapping
        .scheduleLot(validSchedule.withStepPolicy(StepPolicyMessage().withTiered(TieredSteps())))
        .value
        .stepPolicy shouldBe StepPolicyInput.Tiered(Nil)
    }

    "names the invalid field of the conditions of a lot" in {
      RequestMapping.scheduleLot(validSchedule.withAuctionId(lot)).left.value shouldBe FormError("auction_id")
      RequestMapping.scheduleLot(validSchedule.clearStartingPrice).left.value shouldBe FormError("starting_price")
      RequestMapping.scheduleLot(validSchedule.clearStepPolicy).left.value shouldBe FormError("step_policy")
      RequestMapping.scheduleLot(validSchedule.withStepPolicy(StepPolicyMessage())).left.value shouldBe
        FormError("step_policy")
      RequestMapping
        .scheduleLot(validSchedule.withStepPolicy(StepPolicyMessage().withFixed(MoneyMessage(10, "rub"))))
        .left
        .value shouldBe FormError("step_policy.fixed")
      RequestMapping
        .scheduleLot(
          validSchedule.withStepPolicy(
            StepPolicyMessage().withTiered(TieredSteps(Seq(StepTier(None, Some(MoneyMessage(10, "RUB"))))))
          )
        )
        .left
        .value shouldBe FormError("step_policy.tiered.lower_bound")
    }

    "maps the configuration of an auction as sent, without checking its values against each other" in {
      val command = RequestMapping.scheduleAuction(validAuctionSchedule).value
      command.auctionId.value shouldBe UUID.fromString(meetupAuction)
      command.opId.value shouldBe UUID.fromString(op)
      command.config shouldBe AuctionConfigInput(
        Some(OnlinePhase(Instant.parse("2026-10-20T00:00:00Z"), Some(Instant.parse("2026-10-27T00:00:00Z")), true)),
        1,
        ClosingPolicy.Mixed(onlineByDeadline = true),
        LotConfigInput(
          CurrencyCode("RUB"),
          StepPolicyInput.Fixed(Money(10000, CurrencyCode("RUB"))),
          AntiSnipe(Duration.ofSeconds(120), Duration.ofSeconds(300), 3),
          proxyEnabled = true
        )
      )
      // ConfigInvalid решает ядро: `closes_at` раньше `opens_at` и пять блоков финала форма пропускает.
      val contradictory = validConfig
        .withOnlinePhase(OnlinePhaseMessage("2026-10-27T00:00:00Z", Some("2026-10-20T00:00:00Z"), closesLots = true))
        .withFinalBlocks(5)
      RequestMapping.scheduleAuction(validAuctionSchedule.withConfig(contradictory)).isRight shouldBe true
      RequestMapping
        .scheduleAuction(validAuctionSchedule.withConfig(validConfig.clearOnlinePhase))
        .value
        .config
        .onlinePhase shouldBe
        None
    }

    "names the invalid field of the configuration of an auction" in {
      def field(config: AuctionConfigMessage): FormError =
        RequestMapping.scheduleAuction(validAuctionSchedule.withConfig(config)).left.value
      RequestMapping.scheduleAuction(validAuctionSchedule.clearConfig).left.value shouldBe FormError("config")
      RequestMapping.scheduleAuction(validAuctionSchedule.withAuctionId(lot)).left.value shouldBe FormError(
        "auction_id"
      )
      field(validConfig.withOnlinePhase(OnlinePhaseMessage("20.10.2026", None, closesLots = false))) shouldBe
        FormError("config.online_phase.opens_at")
      field(
        validConfig.withOnlinePhase(OnlinePhaseMessage("2026-10-20T00:00:00Z", Some(""), closesLots = false))
      ) shouldBe
        FormError("config.online_phase.closes_at")
      field(validConfig.clearClosingPolicy) shouldBe FormError("config.closing_policy")
      field(validConfig.withClosingPolicy(ClosingPolicyMessage())) shouldBe FormError("config.closing_policy")
      field(validConfig.clearLotDefaults) shouldBe FormError("config.lot_defaults")
      field(validConfig.withLotDefaults(validDefaults.withCurrency("rub"))) shouldBe
        FormError("config.lot_defaults.currency")
      field(validConfig.withLotDefaults(validDefaults.clearStepPolicy)) shouldBe FormError("step_policy")
      field(validConfig.withLotDefaults(validDefaults.clearAntiSnipe)) shouldBe FormError(
        "config.lot_defaults.anti_snipe"
      )
      field(validConfig.withLotDefaults(validDefaults.withAntiSnipe(AntiSnipeMessage(-1, 300, 3)))) shouldBe
        FormError("config.lot_defaults.anti_snipe")
      // Длительность, на которой `Instant` дедлайна переполнился бы, — тоже форма, а не отказ лота на ставке.
      val beyond = RequestMapping.MaxAntiSnipeSeconds + 1
      field(validConfig.withLotDefaults(validDefaults.withAntiSnipe(AntiSnipeMessage(120, beyond, 3)))) shouldBe
        FormError("config.lot_defaults.anti_snipe")
      field(validConfig.withLotDefaults(validDefaults.withAntiSnipe(AntiSnipeMessage(Long.MaxValue, 120, 3)))) shouldBe
        FormError("config.lot_defaults.anti_snipe")
    }

    "maps the start of prebidding of a meetup auction only" in {
      val command = RequestMapping.startPrebidding(StartPrebiddingRequest(Some(viewer), meetupAuction, op)).value
      command.auctionId.value shouldBe UUID.fromString(meetupAuction)
      command.opId.value shouldBe UUID.fromString(op)
      RequestMapping.startPrebidding(StartPrebiddingRequest(Some(viewer), lot, op)).left.value shouldBe
        FormError("auction_id")
      RequestMapping.startPrebidding(StartPrebiddingRequest(None, meetupAuction, op)).left.value shouldBe
        FormError("viewer")
    }
  }
}

object RequestMappingSpec {

  val identity = "01890a5d-ac96-774b-bcce-b302099a8057"
  val lot = "01890a5d-ac97-7c2b-9f3a-0d1b2c3d4e5f"
  val op = "01890a5d-ac98-7aaa-8bbb-cccccccccccc"
  val meetupId = "0190a0e0-0000-7000-8000-000000000001"

  val viewer: ViewerMessage = ViewerMessage(identity, Seq(GlobalRoleMessage.GLOBAL_ROLE_PUBLIC))

  val validBid: PlaceBidRequest = PlaceBidRequest(Some(viewer), lot, Some(MoneyMessage(150, "RUB")), op)

  val validLimit: SetProxyLimitRequest = SetProxyLimitRequest(Some(viewer), lot, Some(MoneyMessage(200, "RUB")), op)

  val validWithdrawal: WithdrawProxyLimitRequest = WithdrawProxyLimitRequest(Some(viewer), lot, op)

  /** Аукцион сходки `meetupId`: UUIDv5, вектор контракта. */
  val meetupAuction = "daef05c7-cd68-5048-b03d-cb4860e8dc73"

  val validSchedule: ScheduleLotRequest = ScheduleLotRequest(
    Some(viewer),
    meetupAuction,
    lot,
    op,
    Some(MoneyMessage(500000, "RUB")),
    Some(StepPolicyMessage().withFixed(MoneyMessage(25000, "RUB")))
  )

  val validDefaults: LotDefaultsMessage = LotDefaultsMessage(
    "RUB",
    Some(StepPolicyMessage().withFixed(MoneyMessage(10000, "RUB"))),
    Some(AntiSnipeMessage(120, 300, 3)),
    proxyEnabled = true
  )

  val validConfig: AuctionConfigMessage = AuctionConfigMessage(
    Some(OnlinePhaseMessage("2026-10-20T00:00:00Z", Some("2026-10-27T00:00:00Z"), closesLots = true)),
    1,
    Some(ClosingPolicyMessage().withMixed(MixedClosing(onlineByDeadline = true))),
    Some(validDefaults)
  )

  val validAuctionSchedule: ScheduleAuctionRequest =
    ScheduleAuctionRequest(Some(viewer), meetupAuction, op, Some(validConfig))
}
