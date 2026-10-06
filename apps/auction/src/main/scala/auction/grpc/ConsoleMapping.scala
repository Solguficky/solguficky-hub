package auction.grpc

import auction.lot.Lot
import auction.lot.LotState
import auction.lot.ParticipantId
import auction.projection.AuctionSnapshotView
import auction.projection.LotSnapshotView
import auction.v1.auction_service as wire

import java.time.Duration
import java.time.Instant

/**
 * Пульт администратора сходки (PER-320) в форме `AuctionConsole`. Только здесь до заморозки состава видна отметка для
 * финала: в снимке лота её нет, потому что выбор организатора до объявления состава рабочий (RFC-011).
 *
 * Просроченный лот — тот же, что считает метрика `auction.lots.overdue`: в торгах по read model, с дедлайном раньше
 * `now − grace`. Одно определение на метрику и пульт, поэтому допуск на отставание проекции у них общий.
 */
object ConsoleMapping {

  def console(
      auction: AuctionSnapshotView,
      lots: List[LotSnapshotView],
      viewer: ParticipantId,
      now: Instant,
      grace: Duration
  ): wire.AuctionConsole =
    wire.AuctionConsole(
      auction = Some(ResponseMapping.auctionSnapshot(auction)),
      lots = lots.map { view =>
        wire.ConsoleLot(
          lot = Some(SnapshotMapping.snapshot(view, viewer)),
          markedForFinal = marked(view.lot),
          overdue = overdue(view.lot, now, grace)
        )
      }
    )

  /** Отмечен для финала: в торгах с отметкой либо уже удержан — удерживается только отмеченный лот. */
  def marked(lot: Lot): Boolean =
    lot.state match {
      case LotState.Trading(trading) => trading.markedForFinal
      case LotState.Held(_) => true
      case _ => false
    }

  def overdue(lot: Lot, now: Instant, grace: Duration): Boolean =
    lot.state match {
      case LotState.Trading(trading) => trading.deadline.exists(_.isBefore(now.minus(grace)))
      case _ => false
    }
}
