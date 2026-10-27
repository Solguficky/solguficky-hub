package auction.grpc

import auction.contract.LotValues
import auction.projection.DayLotStatisticsView
import auction.projection.LotStatisticsView
import auction.v1.auction_service as wire

import java.time.Instant

/**
 * Сводка дня торгов (PER-492) в форме `AuctionDaySummary`: агрегаты окна, без участников, имён и лимитов. Порядок лотов
 * смысла не несёт — ранжирует потребитель, как у статистики недели.
 */
object DaySummaryMapping {

  def summary(lots: List[DayLotStatisticsView]): wire.AuctionDaySummary =
    wire.AuctionDaySummary(lots.map(lot))

  /**
   * Хроники дня участника (PER-725): агрегаты окна той же формы, что у сводки, и из статистики недели — только число
   * ставок и рост от старта за жизнь лота. Число участников и время последней ставки — пульт, и сюда они не идут. Лот,
   * которого не знает одно из чтений, выпадает: выдумывать ему нули значило бы соврать.
   */
  def chronicle(
      from: Instant,
      until: Instant,
      day: List[DayLotStatisticsView],
      lifetime: List[LotStatisticsView]
  ): wire.GetAuctionDayChronicleResponse = {
    val byLot = lifetime.map(view => view.lotId -> view).toMap
    wire.GetAuctionDayChronicleResponse(
      from = LotValues.instant(from),
      until = LotValues.instant(until),
      lots = day.flatMap(window =>
        byLot
          .get(window.lotId)
          .map(life =>
            wire.DayChronicleLot(
              day = Some(lot(window)),
              bidCount = life.bidCount,
              priceGrowth = life.priceGrowth.map(LotValues.money)
            )
          )
      )
    )
  }

  def lot(view: DayLotStatisticsView): wire.DayLotStatistics =
    wire.DayLotStatistics(
      lotId = view.lotId.toString,
      bidCount = view.bidCount,
      maxPrice = view.maxPrice.map(LotValues.money),
      growth = view.growth.map(LotValues.money),
      leaderChangeCount = view.contest.leaderChanges,
      longestDuel = view.contest.longestDuel
    )
}
