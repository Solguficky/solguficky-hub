package auction.persistence

import auction.aggregate.AuctionState
import auction.catalog.LotId
import auction.projection.AuctionSnapshotView
import auction.projection.AuctionViewJson
import auction.projection.AuctionWatchView
import auction.projection.AuctionWatchViews
import auction.projection.LotViewJson
import org.apache.pekko.actor.typed.ActorSystem
import org.apache.pekko.persistence.jdbc.db.SlickExtension
import slick.jdbc.JdbcBackend.Database
import slick.jdbc.PostgresProfile.api.*
import slick.jdbc.TransactionIsolation

import java.util.UUID
import scala.concurrent.ExecutionContext
import scala.concurrent.Future

/**
 * Состояние для потока через пул плагина журнала: аукцион и лоты его состава — в одной транзакции `REPEATABLE READ`, то
 * есть из одного снимка базы.
 */
final class SlickAuctionWatchViews(database: Database, auctions: SlickAuctionViews, lots: SlickLotViews)(using
    ExecutionContext
) extends AuctionWatchViews {

  def read(auctionId: UUID): Future[Option[AuctionWatchView]] =
    database.run(
      auctions
        .byIdAction(auctionId)
        .flatMap {
          case None => DBIO.successful(None)
          case Some(auction) =>
            orderAction(auction).flatMap {
              case Nil => DBIO.successful(Some(AuctionWatchView(auction, Nil)))
              case order =>
                lots
                  .lotsAction(order.map(_.value))
                  .map(found => Some(AuctionWatchView(auction, AuctionWatchView.arrange(order, found))))
            }
        }
        .transactionally
        .withTransactionIsolation(TransactionIsolation.RepeatableRead)
    )

  /**
   * Состав из снимка, а у завершённого аукциона — из `auction_lineup` (PER-712): снимок `Finished` состава не несёт, а
   * последнее сообщение потока обязано нести исходы его лотов, и проданного последним тоже. Строка без места — состав,
   * замороженный до места в `auction_lineup`, и она встаёт после остальных по `lot_id`.
   */
  private def orderAction(auction: AuctionSnapshotView): DBIO[List[LotId]] =
    auction.auction.state match {
      case AuctionState.Finished(_, _) =>
        sql"""SELECT lot_id::text FROM auction_lineup WHERE auction_id = ${auction.auctionId.toString}::uuid
              ORDER BY position NULLS LAST, lot_id""".as[String].map(_.toList.map(id => LotId(UUID.fromString(id))))
      case _ => DBIO.successful(AuctionWatchView.lineupOf(auction.auction))
    }
}

object SlickAuctionWatchViews {

  def apply(system: ActorSystem[?]): SlickAuctionWatchViews = {
    val database = SlickExtension(system).database(system.settings.config.getConfig("jdbc-journal")).database
    given ExecutionContext = system.executionContext
    new SlickAuctionWatchViews(
      database,
      new SlickAuctionViews(database, AuctionViewJson(system)),
      new SlickLotViews(database, LotViewJson(system))
    )
  }
}
