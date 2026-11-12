package auction.settlement

import auction.catalog.LotId
import auction.entity.JournalCorrupted
import auction.entity.JournalFixtures.*
import auction.invoice.*
import auction.lot.LotFixtures.*
import org.apache.pekko.actor.testkit.typed.scaladsl.ActorTestKit
import org.scalatest.BeforeAndAfterAll
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

import java.time.Duration
import scala.util.Using

final class SettlementJournalSpec extends AnyWordSpec with Matchers with BeforeAndAfterAll {
  private val kit = ActorTestKit("settlement-journal", localConfig)
  override protected def afterAll(): Unit = kit.shutdownTestKit()

  private val terms =
    InvoiceTerms.ofSale(auctionId(1), LotId(uuid(10)), participant(1), money(1000), calm, Duration.ofDays(7))
  private val sale = SettlementSale(InvoiceId.of(bid(1)), terms, Duration.ofDays(7))
  private val candidate = SettlementCandidate(bid(2), participant(2), money(800))

  private def golden(name: String): Array[Byte] =
    Using.resource(getClass.getResourceAsStream(s"/journal/$name.json"))(_.readAllBytes())

  "settlement journal" should {
    "round trips every saved step through the actual Pekko serializer and restores the same recovery state" in {
      val replacement =
        SettlementInvoice(
          InvoiceId.of(candidate.bid),
          terms.copy(winner = participant(2), amount = money(800), transferred = true)
        )
      val events = List(
        SettlementEvent.Opened(sale, List(candidate)),
        SettlementEvent.ClosureRequested(sale.invoice, op(1)),
        SettlementEvent.ClosureCompleted(op(1), ClosureOutcome.Closed),
        SettlementEvent.OfferAccepted(candidate.bid, participant(2), replacement, op(2)),
        SettlementEvent.InvoiceConfirmed(replacement.id),
        SettlementEvent.ClosureRequested(replacement.id, op(3)),
        SettlementEvent.ClosureCompleted(op(3), ClosureOutcome.Closed)
      )
      val restored = events.map { event =>
        val stored = SettlementJournal.store(uuid(1), decidedAt)(event)
        val row = write(kit.system, stored)
        val reread = read(kit.system, row).asInstanceOf[StoredSettlementEvent]
        reread shouldBe stored
        SettlementJournal.restore(reread) shouldBe event
        SettlementJournal.restore(reread)
      }
      restored.foldLeft[Settlement](Settlement.Initial)(Settlement.apply) shouldBe
        events.foldLeft[Settlement](Settlement.Initial)(Settlement.apply)
      List(
        SettlementEvent.OfferDeclined(candidate.bid, participant(2), op(4)),
        SettlementEvent.ClosureCompleted(op(5), ClosureOutcome.AlreadyPaid),
        SettlementEvent.ClosureCompleted(op(6), ClosureOutcome.OpIdTaken)
      ).foreach { event =>
        val stored = SettlementJournal.store(uuid(2), decidedAt)(event)
        SettlementJournal.restore(
          read(kit.system, write(kit.system, stored)).asInstanceOf[StoredSettlementEvent]
        ) shouldBe event
      }
    }

    "keeps the stored form of every settlement event equal to its golden file and reads the golden file back" in {
      // Идентификаторы счетов заданы явно: UUIDv5 от ставки в эталон не вписать без пространства имён.
      val goldenSale = SettlementSale(InvoiceId(uuid(20)), terms, Duration.ofDays(7))
      val accepted = SettlementInvoice(
        InvoiceId(uuid(21)),
        terms.copy(winner = participant(2), amount = money(800), transferred = true)
      )
      List(
        "settlement-opened" -> SettlementEvent.Opened(goldenSale, List(candidate)),
        "settlement-closure-requested" -> SettlementEvent.ClosureRequested(goldenSale.invoice, op(1)),
        "settlement-closure-closed" -> SettlementEvent.ClosureCompleted(op(1), ClosureOutcome.Closed),
        "settlement-closure-already-paid" -> SettlementEvent.ClosureCompleted(op(5), ClosureOutcome.AlreadyPaid),
        "settlement-closure-op-id-taken" -> SettlementEvent.ClosureCompleted(op(6), ClosureOutcome.OpIdTaken),
        "settlement-offer-accepted" -> SettlementEvent.OfferAccepted(candidate.bid, participant(2), accepted, op(2)),
        "settlement-offer-declined" -> SettlementEvent.OfferDeclined(candidate.bid, participant(2), op(4)),
        "settlement-invoice-confirmed" -> SettlementEvent.InvoiceConfirmed(accepted.id)
      ).foreach { case (name, event) =>
        val stored = SettlementJournal.store(uuid(1), decidedAt)(event)
        val row = write(kit.system, stored)
        row.manifest shouldBe "auction.settlement.StoredSettlementEvent"
        row.json shouldBe mapper.readTree(golden(name))
        val fromGolden = read(kit.system, row.copy(bytes = golden(name)))
        fromGolden shouldBe stored
        SettlementJournal.restore(fromGolden.asInstanceOf[StoredSettlementEvent]) shouldBe event
      }
    }

    "reads a settlement terms row without the transferred flag as an ordinary invoice" in {
      val opened = read(
        kit.system,
        write(kit.system, SettlementJournal.store(uuid(1), decidedAt)(SettlementEvent.Opened(sale, Nil)))
          .copy(bytes = golden("legacy/settlement-opened-without-transferred"))
      )
      SettlementJournal.restore(opened.asInstanceOf[StoredSettlementEvent]) match {
        case SettlementEvent.Opened(restored, _) => restored.terms.transferred shouldBe false
        case other => fail(s"unexpected $other")
      }
    }

    "refuses a closure row with an unknown outcome name" in {
      val stored =
        SettlementJournal.store(uuid(1), decidedAt)(SettlementEvent.ClosureCompleted(op(1), ClosureOutcome.Closed))
      an[JournalCorrupted] should be thrownBy SettlementJournal.restore(
        stored.copy(closed = stored.closed.map(_.copy(outcome = "Bogus")))
      )
    }

    "refuses a row with sections that do not match the saved step" in {
      val stored =
        SettlementJournal.store(uuid(1), decidedAt)(SettlementEvent.ClosureCompleted(op(1), ClosureOutcome.Closed))
      an[JournalCorrupted] should be thrownBy SettlementJournal.restore(stored.copy(kind = "OfferAccepted"))
    }
  }
}
