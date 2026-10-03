package auction.publication

import auction.entity.StoredLotEvent
import auction.projection.LotJournalGap
import auction.projection.LotRows
import auction.projection.LotView
import auction.projection.LotViewDefectException
import auction.projection.LotViewJson
import org.apache.pekko.actor.typed.ActorSystem
import org.apache.pekko.persistence.typed.PersistenceId
import org.apache.pekko.projection.eventsourced.EventEnvelope
import org.apache.pekko.projection.jdbc.JdbcSession
import org.apache.pekko.projection.jdbc.scaladsl.JdbcHandler
import org.apache.pekko.serialization.SerializationExtension

import java.sql.Connection
import java.util.UUID
import scala.util.Using

object LotPublicationHandler {
  def apply(system: ActorSystem[?]): LotPublicationHandler =
    new LotPublicationHandler(
      LotRows("lot_publication", LotViewJson(system)),
      LotJournalGap(SerializationExtension(system.classicSystem))
    )
}

/**
 * Обработчик проекции публикации: одной транзакцией с offset сворачивает лот в своей строке `lot_publication` и кладёт
 * публичные факты в `lot_outbox`. В сеть он не ходит: шину читает [[OutboxRelay]], и недоступный NATS не держит ни
 * транзакцию, ни поток общего с журналом диспетчера.
 *
 * Снимок берётся из своей строки, а не из `lot_view`: read model двигает другая проекция со своим offset, и её снимок
 * может быть впереди или позади публикуемого события. Повтор события после отката пропускается по версии строки, а
 * пропуск в потоке тега дочитывается из журнала — и пропущенные события тоже публикуются.
 */
final class LotPublicationHandler(rows: LotRows, gap: LotJournalGap)
    extends JdbcHandler[EventEnvelope[StoredLotEvent], JdbcSession] {

  override def process(session: JdbcSession, envelope: EventEnvelope[StoredLotEvent]): Unit = {
    val lotId = UUID.fromString(PersistenceId.extractEntityId(envelope.persistenceId))
    session.withConnection { connection =>
      val before = rows.current(connection, lotId)
      val events = gap.events(connection, before, lotId, envelope.persistenceId, envelope.sequenceNr, envelope.event)
      LotView.replay(before, lotId, events) match {
        case Left(defect) => throw new LotViewDefectException(defect)
        case Right(applied) =>
          applied.lastOption.foreach(last => rows.write(connection, before.fold(0L)(_.version), last.row))
          applied.flatMap(LotFacts.fact).foreach(enqueue(connection, _))
      }
    }
  }

  /**
   * Ключ `event_id` уникален: повтор того же события до строки не доходит — его отсекает версия, — и нарушение
   * уникальности здесь дефект, а не повтор.
   */
  private def enqueue(connection: Connection, fact: LotFact): Unit =
    Using.resource(
      connection.prepareStatement("INSERT INTO lot_outbox (event_id, subject, payload) VALUES (?, ?, ?)")
    ) { statement =>
      statement.setObject(1, fact.eventId)
      statement.setString(2, fact.subject)
      statement.setBytes(3, fact.payload)
      statement.executeUpdate()
    }
}
