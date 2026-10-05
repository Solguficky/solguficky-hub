package auction.persistence

import auction.catalog.ImageVersion
import auction.catalog.LotCard
import auction.catalog.LotId
import auction.catalog.LotTitle
import auction.entity.LotJournal
import auction.projection.LotImageView
import auction.projection.BidRecord
import auction.projection.LotSnapshotView
import auction.projection.LotViewJson
import auction.projection.LotViews
import org.apache.pekko.actor.typed.ActorSystem
import org.apache.pekko.persistence.jdbc.db.SlickExtension
import slick.jdbc.GetResult
import slick.jdbc.JdbcBackend.Database
import slick.jdbc.PostgresProfile.api.*

import java.util.UUID
import scala.concurrent.ExecutionContext
import scala.concurrent.Future

/**
 * Read model лота через пул плагина журнала и plain SQL, как каталог. Карточка присоединяется из `lot_catalog` тем же
 * запросом: снимок торгов и карточка приходят из одного чтения. Байты изображения снимок не выбирает — только версию;
 * их читает отдельный `image`.
 */
final class SlickLotViews(database: Database, json: LotViewJson)(using ExecutionContext) extends LotViews {

  private given GetResult[LotSnapshotView] = GetResult { row =>
    val lotId = UUID.fromString(row.nextString())
    val auctionId = UUID.fromString(row.nextString())
    val version = row.nextLong()
    val lot = LotJournal.restoreLot(json.read(row.nextString()))
    val card = (row.nextStringOption(), row.nextStringOption(), row.nextStringOption()).match {
      case (Some(title), Some(description), image) =>
        Some(LotCard(LotId(lotId), restored(lotId, title), description, image.map(ImageVersion(_))))
      case _ => None
    }
    LotSnapshotView(lotId, auctionId, version, lot, card)
  }

  private given GetResult[LotImageView] = GetResult { row =>
    LotImageView(IArray.unsafeFromArray(row.nextBytes()), row.nextString(), row.nextString())
  }

  def find(lotId: UUID): Future[Option[LotSnapshotView]] =
    database.run(
      sql"""SELECT v.lot_id::text, v.auction_id::text, v.version, v.state::text, c.title, c.description,
                   c.image_version
            FROM lot_view v LEFT JOIN lot_catalog c ON c.lot_id = v.lot_id
            WHERE v.lot_id = ${lotId.toString}::uuid""".as[LotSnapshotView].headOption
    )

  def page(auctionId: UUID, after: Option[UUID], limit: Int): Future[List[LotSnapshotView]] = {
    // Нулевой UUID меньше любого UUIDv7, поэтому первая страница — тот же запрос без второй ветки.
    val from = after.getOrElse(new UUID(0L, 0L)).toString
    database.run(
      sql"""SELECT v.lot_id::text, v.auction_id::text, v.version, v.state::text, c.title, c.description,
                   c.image_version
            FROM lot_view v LEFT JOIN lot_catalog c ON c.lot_id = v.lot_id
            WHERE v.auction_id = ${auctionId.toString}::uuid AND v.lot_id > $from::uuid
            ORDER BY v.lot_id LIMIT $limit""".as[LotSnapshotView].map(_.toList)
    )
  }

  def registryPage(auctionId: UUID, after: Option[UUID], limit: Int): Future[List[LotSnapshotView]] = {
    val from = after.getOrElse(new UUID(0L, 0L)).toString
    database.run(
      sql"""SELECT v.lot_id::text, v.auction_id::text, v.version, v.state::text, c.title, c.description,
                   c.image_version
            FROM auction_lot r JOIN lot_view v ON v.lot_id = r.lot_id
            LEFT JOIN lot_catalog c ON c.lot_id = v.lot_id
            WHERE r.auction_id = ${auctionId.toString}::uuid AND r.lot_id > $from::uuid
            ORDER BY r.lot_id LIMIT $limit""".as[LotSnapshotView].map(_.toList)
    )
  }

  // Видимость — та же строка `lot_view`, что у `find`: лот, которого `GetLot` не отдаёт, изображения не отдаёт тоже.
  def image(lotId: UUID): Future[Option[LotImageView]] =
    database.run(
      sql"""SELECT c.image, c.image_media_type, c.image_version
            FROM lot_view v JOIN lot_catalog c ON c.lot_id = v.lot_id
            WHERE v.lot_id = ${lotId.toString}::uuid AND c.image IS NOT NULL""".as[LotImageView].headOption
    )
  private given GetResult[BidRecord] = GetResult { row =>
    BidRecord(
      lotId = UUID.fromString(row.nextString()),
      sequence = row.nextLong(),
      bidId = UUID.fromString(row.nextString()),
      participant = UUID.fromString(row.nextString()),
      minorUnits = row.nextLong(),
      currency = row.nextString(),
      origin = row.nextString(),
      source = row.nextStringOption(),
      occurredAt = row.nextTimestamp().toInstant
    )
  }

  def history(lotId: UUID, after: Option[Long], limit: Int): Future[Option[List[BidRecord]]] = {
    val id = lotId.toString
    // Номер события начинается с 1, поэтому первая страница — тот же запрос с нулём.
    val from = after.getOrElse(0L)
    val read = for {
      known <- sql"""SELECT 1 FROM lot_view WHERE lot_id = $id::uuid""".as[Int].headOption
      bids <- sql"""SELECT lot_id::text, sequence, bid_id::text, participant_id::text, minor_units, currency, origin,
                       source, occurred_at
                FROM lot_bid WHERE lot_id = $id::uuid AND sequence > $from
                ORDER BY sequence LIMIT $limit""".as[BidRecord]
    } yield known.map(_ => bids.toList)
    database.run(read)
  }

  // Та же защита, что у SlickLotCatalogStore: строка с пустым по типу названием — запись в обход сервиса.
  private def restored(lotId: UUID, title: String): LotTitle =
    LotTitle(title).getOrElse(throw IllegalStateException(s"lot_catalog holds a blank title for lot $lotId"))
}

object SlickLotViews {

  def apply(system: ActorSystem[?]): SlickLotViews = {
    val database = SlickExtension(system).database(system.settings.config.getConfig("jdbc-journal")).database
    new SlickLotViews(database, LotViewJson(system))(using system.executionContext)
  }
}
