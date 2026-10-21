package auction.contract

import auction.aggregate.AuctionConfig
import auction.aggregate.ClosingPolicy
import auction.aggregate.StepWindowConfig
import auction.catalog.LotId
import auction.v1.auction as model
import auction.v1.auction_events.AuctionState as AuctionStateMessage

/** Значения аукциона в типах `auction.proto` — как [[LotValues]] у лота. */
object AuctionValues {

  def config(config: AuctionConfig): model.AuctionConfig =
    model.AuctionConfig(
      onlinePhase = config.onlinePhase.map { phase =>
        model.OnlinePhase(
          opensAt = LotValues.instant(phase.opensAt),
          closesAt = phase.closesAt.map(LotValues.instant),
          closesLots = phase.closesLots,
          raffleClosesAt = phase.raffleClosesAt.map(LotValues.instant),
          rafflePrize = phase.rafflePrize
        )
      },
      finalBlocks = config.finalBlocks,
      closingPolicy = Some(closingPolicy(config.closingPolicy)),
      lotDefaults = config.lotDefaults.map(LotValues.defaults),
      stepWindows = config.stepWindows.map(stepWindow)
    )

  /**
   * Окно сниженного шага в типах `auction.proto`: та же форма у объявленного окна конфигурации и у запущенного по ходу
   * торгов (ADR-047, дополнение 2026-10-12).
   */
  def stepWindow(window: StepWindowConfig): model.AuctionStepWindow =
    model.AuctionStepWindow(
      from = LotValues.instant(window.from),
      until = LotValues.instant(window.until),
      step = Some(LotValues.money(window.step)),
      lotIds = window.lots.toList.map(_.value).sorted.map(_.toString)
    )

  /** Замороженный состав финала: лоты в порядке выхода. */
  def lineupFrozen(order: List[LotId]): AuctionStateMessage.LineupFrozen =
    AuctionStateMessage.LineupFrozen(order.map(_.value.toString))

  /**
   * Идущий финал: состав и активный лот — последний возвращённый в торги, пока он не завершён закрытием ведущим
   * (PER-607). Между лотами активного нет.
   */
  def inFinal(order: List[LotId], active: Option[LotId]): AuctionStateMessage.Final =
    AuctionStateMessage.Final(order.map(_.value.toString), active.map(_.value.toString))

  private def closingPolicy(policy: ClosingPolicy): model.ClosingPolicy =
    policy match {
      case ClosingPolicy.ByAuctioneer => model.ClosingPolicy().withByAuctioneer(model.ClosingByAuctioneer())
      case ClosingPolicy.ByDeadline => model.ClosingPolicy().withByDeadline(model.ClosingByDeadline())
      case ClosingPolicy.Mixed(onlineByDeadline) =>
        model.ClosingPolicy().withMixed(model.MixedClosing(onlineByDeadline))
    }
}
