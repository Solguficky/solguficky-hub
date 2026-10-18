package auction.grpc

import auction.projection.AuctionWatchView
import auction.v1.auction_service as wire

import java.time.Instant

/**
 * Сообщение потока `WatchAuction` из read model: аукцион в форме `AuctionSnapshot`, активный лот финала и состав в
 * порядке выхода. Снимки лотов — без смотрящего: поток одинаков у всех, лимит смотрящего читается `GetLot`. Шаг лота
 * зависит от момента, поэтому `at` один на всё сообщение.
 */
object WatchMapping {

  def watch(view: AuctionWatchView, at: Instant): wire.AuctionWatch =
    wire.AuctionWatch(
      auction = Some(ResponseMapping.auctionSnapshot(view.auction)),
      activeLot = view.activeLot.map(SnapshotMapping.unviewed(_, at)),
      lineup = view.lineup.map(SnapshotMapping.unviewed(_, at))
    )
}
