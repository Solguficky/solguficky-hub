package auction.projection

import auction.invoice.Invoice
import auction.invoice.InvoiceId
import auction.invoice.InvoiceJournal
import auction.invoice.InvoiceTags
import auction.invoice.InvoiceView
import auction.invoice.StoredInvoiceEvent
import auction.publication.Fact
import auction.publication.InvoiceFacts
import auction.telemetry.ProjectionBacklog
import auction.telemetry.ProjectionMetrics
import org.apache.pekko.actor.typed.ActorSystem
import org.apache.pekko.cluster.sharding.typed.ShardedDaemonProcessSettings
import org.apache.pekko.cluster.sharding.typed.scaladsl.ShardedDaemonProcess
import org.apache.pekko.persistence.jdbc.db.SlickExtension
import org.apache.pekko.persistence.jdbc.query.scaladsl.JdbcReadJournal
import org.apache.pekko.persistence.query.Offset
import org.apache.pekko.persistence.typed.PersistenceId
import org.apache.pekko.projection.ProjectionBehavior
import org.apache.pekko.projection.ProjectionId
import org.apache.pekko.projection.eventsourced.EventEnvelope
import org.apache.pekko.projection.eventsourced.scaladsl.EventSourcedProvider
import org.apache.pekko.projection.jdbc.JdbcSession
import org.apache.pekko.projection.jdbc.scaladsl.JdbcHandler
import org.apache.pekko.projection.jdbc.scaladsl.JdbcProjection
import org.apache.pekko.projection.scaladsl.ExactlyOnceProjection
import org.apache.pekko.serialization.Serialization
import org.apache.pekko.serialization.SerializationExtension
import slick.jdbc.JdbcBackend.Database
import slick.jdbc.PostgresProfile.api.*

import java.sql.Connection
import java.sql.Timestamp
import java.util.UUID
import scala.concurrent.Await
import scala.concurrent.duration.FiniteDuration
import scala.util.Using

/**
 * Проекции журнала счетов (PER-338) — та же форма, что [[ResultsProjection]]: экземпляр на тег [[InvoiceTags]] под
 * `ShardedDaemonProcess`, offset и запись обработчика одной транзакцией `JdbcProjection.exactlyOnce`. Их две, у каждой
 * своё имя и свой offset, как у лота: read model [[ViewName]] — строка `auction_invoice` для чтений, и публикация
 * [[PublicationName]] — факт `auction.v1.InvoiceEvent` в общий outbox. Отказ одной не задерживает другую.
 */
object InvoiceProjection {

  val ViewName: String = "invoice-view"

  val PublicationName: String = "invoice-publication"

  type Envelope = EventEnvelope[StoredInvoiceEvent]

  def init(
      system: ActorSystem[?],
      name: String,
      metrics: ProjectionMetrics,
      handler: () => JdbcHandler[Envelope, JdbcSession]
  ): Unit =
    ShardedDaemonProcess(system).init[ProjectionBehavior.Command](
      name,
      InvoiceTags.Count,
      index => ProjectionBehavior(projection(system, name, InvoiceTags.all(index), metrics, handler)),
      ShardedDaemonProcessSettings(system),
      Some(ProjectionBehavior.Stop)
    )

  def projection(
      system: ActorSystem[?],
      name: String,
      tag: String,
      metrics: ProjectionMetrics,
      handler: () => JdbcHandler[Envelope, JdbcSession]
  ): ExactlyOnceProjection[Offset, Envelope] = {
    val source = journal(system)
    JdbcProjection
      .exactlyOnce(
        ProjectionId(name, tag),
        EventSourcedProvider.eventsByTag[StoredInvoiceEvent](system, JdbcReadJournal.Identifier, tag),
        () => new PooledJdbcSession(source.source),
        handler
      )(using system)
      .withStatusObserver(metrics.observer[Envelope](_.timestamp))
  }

  /** Отставание каждого тега для `events_behind` — тот же запрос, что у [[ResultsProjection.backlog]]. */
  def backlog(system: ActorSystem[?], name: String, timeout: FiniteDuration): () => Map[String, Long] = {
    val database = journal(system)
    val tags = InvoiceTags.all
    () => {
      val behind =
        sql"""SELECT t.tag, COUNT(*) FROM event_tag t
              LEFT JOIN pekko_projection_offset_store o ON o.projection_name = $name AND o.projection_key = t.tag
              WHERE t.tag = ANY(${tags.mkString("{", ",", "}")}::varchar[])
                AND t.event_id > COALESCE(o.current_offset::bigint, 0)
              GROUP BY t.tag""".as[(String, Long)]
      ProjectionBacklog.behind(tags, Await.result(database.run(behind), timeout).toMap)
    }
  }

  private def journal(system: ActorSystem[?]): Database =
    SlickExtension(system).database(system.settings.config.getConfig("jdbc-journal")).database

  /**
   * Счёт сразу после события конверта, свёрнутый из его журнала по persistence id тем же [[Invoice.apply]], что у
   * entity. Журнал счёта — несколько строк, поэтому своей строки свёртки, как у лота, проекциям счёта не нужно.
   */
  def replay(
      connection: Connection,
      serialization: Serialization,
      envelope: Envelope
  ): (InvoiceId, Invoice) = {
    val history = JournalGap.missing(connection, serialization, envelope.persistenceId, 0L, envelope.sequenceNr) {
      case stored: StoredInvoiceEvent => stored
    } :+ (envelope.sequenceNr -> envelope.event)
    if (history.map(_._1) != (1L to envelope.sequenceNr))
      throw new IllegalStateException(
        s"${envelope.persistenceId} journal does not hold every event up to ${envelope.sequenceNr}"
      )
    val invoice = InvoiceId(UUID.fromString(PersistenceId.extractEntityId(envelope.persistenceId)))
    invoice -> history.foldLeft(Invoice.initial) { case (state, (_, stored)) =>
      Invoice.apply(state, InvoiceJournal.restoreEvent(stored.event))
    }
  }

  /** Счёт, каким его отдают чтения и факт. До выставления счёта нет — дефект журнала, а не пустая строка. */
  def view(invoice: InvoiceId, state: Invoice): InvoiceView =
    state match {
      case Invoice.Issued(terms, status, fulfillment, _) => InvoiceView(invoice, terms, status, fulfillment)
      case Invoice.Initial => throw new IllegalStateException(s"invoice ${invoice.value} has no issue in its journal")
    }
}

object InvoiceViewHandler {
  def apply(system: ActorSystem[?]): InvoiceViewHandler =
    new InvoiceViewHandler(SerializationExtension(system.classicSystem))
}

/**
 * Обработчик read model счетов: строка `auction_invoice` — счёт целиком после события. Повтор события строку не
 * откатывает: запись идёт только поверх меньшей версии. Пишет только соединением `JdbcSession`, иначе строка оказалась
 * бы впереди offset.
 */
final class InvoiceViewHandler(serialization: Serialization)
    extends JdbcHandler[EventEnvelope[StoredInvoiceEvent], JdbcSession] {

  override def process(session: JdbcSession, envelope: EventEnvelope[StoredInvoiceEvent]): Unit =
    session.withConnection { connection =>
      val (invoice, state) = InvoiceProjection.replay(connection, serialization, envelope)
      write(connection, InvoiceProjection.view(invoice, state), envelope.sequenceNr)
    }

  private def write(connection: Connection, view: InvoiceView, version: Long): Unit =
    Using.resource(
      connection.prepareStatement(
        """INSERT INTO auction_invoice
          |  (invoice_id, auction_id, lot_id, winner_id, amount_minor, currency, payment_due_at, status, fulfillment,
          |   version)
          |VALUES (?::uuid, ?::uuid, ?::uuid, ?::uuid, ?, ?, ?, ?, ?, ?)
          |ON CONFLICT (invoice_id) DO UPDATE SET status = EXCLUDED.status, fulfillment = EXCLUDED.fulfillment,
          |  payment_due_at = EXCLUDED.payment_due_at, version = EXCLUDED.version
          |WHERE auction_invoice.version < EXCLUDED.version""".stripMargin
      )
    ) { statement =>
      statement.setString(1, view.id.value.toString)
      statement.setString(2, view.terms.auction.value.toString)
      statement.setString(3, view.terms.lot.value.toString)
      statement.setString(4, view.terms.winner.value.toString)
      statement.setLong(5, view.terms.amount.minorUnits)
      statement.setString(6, view.terms.amount.currency.value)
      statement.setTimestamp(7, view.terms.paymentDueAt.map(Timestamp.from).orNull)
      statement.setString(8, InvoiceJournal.statusName(view.status))
      statement.setString(9, view.fulfillment.map(InvoiceJournal.methodName).orNull)
      statement.setLong(10, version)
      statement.executeUpdate()
    }
}

object InvoicePublicationHandler {
  def apply(system: ActorSystem[?]): InvoicePublicationHandler =
    new InvoicePublicationHandler(SerializationExtension(system.classicSystem))
}

/**
 * Публикация фактов счёта (integration.md, «Счёт на шине»): на событии с поводом — `invoice_issued`, `invoice_paid`,
 * `invoice_handed_over` — кладёт `auction.v1.InvoiceEvent` со снимком счёта после события в общий outbox `lot_outbox`
 * одной транзакцией с offset. Выбор способа получения повода не имеет. Повтор события, если offset потерян, отсекает
 * уникальный `event_id` outbox.
 */
final class InvoicePublicationHandler(serialization: Serialization)
    extends JdbcHandler[EventEnvelope[StoredInvoiceEvent], JdbcSession] {

  override def process(session: JdbcSession, envelope: EventEnvelope[StoredInvoiceEvent]): Unit =
    if (InvoiceFacts.occasion(InvoiceJournal.restoreEvent(envelope.event.event)).isDefined)
      session.withConnection { connection =>
        val (invoice, state) = InvoiceProjection.replay(connection, serialization, envelope)
        InvoiceFacts
          .fact(envelope.sequenceNr, envelope.event, InvoiceProjection.view(invoice, state))
          .foreach(enqueue(connection, _))
      }

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
