package auction.projection

import auction.entity.StoredLot
import auction.entity.StoredLotEvent
import com.fasterxml.jackson.databind.ObjectMapper
import org.apache.pekko.actor.typed.ActorSystem
import org.apache.pekko.projection.eventsourced.EventEnvelope
import org.apache.pekko.persistence.typed.PersistenceId
import org.apache.pekko.projection.jdbc.JdbcSession
import org.apache.pekko.projection.jdbc.scaladsl.JdbcHandler
import org.apache.pekko.serialization.Serialization
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
    new LotViewHandler(LotViewJson(system), SerializationExtension(system.classicSystem))
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
 * идемпотентен и без offset.
 *
 * Пропуск номера обработчик не принимает за дефект сразу: поток тега может не нести событие лота — его транзакция
 * закоммитилась позже окна, которое read journal ждёт номер `ordering`, событие записано до тегов или тег лота сменился
 * с числом срезов. Тогда пропущенные события дочитываются из журнала лота тем же соединением и сворачиваются вместе с
 * доставленным. Без этого один пропуск останавливал бы весь тег: проекция падала бы на нём при каждом рестарте.
 */
final class LotViewHandler(json: LotViewJson, serialization: Serialization)
    extends JdbcHandler[EventEnvelope[StoredLotEvent], JdbcSession] {

  override def process(session: JdbcSession, envelope: EventEnvelope[StoredLotEvent]): Unit = {
    val lotId = UUID.fromString(PersistenceId.extractEntityId(envelope.persistenceId))
    session.withConnection { connection =>
      val before = current(connection, lotId)
      val delivered = (envelope.sequenceNr, envelope.event)
      val events = LotView.project(before, lotId, envelope.sequenceNr, envelope.event) match {
        case Left(LotViewDefect.Gap(_, version, sequence)) =>
          missing(connection, envelope.persistenceId, version, sequence) :+ delivered
        case _ => Vector(delivered)
      }
      LotView.fold(before, lotId, events) match {
        case Left(defect) => throw new LotViewDefectException(defect)
        case Right((written, bids)) =>
          written.foreach(write(connection, before.fold(0L)(_.version), _))
          bids.foreach(record(connection, _))
      }
    }
  }

  /** События лота строго между версией read model и доставленным номером — из журнала, а не из потока тега. */
  private def missing(
      connection: Connection,
      persistenceId: String,
      version: Long,
      sequence: Long
  ): Vector[(Long, StoredLotEvent)] =
    Using.resource(
      connection.prepareStatement(
        """SELECT sequence_number, event_ser_id, event_ser_manifest, event_payload FROM event_journal
          |WHERE persistence_id = ? AND sequence_number > ? AND sequence_number < ? AND NOT deleted
          |ORDER BY sequence_number""".stripMargin
      )
    ) { statement =>
      statement.setString(1, persistenceId)
      statement.setLong(2, version)
      statement.setLong(3, sequence)
      Using.resource(statement.executeQuery()) { rows =>
        Iterator
          .continually(rows)
          .takeWhile(_.next())
          .map { row =>
            val event = serialization.deserialize(row.getBytes(4), row.getInt(2), row.getString(3)).get match {
              case stored: StoredLotEvent => stored
              case other => throw new IllegalStateException(s"lot journal row of type ${other.getClass.getName}")
            }
            row.getLong(1) -> event
          }
          .toVector
      }
    }

  private def current(connection: Connection, lotId: UUID): Option[LotViewRow] =
    Using.resource(
      connection.prepareStatement("SELECT auction_id, state::text FROM lot_view WHERE lot_id = ? FOR UPDATE")
    ) { statement =>
      statement.setObject(1, lotId)
      Using.resource(statement.executeQuery()) { rows =>
        if (rows.next()) Some(LotViewRow(lotId, rows.getObject(1, classOf[UUID]), json.read(rows.getString(2))))
        else None
      }
    }

  /**
   * Версия в условии — вторая защита от гонки двух писателей одного лота: тег лота читает один экземпляр проекции, и
   * строка, которую не удалось обновить, — дефект, а не повтор.
   */
  private def write(connection: Connection, previous: Long, row: LotViewRow): Unit =
    Using.resource(
      connection.prepareStatement(
        """INSERT INTO lot_view (lot_id, auction_id, version, state) VALUES (?, ?, ?, ?::jsonb)
          |ON CONFLICT (lot_id) DO UPDATE SET version = EXCLUDED.version, state = EXCLUDED.state
          |WHERE lot_view.version = ?""".stripMargin
      )
    ) { statement =>
      statement.setObject(1, row.lotId)
      statement.setObject(2, row.auctionId)
      statement.setLong(3, row.version)
      statement.setString(4, json.write(row.stored))
      statement.setLong(5, previous)
      if (statement.executeUpdate() != 1)
        throw new IllegalStateException(s"lot_view row of lot ${row.lotId} moved past version $previous")
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
