package auction.publication

import auction.projection.JournalGap
import auction.raffle.Raffle
import auction.raffle.RaffleJournal
import auction.raffle.StoredRaffleEvent
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

object RafflePublicationHandler {
  def apply(system: ActorSystem[?]): RafflePublicationHandler =
    new RafflePublicationHandler(SerializationExtension(system.classicSystem))
}

/**
 * Обработчик проекции публикации итога розыгрыша (PER-620): на событии, у которого есть повод, сворачивает розыгрыш
 * чистым [[Raffle.apply]] из его журнала до этого события и кладёт факт в общий outbox `lot_outbox` одной транзакцией с
 * offset. Своей строки, как у лота и аукциона, у розыгрыша нет: повод один на розыгрыш, а журнал короткий, поэтому
 * история читается по persistence id — и тогда розыгрыш, открытый до появления тегов, сворачивается так же, — а копия
 * пула с identity участников не ложится в ещё одну таблицу. Повтор события, если offset потерян, отсекает уникальный
 * `event_id` outbox.
 */
final class RafflePublicationHandler(serialization: Serialization)
    extends JdbcHandler[EventEnvelope[StoredRaffleEvent], JdbcSession] {

  override def process(session: JdbcSession, envelope: EventEnvelope[StoredRaffleEvent]): Unit =
    if (RaffleFacts.occasion(RaffleJournal.restoreEvent(envelope.event.event)).isDefined)
      session.withConnection { connection =>
        val auctionId = UUID.fromString(PersistenceId.extractEntityId(envelope.persistenceId))
        val history = JournalGap.missing(connection, serialization, envelope.persistenceId, 0L, envelope.sequenceNr) {
          case stored: StoredRaffleEvent => stored
        } :+ (envelope.sequenceNr -> envelope.event)
        if (history.map(_._1) != (1L to envelope.sequenceNr))
          throw new IllegalStateException(
            s"${envelope.persistenceId} journal does not hold every event up to ${envelope.sequenceNr}"
          )
        val after = history.foldLeft(Raffle.initial) { case (raffle, (sequence, stored)) =>
          Raffle.apply(raffle, RaffleJournal.envelope(sequence, stored))
        }
        RaffleFacts.fact(auctionId, envelope.sequenceNr, envelope.event, after).foreach(enqueue(connection, _))
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
