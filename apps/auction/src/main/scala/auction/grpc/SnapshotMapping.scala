package auction.grpc

import auction.contract.LotValues
import auction.lot.Lot
import auction.lot.LotState
import auction.lot.ParticipantId
import auction.lot.ProxyLimit
import auction.lot.StepWindow
import auction.lot.TradingState
import auction.projection.LotSnapshotView
import auction.v1.auction as model
import auction.v1.auction_service as wire

import java.time.Instant

/**
 * Отображение лота из read model в `LotSnapshot` так, как его видит один смотрящий.
 *
 * Чужие прокси-лимиты наружу не уходят: `viewer_proxy_limit` — лимит самого смотрящего, и никакого другого поля с
 * лимитами в ответе нет. Следующая цена — та же `Lot.minRequired`, по которой entity принимает ставку, и только в
 * торгах: вызывающий не повторяет правило шага.
 *
 * Шаг зависит от момента (П-03, окно сниженного шага), поэтому снимок считается на `at` — момент ответа, один на весь
 * ответ, даже если в нём несколько лотов. Рядом со следующей ценой лежат обычный шаг, действующее окно с шагом, который
 * действует, и ближайшее будущее окно с объявленной суммой: край показывает «Счастливые часы», не повторяя правила.
 */
object SnapshotMapping {

  def snapshot(view: LotSnapshotView, viewer: ParticipantId, at: Instant): wire.LotSnapshot = {
    val base = wire.LotSnapshot(
      id = view.lotId.toString,
      auctionId = view.auctionId.toString,
      version = view.version,
      card = view.card.map(ResponseMapping.lotCard),
      bidCount = view.bidCount
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
          .withNextPrice(LotValues.money(Lot.minRequired(trading, at)))
          .withBaseStep(LotValues.money(Lot.baseStep(trading, trading.currentPrice)))
          .copy(
            viewerProxyLimit = own(trading.proxyLimits, viewer),
            activeWindow = Lot.activeWindow(trading, at).map(active(trading, _, at)),
            nextWindow = Lot.nextWindow(trading, at).map(window)
          )
          .withTrading(LotValues.trading(trading))
      case LotState.Held(held) =>
        base
          .withConfig(LotValues.config(held.config))
          .copy(viewerProxyLimit = own(held.proxyLimits, viewer))
          .withHeld(LotValues.held(held))
      case LotState.Sold(sale) => base.withSold(LotValues.sale(sale))
      case LotState.Unsold(reason) => base.withUnsold(LotValues.unsold(reason))
    }
  }

  /** Действующее окно несёт шаг, который действует: сумму окна, но не выше обычного шага при текущей цене. */
  private def active(trading: TradingState, current: StepWindow, at: Instant): wire.LotStepWindow =
    window(current).withStep(LotValues.money(Lot.step(trading, trading.currentPrice, at)))

  private def window(value: StepWindow): wire.LotStepWindow =
    wire.LotStepWindow(
      from = LotValues.instant(value.from),
      until = LotValues.instant(value.until),
      step = Some(LotValues.money(value.step))
    )

  private def own(limits: Map[ParticipantId, ProxyLimit], viewer: ParticipantId): Option[model.Money] =
    limits.get(viewer).map(limit => LotValues.money(limit.max))
}
