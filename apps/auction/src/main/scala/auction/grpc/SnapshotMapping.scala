package auction.grpc

import auction.lot.Lot
import auction.lot.LotConfig
import auction.lot.LotState
import auction.lot.Money
import auction.lot.ParticipantId
import auction.lot.Phase
import auction.lot.ProxyLimit
import auction.lot.StepPolicy
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
 */
object SnapshotMapping {

  def snapshot(view: LotSnapshotView, viewer: ParticipantId): wire.LotSnapshot = {
    val base = wire.LotSnapshot(
      id = view.lotId.toString,
      auctionId = view.auctionId.toString,
      version = view.version,
      card = view.card.map(card => wire.LotCard(card.title.value, card.description))
    )
    view.lot.state match {
      case LotState.Initial =>
        throw new IllegalStateException(s"lot view of lot ${view.lotId} holds a lot that was never drafted")
      case LotState.Draft => base.withDraft(model.LotDraft())
      case LotState.Scheduled(schedule) =>
        base
          .withConfig(config(schedule.config))
          .withScheduled(model.LotSchedule(Some(money(schedule.startingPrice))))
      case LotState.Trading(trading) =>
        base
          .withConfig(config(trading.config))
          .withNextPrice(money(Lot.minRequired(trading)))
          .copy(viewerProxyLimit = own(trading.proxyLimits, viewer))
          .withTrading(
            model.LotTrading(
              currentPrice = Some(money(trading.currentPrice)),
              ask = trading.ask.map(money),
              leaderId = trading.leader.map(_.value.toString),
              leadingBidId = trading.leadingBidId.map(_.value.toString),
              deadline = trading.deadline.map(instant),
              // Счётчик продлений появится с правилом анти-снайпа; до него продлений не было.
              extensionsUsed = 0,
              phase = phase(trading.phase)
            )
          )
      case LotState.Held(held) =>
        base
          .withConfig(config(held.config))
          .copy(viewerProxyLimit = own(held.proxyLimits, viewer))
          .withHeld(
            model.LotHeld(
              currentPrice = Some(money(held.currentPrice)),
              leaderId = held.leader.map(_.value.toString),
              leadingBidId = held.leadingBidId.map(_.value.toString),
              extensionsUsed = 0
            )
          )
      case LotState.Sold(sale) =>
        base.withSold(
          model.LotSale(
            winnerId = sale.winner.value.toString,
            price = Some(money(sale.price)),
            bidId = sale.bidId.value.toString,
            soldAt = instant(sale.at)
          )
        )
    }
  }

  private def own(limits: Map[ParticipantId, ProxyLimit], viewer: ParticipantId): Option[model.Money] =
    limits.get(viewer).map(limit => money(limit.max))

  private def config(config: LotConfig): model.LotConfig =
    model.LotConfig(
      currency = config.currency.value,
      stepPolicy = Some(stepPolicy(config.stepPolicy)),
      antiSnipe = Some(
        model.AntiSnipe(
          windowSeconds = config.antiSnipe.window.getSeconds,
          extensionSeconds = config.antiSnipe.extension.getSeconds,
          maxExtensions = config.antiSnipe.maxExtensions
        )
      ),
      proxyEnabled = config.proxyEnabled
    )

  /** Первый порог хранится в политике отдельно как шаг от нуля; в контракте он первый в списке с границей ноль. */
  private def stepPolicy(policy: StepPolicy): model.StepPolicy =
    policy match {
      case StepPolicy.Fixed(step) => model.StepPolicy().withFixed(money(step))
      case StepPolicy.Tiered(base, tiers) =>
        val first = model.StepTier(Some(money(Money(0, base.currency))), Some(money(base)))
        val rest = tiers.map(tier => model.StepTier(Some(money(tier.bound)), Some(money(tier.step))))
        model.StepPolicy().withTiered(model.TieredSteps(first :: rest))
    }

  private def phase(phase: Phase): model.LotPhase =
    phase match {
      case Phase.Online => model.LotPhase.LOT_PHASE_ONLINE
      case Phase.Live => model.LotPhase.LOT_PHASE_LIVE
    }

  private def money(amount: Money): model.Money = model.Money(amount.minorUnits, amount.currency.value)

  /** RFC 3339 в UTC: `Instant.toString` пишет ровно эту форму. */
  private def instant(at: Instant): String = at.toString
}
