package auction.projection

import auction.entity.StoredAuction
import auction.entity.StoredAuctionEvent
import com.fasterxml.jackson.databind.ObjectMapper
import org.apache.pekko.actor.typed.ActorSystem
import org.apache.pekko.persistence.typed.PersistenceId
import org.apache.pekko.projection.eventsourced.EventEnvelope
import org.apache.pekko.projection.jdbc.JdbcSession
import org.apache.pekko.projection.jdbc.scaladsl.JdbcHandler
import org.apache.pekko.serialization.Serialization
import org.apache.pekko.serialization.SerializationExtension
import org.apache.pekko.serialization.jackson.JacksonObjectMapperProvider

import java.sql.Connection
import java.util.UUID
import scala.util.Using

/**
 * Снимок аукциона в `auction_view.state` — JSON модели хранения snapshot тем же mapper'ом `jackson-json`, что у лота.
 */
final class AuctionViewJson(mapper: ObjectMapper) {
  def write(stored: StoredAuction): String = mapper.writeValueAsString(stored)
  def read(json: String): StoredAuction = mapper.readValue(json, classOf[StoredAuction])
}

object AuctionViewJson {
  def apply(system: ActorSystem[?]): AuctionViewJson =
    new AuctionViewJson(JacksonObjectMapperProvider(system).getOrCreate("jackson-json", None))
}

final class AuctionViewDefectException(val defect: AuctionViewDefect)
    extends RuntimeException(s"auction view defect: $defect")

object AuctionViewHandler {
  def apply(system: ActorSystem[?]): AuctionViewHandler =
    new AuctionViewHandler(AuctionViewJson(system), SerializationExtension(system.classicSystem))

  /**
   * Статус аукциона строкой `auction_view.status` — по нему перечисляются активные и прошедшие. Значения — имена
   * статусов `AuctionSnapshot` контракта.
   */
  def status(stored: StoredAuction): String =
    stored.state match {
      case "Draft" => "draft"
      case other => throw new IllegalStateException(s"auction view of state $other has no status")
    }
}

/**
 * Обработчик проекции аукциона: строка `auction_view` и реестр `auction_lot` одной транзакцией `JdbcSession` вместе с
 * offset (ADR-045). Реестр пишется разностью до и после события: лот, добавленный в реестр, — новая строка, снятый —
 * удалённая. Пишет только соединение сессии, как у лота.
 */
final class AuctionViewHandler(json: AuctionViewJson, serialization: Serialization)
    extends JdbcHandler[EventEnvelope[StoredAuctionEvent], JdbcSession] {

  override def process(session: JdbcSession, envelope: EventEnvelope[StoredAuctionEvent]): Unit = {
    val auctionId = UUID.fromString(PersistenceId.extractEntityId(envelope.persistenceId))
    session.withConnection { connection =>
      val before = current(connection, auctionId)
      val delivered = envelope.sequenceNr -> envelope.event
      val events = AuctionView.project(before, auctionId, envelope.sequenceNr, envelope.event) match {
        case Left(AuctionViewDefect.Gap(_, version, sequence)) =>
          JournalGap.missing(connection, serialization, envelope.persistenceId, version, sequence) {
            case stored: StoredAuctionEvent => stored
          } :+ delivered
        case _ => Vector(delivered)
      }
      AuctionView.fold(before, auctionId, events) match {
        case Left(defect) => throw new AuctionViewDefectException(defect)
        case Right(Some(after)) if !before.exists(_.version == after.version) =>
          write(connection, before.fold(0L)(_.version), after)
          val previous = before.fold(Set.empty[UUID])(_.lots)
          (after.lots -- previous).foreach(insertLot(connection, auctionId, _))
          (previous -- after.lots).foreach(deleteLot(connection, auctionId, _))
        case Right(_) => ()
      }
    }
  }

  private def current(connection: Connection, auctionId: UUID): Option[AuctionViewRow] =
    Using.resource(
      connection.prepareStatement("SELECT meetup_id, state::text FROM auction_view WHERE auction_id = ? FOR UPDATE")
    ) { statement =>
      statement.setObject(1, auctionId)
      Using.resource(statement.executeQuery()) { rows =>
        if (rows.next()) Some(AuctionViewRow(auctionId, rows.getObject(1, classOf[UUID]), json.read(rows.getString(2))))
        else None
      }
    }

  /** Версия в условии — защита от второго писателя, как у `LotRows.write`. */
  private def write(connection: Connection, previous: Long, row: AuctionViewRow): Unit =
    Using.resource(
      connection.prepareStatement(
        """INSERT INTO auction_view (auction_id, meetup_id, version, status, state) VALUES (?, ?, ?, ?, ?::jsonb)
          |ON CONFLICT (auction_id) DO UPDATE SET version = EXCLUDED.version, status = EXCLUDED.status,
          |state = EXCLUDED.state WHERE auction_view.version = ?""".stripMargin
      )
    ) { statement =>
      statement.setObject(1, row.auctionId)
      statement.setObject(2, row.meetupId)
      statement.setLong(3, row.version)
      statement.setString(4, AuctionViewHandler.status(row.stored))
      statement.setString(5, json.write(row.stored))
      statement.setLong(6, previous)
      if (statement.executeUpdate() != 1)
        throw new IllegalStateException(s"auction_view row of auction ${row.auctionId} moved past version $previous")
    }

  private def insertLot(connection: Connection, auctionId: UUID, lotId: UUID): Unit =
    Using.resource(
      connection.prepareStatement(
        "INSERT INTO auction_lot (auction_id, lot_id) VALUES (?, ?) ON CONFLICT (auction_id, lot_id) DO NOTHING"
      )
    ) { statement =>
      statement.setObject(1, auctionId)
      statement.setObject(2, lotId)
      statement.executeUpdate()
    }

  private def deleteLot(connection: Connection, auctionId: UUID, lotId: UUID): Unit =
    Using.resource(connection.prepareStatement("DELETE FROM auction_lot WHERE auction_id = ? AND lot_id = ?")) {
      statement =>
        statement.setObject(1, auctionId)
        statement.setObject(2, lotId)
        statement.executeUpdate()
    }
}
