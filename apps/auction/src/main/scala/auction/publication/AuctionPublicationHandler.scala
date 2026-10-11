package auction.publication

import auction.entity.StoredAuctionEvent
import auction.projection.AuctionView
import auction.projection.AuctionViewDefect
import auction.projection.AuctionViewDefectException
import auction.projection.AuctionViewJson
import auction.projection.AuctionViewRow
import auction.projection.JournalGap
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

object AuctionPublicationHandler {
  def apply(system: ActorSystem[?]): AuctionPublicationHandler =
    new AuctionPublicationHandler(AuctionViewJson(system), SerializationExtension(system.classicSystem))
}

/**
 * Обработчик проекции публикации фактов аукциона — та же форма, что [[LotPublicationHandler]]: одной транзакцией с
 * offset сворачивает аукцион в своей строке `auction_publication` тем же ядром [[AuctionView]], что read model, и
 * кладёт публичные факты в общий outbox `lot_outbox`. Снимок берётся из своей строки, а не из `auction_view`: read
 * model двигает чужой offset. Повтор события пропускается по версии строки, пропуск номера дочитывается из журнала, и
 * пропущенные события тоже публикуются.
 */
final class AuctionPublicationHandler(json: AuctionViewJson, serialization: Serialization)
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
      val applied = events.foldLeft[(Option[AuctionViewRow], Vector[Fact])]((before, Vector.empty)) {
        case ((row, facts), (sequence, stored)) =>
          AuctionView.project(row, auctionId, sequence, stored) match {
            case Left(defect) => throw new AuctionViewDefectException(defect)
            case Right(None) => (row, facts)
            case Right(Some(after)) => (Some(after), facts ++ AuctionFacts.fact(sequence, stored, after))
          }
      }
      applied match {
        case (Some(after), facts) if !before.exists(_.version == after.version) =>
          write(connection, before.fold(0L)(_.version), after)
          facts.foreach(enqueue(connection, _))
        case _ => ()
      }
    }
  }

  private def current(connection: Connection, auctionId: UUID): Option[AuctionViewRow] =
    Using.resource(
      connection.prepareStatement(
        "SELECT meetup_id, state::text FROM auction_publication WHERE auction_id = ? FOR UPDATE"
      )
    ) { statement =>
      statement.setObject(1, auctionId)
      Using.resource(statement.executeQuery()) { rows =>
        if (rows.next()) Some(AuctionViewRow(auctionId, rows.getObject(1, classOf[UUID]), json.read(rows.getString(2))))
        else None
      }
    }

  /** Версия в условии — защита от второго писателя, как у `auction_view`. */
  private def write(connection: Connection, previous: Long, row: AuctionViewRow): Unit =
    Using.resource(
      connection.prepareStatement(
        """INSERT INTO auction_publication (auction_id, meetup_id, version, state) VALUES (?, ?, ?, ?::jsonb)
          |ON CONFLICT (auction_id) DO UPDATE SET version = EXCLUDED.version, state = EXCLUDED.state
          |WHERE auction_publication.version = ?""".stripMargin
      )
    ) { statement =>
      statement.setObject(1, row.auctionId)
      statement.setObject(2, row.meetupId)
      statement.setLong(3, row.version)
      statement.setString(4, json.write(row.stored))
      statement.setLong(5, previous)
      if (statement.executeUpdate() != 1)
        throw new IllegalStateException(
          s"auction_publication row of auction ${row.auctionId} moved past version $previous"
        )
    }

  /** Ключ `event_id` уникален, как у фактов лота: повтор события до строки не доходит — его отсекает версия. */
  private def enqueue(connection: Connection, fact: Fact): Unit =
    Using.resource(
      connection.prepareStatement("INSERT INTO lot_outbox (event_id, subject, payload) VALUES (?, ?, ?)")
    ) { statement =>
      statement.setObject(1, fact.eventId)
      statement.setString(2, fact.subject)
      statement.setBytes(3, fact.payload)
      statement.executeUpdate()
    }
}
