package auction.grpc

import auction.contract.LotValues
import auction.lot.Lot
import auction.lot.LotState
import auction.lot.ParticipantId
import auction.lot.ProxyLimit
import auction.projection.LotSnapshotView
import auction.v1.auction as model
import auction.v1.auction_service as wire

/**
 * Отображение лота из read model в `LotSnapshot` так, как его видит один смотрящий.
 *
 * Чужие прокси-лимиты наружу не уходят: `viewer_proxy_limit` — лимит самого смотрящего, и никакого другого поля с
 * лимитами в ответе нет. Следующая цена — та же `Lot.minRequired`, по которой entity принимает ставку, и только в
 * торгах: вызывающий не повторяет правило шага.
 */
object SnapshotMapping {

  def snapshot(view: LotSnapshotView, viewer: ParticipantId): wire.LotSnapshot = {
    val base = wire.LotSnapshot(
      id = view.lotId.toString,
      auctionId = view.auctionId.toString,
      version = view.version,
      card = view.card.map(ResponseMapping.lotCard)
    )
    view.lot.state match {
      case LotState.Initial =>
        throw new IllegalStateException(s"lot view of lot ${view.lotId} holds a lot that was never drafted")
      case LotState.Draft => base.withDraft(model.LotDraft())
      case LotState.Scheduled(schedule) =>
        base
          .withConfig(LotValues.config(schedule.config))
          .withScheduled(model.LotSchedule(Some(LotValues.money(schedule.startingPrice))))
      case LotState.Trading(trading) =>
        base
          .withConfig(LotValues.config(trading.config))
          .withNextPrice(LotValues.money(Lot.minRequired(trading)))
          .copy(viewerProxyLimit = own(trading.proxyLimits, viewer))
          .withTrading(LotValues.trading(trading))
      case LotState.Held(held) =>
        base
          .withConfig(LotValues.config(held.config))
          .copy(viewerProxyLimit = own(held.proxyLimits, viewer))
          .withHeld(LotValues.held(held))
      case LotState.Sold(sale) => base.withSold(LotValues.sale(sale))
    }
  }

  private def own(limits: Map[ParticipantId, ProxyLimit], viewer: ParticipantId): Option[model.Money] =
    limits.get(viewer).map(limit => LotValues.money(limit.max))
}
