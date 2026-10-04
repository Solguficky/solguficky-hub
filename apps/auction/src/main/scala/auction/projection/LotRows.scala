package auction.projection

import auction.entity.StoredLotEvent
import org.apache.pekko.serialization.Serialization

import java.sql.Connection
import java.util.UUID
import scala.util.Using

/**
 * Строка свёрнутого лота одной проекции: `lot_view` у read model и `lot_publication` у публикации. Форма у них одна —
 * снимок модели хранения snapshot и версия последнего применённого события, — а offset у каждой свой, поэтому таблицы
 * разные: снимок чужой проекции может быть и впереди, и позади своего события.
 *
 * Читается и пишется только соединением `JdbcSession`, в транзакции offset.
 *
 * @param table
 *   имя таблицы — константа проекции, а не ввод
 */
final class LotRows(table: String, json: LotViewJson) {

  def current(connection: Connection, lotId: UUID): Option[LotViewRow] =
    Using.resource(
      connection.prepareStatement(s"SELECT auction_id, state::text FROM $table WHERE lot_id = ? FOR UPDATE")
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
  def write(connection: Connection, previous: Long, row: LotViewRow): Unit =
    Using.resource(
      connection.prepareStatement(
        s"""INSERT INTO $table (lot_id, auction_id, version, state) VALUES (?, ?, ?, ?::jsonb)
           |ON CONFLICT (lot_id) DO UPDATE SET version = EXCLUDED.version, state = EXCLUDED.state
           |WHERE $table.version = ?""".stripMargin
      )
    ) { statement =>
      statement.setObject(1, row.lotId)
      statement.setObject(2, row.auctionId)
      statement.setLong(3, row.version)
      statement.setString(4, json.write(row.stored))
      statement.setLong(5, previous)
      if (statement.executeUpdate() != 1)
        throw new IllegalStateException(s"$table row of lot ${row.lotId} moved past version $previous")
    }
}

/**
 * Пропуск номера в потоке тега проекция не принимает за дефект сразу: поток может не нести событие лота — его
 * транзакция закоммитилась позже окна, которое read journal ждёт номер `ordering`, событие записано до тегов или тег
 * лота сменился с числом срезов. Тогда пропущенные события дочитываются из журнала лота тем же соединением и
 * сворачиваются вместе с доставленным. Без этого один пропуск останавливал бы весь тег: проекция падала бы на нём при
 * каждом рестарте.
 */
final class LotJournalGap(serialization: Serialization) {

  /** События лота строго между версией строки и доставленным номером — из журнала, а не из потока тега. */
  def missing(
      connection: Connection,
      persistenceId: String,
      version: Long,
      sequence: Long
  ): Vector[(Long, StoredLotEvent)] =
    JournalGap.missing(connection, serialization, persistenceId, version, sequence) { case stored: StoredLotEvent =>
      stored
    }

  /**
   * События, которые свёртка должна применить к строке `before`: доставленное, а перед ним — пропущенные, если между
   * версией строки и номером доставленного пропуск.
   */
  def events(
      connection: Connection,
      before: Option[LotViewRow],
      lotId: UUID,
      persistenceId: String,
      sequence: Long,
      delivered: StoredLotEvent
  ): Vector[(Long, StoredLotEvent)] =
    LotView.project(before, lotId, sequence, delivered) match {
      case Left(LotViewDefect.Gap(_, version, _)) =>
        missing(connection, persistenceId, version, sequence) :+ (sequence -> delivered)
      case _ => Vector(sequence -> delivered)
    }
}

/** Чтение строк журнала одного persistence id мимо потока тега — общее для проекций лота и аукциона. */
object JournalGap {

  /**
   * События строго между `version` и `sequence` по порядку. Строка другого типа, чем ждёт `cast`, — испорченный журнал.
   */
  def missing[E](
      connection: Connection,
      serialization: Serialization,
      persistenceId: String,
      version: Long,
      sequence: Long
  )(cast: PartialFunction[AnyRef, E]): Vector[(Long, E)] =
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
            val event = serialization.deserialize(row.getBytes(4), row.getInt(2), row.getString(3)).get
            val typed = cast.applyOrElse(
              event,
              (other: AnyRef) =>
                throw new IllegalStateException(s"$persistenceId journal row of type ${other.getClass.getName}")
            )
            row.getLong(1) -> typed
          }
          .toVector
      }
    }
}
