package auction.persistence

import auction.aggregate.AuctionState
import auction.entity.AuctionJournal
import auction.entity.LotJournal
import auction.lot.BidOrigin
import auction.lot.BidSource
import auction.lot.CurrencyCode
import auction.lot.LotState
import auction.lot.Money
import auction.lot.ParticipantId
import auction.projection.AuctionViewHandler
import auction.projection.AuctionViewJson
import auction.projection.AuctionWatchView
import auction.projection.LotViewJson
import auction.screen.RecentBid
import auction.screen.Screen
import auction.screen.ScreenImage
import auction.screen.ScreenReading
import auction.screen.ScreenViews
import auction.screen.SoldLot
import org.apache.pekko.actor.typed.ActorSystem
import org.apache.pekko.persistence.jdbc.db.SlickExtension
import slick.jdbc.GetResult
import slick.jdbc.JdbcBackend.Database
import slick.jdbc.PostgresProfile.api.*
import slick.jdbc.TransactionIsolation

import java.util.UUID
import scala.concurrent.ExecutionContext
import scala.concurrent.Future

/**
 * Чтение экрана через пул плагина журнала, одной транзакцией `REPEATABLE READ`, как у потока `WatchAuction`. Последние
 * ставки читаются только у лота, который экран показывает в торгах, а проданные лоты — только у завершённого или
 * отменённого аукциона: остальным состояниям они не нужны.
 */
final class SlickScreenViews(database: Database, auctions: AuctionViewJson, lots: SlickLotViews, lotJson: LotViewJson)(
    using ExecutionContext
) extends ScreenViews {

  def read(auctionId: UUID): Future[Option[ScreenReading]] =
    database.run(
      auctionAction(auctionId)
        .flatMap {
          case None => DBIO.successful(None)
          case Some((meetupId, auction)) =>
            val order = AuctionWatchView.lineupOf(auction)
            for {
              found <- if (order.isEmpty) DBIO.successful(Vector.empty) else lots.lotsAction(order.map(_.value))
              base = ScreenReading(auctionId, meetupId, auction, AuctionWatchView.arrange(order, found), Nil, Nil)
              bids <- Screen.shownLot(base).filter(view => isTrading(view.lot.state)) match {
                case Some(view) => recentBidsAction(view.lotId)
                case None => DBIO.successful(Nil)
              }
              sold <- auction.state match {
                case AuctionState.Finished(_, _) | AuctionState.Cancelled(_, _, _) => soldAction(auctionId)
                case _ => DBIO.successful(Nil)
              }
            } yield Some(base.copy(recentBids = bids, sold = sold))
        }
        .transactionally
        .withTransactionIsolation(TransactionIsolation.RepeatableRead)
    )

  def image(auctionId: UUID, lotId: UUID, version: String): Future[Option[ScreenImage]] =
    database.run(
      sql"""SELECT c.image, c.image_media_type
            FROM lot_view v JOIN lot_catalog c ON c.lot_id = v.lot_id
            WHERE v.lot_id = ${lotId.toString}::uuid AND v.auction_id = ${auctionId.toString}::uuid
              AND c.image IS NOT NULL AND c.image_version = $version"""
        .as[ScreenImage](using GetResult(row => ScreenImage(IArray.unsafeFromArray(row.nextBytes()), row.nextString())))
        .headOption
    )

  private def isTrading(state: LotState): Boolean =
    state match {
      case LotState.Trading(_) => true
      case _ => false
    }

  private def auctionAction(auctionId: UUID): DBIO[Option[(UUID, auction.aggregate.Auction)]] =
    sql"""SELECT meetup_id::text, state::text FROM auction_view
          WHERE auction_id = ${auctionId.toString}::uuid AND status <> ${AuctionViewHandler.Discarded}"""
      .as[(String, String)]
      .headOption
      .map(_.map((meetup, state) => UUID.fromString(meetup) -> AuctionJournal.restoreAuction(auctions.read(state))))

  // Порядок — журнала, а не часов: события одной команды делят время.
  private def recentBidsAction(lotId: UUID): DBIO[List[RecentBid]] =
    sql"""SELECT participant_id::text, minor_units, currency, origin, source FROM lot_bid
          WHERE lot_id = ${lotId.toString}::uuid AND NOT removed ORDER BY sequence DESC LIMIT ${Screen.RecentBids}"""
      .as[(String, Long, String, String, Option[String])]
      .map(_.toList.map { (participant, minor, currency, origin, source) =>
        RecentBid(
          ParticipantId(UUID.fromString(participant)),
          Money(minor, CurrencyCode(currency)),
          SlickScreenViews.origin(lotId, origin, source)
        )
      })

  // Все лоты, рождённые в аукционе, а не состав: проданный в перерыве лот из состава выпадает, но в итог входит.
  private def soldAction(auctionId: UUID): DBIO[List[SoldLot]] =
    sql"""SELECT v.state::text,
                 EXISTS (SELECT 1 FROM auction_lineup l WHERE l.auction_id = v.auction_id AND l.lot_id = v.lot_id)
          FROM lot_view v WHERE v.auction_id = ${auctionId.toString}::uuid"""
      .as[(String, Boolean)]
      .map(_.toList.flatMap { (state, inLineup) =>
        LotJournal.restoreLot(lotJson.read(state)).state match {
          case LotState.Sold(sale) => Some(SoldLot(sale.price, inLineup))
          case _ => None
        }
      })
}

object SlickScreenViews {

  /** Сочетания, которые пишет проекция (`grpc/HistoryMapping`); иное — строка, записанная в обход неё. */
  private[persistence] def origin(lotId: UUID, origin: String, source: Option[String]): BidOrigin =
    (origin, source) match {
      case ("Manual", Some(channel)) =>
        BidOrigin.Manual(
          BidSource.values
            .find(_.toString == channel)
            .getOrElse(throw IllegalStateException(s"lot_bid of lot $lotId holds source $channel"))
        )
      case ("Proxy", None) => BidOrigin.Proxy
      case _ => throw IllegalStateException(s"lot_bid of lot $lotId holds origin $origin with source $source")
    }

  def apply(system: ActorSystem[?]): SlickScreenViews = {
    val database = SlickExtension(system).database(system.settings.config.getConfig("jdbc-journal")).database
    given ExecutionContext = system.executionContext
    val lotJson = LotViewJson(system)
    new SlickScreenViews(database, AuctionViewJson(system), new SlickLotViews(database, lotJson), lotJson)
  }
}
