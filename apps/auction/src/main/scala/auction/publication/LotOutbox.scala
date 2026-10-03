package auction.publication

import auction.telemetry.OutboxBacklog

import java.sql.Connection
import java.util.UUID
import scala.util.Using

/** Неопубликованный факт в порядке записи: `position` растёт с каждой строкой. */
final case class PendingFact(position: Long, fact: LotFact)

/**
 * Таблица `lot_outbox` со стороны релея. Строку пишет проекция публикации, а релей читает её в порядке записи и удаляет
 * после ack шины: журнал остаётся источником истины, и опубликованная строка ничего не несёт.
 *
 * Каждый вызов берёт своё соединение из пула журнала в autocommit: удаление после одного ack не ждёт остальных.
 */
final class LotOutbox(connect: () => Connection) {

  def pending(limit: Int): Vector[PendingFact] =
    Using.resource(connect()) { connection =>
      Using.resource(
        connection.prepareStatement(
          "SELECT position, event_id, subject, payload FROM lot_outbox ORDER BY position LIMIT ?"
        )
      ) { statement =>
        statement.setInt(1, limit)
        Using.resource(statement.executeQuery()) { rows =>
          Iterator
            .continually(rows)
            .takeWhile(_.next())
            .map { row =>
              PendingFact(row.getLong(1), LotFact(row.getObject(2, classOf[UUID]), row.getString(3), row.getBytes(4)))
            }
            .toVector
        }
      }
    }

  def remove(eventId: UUID): Unit =
    Using.resource(connect()) { connection =>
      Using.resource(connection.prepareStatement("DELETE FROM lot_outbox WHERE event_id = ?")) { statement =>
        statement.setObject(1, eventId)
        statement.executeUpdate()
      }
    }

  /** Сколько фактов ждёт шину и сколько секунд ждёт старейший; время считает база, а не часы узла. */
  def backlog(): OutboxBacklog =
    Using.resource(connect()) { connection =>
      Using.resource(
        connection.prepareStatement(
          "SELECT COUNT(*), COALESCE(EXTRACT(EPOCH FROM now() - MIN(created_at)), 0) FROM lot_outbox"
        )
      ) { statement =>
        Using.resource(statement.executeQuery()) { rows =>
          rows.next()
          OutboxBacklog(rows.getLong(1), math.max(0.0, rows.getDouble(2)))
        }
      }
    }
}
