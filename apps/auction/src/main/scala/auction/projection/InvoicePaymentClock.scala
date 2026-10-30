package auction.projection

import auction.aggregate.Auction
import auction.aggregate.AuctionEvent
import auction.entity.AuctionJournal
import auction.entity.StoredAuctionEvent
import auction.invoice.InvoiceGateway
import auction.invoice.InvoiceId
import org.apache.pekko.Done
import org.apache.pekko.actor.typed.ActorSystem
import org.apache.pekko.actor.typed.Behavior
import org.apache.pekko.actor.typed.scaladsl.Behaviors
import org.apache.pekko.persistence.jdbc.db.SlickExtension
import org.slf4j.LoggerFactory
import org.apache.pekko.serialization.Serialization
import org.apache.pekko.serialization.SerializationExtension
import net.logstash.logback.argument.StructuredArguments
import auction.telemetry.NatsClientLog
import java.io.PrintWriter
import java.io.StringWriter
import scala.jdk.CollectionConverters.*
import slick.jdbc.GetResult
import slick.jdbc.JdbcBackend.Database
import slick.jdbc.PostgresProfile.api.*

import java.sql.Connection
import java.sql.Timestamp
import java.time.Instant
import java.time.temporal.ChronoUnit
import java.util.UUID
import scala.concurrent.ExecutionContext
import scala.concurrent.Future
import scala.concurrent.duration.*
import scala.util.Failure
import scala.util.Success
import scala.util.Try
import scala.util.Using

/** Общий срок оплаты — факт окончания всего аукциона плюс настроенный срок. */
object InvoicePaymentClock {
  def ended(event: AuctionEvent): Boolean = event match {
    case AuctionEvent.AuctionFinished | AuctionEvent.PrebiddingEnded(true) | AuctionEvent.AuctionCancelled => true
    case _ => false
  }

  def deadline(auction: Auction, endedAt: Instant): Instant =
    endedAt.plus(InvoicingHandler.termOf(auction)).truncatedTo(ChronoUnit.MICROS)

  /** Пишется одной транзакцией с auction-view и offset, включая догонку пропущенных строк журнала. */
  def record(connection: Connection, auctionId: UUID, auction: Auction, events: Seq[StoredAuctionEvent]): Unit =
    events.find(event => ended(AuctionJournal.restoreEvent(event.event))).foreach { event =>
      Using.resource(
        connection.prepareStatement(
          "INSERT INTO auction_payment_clock (auction_id, payment_due_at) VALUES (?, ?) ON CONFLICT DO NOTHING"
        )
      ) { statement =>
        statement.setObject(1, auctionId)
        statement.setTimestamp(2, Timestamp.from(deadline(auction, event.occurredAt)))
        statement.executeUpdate()
      }
    }

  final case class Change(invoice: InvoiceId, expected: Option[Instant], dueAt: Option[Instant])

  /** Догоняет поздние продажи и старые неоплаченные счета; оплаченные не выбирает. */
  def changes(database: Database): Future[Vector[Change]] = {
    given GetResult[Change] = GetResult { row =>
      Change(
        InvoiceId(UUID.fromString(row.<<)),
        row.<<?[Timestamp].map(_.toInstant),
        row.<<?[Timestamp].map(_.toInstant)
      )
    }
    database.run(sql"""SELECT i.invoice_id::text, i.payment_due_at, c.payment_due_at
      FROM auction_invoice i
      JOIN auction_view a ON a.auction_id = i.auction_id
      LEFT JOIN auction_payment_clock c ON c.auction_id = i.auction_id
      WHERE i.status = 'AwaitingPayment'
        AND (c.auction_id IS NOT NULL OR a.status IN ('prebidding', 'settling', 'on_break', 'lineup_frozen', 'in_final'))
        AND i.payment_due_at IS DISTINCT FROM c.payment_due_at
      ORDER BY i.invoice_id LIMIT 100""".as[Change])
  }

  /** Восстанавливает общий срок и для аукциона, завершившегося до обновления процесса. */
  def backfill(database: Database, json: AuctionViewJson, serialization: Serialization): Future[Unit] =
    database.run(SimpleDBIO[Unit] { context =>
      Using.resource(
        context.connection.prepareStatement(
          """SELECT a.auction_id, a.state::text FROM auction_view a
          |WHERE a.status IN ('finished', 'cancelled')
          |AND NOT EXISTS (SELECT 1 FROM auction_payment_clock c WHERE c.auction_id = a.auction_id)
          |AND EXISTS (SELECT 1 FROM auction_invoice i WHERE i.auction_id = a.auction_id AND i.status = 'AwaitingPayment')
          |ORDER BY a.auction_id LIMIT 100""".stripMargin
        )
      ) { statement =>
        Using.resource(statement.executeQuery()) { rows =>
          while (rows.next()) {
            val id = rows.getObject(1, classOf[UUID])
            val history = JournalGap.missing(context.connection, serialization, s"auction|$id", 0L, Long.MaxValue) {
              case event: StoredAuctionEvent => event
            }
            record(
              context.connection,
              id,
              AuctionJournal.restoreAuction(json.read(rows.getString(2))),
              history.map(_._2)
            )
          }
        }
      }
    }.transactionally)

  private sealed trait Command
  private case object Tick extends Command
  private final case class Completed(result: Try[Done], started: Long) extends Command

  def start(system: ActorSystem[?], invoices: InvoiceGateway): Unit = {
    val database = SlickExtension(system).database(system.settings.config.getConfig("jdbc-journal")).database
    system.systemActorOf(
      behavior(database, invoices, AuctionViewJson(system), SerializationExtension(system.classicSystem)),
      "invoice-payment-clock"
    )
    ()
  }

  private def behavior(
      database: Database,
      invoices: InvoiceGateway,
      json: AuctionViewJson,
      serialization: Serialization
  ): Behavior[Command] =
    Behaviors.setup { context =>
      given ExecutionContext = context.executionContext
      Behaviors.withTimers { timers =>
        timers.startSingleTimer(Tick, 1.second)
        Behaviors.receiveMessage {
          case Tick =>
            val started = System.nanoTime()
            val pass = backfill(database, json, serialization).flatMap(_ => changes(database)).flatMap { pending =>
              pending.foldLeft(Future.successful[Done](Done)) { (previous, change) =>
                previous.flatMap(_ => invoices.changeDue(change.invoice, change.expected, change.dueAt))
              }
            }
            context.pipeToSelf(pass)(result => Completed(result, started))
            Behaviors.same
          case Completed(result, started) =>
            result match {
              case Failure(cause) =>
                val stack = new StringWriter()
                cause.printStackTrace(new PrintWriter(stack))
                LoggerFactory
                  .getLogger("auction.invoice.payment-clock")
                  .error(
                    "invoice payment clock synchronization failed",
                    StructuredArguments.entries(
                      Map[String, Any](
                        "operation" -> "auction.invoice.payment_clock",
                        "result" -> "error",
                        "duration_us" -> (System.nanoTime() - started) / 1000,
                        "error_category" -> "unexpected",
                        "error" -> cause.getClass.getName,
                        "stack" -> NatsClientLog.withoutCredentials(stack.toString)
                      ).asJava
                    )
                  )
              case Success(_) => ()
            }
            timers.startSingleTimer(Tick, 1.second)
            Behaviors.same
        }
      }
    }
}
