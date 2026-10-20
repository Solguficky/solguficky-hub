package auction.projection

import auction.lot.AuctionId
import auction.lot.ParticipantId

import java.time.Instant
import scala.concurrent.Future

/**
 * Ставки финала аукциона по участникам (PER-653): момент последней ставки каждого, кто ставил в лоте состава после
 * возврата его в торги. Граница финала — строки read model (`auction_lineup`, `lot_resume`, `lot_bid`), поэтому ответ
 * согласован в конечном счёте, как и остальные чтения.
 */
trait FinalBids {
  def lastBids(auction: AuctionId): Future[Map[ParticipantId, Instant]]
}

object FinalBids {

  /** Ставок финала нет: порядок списка имён — по имени, без ставивших. */
  val empty: FinalBids = _ => Future.successful(Map.empty)
}
