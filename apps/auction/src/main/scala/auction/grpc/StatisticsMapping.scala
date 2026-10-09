package auction.grpc

import auction.contract.LotValues
import auction.projection.LotStatisticsView
import auction.v1.auction_service as wire

/**
 * Статистика лотов реестра (PER-481) в форме `AuctionLotStatistics`: только агрегаты, без участников, имён и лимитов.
 * Порядок лотов смысла не несёт — ранжирует потребитель.
 */
object StatisticsMapping {

  def statistics(lots: List[LotStatisticsView]): wire.AuctionLotStatistics =
    wire.AuctionLotStatistics(lots.map(lot))

  def lot(view: LotStatisticsView): wire.LotStatistics =
    wire.LotStatistics(
      lotId = view.lotId.toString,
      bidCount = view.bidCount,
      uniqueParticipantCount = view.participantCount,
      priceGrowth = view.priceGrowth.map(LotValues.money),
      lastBidAt = view.lastBidAt.map(LotValues.instant)
    )
}
