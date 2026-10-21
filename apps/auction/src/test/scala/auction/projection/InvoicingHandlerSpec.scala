package auction.projection

import auction.aggregate.AuctionConfig
import auction.catalog.LotId
import auction.entity.Initiator
import auction.entity.JournalFixtures.*
import auction.entity.LotJournal
import auction.entity.StoredLotEvent
import auction.entity.Transaction
import auction.invoice.InvoiceId
import auction.invoice.InvoiceTerms
import auction.lot.AuctionId
import auction.lot.LotEvent
import auction.lot.LotFixtures.*
import auction.lot.UnsoldReason
import org.apache.pekko.Done
import org.apache.pekko.persistence.query.Sequence
import org.apache.pekko.projection.eventsourced.EventEnvelope
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

import java.time.Duration
import java.time.Instant
import java.util.UUID
import java.util.concurrent.ConcurrentLinkedQueue
import scala.concurrent.Await
import scala.concurrent.ExecutionContext
import scala.concurrent.Future
import scala.concurrent.duration.*
import scala.jdk.CollectionConverters.*

/**
 * Обработчик выставления на подменах портов: продажа даёт счёт с ценой продажи и сроком из конфигурации аукциона, от
 * момента продажи; тестовый аукцион получает срок платформы, не спрашивая аукцион; остальные события ничего не шлют, а
 * молчание аукциона или счёта — упавшее `Future`, и событие повторится.
 */
final class InvoicingHandlerSpec extends AnyWordSpec with Matchers {

  private given ExecutionContext = ExecutionContext.global

  private val soldAt = Instant.parse("2026-10-08T21:00:00Z")
  private val lot = LotId(uuid(11))
  private val meetupAuction = AuctionId(UUID.fromString("83a6d0b2-84ed-5444-a77b-dd0338dc84a4"))
  private val testAuction = AuctionId(uuid(40))

  private def envelope(of: AuctionId, event: LotEvent, sequence: Long = 7): EventEnvelope[StoredLotEvent] = {
    val transaction = Transaction(uuid(2), op(1), of, soldAt, Initiator.Scheduler)
    EventEnvelope(Sequence(sequence), s"lot|${lot.value}", sequence, LotJournal.store(uuid(1), transaction, event), 0L)
  }

  private val sold = LotEvent.LotSold(participant(1), money(125000), bid(9), soldAt)

  private final class Ports(term: Future[Duration] = Future.successful(Duration.ofDays(3))) {
    val asked = new ConcurrentLinkedQueue[AuctionId]()
    val issued = new ConcurrentLinkedQueue[(InvoiceId, InvoiceTerms)]()
    val handler = InvoicingHandler(
      asking => { asked.add(asking); term },
      (invoice, terms) => { issued.add(invoice -> terms); Future.successful(Done) }
    )
  }

  private def processed(ports: Ports, envelope: EventEnvelope[StoredLotEvent]): Done =
    Await.result(ports.handler.process(envelope), 3.seconds)

  "the invoicing handler" should {

    "issue an invoice for a sale with the price of the sale and the term of the auction from the sale" in {
      val ports = Ports()
      processed(ports, envelope(meetupAuction, sold)) shouldBe Done
      ports.asked.asScala.toList shouldBe List(meetupAuction)
      ports.issued.asScala.toList shouldBe List(
        InvoiceId.of(bid(9)) -> InvoiceTerms(
          meetupAuction,
          lot,
          participant(1),
          money(125000),
          Instant.parse("2026-10-11T21:00:00Z")
        )
      )
    }

    "issue the same invoice again for a redelivered sale" in {
      val ports = Ports()
      processed(ports, envelope(meetupAuction, sold))
      processed(ports, envelope(meetupAuction, sold))
      ports.issued.asScala.map(_._1).toSet shouldBe Set(InvoiceId.of(bid(9)))
    }

    "give the invoice of a test auction the term of the platform without asking the auction" in {
      val ports = Ports()
      processed(ports, envelope(testAuction, sold))
      ports.asked.asScala shouldBe empty
      ports.issued.asScala.map(_._2.paymentDueAt).toList shouldBe List(soldAt.plus(AuctionConfig.PlatformPaymentTerm))
    }

    "send nothing for an event that is not a sale" in {
      val ports = Ports()
      processed(ports, envelope(meetupAuction, LotEvent.LotUnsold(UnsoldReason.NoBids)))
      processed(ports, envelope(meetupAuction, placed))
      ports.asked.asScala shouldBe empty
      ports.issued.asScala shouldBe empty
    }

    "fail the event when the auction does not answer, so that it is processed again" in {
      val ports = Ports(Future.failed(new RuntimeException("auction did not answer")))
      a[RuntimeException] should be thrownBy processed(ports, envelope(meetupAuction, sold))
      ports.issued.asScala shouldBe empty
    }
  }
}
