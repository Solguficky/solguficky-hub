package auction.persistence

import auction.catalog.ImageVersion
import auction.catalog.LotCard
import auction.catalog.LotId
import auction.catalog.LotTitle
import auction.entity.LotJournal
import auction.lot.CurrencyCode
import auction.lot.Money
import auction.projection.DayLotStatisticsView
import auction.projection.LotImageView
import auction.projection.BidRecord
import auction.projection.LotSnapshotView
import auction.projection.LotStatisticsView
import auction.projection.LotViewJson
import auction.projection.LotViews
import org.apache.pekko.actor.typed.ActorSystem
import org.apache.pekko.persistence.jdbc.db.SlickExtension
import slick.jdbc.GetResult
import slick.jdbc.JdbcBackend.Database
import slick.jdbc.PostgresProfile.api.*

import java.sql.Timestamp
import java.time.Instant
import java.util.UUID
import scala.concurrent.ExecutionContext
import scala.concurrent.Future

/**
 * Read model лота через пул плагина журнала и plain SQL, как каталог. Карточка присоединяется из `lot_catalog` тем же
 * запросом, а число ставок считается по `lot_bid`: снимок торгов, карточка и счёт приходят из одного чтения. Байты
 * изображения снимок не выбирает — только версию; их читает отдельный `image`.
 */
final class SlickLotViews(database: Database, json: LotViewJson)(using ExecutionContext) extends LotViews {

  // Число ставок лота `v` — одно выражение у снимка и у статистики: контракт требует, чтобы они совпадали.
  private val BidCountSql = "(SELECT COUNT(*) FROM lot_bid b WHERE b.lot_id = v.lot_id)"

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
    LotSnapshotView(lotId, auctionId, version, lot, card, row.nextLong())
  }

  private given GetResult[LotImageView] = GetResult { row =>
    LotImageView(IArray.unsafeFromArray(row.nextBytes()), row.nextString(), row.nextString())
  }

  def find(lotId: UUID): Future[Option[LotSnapshotView]] =
    database.run(
      sql"""SELECT v.lot_id::text, v.auction_id::text, v.version, v.state::text, c.title, c.description,
                   c.image_version, #$BidCountSql
            FROM lot_view v LEFT JOIN lot_catalog c ON c.lot_id = v.lot_id
            WHERE v.lot_id = ${lotId.toString}::uuid""".as[LotSnapshotView].headOption
    )

  /** Лоты по идентификаторам в любом порядке; лот, которого read model не знает, не отдаётся. */
  private[persistence] def lotsAction(lotIds: List[UUID]): DBIO[Vector[LotSnapshotView]] = {
    val ids = lotIds.map(_.toString).mkString("{", ",", "}")
    sql"""SELECT v.lot_id::text, v.auction_id::text, v.version, v.state::text, c.title, c.description,
                 c.image_version, #$BidCountSql
          FROM lot_view v LEFT JOIN lot_catalog c ON c.lot_id = v.lot_id
          WHERE v.lot_id = ANY($ids::uuid[])""".as[LotSnapshotView]
  }

  def page(auctionId: UUID, after: Option[UUID], limit: Int): Future[List[LotSnapshotView]] = {
    // Нулевой UUID меньше любого UUIDv7, поэтому первая страница — тот же запрос без второй ветки.
    val from = after.getOrElse(new UUID(0L, 0L)).toString
    database.run(
      sql"""SELECT v.lot_id::text, v.auction_id::text, v.version, v.state::text, c.title, c.description,
                   c.image_version, #$BidCountSql
            FROM lot_view v LEFT JOIN lot_catalog c ON c.lot_id = v.lot_id
            WHERE v.auction_id = ${auctionId.toString}::uuid AND v.lot_id > $from::uuid
            ORDER BY v.lot_id LIMIT $limit""".as[LotSnapshotView].map(_.toList)
    )
  }

  def registryPage(auctionId: UUID, after: Option[UUID], limit: Int): Future[List[LotSnapshotView]] = {
    val from = after.getOrElse(new UUID(0L, 0L)).toString
    database.run(
      sql"""SELECT v.lot_id::text, v.auction_id::text, v.version, v.state::text, c.title, c.description,
                   c.image_version, #$BidCountSql
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

  private given GetResult[LotStatisticsView] = GetResult { row =>
    val lotId = UUID.fromString(row.nextString())
    val lot = LotJournal.restoreLot(json.read(row.nextString()))
    val start = money(row.nextLongOption(), row.nextStringOption())
    val bidCount = row.nextLong()
    val participantCount = row.nextLong()
    val lastBidAt = row.nextTimestampOption().map(_.toInstant)
    val heldPrice = money(row.nextLongOption(), row.nextStringOption())
    val inLineup = row.nextBoolean()
    val finalBidCount = row.nextLong()
    // Обеих метрик финала нет у лота вне состава, даже если он был удержан и в состав не попал (PER-608).
    LotStatisticsView(
      lotId,
      lot,
      start,
      bidCount,
      participantCount,
      lastBidAt,
      if (inLineup) heldPrice else None,
      if (inLineup) Some(finalBidCount) else None
    )
  }

  private def money(minorUnits: Option[Long], currency: Option[String]): Option[Money] =
    (minorUnits, currency) match {
      case (Some(minorUnits), Some(currency)) => Some(Money(minorUnits, CurrencyCode(currency)))
      case _ => None
    }

  def statistics(auctionId: UUID): Future[List[LotStatisticsView]] =
    database.run(
      sql"""SELECT v.lot_id::text, v.state::text, s.minor_units, s.currency, #$BidCountSql,
                   (SELECT COUNT(*) FROM lot_participant p WHERE p.lot_id = v.lot_id),
                   (SELECT b.occurred_at FROM lot_bid b WHERE b.lot_id = v.lot_id ORDER BY b.sequence DESC LIMIT 1),
                   h.minor_units, h.currency, (l.lot_id IS NOT NULL),
                   (SELECT COUNT(*) FROM lot_bid b WHERE b.lot_id = v.lot_id
                      AND res.sequence IS NOT NULL AND b.sequence > res.sequence)
            FROM auction_lot r JOIN lot_view v ON v.lot_id = r.lot_id
            LEFT JOIN lot_starting_price s ON s.lot_id = v.lot_id
            LEFT JOIN lot_hold h ON h.lot_id = v.lot_id
            LEFT JOIN lot_resume res ON res.lot_id = v.lot_id
            LEFT JOIN auction_lineup l ON l.auction_id = r.auction_id AND l.lot_id = v.lot_id
            WHERE r.auction_id = ${auctionId.toString}::uuid
            ORDER BY r.lot_id""".as[LotStatisticsView].map(_.toList)
    )

  private given GetResult[DayLotStatisticsView] = GetResult { row =>
    DayLotStatisticsView(
      lotId = UUID.fromString(row.nextString()),
      bidCount = row.nextLong(),
      maxPrice = money(row.nextLongOption(), row.nextStringOption()),
      priceBefore = money(row.nextLongOption(), row.nextStringOption())
    )
  }

  /**
   * Статистика лота за окно (PER-492). Цена и её валюта берутся одной строкой ставки — той, что несёт максимум окна, —
   * поэтому у лота с одной валютой нет второго чтения, которое могло бы её разойтись. Цена к открытию окна — тоже
   * строка: последняя ставка до окна по номеру события, а без ставок — стартовая цена `LotOpened`. Обе ветки пусты
   * только у лота без ставок вовсе и без стартовой цены, и тогда роста у него нет.
   */
  def dayStatistics(auctionId: UUID, from: Instant, until: Instant): Future[List[DayLotStatisticsView]] = {
    val windowFrom = Timestamp.from(from)
    val windowUntil = Timestamp.from(until)
    database.run(
      sql"""SELECT v.lot_id::text,
                   (SELECT COUNT(*) FROM lot_bid b
                      WHERE b.lot_id = v.lot_id AND b.occurred_at >= $windowFrom AND b.occurred_at < $windowUntil),
                   t.minor_units, t.currency,
                   COALESCE(p.minor_units, s.minor_units), COALESCE(p.currency, s.currency)
            FROM auction_lot r JOIN lot_view v ON v.lot_id = r.lot_id
            LEFT JOIN LATERAL (
              SELECT b.minor_units, b.currency
              FROM lot_bid b
              WHERE b.lot_id = v.lot_id AND b.occurred_at >= $windowFrom AND b.occurred_at < $windowUntil
              ORDER BY b.minor_units DESC, b.sequence DESC LIMIT 1
            ) t ON TRUE
            LEFT JOIN LATERAL (
              SELECT b.minor_units, b.currency
              FROM lot_bid b
              WHERE b.lot_id = v.lot_id AND b.occurred_at < $windowFrom
              ORDER BY b.sequence DESC LIMIT 1
            ) p ON TRUE
            LEFT JOIN lot_starting_price s ON s.lot_id = v.lot_id
            WHERE r.auction_id = ${auctionId.toString}::uuid
            ORDER BY r.lot_id""".as[DayLotStatisticsView].map(_.toList)
    )
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
