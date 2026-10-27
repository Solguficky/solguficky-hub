package auction.grpc

import auction.contract.LotValues
import auction.lot.Lot
import auction.lot.LotState
import auction.lot.ParticipantId
import auction.lot.ProxyLimit
import auction.lot.StepWindow
import auction.lot.TradingState
import auction.naming.DisplayName
import auction.projection.LotSetView
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

  /**
   * `names` — имена собравших сеты лотов ответа (ADR-073, п. 7): собравший без имени в них приходит без
   * `collector_name`.
   */
  def snapshot(
      view: LotSnapshotView,
      viewer: ParticipantId,
      at: Instant,
      names: Map[ParticipantId, DisplayName] = Map.empty
  ): wire.LotSnapshot =
    of(view, at, own(_, viewer), names)

  /**
   * Снимок без смотрящего — для потока `WatchAuction`: поток одинаков у всех, и `viewer_proxy_limit` в нём не задаётся.
   */
  def unviewed(
      view: LotSnapshotView,
      at: Instant,
      names: Map[ParticipantId, DisplayName] = Map.empty
  ): wire.LotSnapshot =
    of(view, at, _ => None, names)

  /** Собравшие сеты лотов: их имена отвечающий читает одним запросом до снимка. */
  def collectors(views: Iterable[LotSnapshotView]): Set[ParticipantId] =
    views.iterator.flatMap(_.lotSet).flatMap(_.collector).map(ParticipantId(_)).toSet

  private def of(
      view: LotSnapshotView,
      at: Instant,
      limit: Map[ParticipantId, ProxyLimit] => Option[model.Money],
      names: Map[ParticipantId, DisplayName]
  ): wire.LotSnapshot = {
    val base = wire.LotSnapshot(
      id = view.lotId.toString,
      auctionId = view.auctionId.toString,
      version = view.version,
      card = view.card.map(ResponseMapping.lotCard),
      bidCount = view.bidCount,
      lotSet = view.lotSet.map(lotSet(_, names))
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
            viewerProxyLimit = limit(trading.proxyLimits),
            activeWindow = Lot.activeWindow(trading, at).flatMap(active(trading, _, at)),
            nextWindow = Lot.nextWindow(trading, at).map(window)
          )
          .withTrading(LotValues.trading(trading))
      case LotState.Held(held) =>
        base
          .withConfig(LotValues.config(held.config))
          .copy(viewerProxyLimit = limit(held.proxyLimits))
          .withHeld(LotValues.held(held))
      case LotState.Sold(sale) => base.withSold(LotValues.sale(sale))
      case LotState.Unsold(reason) => base.withUnsold(LotValues.unsold(reason))
      case LotState.Withdrawn(reason) => base.withWithdrawn(LotValues.withdrawn(reason))
    }
  }

  /**
   * Действующее окно несёт шаг, который действует, и стартовую цену, пока лот без ставок и она ниже обычной. Окно,
   * которое при текущей цене ничего не меняет, участнику не показывается: на дешёвых порогах `Tiered` шаг окна не ниже
   * обычного, а стартовая окна после первой ставки не действует, и видно оно только в пульте (RFC-011, П-03; ADR-047,
   * дополнение 2026-10-27).
   */
  private def active(trading: TradingState, current: StepWindow, at: Instant): Option[wire.LotStepWindow] = {
    val step = Lot.step(trading, trading.currentPrice, at)
    val lowered = Option.when(step != Lot.baseStep(trading, trading.currentPrice))(LotValues.money(step))
    val opening = Lot.openingPrice(trading, at)
    val start = Option.when(trading.leader.isEmpty && opening != trading.currentPrice)(LotValues.money(opening))
    Option.when(lowered.isDefined || start.isDefined)(window(current).copy(step = lowered, start = start))
  }

  private def window(value: StepWindow): wire.LotStepWindow =
    wire.LotStepWindow(
      from = LotValues.instant(value.from),
      until = LotValues.instant(value.until),
      step = value.step.map(LotValues.money),
      start = value.start.map(LotValues.money)
    )

  private def lotSet(view: LotSetView, names: Map[ParticipantId, DisplayName]): wire.LotSetMembership =
    wire.LotSetMembership(
      lotSetId = view.lotSetId.toString,
      name = view.name,
      lotIds = view.lots.map(_.toString),
      collectorId = view.collector.map(_.toString),
      collectorName = view.collector.flatMap(id => names.get(ParticipantId(id))).map(ResponseMapping.displayName)
    )

  private def own(limits: Map[ParticipantId, ProxyLimit], viewer: ParticipantId): Option[model.Money] =
    limits.get(viewer).map(limit => LotValues.money(limit.max))
}
