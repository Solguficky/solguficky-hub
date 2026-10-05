package auction.contract

import auction.lot.AntiSnipe
import auction.lot.BidSource
import auction.lot.HeldState
import auction.lot.LotConfig
import auction.lot.Money
import auction.lot.Phase
import auction.lot.Sale
import auction.lot.StepPolicy
import auction.lot.TradingState
import auction.v1.auction as model

import java.time.Instant

/**
 * Значения лота в типах `auction.proto`, общих для чтения по gRPC и для фактов на шине. Оба снимка — `LotSnapshot`
 * ответа и `LotState` события — собираются из одних и тех же сообщений, и отображение у них одно: два описания правила
 * шага разошлись бы молча.
 *
 * Чужие прокси-лимиты сюда не входят: лимит — приватный факт владельца, и решать, кому его показать, — дело того, кто
 * собирает снимок.
 */
object LotValues {

  def config(config: LotConfig): model.LotConfig =
    model.LotConfig(
      currency = config.currency.value,
      stepPolicy = Some(stepPolicy(config.stepPolicy)),
      antiSnipe = Some(antiSnipe(config.antiSnipe)),
      proxyEnabled = config.proxyEnabled
    )

  /** Умолчания аукциона для условий лота: те же поля, что у конфигурации лота, но торгов по ним нет. */
  def defaults(config: LotConfig): model.LotDefaults =
    model.LotDefaults(
      currency = config.currency.value,
      stepPolicy = Some(stepPolicy(config.stepPolicy)),
      antiSnipe = Some(antiSnipe(config.antiSnipe)),
      proxyEnabled = config.proxyEnabled
    )

  def trading(trading: TradingState): model.LotTrading =
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

  def held(held: HeldState): model.LotHeld =
    model.LotHeld(
      currentPrice = Some(money(held.currentPrice)),
      leaderId = held.leader.map(_.value.toString),
      leadingBidId = held.leadingBidId.map(_.value.toString),
      extensionsUsed = 0
    )

  def sale(sale: Sale): model.LotSale =
    model.LotSale(
      winnerId = sale.winner.value.toString,
      price = Some(money(sale.price)),
      bidId = sale.bidId.value.toString,
      soldAt = instant(sale.at)
    )

  def money(amount: Money): model.Money = model.Money(amount.minorUnits, amount.currency.value)

  /** RFC 3339 в UTC: `Instant.toString` пишет ровно эту форму. */
  def instant(at: Instant): String = at.toString

  def bidSource(source: BidSource): model.BidSource =
    source match {
      case BidSource.Bot => model.BidSource.BID_SOURCE_BOT
      case BidSource.Floor => model.BidSource.BID_SOURCE_FLOOR
    }

  /** Первый порог хранится в политике отдельно как шаг от нуля; в контракте он первый в списке с границей ноль. */
  private def stepPolicy(policy: StepPolicy): model.StepPolicy =
    policy match {
      case StepPolicy.Fixed(step) => model.StepPolicy().withFixed(money(step))
      case StepPolicy.Tiered(base, tiers) =>
        val first = model.StepTier(Some(money(Money(0, base.currency))), Some(money(base)))
        val rest = tiers.map(tier => model.StepTier(Some(money(tier.bound)), Some(money(tier.step))))
        model.StepPolicy().withTiered(model.TieredSteps(first :: rest))
    }

  private def antiSnipe(antiSnipe: AntiSnipe): model.AntiSnipe =
    model.AntiSnipe(
      windowSeconds = antiSnipe.window.getSeconds,
      extensionSeconds = antiSnipe.extension.getSeconds,
      maxExtensions = antiSnipe.maxExtensions
    )

  private def phase(phase: Phase): model.LotPhase =
    phase match {
      case Phase.Online => model.LotPhase.LOT_PHASE_ONLINE
      case Phase.Live => model.LotPhase.LOT_PHASE_LIVE
    }
}
