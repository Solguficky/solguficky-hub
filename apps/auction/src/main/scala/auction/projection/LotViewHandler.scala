package auction.projection

import auction.entity.StoredLot
import auction.entity.StoredLotEvent
import com.fasterxml.jackson.databind.ObjectMapper
import org.apache.pekko.actor.typed.ActorSystem
import org.apache.pekko.projection.eventsourced.EventEnvelope
import org.apache.pekko.persistence.typed.PersistenceId
import org.apache.pekko.projection.jdbc.JdbcSession
import org.apache.pekko.projection.jdbc.scaladsl.JdbcHandler
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
 */
final class LotViewHandler(json: LotViewJson) extends JdbcHandler[EventEnvelope[StoredLotEvent], JdbcSession] {

  override def process(session: JdbcSession, envelope: EventEnvelope[StoredLotEvent]): Unit = {
    val lotId = UUID.fromString(PersistenceId.extractEntityId(envelope.persistenceId))
    session.withConnection { connection =>
      LotView.project(current(connection, lotId), lotId, envelope.sequenceNr, envelope.event) match {
        case Left(defect) => throw new LotViewDefectException(defect)
        case Right(LotViewStep.Skip) => ()
        case Right(LotViewStep.Write(row, bid)) =>
          write(connection, row)
          bid.foreach(record(connection, _))
      }
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
  private def write(connection: Connection, row: LotViewRow): Unit =
    Using.resource(
      connection.prepareStatement(
        """INSERT INTO lot_view (lot_id, auction_id, version, state) VALUES (?, ?, ?, ?::jsonb)
          |ON CONFLICT (lot_id) DO UPDATE SET version = EXCLUDED.version, state = EXCLUDED.state
          |WHERE lot_view.version = EXCLUDED.version - 1""".stripMargin
      )
    ) { statement =>
      statement.setObject(1, row.lotId)
      statement.setObject(2, row.auctionId)
      statement.setLong(3, row.version)
      statement.setString(4, json.write(row.stored))
      if (statement.executeUpdate() != 1)
        throw new IllegalStateException(s"lot_view row of lot ${row.lotId} moved past version ${row.version - 1}")
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
