package auction.projection

import auction.aggregate.Auction
import auction.aggregate.MeetupId

import java.util.UUID
import scala.concurrent.Future

/** Аукцион из read model: его идентификатор и состояние, свёрнутое проекцией. */
final case class AuctionSnapshotView(auctionId: UUID, auction: Auction)

/** Какие аукционы перечислить (ADR-047): черновик не входит ни в один список. */
enum AuctionListing {
  case Active
  case Finished
}

/**
 * Чтение read model аукционов. Его пишет проекция, поэтому ответ согласован в конечном счёте; entity чтение не
 * поднимает — карточка каждой сходки иначе будила бы пустой журнал (ADR-047).
 */
trait AuctionViews {
  def byMeetup(meetup: MeetupId): Future[Option[AuctionSnapshotView]]

  /** Аукционы выборки по возрастанию `auction_id`, строго после `after`, не больше `limit`. */
  def page(listing: AuctionListing, after: Option[UUID], limit: Int): Future[List[AuctionSnapshotView]]
}

object AuctionViews {

  /**
   * Статусы выборки — значения `auction_view.status`. Активные — от `scheduled` до `in_final`, прошедшие — `finished`;
   * проекция пишет `draft`, `scheduled` и `prebidding`, остальные статусы приносит перерыв и финал (PER-334).
   */
  def statuses(listing: AuctionListing): List[String] =
    listing match {
      case AuctionListing.Active => List("scheduled", "prebidding", "settling", "on_break", "lineup_frozen", "in_final")
      case AuctionListing.Finished => List("finished")
    }
}
