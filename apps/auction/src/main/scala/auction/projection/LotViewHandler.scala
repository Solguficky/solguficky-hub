package auction.projection

import auction.entity.StoredLot
import auction.entity.StoredLotEvent
import auction.entity.StoredMoney
import auction.watch.AuctionChanges
import com.fasterxml.jackson.databind.ObjectMapper
import org.apache.pekko.actor.typed.ActorSystem
import org.apache.pekko.projection.eventsourced.EventEnvelope
import org.apache.pekko.persistence.typed.PersistenceId
import org.apache.pekko.projection.jdbc.JdbcSession
import org.apache.pekko.projection.jdbc.scaladsl.JdbcHandler
import org.apache.pekko.serialization.SerializationExtension
import org.apache.pekko.serialization.jackson.JacksonObjectMapperProvider

import java.sql.Connection
import java.sql.Timestamp
import java.time.Instant
import java.util.UUID
import scala.util.Using

/**
 * Снимок лота в `lot_view.state` — тот же JSON модели хранения, что snapshot entity (ADR-058), тем же настроенным
 * mapper'ом `jackson-json`: даты строками, без чисел с плавающей точкой.
 */
final class LotViewJson(mapper: ObjectMapper) {
  def write(stored: StoredLot): String = mapper.writeValueAsString(stored)
  def read(json: String): StoredLot = mapper.readValue(json, classOf[StoredLot])
}

object LotViewHandler {
  def apply(system: ActorSystem[?]): LotViewHandler =
    new LotViewHandler(
      LotRows("lot_view", LotViewJson(system)),
      LotJournalGap(SerializationExtension(system.classicSystem))
    )
}

object LotViewJson {
  def apply(system: ActorSystem[?]): LotViewJson =
    new LotViewJson(JacksonObjectMapperProvider(system).getOrCreate("jackson-json", None))
}

/**
 * Обработчик проекции лота: одно событие — одна транзакция `JdbcSession`, в которой `JdbcProjection.exactlyOnce` пишет
 * и offset (ADR-045). Поэтому вся запись идёт только через соединение сессии: соединение пула Slick вышло бы из
 * транзакции, и read model могла бы оказаться впереди offset.
 *
 * Повторная доставка события после отката пропускается по версии строки ([[LotView.project]]), так что обработчик
 * идемпотентен и без offset. Факты статистики — участники лота и стартовая цена (PER-481) — пишутся той же транзакцией
 * и только из применённых событий, поэтому повтор не меняет и их. Пропуск номера в потоке тега дочитывается из журнала
 * лота ([[LotJournalGap]]).
 *
 * Записанная строка объявляет свой аукцион сигналом той же транзакции ([[AuctionChanges.announce]]): потоки
 * `WatchAuction` перечитывают его после коммита.
 */
final class LotViewHandler(rows: LotRows, gap: LotJournalGap)
    extends JdbcHandler[EventEnvelope[StoredLotEvent], JdbcSession] {

  override def process(session: JdbcSession, envelope: EventEnvelope[StoredLotEvent]): Unit = {
    val lotId = UUID.fromString(PersistenceId.extractEntityId(envelope.persistenceId))
    session.withConnection { connection =>
      val before = rows.current(connection, lotId)
      val events = gap.events(connection, before, lotId, envelope.persistenceId, envelope.sequenceNr, envelope.event)
      LotView.fold(before, lotId, events) match {
        case Left(defect) => throw new LotViewDefectException(defect)
        case Right(folded) =>
          folded.row.foreach { row =>
            rows.write(connection, before.fold(0L)(_.version), row)
            AuctionChanges.announce(connection, row.auctionId)
          }
          folded.bids.foreach(record(connection, _))
          folded.participants.distinct.foreach(addParticipant(connection, lotId, _))
          folded.startingPrice.foreach(recordStartingPrice(connection, lotId, _))
          folded.heldPrice.foreach(recordHeldPrice(connection, lotId, _))
          folded.resumedSequence.foreach(recordResumed(connection, lotId, _, folded.resumedAt))
          folded.removals.foreach(recordRemoval(connection, _))
      }
    }
  }

  /**
   * Снятие участника (ADR-072, PER-658): его ставки и участие помечаются снятыми, а снятие ложится в хронологию. Строки
   * ставок и участия пишутся раньше в той же транзакции, а после снятия у снятого их не бывает (И-22), поэтому пометка
   * накрывает всё, что у него есть. Повтор события пропускает версия строки лота, а `ON CONFLICT` — на перестройку.
   */
  private def recordRemoval(connection: Connection, removal: RemovalRecord): Unit = {
    List(
      "UPDATE lot_bid SET removed = true WHERE lot_id = ? AND participant_id = ?",
      "UPDATE lot_participant SET removed = true WHERE lot_id = ? AND participant_id = ?"
    ).foreach { sql =>
      Using.resource(connection.prepareStatement(sql)) { statement =>
        statement.setObject(1, removal.lotId)
        statement.setObject(2, removal.participant)
        statement.executeUpdate()
      }
    }
    Using.resource(
      connection.prepareStatement(
        """INSERT INTO lot_removal (lot_id, sequence, minor_units, currency, leader_id, occurred_at)
          |VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (lot_id, sequence) DO NOTHING""".stripMargin
      )
    ) { statement =>
      statement.setObject(1, removal.lotId)
      statement.setLong(2, removal.sequence)
      statement.setLong(3, removal.minorUnits)
      statement.setString(4, removal.currency)
      statement.setObject(5, removal.leader.orNull)
      statement.setTimestamp(6, Timestamp.from(removal.occurredAt))
      statement.executeUpdate()
    }
  }

  // Строка участника не удаляется: отзыв лимита участия не снимает, а повтор гасит первичный ключ. Снятого участника
  // помечает `recordRemoval`.
  private def addParticipant(connection: Connection, lotId: UUID, participant: UUID): Unit =
    Using.resource(
      connection.prepareStatement(
        "INSERT INTO lot_participant (lot_id, participant_id) VALUES (?, ?) ON CONFLICT (lot_id, participant_id) DO NOTHING"
      )
    ) { statement =>
      statement.setObject(1, lotId)
      statement.setObject(2, participant)
      statement.executeUpdate()
    }

  // `LotOpened` у лота один: `ON CONFLICT` здесь только на случай перестройки поверх уже записанной строки.
  private def recordStartingPrice(connection: Connection, lotId: UUID, price: StoredMoney): Unit =
    Using.resource(
      connection.prepareStatement(
        """INSERT INTO lot_starting_price (lot_id, minor_units, currency) VALUES (?, ?, ?)
          |ON CONFLICT (lot_id) DO UPDATE SET minor_units = EXCLUDED.minor_units, currency = EXCLUDED.currency""".stripMargin
      )
    ) { statement =>
      statement.setObject(1, lotId)
      statement.setLong(2, price.minorUnits)
      statement.setString(3, price.currency)
      statement.executeUpdate()
    }

  // `LotHeldForFinal` у лота один (в `Held` лот приходит из торгов один раз), а `ON CONFLICT` — на случай перестройки.
  private def recordHeldPrice(connection: Connection, lotId: UUID, price: StoredMoney): Unit =
    Using.resource(
      connection.prepareStatement(
        """INSERT INTO lot_hold (lot_id, minor_units, currency) VALUES (?, ?, ?)
          |ON CONFLICT (lot_id) DO UPDATE SET minor_units = EXCLUDED.minor_units, currency = EXCLUDED.currency""".stripMargin
      )
    ) { statement =>
      statement.setObject(1, lotId)
      statement.setLong(2, price.minorUnits)
      statement.setString(3, price.currency)
      statement.executeUpdate()
    }

  // Номер `LotResumed`: ставки финала — строки `lot_bid` с номером больше него. Возврат в торги у лота один. Время
  // возврата (PER-819) читает экран зала: «лот в торгах уже столько-то».
  private def recordResumed(connection: Connection, lotId: UUID, sequence: Long, at: Option[Instant]): Unit =
    Using.resource(
      connection.prepareStatement(
        """INSERT INTO lot_resume (lot_id, sequence, occurred_at) VALUES (?, ?, ?)
          |ON CONFLICT (lot_id) DO UPDATE SET sequence = EXCLUDED.sequence, occurred_at = EXCLUDED.occurred_at""".stripMargin
      )
    ) { statement =>
      statement.setObject(1, lotId)
      statement.setLong(2, sequence)
      statement.setTimestamp(3, at.map(Timestamp.from).orNull)
      statement.executeUpdate()
    }

  private def record(connection: Connection, bid: BidRecord): Unit =
    Using.resource(
      connection.prepareStatement(
        """INSERT INTO lot_bid (lot_id, sequence, bid_id, participant_id, minor_units, currency, origin, source,
          |occurred_at, window_start_minor_units) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          |ON CONFLICT (lot_id, sequence) DO NOTHING""".stripMargin
      )
    ) { statement =>
      statement.setObject(1, bid.lotId)
      statement.setLong(2, bid.sequence)
      statement.setObject(3, bid.bidId)
      statement.setObject(4, bid.participant)
      statement.setLong(5, bid.minorUnits)
      statement.setString(6, bid.currency)
      statement.setString(7, bid.origin)
      statement.setString(8, bid.source.orNull)
      statement.setTimestamp(9, Timestamp.from(bid.occurredAt))
      bid.windowStart match {
        case Some(start) => statement.setLong(10, start)
        case None => statement.setNull(10, java.sql.Types.BIGINT)
      }
      statement.executeUpdate()
    }
}

final class LotViewDefectException(val defect: LotViewDefect) extends RuntimeException(s"lot view defect: $defect")
