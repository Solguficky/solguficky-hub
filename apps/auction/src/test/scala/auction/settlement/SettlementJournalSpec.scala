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

final class SettlementJournalSpec extends AnyWordSpec with Matchers with BeforeAndAfterAll {
  private val kit = ActorTestKit("settlement-journal", localConfig)
  override protected def afterAll(): Unit = kit.shutdownTestKit()

  private val terms =
    InvoiceTerms.ofSale(auctionId(1), LotId(uuid(10)), participant(1), money(1000), calm, Duration.ofDays(7))
  private val sale = SettlementSale(InvoiceId.of(bid(1)), terms, Duration.ofDays(7))
  private val candidate = SettlementCandidate(bid(2), participant(2), money(800))

  "settlement journal" should {
    "round trips every saved step through the actual Pekko serializer and restores the same recovery state" in {
      val replacement =
        SettlementInvoice(InvoiceId.of(candidate.bid), terms.copy(winner = participant(2), amount = money(800)))
      val events = List(
        SettlementEvent.Opened(sale, List(candidate)),
        SettlementEvent.ClosureRequested(sale.invoice, op(1)),
        SettlementEvent.ClosureCompleted(op(1), true),
        SettlementEvent.OfferAccepted(candidate.bid, participant(2), replacement, op(2)),
        SettlementEvent.InvoiceConfirmed(replacement.id),
        SettlementEvent.ClosureRequested(replacement.id, op(3)),
        SettlementEvent.ClosureCompleted(op(3), true)
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
        SettlementEvent.ClosureCompleted(op(5), false)
      ).foreach { event =>
        val stored = SettlementJournal.store(uuid(2), decidedAt)(event)
        SettlementJournal.restore(
          read(kit.system, write(kit.system, stored)).asInstanceOf[StoredSettlementEvent]
        ) shouldBe event
      }
    }

    "refuses a row with sections that do not match the saved step" in {
      val stored = SettlementJournal.store(uuid(1), decidedAt)(SettlementEvent.ClosureCompleted(op(1), true))
      an[JournalCorrupted] should be thrownBy SettlementJournal.restore(stored.copy(kind = "OfferAccepted"))
    }
  }
}
