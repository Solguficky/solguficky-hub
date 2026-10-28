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
import auction.projection.SettlementSalesHandler
import auction.catalog.LotId
import auction.settlement.*
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
import scala.concurrent.Future
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

  private final case class Node(
      kit: ActorTestKit,
      sharding: ClusterSharding,
      invoices: InvoiceGateway,
      settlements: SettlementGateway
  )

  private def withNode[A](
      database: DatabaseSettings,
      wrap: InvoiceGateway => InvoiceGateway = identity,
      clock: Clock = Clock.systemUTC()
  )(use: Node => A): A = {
    val config = ConfigFactory
      .parseString("""pekko.projection.restart-backoff { min-backoff = 100ms, max-backoff = 300ms }""")
      .withFallback(nodeConfig(database))
    val kit = ActorTestKit(s"auction-invoice-${UUID.randomUUID()}", config)
    try {
      val sharding = AuctionNode.join(kit.system)
      AuctionNode.registerLots(sharding, clock, UuidV7.generator(clock))
      val invoices = AuctionNode.registerInvoices(sharding, clock, UuidV7.generator(clock), 5.seconds)
      val reader = InMemoryMetricReader.create()
      val meter = SdkMeterProvider.builder().registerMetricReader(reader).build().get("t")
      val metrics = ProjectionMetrics(meter, clock)
      AuctionNode.startProjection(kit.system, metrics, 5.seconds)
      val settlements =
        AuctionNode.startInvoicing(kit.system, sharding, wrap(invoices), metrics, 5.seconds, 5.seconds, clock)
      AuctionNode.startPublication(
        kit.system,
        metrics,
        PublicationMetrics(meter),
        PublicationSettings(None, interval = 100.millis, batch = 100, ackTimeout = 1.second),
        5.seconds
      )
      use(Node(kit, sharding, invoices, settlements))
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
  private def soldLot(node: Node, bids: List[(Int, Long)] = List(1 -> 100L)): (UUID, LotEvent.LotSold) = {
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
    bids.zipWithIndex.foreach { case ((who, amount), index) =>
      lot
        .ask[Either[PlaceBidRejected, LotEntity.Recorded]](
          LotEntity.Bid(placeBid(who, amount, 4 + index), Initiator.Participant(participant(who)), _)
        )
        .futureValue
        .isRight shouldBe true
    }
    val closed = lot
      .ask[Either[CloseLotRejected, Envelope]](
        LotEntity.Close(closeLot(4 + bids.size, CloseReason.ByAuctioneer), Initiator.Scheduler, _)
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

    "recovers a closed invoice and accepted replacement without repeating an offer or a financial obligation" in {
      val database = migrated()
      val at = calm.plusSeconds(20 * 86400L)
      // Эффект записался в PostgreSQL, но подтверждение не дошло до расчётов.
      def loseAnswers(delegate: InvoiceGateway): InvoiceGateway = new InvoiceGateway {
        def get(id: InvoiceId) = delegate.get(id)
        def issue(id: InvoiceId, terms: InvoiceTerms) = {
          import scala.concurrent.ExecutionContext.Implicits.global
          delegate.issue(id, terms).flatMap { done =>
            if (terms.winner == participant(3)) Future.failed(new IllegalStateException("lost issue reply"))
            else Future.successful(done)
          }
        }
        override def markUnredeemed(id: InvoiceId, opId: OpId) = {
          import scala.concurrent.ExecutionContext.Implicits.global
          delegate.markUnredeemed(id, opId).flatMap(_ => Future.failed(new IllegalStateException("lost closure reply")))
        }
        def markPaid(id: InvoiceId, opId: OpId) = delegate.markPaid(id, opId)
        def markHandedOver(id: InvoiceId, opId: OpId) = delegate.markHandedOver(id, opId)
        def chooseFulfillment(id: InvoiceId, viewer: ParticipantId, method: FulfillmentMethod, opId: OpId) =
          delegate.chooseFulfillment(id, viewer, method, opId)
      }
      val (lot, original) = withNode(database, loseAnswers) { node =>
        val (id, sold) = soldLot(node, List(2 -> 100L, 3 -> 200L, 1 -> 300L))
        val lot = LotId(id)
        val original = InvoiceId.of(sold.bidId)
        eventually(node.settlements.get(lot).futureValue shouldBe a[Settlement.Open])
        node.settlements.requestUnredeemed(lot, original, op(50)).futureValue shouldBe Right(Done)
        eventually {
          node.invoices.get(original).futureValue.asInstanceOf[Invoice.Issued].status shouldBe InvoiceStatus.Unredeemed
          node.settlements.get(lot).futureValue.asInstanceOf[Settlement.Open].stage shouldBe SettlementStage.Closing(
            op(50)
          )
        }
        lot -> original
      }
      val offer = withNode(database, clock = Clock.fixed(at, java.time.ZoneOffset.UTC)) { node =>
        eventually {
          node.settlements.get(lot).futureValue.asInstanceOf[Settlement.Open].stage shouldBe
            a[SettlementStage.Offering]
        }
        val before = node.settlements.get(lot).futureValue.asInstanceOf[Settlement.Open]
        val candidate = before.offers.head.offer.candidate
        candidate.participant shouldBe participant(3)
        candidate.amount shouldBe money(200)
        candidate.bid
      }
      val replacement = withNode(database, loseAnswers, Clock.fixed(at, java.time.ZoneOffset.UTC)) { node =>
        node.settlements.accept(lot, offer, participant(3), op(51)).futureValue shouldBe Right(Done)
        val id = InvoiceId.of(offer)
        eventually {
          node.invoices.get(id).futureValue shouldBe a[Invoice.Issued]
          node.settlements.get(lot).futureValue.asInstanceOf[Settlement.Open].stage shouldBe SettlementStage.Issuing
        }
        id
      }
      // Backfill обеих проекций продажи не должен возродить исходный счёт или заменить текущего покупателя.
      withConnection(database) { connection =>
        connection
          .createStatement()
          .executeUpdate(
            s"DELETE FROM pekko_projection_offset_store WHERE projection_name IN ('${InvoicingProjection.Name}', '${SettlementSalesHandler.Name}')"
          )
      }
      withNode(database) { node =>
        eventually {
          val state = node.settlements.get(lot).futureValue.asInstanceOf[Settlement.Open]
          state.stage shouldBe SettlementStage.AwaitingPayment
          state.invoices.map(_.id) shouldBe List(original, replacement)
          Settlement.buyer(state) shouldBe Some(participant(3))
          state.sale.terms.winner shouldBe participant(1)
          node.invoices.get(original).futureValue.asInstanceOf[Invoice.Issued].status shouldBe InvoiceStatus.Unredeemed
          val current = node.invoices.get(replacement).futureValue.asInstanceOf[Invoice.Issued]
          current.terms.amount shouldBe money(200)
          current.terms.paymentDueAt shouldBe at.plus(AuctionConfig.PlatformPaymentTerm)
          invoiceRows(database).count(_._5 == "AwaitingPayment") shouldBe 1
        }
        node.settlements.accept(lot, offer, participant(3), op(51)).futureValue shouldBe Right(Done)
        node.settlements.requestUnredeemed(lot, original, op(50)).futureValue shouldBe Right(Done)
        node.invoices.markPaid(original, op(60)).futureValue shouldBe Left(InvoiceRefusal.InvoiceClosed)
        journalRows(database, original) shouldBe 2L
        journalRows(database, replacement) shouldBe 1L
      }
    }

    "never transfers a paid invoice or pays a closed obligation under concurrent marks" in {
      val database = migrated()
      withNode(database) { node =>
        val (_, sold) = soldLot(node)
        val id = InvoiceId.of(sold.bidId)
        eventually(node.invoices.get(id).futureValue shouldBe a[Invoice.Issued])
        val paid = node.invoices.markPaid(id, op(70))
        val closed = node.invoices.markUnredeemed(id, op(71))
        (paid.futureValue, closed.futureValue) match {
          case (Right(Done), Left(InvoiceRefusal.InvoiceAlreadyPaid)) =>
            node.invoices.get(id).futureValue.asInstanceOf[Invoice.Issued].status shouldBe InvoiceStatus.Paid
          case (Left(InvoiceRefusal.InvoiceClosed), Right(Done)) =>
            node.invoices.get(id).futureValue.asInstanceOf[Invoice.Issued].status shouldBe InvoiceStatus.Unredeemed
          case other => fail(s"payment and closure both succeeded or failed: $other")
        }
        journalRows(database, id) shouldBe 2L
      }
    }

    "is issued once for a sale with the price of the sale and the term counted from the sale" in {
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

    "is not issued a second time when the sale is delivered again" in {
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

    "refuses the handover before the payment by name and publish each transition once" in {
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
