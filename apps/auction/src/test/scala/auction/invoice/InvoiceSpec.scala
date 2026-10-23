package auction.invoice

import auction.catalog.LotId
import auction.entity.JournalFixtures.uuid
import auction.lot.LotFixtures.*
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

import java.time.Duration
import java.time.Instant

/**
 * Ядро счёта (PER-338): счёт выставляется по продаже один раз с суммой, равной цене продажи, и сроком от момента
 * продажи; путь статусов один и в одну сторону; повтор своего `op_id` — исходный ответ, чужой — отказ.
 */
final class InvoiceSpec extends AnyWordSpec with Matchers {

  private val soldAt = Instant.parse("2026-10-08T21:00:00Z")
  private val winner = participant(1)
  private val terms =
    InvoiceTerms.ofSale(auctionId(1), LotId(uuid(11)), winner, money(125000), soldAt, Duration.ofDays(7))

  private def run(state: Invoice, decided: Either[InvoiceRefusal, Option[InvoiceEvent]]): Invoice =
    decided.toOption.flatten.fold(state)(Invoice.apply(state, _))

  private val issued = run(Invoice.initial, Right(Invoice.issue(Invoice.initial, terms)))
  private val paid = run(issued, Invoice.markPaid(issued, op(1)))

  "an invoice" should {

    "is issued once per sale with the price of the sale and the term counted from the sale" in {
      terms.amount shouldBe money(125000)
      terms.paymentDueAt shouldBe Instant.parse("2026-10-15T21:00:00Z")
      Invoice.issue(Invoice.initial, terms) shouldBe Some(InvoiceEvent.InvoiceIssued(terms))
      Invoice.issue(issued, terms) shouldBe None
      Invoice.issue(issued, terms.copy(amount = money(1))) shouldBe None
      issued shouldBe Invoice.Issued(terms, InvoiceStatus.AwaitingPayment, None, Map.empty)
    }

    "cuts the due moment to microseconds, the precision the read model keeps" in {
      val precise = Instant.parse("2026-10-08T21:00:00.123456789Z")
      InvoiceTerms
        .ofSale(auctionId(1), LotId(uuid(11)), winner, money(1), precise, Duration.ofDays(1))
        .paymentDueAt shouldBe Instant.parse("2026-10-09T21:00:00.123456Z")
    }

    "derives one id from the winning bid, and another id from another bid" in {
      InvoiceId.of(bid(1)) shouldBe InvoiceId.of(bid(1))
      InvoiceId.of(bid(1)) should not be InvoiceId.of(bid(2))
      InvoiceId.of(bid(1)).value.version shouldBe 5
    }

    "refuses every command before the invoice is issued" in {
      Invoice.markPaid(Invoice.initial, op(1)) shouldBe Left(InvoiceRefusal.InvoiceNotFound)
      Invoice.markHandedOver(Invoice.initial, op(1)) shouldBe Left(InvoiceRefusal.InvoiceNotFound)
      Invoice.chooseFulfillment(Invoice.initial, winner, FulfillmentMethod.Pickup, op(1)) shouldBe
        Left(InvoiceRefusal.InvoiceNotFound)
    }

    "marks the payment once and accept a later mark without a second transition" in {
      Invoice.markPaid(issued, op(1)) shouldBe Right(Some(InvoiceEvent.InvoicePaid(op(1))))
      paid match {
        case Invoice.Issued(_, status, _, _) => status shouldBe InvoiceStatus.Paid
        case other => fail(s"unexpected $other")
      }
      Invoice.markPaid(paid, op(1)) shouldBe Right(None)
      Invoice.markPaid(paid, op(2)) shouldBe Right(None)
    }

    "refuses to hand over an invoice that still awaits payment by name" in {
      Invoice.markHandedOver(issued, op(2)) shouldBe Left(InvoiceRefusal.InvoiceNotPaid)
    }

    "hands over a paid invoice once and accept a later mark without a second transition" in {
      Invoice.markHandedOver(paid, op(2)) shouldBe Right(Some(InvoiceEvent.InvoiceHandedOver(op(2))))
      val handedOver = run(paid, Invoice.markHandedOver(paid, op(2)))
      Invoice.markHandedOver(handedOver, op(3)) shouldBe Right(None)
      Invoice.markPaid(handedOver, op(4)) shouldBe Right(None)
    }

    "refuses an op_id already taken by a command of another kind" in {
      Invoice.markHandedOver(paid, op(1)) shouldBe Left(InvoiceRefusal.OpIdTaken)
      Invoice.chooseFulfillment(paid, winner, FulfillmentMethod.Pickup, op(1)) shouldBe Left(InvoiceRefusal.OpIdTaken)
    }

    "lets the winner replace the method until the lot is handed over, and freeze it after" in {
      val picked = run(issued, Invoice.chooseFulfillment(issued, winner, FulfillmentMethod.Pickup, op(5)))
      val delivered = run(picked, Invoice.chooseFulfillment(picked, winner, FulfillmentMethod.Delivery, op(6)))
      delivered match {
        case Invoice.Issued(_, _, fulfillment, _) => fulfillment shouldBe Some(FulfillmentMethod.Delivery)
        case other => fail(s"unexpected $other")
      }
      // Запоздавший повтор первого выбора после второго — исходный ответ, а не возврат прежнего способа.
      Invoice.chooseFulfillment(delivered, winner, FulfillmentMethod.Pickup, op(5)) shouldBe Right(None)
      val handedOver = List(
        Invoice.markPaid(delivered, op(7)),
        Invoice.markHandedOver(run(delivered, Invoice.markPaid(delivered, op(7))), op(8))
      ).foldLeft(delivered)(run)
      Invoice.chooseFulfillment(handedOver, winner, FulfillmentMethod.Digital, op(9)) shouldBe
        Left(InvoiceRefusal.FulfillmentFrozen)
    }

    "hides an invoice from anyone but its winner" in {
      Invoice.chooseFulfillment(issued, participant(2), FulfillmentMethod.Pickup, op(5)) shouldBe
        Left(InvoiceRefusal.InvoiceNotFound)
    }
  }
}
