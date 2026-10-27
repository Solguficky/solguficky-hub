package auction.grpc

import auction.lot.ParticipantId
import auction.naming.DisplayName
import auction.projection.AuctionWatchView
import auction.v1.auction_service as wire

import java.time.Instant

/**
 * Сообщение потока `WatchAuction` из read model: аукцион в форме `AuctionSnapshot`, активный лот финала и состав в
 * порядке выхода. Снимки лотов — без смотрящего: поток одинаков у всех, лимит смотрящего читается `GetLot`. Шаг лота
 * зависит от момента, поэтому `at` один на всё сообщение.
 */
object WatchMapping {

  /** `names` — имена собравших сеты лотов сообщения (ADR-073, п. 7), как у `GetLot`. */
  def watch(
      view: AuctionWatchView,
      at: Instant,
      names: Map[ParticipantId, DisplayName] = Map.empty
  ): wire.AuctionWatch =
    wire.AuctionWatch(
      auction = Some(ResponseMapping.auctionSnapshot(view.auction)),
      activeLot = view.activeLot.map(SnapshotMapping.unviewed(_, at, names)),
      lineup = view.lineup.map(SnapshotMapping.unviewed(_, at, names))
    )
}
