package auction.publication

import auction.lot.ParticipantId
import auction.projection.JournalGap
import auction.results.ResultRow
import auction.results.Results
import auction.results.ResultsJournal
import auction.results.StoredResultsEvent
import auction.watch.AuctionChanges
import org.apache.pekko.actor.typed.ActorSystem
import org.apache.pekko.persistence.typed.PersistenceId
import org.apache.pekko.projection.eventsourced.EventEnvelope
import org.apache.pekko.projection.jdbc.JdbcSession
import org.apache.pekko.projection.jdbc.scaladsl.JdbcHandler
import org.apache.pekko.serialization.Serialization
import org.apache.pekko.serialization.SerializationExtension

import java.sql.Connection
import java.util.UUID
import scala.util.Using

object ResultsPublicationHandler {
  def apply(system: ActorSystem[?]): ResultsPublicationHandler =
    new ResultsPublicationHandler(SerializationExtension(system.classicSystem))
}

/**
 * Обработчик проекции публикации итогов прогнозов (PER-490): на событии, у которого есть повод, сворачивает итоги
 * чистым [[Results.apply]] из их журнала до этого события и кладёт факт в общий outbox `lot_outbox` одной транзакцией с
 * offset. Своей строки, как у лота и аукциона, у итогов нет: повод один на подсчёт, и журнал короткий, поэтому история
 * читается по persistence id. Строки участников читаются тем же соединением: их записала entity до события, и одна
 * транзакция видит их вместе с offset. Повтор события, если offset потерян, отсекает уникальный `event_id` outbox.
 */
final class ResultsPublicationHandler(serialization: Serialization)
    extends JdbcHandler[EventEnvelope[StoredResultsEvent], JdbcSession] {

  override def process(session: JdbcSession, envelope: EventEnvelope[StoredResultsEvent]): Unit =
    if (ResultsFacts.occasion(ResultsJournal.restoreEvent(envelope.event.event)).isDefined)
      session.withConnection { connection =>
        val auctionId = UUID.fromString(PersistenceId.extractEntityId(envelope.persistenceId))
        val history = JournalGap.missing(connection, serialization, envelope.persistenceId, 0L, envelope.sequenceNr) {
          case stored: StoredResultsEvent => stored
        } :+ (envelope.sequenceNr -> envelope.event)
        if (history.map(_._1) != (1L to envelope.sequenceNr))
          throw new IllegalStateException(
            s"${envelope.persistenceId} journal does not hold every event up to ${envelope.sequenceNr}"
          )
        val after = history.foldLeft(Results.initial) { case (results, (_, stored)) =>
          Results.apply(results, ResultsJournal.restoreEvent(stored.event))
        }
        val rows = participants(connection, auctionId)
        ResultsFacts.fact(auctionId, envelope.sequenceNr, envelope.event, after, rows).foreach(enqueue(connection, _))
        // Итоги входят в итог экрана зала (PER-839), а подсчёт идёт после конца аукциона: без сигнала открытый экран
        // так и остался бы без них. Сигнал уходит после коммита этой транзакции, когда событие итогов уже в журнале.
        AuctionChanges.announce(connection, auctionId)
      }

  /** Строки итогов аукциона; до подсчёта их нет, и снимок факта несёт пустых участников. */
  private def participants(connection: Connection, auctionId: UUID): List[ResultRow] =
    Using.resource(
      connection.prepareStatement(
        """SELECT participant_id::text, nomination, guessed, deviation, name FROM auction_result
          |WHERE auction_id = ?::uuid ORDER BY participant_id, nomination""".stripMargin
      )
    ) { statement =>
      statement.setString(1, auctionId.toString)
      Using.resource(statement.executeQuery()) { rows =>
        Iterator
          .continually(rows)
          .takeWhile(_.next())
          .map { row =>
            // `wasNull` относится к последней прочитанной колонке, поэтому читается сразу после `deviation`.
            val deviation = row.getLong(4)
            val hasDeviation = !row.wasNull()
            ResultRow(
              ParticipantId(UUID.fromString(row.getString(1))),
              ResultsJournal.restoreNomination(row.getString(2)),
              row.getBoolean(3),
              if (hasDeviation) Some(deviation) else None,
              row.getString(5)
            )
          }
          .toList
      }
    }

  /** Ключ `event_id` уникален: повтор того же события ничего не добавляет. */
  private def enqueue(connection: Connection, fact: Fact): Unit =
    Using.resource(
      connection.prepareStatement(
        "INSERT INTO lot_outbox (event_id, subject, payload) VALUES (?, ?, ?) ON CONFLICT (event_id) DO NOTHING"
      )
    ) { statement =>
      statement.setObject(1, fact.eventId)
      statement.setString(2, fact.subject)
      statement.setBytes(3, fact.payload)
      statement.executeUpdate()
    }
}
