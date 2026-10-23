package auction.persistence

import auction.aggregate.MeetupId
import auction.entity.AuctionJournal
import auction.projection.AuctionListing
import auction.projection.AuctionSnapshotView
import auction.projection.AuctionViewHandler
import auction.projection.AuctionViewJson
import auction.projection.AuctionViews
import org.apache.pekko.actor.typed.ActorSystem
import org.apache.pekko.persistence.jdbc.db.SlickExtension
import slick.jdbc.GetResult
import slick.jdbc.JdbcBackend.Database
import slick.jdbc.PostgresProfile.api.*

import java.util.UUID
import scala.concurrent.ExecutionContext
import scala.concurrent.Future

/** Read model аукционов через пул плагина журнала и plain SQL, как read model лота. */
final class SlickAuctionViews(database: Database, json: AuctionViewJson)(using ExecutionContext) extends AuctionViews {

  private given GetResult[AuctionSnapshotView] = GetResult { row =>
    val auctionId = UUID.fromString(row.nextString())
    AuctionSnapshotView(auctionId, AuctionJournal.restoreAuction(json.read(row.nextString())))
  }

  def byMeetup(meetup: MeetupId): Future[Option[AuctionSnapshotView]] =
    database.run(
      sql"""SELECT auction_id::text, state::text FROM auction_view
            WHERE meetup_id = ${meetup.value.toString}::uuid
              AND status <> ${AuctionViewHandler.Discarded}""".as[AuctionSnapshotView].headOption
    )

  def byId(auctionId: UUID): Future[Option[AuctionSnapshotView]] =
    database.run(byIdAction(auctionId))

  private[persistence] def byIdAction(auctionId: UUID): DBIO[Option[AuctionSnapshotView]] =
    sql"""SELECT auction_id::text, state::text FROM auction_view
          WHERE auction_id = ${auctionId.toString}::uuid
            AND status <> ${AuctionViewHandler.Discarded}""".as[AuctionSnapshotView].headOption

  // Признак скрытия — поле `hidden` снимка в `state`: snapshot без него, записанный до признака, — видимый аукцион.
  def page(
      listing: AuctionListing,
      after: Option[UUID],
      limit: Int,
      revealHidden: Boolean
  ): Future[List[AuctionSnapshotView]] = {
    val statuses = AuctionViews.statuses(listing).mkString("{", ",", "}")
    val from = after.getOrElse(new UUID(0L, 0L)).toString
    database.run(
      sql"""SELECT auction_id::text, state::text FROM auction_view
            WHERE status = ANY($statuses::text[]) AND auction_id > $from::uuid
              AND ($revealHidden OR NOT coalesce((state ->> 'hidden')::boolean, false))
            ORDER BY auction_id LIMIT $limit""".as[AuctionSnapshotView].map(_.toList)
    )
  }
}

object SlickAuctionViews {

  def apply(system: ActorSystem[?]): SlickAuctionViews = {
    val database = SlickExtension(system).database(system.settings.config.getConfig("jdbc-journal")).database
    new SlickAuctionViews(database, AuctionViewJson(system))(using system.executionContext)
  }
}
