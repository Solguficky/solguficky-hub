package auction.projection

import auction.aggregate.Auction
import auction.aggregate.AuctionState
import auction.catalog.LotId

import java.util.UUID
import scala.concurrent.Future

/**
 * Состояние аукциона для потока `WatchAuction` (PER-335): аукцион и лоты его замороженного состава в порядке выхода.
 * Лот состава, которого read model лота ещё не знает, в состав не попадает: снимка торгов у него нет, а его первая
 * строка сама даст повод перечитать.
 */
final case class AuctionWatchView(auction: AuctionSnapshotView, lineup: List[LotSnapshotView]) {

  /** Активный лот финала — последний возвращённый в торги, как в `AuctionState.Final` контракта. */
  def activeLot: Option[LotSnapshotView] =
    auction.auction.state match {
      case AuctionState.Final(_, _, _, activated) =>
        activated.lastOption.flatMap(active => lineup.find(_.lotId == active.value))
      case _ => None
    }
}

object AuctionWatchView {

  /** Состав, который несёт аукцион: пуст до заморозки, с заморозки — порядок выхода. */
  def lineupOf(auction: Auction): List[LotId] =
    auction.state match {
      case AuctionState.LineupFrozen(_, _, order) => order
      case AuctionState.Final(_, _, order, _) => order
      case AuctionState.Initial | AuctionState.Draft | AuctionState.Scheduled(_) | AuctionState.Prebidding(_, _) |
          AuctionState.Settling(_, _) | AuctionState.Break(_, _) | AuctionState.Finished(_, _) |
          AuctionState.Cancelled(_, _, _) =>
        Nil
    }

  /** Лоты состава в порядке выхода из прочитанных в любом порядке; непрочитанный лот пропускается. */
  def arrange(order: List[LotId], lots: Iterable[LotSnapshotView]): List[LotSnapshotView] = {
    val byId = lots.map(view => view.lotId -> view).toMap
    order.flatMap(lot => byId.get(lot.value))
  }
}

/**
 * Чтение состояния для потока. Аукцион и лоты состава читаются одним снимком базы: проекции аукциона и лота пишут
 * независимо, и два отдельных чтения могли бы сложить аукцион и лоты из разных моментов.
 */
trait AuctionWatchViews {

  /** `None` — аукциона нет в read model: он не рождался или удалён до торгов. */
  def read(auctionId: UUID): Future[Option[AuctionWatchView]]
}
