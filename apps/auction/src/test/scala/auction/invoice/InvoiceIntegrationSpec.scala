package auction.invoice

import auction.AuctionNode
import auction.contract.LotValues
import auction.aggregate.AuctionConfig
import auction.entity.Initiator
import auction.entity.LotEntity
import auction.entity.UuidV7
import auction.lot.*
import auction.lot.LotFixtures.*
import auction.persistence.DatabaseSettings
import auction.persistence.JournalSchema
import auction.projection.InvoicingProjection
import auction.publication.PublicationSettings
import auction.telemetry.ProjectionMetrics
import auction.telemetry.PublicationMetrics
import auction.testkit.PostgresFixture
import auction.v1.auction_events as bus
import com.typesafe.config.ConfigFactory
import io.opentelemetry.sdk.metrics.SdkMeterProvider
import io.opentelemetry.sdk.testing.exporter.InMemoryMetricReader
import org.apache.pekko.Done
import org.apache.pekko.actor.testkit.typed.scaladsl.ActorTestKit
import org.apache.pekko.cluster.sharding.typed.scaladsl.ClusterSharding
import org.apache.pekko.util.Timeout
import org.scalatest.concurrent.Eventually
import org.scalatest.concurrent.ScalaFutures
import org.scalatest.matchers.should.Matchers
import org.scalatest.time.Millis
import org.scalatest.time.Seconds
import org.scalatest.time.Span
import org.scalatest.wordspec.AnyWordSpec

import java.sql.DriverManager
import java.time.Clock
import java.time.Instant
import java.util.UUID
import scala.concurrent.duration.*
import scala.util.Using

/**
 * Счета на настоящем PostgreSQL (PER-338): узел собран так же, как в `Main`, продажа лота выставляет счёт проекцией
 * журнала лотов, а read model и факт шины пишут проекции журнала счетов. Повторная доставка продажи — настоящий
 * механизм повтора: offset `lot-invoicing` удаляется, и проекция после рестарта узла переигрывает журнал лотов с
 * начала.
 */
final class InvoiceIntegrationSpec
    extends AnyWordSpec
    with Matchers
    with PostgresFixture
    with ScalaFutures
    with Eventually {

  implicit override val patienceConfig: PatienceConfig =
    PatienceConfig(timeout = Span(30, Seconds), interval = Span(100, Millis))

  private given Timeout = Timeout(20.seconds)

  private final case class Node(kit: ActorTestKit, sharding: ClusterSharding, invoices: InvoiceGateway)

  private def withNode[A](database: DatabaseSettings)(use: Node => A): A = {
    val config = ConfigFactory
      .parseString("""pekko.projection.restart-backoff { min-backoff = 100ms, max-backoff = 300ms }""")
      .withFallback(nodeConfig(database))
    val kit = ActorTestKit(s"auction-invoice-${UUID.randomUUID()}", config)
    try {
      val clock = Clock.systemUTC()
      val sharding = AuctionNode.join(kit.system)
      AuctionNode.registerLots(sharding, clock, UuidV7.generator(clock))
      val invoices = AuctionNode.registerInvoices(sharding, clock, UuidV7.generator(clock), 5.seconds)
      val reader = InMemoryMetricReader.create()
      val meter = SdkMeterProvider.builder().registerMetricReader(reader).build().get("t")
      val metrics = ProjectionMetrics(meter, clock)
      AuctionNode.startProjection(kit.system, metrics, 5.seconds)
      AuctionNode.startInvoicing(kit.system, sharding, invoices, metrics, 5.seconds, 5.seconds)
      AuctionNode.startPublication(
        kit.system,
        metrics,
        PublicationMetrics(meter),
        PublicationSettings(None, interval = 100.millis, batch = 100, ackTimeout = 1.second),
        5.seconds
      )
      use(Node(kit, sharding, invoices))
    } finally kit.shutdownTestKit()
  }

  private def migrated(): DatabaseSettings = {
    val database = freshDatabase()
    JournalSchema.migrate(database)
    database
  }

  private val ids = UuidV7.generator(Clock.systemUTC())

  /**
   * Проданный лот тестового аукциона `auctionId(1)` — не UUIDv5, поэтому срок оплаты у счёта — срок платформы:
   * рождение, условия, открытие, ставка участника 1 по стартовой цене и закрытие ведущим. Отдаёт лот и выигравшую
   * ставку.
   */
  private def soldLot(node: Node): (UUID, LotEvent.LotSold) = {
    val id = ids()
    val lot = node.sharding.entityRefFor(LotEntity.TypeKey, id.toString)
    lot.ask[Either[DraftLotRejected, Envelope]](LotEntity.Draft(draftLot(opN = 1), Initiator.Scheduler, _)).futureValue
    lot
      .ask[Either[ScheduleLotRejected, Envelope]](LotEntity.Plan(scheduleLot(opN = 2), Initiator.Scheduler, _))
      .futureValue
    lot
      .ask[Either[OpenLotRejected, Envelope]](
        LotEntity.Open(openLot(opN = 3, deadline = Some(distantDeadline)), Initiator.Scheduler, _)
      )
      .futureValue
    lot
      .ask[Either[PlaceBidRejected, LotEntity.Recorded]](
        LotEntity.Bid(placeBid(1, 100, 4), Initiator.Participant(participant(1)), _)
      )
      .futureValue
      .isRight shouldBe true
    val closed = lot
      .ask[Either[CloseLotRejected, Envelope]](
        LotEntity.Close(closeLot(5, CloseReason.ByAuctioneer), Initiator.Scheduler, _)
      )
      .futureValue
    closed.map(_.event) match {
      case Right(sold: LotEvent.LotSold) => id -> sold
      case other => fail(s"lot was not sold: $other")
    }
  }

  private def query[A](database: DatabaseSettings, sql: String)(read: java.sql.ResultSet => A): List[A] =
    Using.resource(DriverManager.getConnection(database.url, database.user, database.password)) { connection =>
      Using.resource(connection.createStatement().executeQuery(sql)) { rows =>
        Iterator.continually(rows).takeWhile(_.next()).map(read).toList
      }
    }

  private def invoiceRows(database: DatabaseSettings): List[(String, Long, String, Instant, String)] =
    query(database, "SELECT invoice_id::text, amount_minor, currency, payment_due_at, status FROM auction_invoice") {
      row => (row.getString(1), row.getLong(2), row.getString(3), row.getTimestamp(4).toInstant, row.getString(5))
    }

  private def invoiceFacts(database: DatabaseSettings): List[(String, bus.InvoiceEvent)] =
    query(
      database,
      "SELECT subject, payload FROM lot_outbox WHERE subject LIKE 'events.auction.invoice_%' ORDER BY position"
    ) { row =>
      row.getString(1) -> bus.InvoiceEvent.parseFrom(row.getBytes(2))
    }

  private def journalRows(database: DatabaseSettings, invoice: InvoiceId): Long =
    query(
      database,
      s"SELECT COUNT(*) FROM event_journal WHERE persistence_id = 'invoice|${invoice.value}'"
    )(_.getLong(1)).head

  "an invoice" should {

    "be issued once for a sale with the price of the sale and the term counted from the sale" in {
      val database = migrated()
      withNode(database) { node =>
        val (_, sold) = soldLot(node)
        val invoice = InvoiceId.of(sold.bidId)
        val due = sold.at.plus(AuctionConfig.PlatformPaymentTerm).truncatedTo(java.time.temporal.ChronoUnit.MICROS)
        eventually {
          invoiceRows(database) shouldBe List((invoice.value.toString, 100L, "RUB", due, "AwaitingPayment"))
          val facts = invoiceFacts(database)
          facts.map(_._1) shouldBe List("events.auction.invoice_issued")
          facts.flatMap(_._2.state).map(_.amount) shouldBe List(Some(LotValues.money(sold.price)))
        }
      }
    }

    "not be issued a second time when the sale is delivered again" in {
      val database = migrated()
      val invoice = withNode(database) { node =>
        val (_, sold) = soldLot(node)
        val invoice = InvoiceId.of(sold.bidId)
        eventually(invoiceRows(database).map(_._1) shouldBe List(invoice.value.toString))
        invoice
      }
      query(
        database,
        s"SELECT COUNT(*) FROM pekko_projection_offset_store WHERE projection_name = '${InvoicingProjection.Name}'"
      )(
        _.getLong(1)
      ).head should be > 0L
      Using.resource(DriverManager.getConnection(database.url, database.user, database.password)) { connection =>
        connection
          .createStatement()
          .executeUpdate(
            s"DELETE FROM pekko_projection_offset_store WHERE projection_name = '${InvoicingProjection.Name}'"
          )
      }
      withNode(database) { _ =>
        // Проекция переиграла журнал лотов с начала: offset снова записан, а счёт остался одним событием.
        eventually {
          query(
            database,
            s"SELECT COUNT(*) FROM pekko_projection_offset_store WHERE projection_name = '${InvoicingProjection.Name}'"
          )(_.getLong(1)).head should be > 0L
        }
        journalRows(database, invoice) shouldBe 1L
        invoiceRows(database).map(_._1) shouldBe List(invoice.value.toString)
        invoiceFacts(database).map(_._1) shouldBe List("events.auction.invoice_issued")
      }
    }

    "refuse the handover before the payment by name and publish each transition once" in {
      val database = migrated()
      withNode(database) { node =>
        val (_, sold) = soldLot(node)
        val invoice = InvoiceId.of(sold.bidId)
        eventually(invoiceRows(database).map(_._1) shouldBe List(invoice.value.toString))
        node.invoices.markHandedOver(invoice, op(10)).futureValue shouldBe Left(InvoiceRefusal.InvoiceNotPaid)
        node.invoices.markPaid(invoice, op(11)).futureValue shouldBe Right(Done)
        node.invoices.markPaid(invoice, op(12)).futureValue shouldBe Right(Done)
        node.invoices.markHandedOver(invoice, op(13)).futureValue shouldBe Right(Done)
        eventually {
          invoiceRows(database).map(_._5) shouldBe List("HandedOver")
          invoiceFacts(database).map(_._1) shouldBe List(
            "events.auction.invoice_issued",
            "events.auction.invoice_paid",
            "events.auction.invoice_handed_over"
          )
        }
        journalRows(database, invoice) shouldBe 3L
      }
    }
  }
}
