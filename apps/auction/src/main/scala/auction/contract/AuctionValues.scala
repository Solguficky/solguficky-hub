package auction.contract

import auction.aggregate.AuctionConfig
import auction.aggregate.ClosingPolicy
import auction.v1.auction as model

/** Значения аукциона в типах `auction.proto` — как [[LotValues]] у лота. */
object AuctionValues {

  def config(config: AuctionConfig): model.AuctionConfig =
    model.AuctionConfig(
      onlinePhase = config.onlinePhase.map { phase =>
        model.OnlinePhase(
          opensAt = LotValues.instant(phase.opensAt),
          closesAt = phase.closesAt.map(LotValues.instant),
          closesLots = phase.closesLots
        )
      },
      finalBlocks = config.finalBlocks,
      closingPolicy = Some(closingPolicy(config.closingPolicy)),
      lotDefaults = Some(LotValues.defaults(config.lotDefaults))
    )

  private def closingPolicy(policy: ClosingPolicy): model.ClosingPolicy =
    policy match {
      case ClosingPolicy.ByAuctioneer => model.ClosingPolicy().withByAuctioneer(model.ClosingByAuctioneer())
      case ClosingPolicy.ByDeadline => model.ClosingPolicy().withByDeadline(model.ClosingByDeadline())
      case ClosingPolicy.Mixed(onlineByDeadline) =>
        model.ClosingPolicy().withMixed(model.MixedClosing(onlineByDeadline))
    }
}
