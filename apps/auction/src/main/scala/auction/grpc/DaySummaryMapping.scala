package auction.grpc

import auction.contract.LotValues
import auction.projection.DayLotStatisticsView
import auction.v1.auction_service as wire

/**
 * Сводка дня торгов (PER-492) в форме `AuctionDaySummary`: агрегаты окна, без участников, имён и лимитов. Порядок лотов
 * смысла не несёт — ранжирует потребитель, как у статистики недели.
 */
object DaySummaryMapping {

  def summary(lots: List[DayLotStatisticsView]): wire.AuctionDaySummary =
    wire.AuctionDaySummary(lots.map(lot))

  def lot(view: DayLotStatisticsView): wire.DayLotStatistics =
    wire.DayLotStatistics(
      lotId = view.lotId.toString,
      bidCount = view.bidCount,
      maxPrice = view.maxPrice.map(LotValues.money),
      growth = view.growth.map(LotValues.money)
    )
}
