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
import auction.projection.HistoryRecord
import auction.projection.LotContest
import auction.projection.LotSetView
import auction.projection.LotSnapshotView
import auction.projection.LotStatisticsView
import auction.projection.LotViewJson
import auction.projection.LotViews
import org.apache.pekko.actor.typed.ActorSystem
import org.apache.pekko.persistence.jdbc.db.SlickExtension
import slick.jdbc.GetResult
import slick.jdbc.JdbcBackend.Database
import slick.jdbc.PostgresProfile.api.*
import slick.jdbc.TransactionIsolation

import java.sql.Timestamp
import java.time.Instant
import java.util.UUID
import scala.concurrent.ExecutionContext
import scala.concurrent.Future

/**
 * Read model лота через пул плагина журнала и plain SQL, как каталог. Карточка присоединяется из `lot_catalog` тем же
 * запросом, а число ставок считается по `lot_bid`: снимок торгов, карточка и счёт приходят из одного чтения. Байты
 * изображения и фото снимок не выбирает — только версии; их читают отдельные `image` и `photo`.
 */
final class SlickLotViews(database: Database, json: LotViewJson)(using ExecutionContext) extends LotViews {

  // Число ставок лота `v` — одно выражение у снимка и у статистики: контракт требует, чтобы они совпадали. Ставки
  // снятого участника не считаются (ADR-072, PER-658).
  private val BidCountSql = "(SELECT COUNT(*) FROM lot_bid b WHERE b.lot_id = v.lot_id AND NOT b.removed)"

  // Сет лота (ADR-073) — полный сет аукциона лота, в котором лот есть; лот входит не больше чем в один сет.
  private val LotSetSql =
    """LEFT JOIN LATERAL (SELECT s.lot_set_id, s.name, s.lot_ids, s.collector_id FROM auction_lot_set s
      |  WHERE s.auction_id = v.auction_id AND v.lot_id = ANY(s.lot_ids) AND cardinality(s.lot_ids) >= 2
      |  LIMIT 1) s ON true""".stripMargin

  private val LotSetColumnsSql = "s.lot_set_id::text, s.name, s.lot_ids::text[], s.collector_id::text"

  // Фото карточки (ADR-057, дополнение 2026-10-24): id и версии без байтов, в порядке показа.
  private val PhotosSql = LotPhotoColumns.sql("v.lot_id")

  private given GetResult[LotSnapshotView] = GetResult { row =>
    val lotId = UUID.fromString(row.nextString())
    val auctionId = UUID.fromString(row.nextString())
    val version = row.nextLong()
    val lot = LotJournal.restoreLot(json.read(row.nextString()))
    val card = (row.nextStringOption(), row.nextStringOption(), row.nextStringOption(), row.nextStringOption()).match {
      case (Some(title), Some(description), image, photos) =>
        Some(
          LotCard(
            LotId(lotId),
            restored(lotId, title),
            description,
            image.map(ImageVersion(_)),
            LotPhotoColumns.parse(photos)
          )
        )
      case _ => None
    }
    val bidCount = row.nextLong()
    val lotSet = (row.nextStringOption(), row.nextStringOption(), Option(row.nextObject())).match {
      case (Some(set), Some(name), Some(lots: java.sql.Array)) =>
        val ids = lots.getArray.asInstanceOf[Array[String]].toList.map(UUID.fromString)
        Some(LotSetView(UUID.fromString(set), name, ids, row.nextStringOption().map(UUID.fromString)))
      case _ =>
        row.skip
        None
    }
    LotSnapshotView(lotId, auctionId, version, lot, card, bidCount, lotSet)
  }

  private given GetResult[LotImageView] = GetResult { row =>
    LotImageView(IArray.unsafeFromArray(row.nextBytes()), row.nextString(), row.nextString())
  }

  def find(lotId: UUID): Future[Option[LotSnapshotView]] =
    database.run(
      sql"""SELECT v.lot_id::text, v.auction_id::text, v.version, v.state::text, c.title, c.description,
                   c.image_version, #$PhotosSql, #$BidCountSql, #$LotSetColumnsSql
            FROM lot_view v LEFT JOIN lot_catalog c ON c.lot_id = v.lot_id #$LotSetSql
            WHERE v.lot_id = ${lotId.toString}::uuid""".as[LotSnapshotView].headOption
    )

  /** Лоты по идентификаторам в любом порядке; лот, которого read model не знает, не отдаётся. */
  private[persistence] def lotsAction(lotIds: List[UUID]): DBIO[Vector[LotSnapshotView]] = {
    val ids = lotIds.map(_.toString).mkString("{", ",", "}")
    sql"""SELECT v.lot_id::text, v.auction_id::text, v.version, v.state::text, c.title, c.description,
                 c.image_version, #$PhotosSql, #$BidCountSql, #$LotSetColumnsSql
          FROM lot_view v LEFT JOIN lot_catalog c ON c.lot_id = v.lot_id #$LotSetSql
          WHERE v.lot_id = ANY($ids::uuid[])""".as[LotSnapshotView]
  }

  def page(auctionId: UUID, after: Option[UUID], limit: Int): Future[List[LotSnapshotView]] = {
    // Нулевой UUID меньше любого UUIDv7, поэтому первая страница — тот же запрос без второй ветки.
    val from = after.getOrElse(new UUID(0L, 0L)).toString
    database.run(
      sql"""SELECT v.lot_id::text, v.auction_id::text, v.version, v.state::text, c.title, c.description,
                   c.image_version, #$PhotosSql, #$BidCountSql, #$LotSetColumnsSql
            FROM lot_view v LEFT JOIN lot_catalog c ON c.lot_id = v.lot_id #$LotSetSql
            WHERE v.auction_id = ${auctionId.toString}::uuid AND v.lot_id > $from::uuid
            ORDER BY v.lot_id LIMIT $limit""".as[LotSnapshotView].map(_.toList)
    )
  }

  def registryPage(auctionId: UUID, after: Option[UUID], limit: Int): Future[List[LotSnapshotView]] = {
    val from = after.getOrElse(new UUID(0L, 0L)).toString
    database.run(
      sql"""SELECT v.lot_id::text, v.auction_id::text, v.version, v.state::text, c.title, c.description,
                   c.image_version, #$PhotosSql, #$BidCountSql, #$LotSetColumnsSql
            FROM auction_lot r JOIN lot_view v ON v.lot_id = r.lot_id
            LEFT JOIN lot_catalog c ON c.lot_id = v.lot_id #$LotSetSql
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

  // Видимость — та же, что у `image`: фото лота, которого `find` не отдаёт, не отдаётся.
  def photo(lotId: UUID, photoId: UUID): Future[Option[LotImageView]] =
    database.run(
      sql"""SELECT p.content, p.media_type, p.version
            FROM lot_view v JOIN lot_photo p ON p.lot_id = v.lot_id
            WHERE v.lot_id = ${lotId.toString}::uuid AND p.photo_id = ${photoId.toString}::uuid"""
        .as[LotImageView]
        .headOption
    )
  // Строка ставки и строка снятия — одна выборка с общими колонками: у снятия пусты поля ставки, у ставки — лидер.
  private given GetResult[HistoryRecord] = GetResult { row =>
    val lotId = UUID.fromString(row.nextString())
    val sequence = row.nextLong()
    val kind = row.nextString()
    val bidId = row.nextStringOption()
    val participant = row.nextStringOption()
    val minorUnits = row.nextLong()
    val currency = row.nextString()
    val origin = row.nextStringOption()
    val source = row.nextStringOption()
    val removed = row.nextBoolean()
    val leader = row.nextStringOption().map(UUID.fromString)
    val occurredAt = row.nextTimestamp().toInstant
    kind match {
      case "bid" =>
        HistoryRecord.Bid(
          BidRecord(
            lotId = lotId,
            sequence = sequence,
            bidId = UUID.fromString(bidId.get),
            participant = UUID.fromString(participant.get),
            minorUnits = minorUnits,
            currency = currency,
            origin = origin.get,
            source = source,
            occurredAt = occurredAt,
            removed = removed
          )
        )
      case _ => HistoryRecord.Removal(sequence, minorUnits, currency, leader, occurredAt)
    }
  }

  def history(lotId: UUID, after: Option[Long], limit: Int): Future[Option[List[HistoryRecord]]] = {
    val id = lotId.toString
    // Номер события начинается с 1, поэтому первая страница — тот же запрос с нулём.
    val from = after.getOrElse(0L)
    val read = for {
      known <- sql"""SELECT 1 FROM lot_view WHERE lot_id = $id::uuid""".as[Int].headOption
      entries <- sql"""SELECT lot_id::text, sequence, 'bid', bid_id::text, participant_id::text, minor_units, currency,
                         origin, source, removed, NULL, occurred_at
                       FROM lot_bid WHERE lot_id = $id::uuid AND sequence > $from
                       UNION ALL
                       SELECT lot_id::text, sequence, 'removal', NULL, NULL, minor_units, currency,
                         NULL, NULL, false, leader_id::text, occurred_at
                       FROM lot_removal WHERE lot_id = $id::uuid AND sequence > $from
                       ORDER BY sequence LIMIT $limit""".as[HistoryRecord]
    } yield known.map(_ => entries.toList)
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

  // Запись хронологии вместе с её лотом: у строки снятия своего лота в `HistoryRecord` нет, а группировать надо.
  private given GetResult[(UUID, HistoryRecord)] = GetResult { row =>
    val lotId = UUID.fromString(row.nextString())
    (lotId, summon[GetResult[HistoryRecord]](row))
  }

  /**
   * Хронология каждого лота реестра — те же строки `lot_bid` и `lot_removal`, что у `history`, — по возрастанию номера
   * события. Из неё ядро [[LotContest]] считает борьбу за лот (PER-511); лот без ставок в выдачу не попадает.
   */
  private def chronicles(auctionId: UUID): DBIO[Map[UUID, List[HistoryRecord]]] =
    sql"""SELECT e.lot_id, e.* FROM (
            SELECT b.lot_id::text, b.sequence, 'bid', b.bid_id::text, b.participant_id::text, b.minor_units,
              b.currency, b.origin, b.source, b.removed, NULL, b.occurred_at
            FROM auction_lot r JOIN lot_bid b ON b.lot_id = r.lot_id
            WHERE r.auction_id = ${auctionId.toString}::uuid
            UNION ALL
            SELECT x.lot_id::text, x.sequence, 'removal', NULL, NULL, x.minor_units, x.currency,
              NULL, NULL, false, x.leader_id::text, x.occurred_at
            FROM auction_lot r JOIN lot_removal x ON x.lot_id = r.lot_id
            WHERE r.auction_id = ${auctionId.toString}::uuid
          ) e (lot_id, sequence, kind, bid_id, participant_id, minor_units, currency, origin, source, removed,
               leader_id, occurred_at)
          ORDER BY e.lot_id, e.sequence"""
      .as[(UUID, HistoryRecord)]
      .map(_.groupMap(_._1)(_._2).view.mapValues(_.toList).toMap)

  /**
   * Агрегаты лотов вместе с борьбой за каждый (PER-511): `contest` получает хронологию лота и отдаёт строку с
   * метриками. Агрегаты и хронология читаются одним снимком базы: иначе ставка между двумя запросами попала бы в одно и
   * не попала в другое.
   */
  private def withContest[A](auctionId: UUID, lots: DBIO[List[A]])(
      contest: (A, List[HistoryRecord]) => A
  )(lotId: A => UUID): Future[List[A]] =
    database.run(
      (for {
        rows <- lots
        chronicle <- chronicles(auctionId)
      } yield rows.map(row => contest(row, chronicle.getOrElse(lotId(row), Nil)))).transactionally
        .withTransactionIsolation(TransactionIsolation.RepeatableRead)
    )

  def statistics(auctionId: UUID): Future[List[LotStatisticsView]] =
    withContest(auctionId, statisticsAction(auctionId))((lot, history) => lot.copy(contest = LotContest.of(history)))(
      _.lotId
    )

  private def statisticsAction(auctionId: UUID): DBIO[List[LotStatisticsView]] =
    sql"""SELECT v.lot_id::text, v.state::text, s.minor_units, s.currency, #$BidCountSql,
                   (SELECT COUNT(*) FROM lot_participant p WHERE p.lot_id = v.lot_id AND NOT p.removed),
                   (SELECT b.occurred_at FROM lot_bid b WHERE b.lot_id = v.lot_id AND NOT b.removed
                      ORDER BY b.sequence DESC LIMIT 1),
                   h.minor_units, h.currency, (l.lot_id IS NOT NULL),
                   (SELECT COUNT(*) FROM lot_bid b WHERE b.lot_id = v.lot_id AND NOT b.removed
                      AND res.sequence IS NOT NULL AND b.sequence > res.sequence)
            FROM auction_lot r JOIN lot_view v ON v.lot_id = r.lot_id
            LEFT JOIN lot_starting_price s ON s.lot_id = v.lot_id
            LEFT JOIN lot_hold h ON h.lot_id = v.lot_id
            LEFT JOIN lot_resume res ON res.lot_id = v.lot_id
            LEFT JOIN auction_lineup l ON l.auction_id = r.auction_id AND l.lot_id = v.lot_id
            WHERE r.auction_id = ${auctionId.toString}::uuid
            ORDER BY r.lot_id""".as[LotStatisticsView].map(_.toList)

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
    val lots =
      sql"""SELECT v.lot_id::text,
                   (SELECT COUNT(*) FROM lot_bid b
                      WHERE b.lot_id = v.lot_id AND NOT b.removed
                        AND b.occurred_at >= $windowFrom AND b.occurred_at < $windowUntil),
                   t.minor_units, t.currency,
                   COALESCE(p.minor_units, s.minor_units), COALESCE(p.currency, s.currency)
            FROM auction_lot r JOIN lot_view v ON v.lot_id = r.lot_id
            LEFT JOIN LATERAL (
              SELECT b.minor_units, b.currency
              FROM lot_bid b
              WHERE b.lot_id = v.lot_id AND NOT b.removed
                AND b.occurred_at >= $windowFrom AND b.occurred_at < $windowUntil
              ORDER BY b.minor_units DESC, b.sequence DESC LIMIT 1
            ) t ON TRUE
            LEFT JOIN LATERAL (
              SELECT e.minor_units, e.currency
              FROM (
                SELECT b.sequence, b.minor_units, b.currency FROM lot_bid b
                WHERE b.lot_id = v.lot_id AND NOT b.removed AND b.occurred_at < $windowFrom
                UNION ALL
                SELECT x.sequence, x.minor_units, x.currency FROM lot_removal x
                WHERE x.lot_id = v.lot_id AND x.occurred_at < $windowFrom
              ) e
              ORDER BY e.sequence DESC LIMIT 1
            ) p ON TRUE
            LEFT JOIN lot_starting_price s ON s.lot_id = v.lot_id
            WHERE r.auction_id = ${auctionId.toString}::uuid
            ORDER BY r.lot_id""".as[DayLotStatisticsView].map(_.toList)
    withContest(auctionId, lots)((lot, history) => lot.copy(contest = LotContest.of(history, Some((from, until)))))(
      _.lotId
    )
  }

  def participantCount(auctionId: UUID): Future[Long] =
    database.run(
      sql"""SELECT COUNT(DISTINCT p.participant_id)
            FROM auction_lot r JOIN lot_participant p ON p.lot_id = r.lot_id
            WHERE r.auction_id = ${auctionId.toString}::uuid AND NOT p.removed""".as[Long].head
    )

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
