package auction.contracts

import auction.v1.auction_events.{BidPlaced, LotEvent, ManualBid, ProxyBid}
import auction.v1.auction_service.AuctionService
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

/**
 * Держит проверяемой кодогенерацию собственного контракта аукциона, как `IdentityContractSpec` держит чужой.
 *
 * Поведение торгов здесь не проверяется: ядра ещё нет. Проверяется то, что обещает схема и что прошлое поколение ломало
 * на проводе, — отсутствие значения остаётся отсутствием, а не нулём (дефект 5.7 архива, RFC-011 П-01).
 */
final class AuctionContractSpec extends AnyWordSpec with Matchers {

  "generated auction contract" should {

    // Прежний продюсер писал `PreviousLeaderId ?? 0` в optional-поле, взводил
    // признак присутствия всегда, и Notifications рассылал «вашу ставку
    // перебили» пользователю с id 0.
    "keeps the previous leader absent on the first bid after a round trip" in {
      val firstBid = BidPlaced(origin = BidPlaced.Origin.Manual(ManualBid()))

      BidPlaced.parseFrom(firstBid.toByteArray).previousLeaderId shouldBe None
    }

    "keeps a proxy bid free of a source" in {
      val proxyBid = BidPlaced(previousLeaderId = Some("0190a0e0-0000-7000-8000-000000000001"))
        .withProxy(ProxyBid())

      BidPlaced.parseFrom(proxyBid.toByteArray).origin.manual shouldBe None
    }

    "leaves the occasion unset on an event that carries none" in {
      LotEvent.parseFrom(LotEvent(eventId = "e", lotId = "l", version = 1).toByteArray).occasion.isEmpty shouldBe true
    }

    // Серверный трейт генерирует pekko-grpc поверх того же ScalaPB (ADR-048).
    // Ссылка на тип держит его появление в сборке: пропавшая генерация роняет
    // компиляцию этого теста, а не первого обработчика, который его реализует.
    "exposes the server side of the service" in {
      AuctionService.name shouldBe "auction.v1.AuctionService"
    }
  }
}
