package auction.projection

import auction.entity.StoredLot
import auction.entity.StoredLotEvent
import auction.entity.StoredMoney
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
          folded.row.foreach(rows.write(connection, before.fold(0L)(_.version), _))
          folded.bids.foreach(record(connection, _))
          folded.participants.distinct.foreach(addParticipant(connection, lotId, _))
          folded.startingPrice.foreach(recordStartingPrice(connection, lotId, _))
      }
    }
  }

  // Строка участника не удаляется: отзыв лимита участия не снимает, а повтор гасит первичный ключ.
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

  private def record(connection: Connection, bid: BidRecord): Unit =
    Using.resource(
      connection.prepareStatement(
        """INSERT INTO lot_bid (lot_id, sequence, bid_id, participant_id, minor_units, currency, origin, source,
          |occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (lot_id, sequence) DO NOTHING""".stripMargin
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
      statement.executeUpdate()
    }
}

final class LotViewDefectException(val defect: LotViewDefect) extends RuntimeException(s"lot view defect: $defect")
