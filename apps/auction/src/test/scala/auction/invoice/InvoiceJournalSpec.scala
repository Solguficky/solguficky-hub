package auction.invoice

import auction.catalog.LotId
import auction.entity.JournalCorrupted
import auction.entity.JournalFixtures.*
import auction.lot.LotFixtures.*
import org.apache.pekko.actor.testkit.typed.scaladsl.ActorTestKit
import org.scalatest.BeforeAndAfterAll
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

import java.time.Instant
import scala.util.Using

/**
 * Модель хранения счёта: каждое событие пишется так, как его держит эталон, и эталон читается в то же значение. Имена
 * полей и `kind` — формат журнала, и их переименование ломает эталон первым.
 */
final class InvoiceJournalSpec extends AnyWordSpec with Matchers with BeforeAndAfterAll {

  private val kit = ActorTestKit("invoice-journal", localConfig)

  override protected def afterAll(): Unit = kit.shutdownTestKit()

  private val terms = InvoiceTerms(
    auctionId(1),
    LotId(uuid(11)),
    participant(1),
    money(125000),
    Instant.parse("2026-10-15T21:00:00Z")
  )

  private def golden(name: String): Array[Byte] =
    Using.resource(getClass.getResourceAsStream(s"/journal/$name.json"))(_.readAllBytes())

  private def keepsGolden(name: String, event: InvoiceEvent) = {
    val stored = InvoiceJournal.store(uuid(1), decidedAt)(event)
    val row = write(kit.system, stored)
    row.json shouldBe mapper.readTree(golden(name))
    read(kit.system, row.copy(bytes = golden(name))) shouldBe stored
    InvoiceJournal.restoreEvent(stored.event) shouldBe event
  }

  "invoice journal" should {

    "keep the stored form of every invoice event equal to its golden file and read the golden file back" in {
      keepsGolden("invoice-issued", InvoiceEvent.InvoiceIssued(terms))
      keepsGolden("invoice-paid", InvoiceEvent.InvoicePaid(op(2)))
      keepsGolden("invoice-handed-over", InvoiceEvent.InvoiceHandedOver(op(3)))
      keepsGolden("fulfillment-chosen", InvoiceEvent.FulfillmentChosen(FulfillmentMethod.Delivery, op(4)))
    }

    "read every fulfillment method back by its stored name" in {
      FulfillmentMethod.values.foreach { method =>
        InvoiceJournal.restoreMethod(InvoiceJournal.methodName(method)) shouldBe method
      }
      InvoiceStatus.values.foreach { status =>
        InvoiceJournal.restoreStatus(InvoiceJournal.statusName(status)) shouldBe status
      }
    }

    "refuse a row whose section does not match its kind" in {
      val broken =
        InvoiceJournal.store(uuid(1), decidedAt)(InvoiceEvent.InvoicePaid(op(2))).event.copy(kind = "InvoiceHandedOver")
      an[JournalCorrupted] should be thrownBy InvoiceJournal.restoreEvent(broken)
    }
  }
}
