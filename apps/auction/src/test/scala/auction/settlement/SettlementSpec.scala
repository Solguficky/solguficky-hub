package auction.settlement

import auction.catalog.LotId
import auction.entity.JournalFixtures.uuid
import auction.invoice.*
import auction.lot.*
import auction.lot.LotFixtures.*
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

import java.time.Duration

final class SettlementSpec extends AnyWordSpec with Matchers {
  private val terms =
    InvoiceTerms.ofSale(auctionId(1), LotId(uuid(10)), participant(1), money(1000), calm, Duration.ofDays(7))
  private val sale = SettlementSale(InvoiceId.of(bid(1)), terms, Duration.ofDays(7))
  private val boris = SettlementCandidate(bid(2), participant(2), money(800))
  private val vera = SettlementCandidate(bid(3), participant(3), money(600))

  private def writtenHistory(events: List[LotEvent]): List[Written] = {
    val prefix = List(
      LotEvent.LotDrafted(auctionId(1)),
      LotEvent.LotScheduled(schedule()),
      LotEvent.LotOpened(money(100), config(), Some(deadline))
    )
    (prefix ++ events).zipWithIndex.map { (event, index) =>
      Written(Envelope(index.toLong + 1, op(index + 100), event), calm)
    }
  }

  private def auctionWithLimits(): Journal = {
    val draft = Journal.of(Lot.initial).draft(draftLot(1))._2
    val scheduled = draft.schedule(scheduleLot(2))._2
    val opened = scheduled.open(openLot(3))._2
    val m = opened.limit(setProxyLimit(2, 900, 4))._2
    m.limit(setProxyLimit(3, 1000, 5))._2
  }

  private def opened(candidates: List[SettlementCandidate] = List(boris, vera)): Settlement =
    Settlement(Settlement.Initial, SettlementEvent.Opened(sale, candidates))

  private def written(state: Settlement, result: Either[SettlementRefusal, Option[SettlementEvent]]): Settlement =
    result.toOption.get.fold(state)(Settlement(state, _))

  private def offering(candidates: List[SettlementCandidate] = List(boris, vera)): Settlement = {
    val closing = written(opened(candidates), Settlement.requestUnredeemed(opened(candidates), sale.invoice, op(10)))
    Settlement(closing, Settlement.closureCompleted(closing, op(10), ClosureOutcome.Closed).get)
  }

  "settlement" should {
    "offers each participant once at the last accepted bid including automatic bids, skipping a proxy without a bid" in {
      val history = List(
        LotEvent.BidPlaced(bid(10), participant(2), money(300), None, BidOrigin.Manual(BidSource.Bot)),
        LotEvent.ProxyLimitSet(participant(4), money(2000)),
        LotEvent.BidPlaced(boris.bid, boris.participant, boris.amount, None, BidOrigin.Proxy),
        LotEvent.BidPlaced(bid(1), participant(1), money(1000), None, BidOrigin.Manual(BidSource.Bot))
      )
      Settlement.candidates(writtenHistory(history), participant(1)) shouldBe List(boris)
    }

    "excludes a removed participant even though the journal retains their accepted bids" in {
      val history = List(
        LotEvent.BidPlaced(boris.bid, boris.participant, boris.amount, None, BidOrigin.Manual(BidSource.Bot)),
        LotEvent.ParticipantRemoved(boris.participant, money(100), None, None)
      )
      Settlement.candidates(writtenHistory(history), participant(1)) shouldBe Nil
    }

    "offers the recalculated 100 instead of the 910 raised against a removed participant" in {
      val before = auctionWithLimits()
      tradingOf(before.lot).currentPrice shouldBe money(910)
      val (result, removed) = before.remove(removeParticipant(2, 6, before.entries.size.toLong))
      result.isRight shouldBe true
      tradingOf(removed.lot).currentPrice shouldBe money(100)
      val withdrawn = removed.withdraw(withdrawProxyLimit(3, 7))._2
      val winning = withdrawn.submit(placeBid(1, 200, 8), bid(80))._2
      val sold = winning.close(closeLot(9, CloseReason.ByAuctioneer), calm)._2
      sold.lot.state.asInstanceOf[LotState.Sold].sale.price shouldBe money(200)
      val candidates = Settlement.candidates(sold.rows.toList, participant(1))
      candidates.map(candidate => candidate.participant -> candidate.amount) shouldBe
        List(participant(3) -> money(100))
      val state = offering(candidates)
      val accepted = written(state, Settlement.accept(state, candidates.head.bid, participant(3), op(90), calm))
        .asInstanceOf[Settlement.Open]
      accepted.current.terms.amount shouldBe money(100)
    }

    "recalculates a nonleading candidate as well as the leader when another participant is removed" in {
      val before = auctionWithLimits().limit(setProxyLimit(4, 2000, 6))._2
      val removed = before.remove(removeParticipant(2, 7, before.entries.size.toLong))._2
      val bWithdrawn = removed.withdraw(withdrawProxyLimit(3, 8))._2
      val cWithdrawn = bWithdrawn.withdraw(withdrawProxyLimit(4, 9))._2
      val winning = cWithdrawn.submit(placeBid(1, 1100, 10), bid(81))._2
      val sold = winning.close(closeLot(11, CloseReason.ByAuctioneer), calm)._2
      val candidates = Settlement.candidates(sold.rows.toList, participant(1))
      candidates.find(_.participant == participant(3)).map(_.amount) shouldBe Some(money(100))
      candidates.exists(_.participant == participant(2)) shouldBe false
    }

    "waits for an explicit unredeemed command and confirmed closure before offering the lot" in {
      val state = opened()
      state.asInstanceOf[Settlement.Open].stage shouldBe SettlementStage.AwaitingPayment
      val closing = written(state, Settlement.requestUnredeemed(state, sale.invoice, op(10)))
      closing.asInstanceOf[Settlement.Open].offers shouldBe Nil
      Settlement.buyer(closing) shouldBe Some(participant(1))
      Settlement.buyer(offering()) shouldBe None
      offering().asInstanceOf[Settlement.Open].stage shouldBe SettlementStage.Offering(SettlementOffer(boris))
    }

    "keeps the original obligation when payment won the race with closure" in {
      val closing = written(opened(), Settlement.requestUnredeemed(opened(), sale.invoice, op(10)))
      val after = Settlement(closing, Settlement.closureCompleted(closing, op(10), ClosureOutcome.AlreadyPaid).get)
        .asInstanceOf[Settlement.Open]
      after.stage shouldBe SettlementStage.AwaitingPayment
      after.offers shouldBe Nil
      after.closures shouldBe Map(op(10) -> ClosureOutcome.AlreadyPaid)
    }

    "creates immutable new terms after consent with the auction term counted from consent" in {
      val state = offering()
      val acceptedAt = calm.plus(Duration.ofDays(20))
      val accepted = written(state, Settlement.accept(state, boris.bid, boris.participant, op(11), acceptedAt))
        .asInstanceOf[Settlement.Open]
      accepted.current.id shouldBe InvoiceId.of(boris.bid)
      accepted.current.terms.amount shouldBe money(800)
      accepted.current.terms.paymentDueAt shouldBe acceptedAt.plus(Duration.ofDays(7))
      accepted.sale shouldBe sale
      accepted.invoices.head shouldBe SettlementInvoice(sale.invoice, terms)
      Settlement.accept(accepted, boris.bid, boris.participant, op(11), acceptedAt.plusSeconds(100)) shouldBe Right(
        None
      )
      accepted.stage shouldBe SettlementStage.Issuing
    }

    "keeps an operation conflict distinct from payment and does not offer the lot after either refusal" in {
      val closing = written(opened(), Settlement.requestUnredeemed(opened(), sale.invoice, op(10)))
      val after = Settlement(closing, Settlement.closureCompleted(closing, op(10), ClosureOutcome.OpIdTaken).get)
        .asInstanceOf[Settlement.Open]
      after.closures shouldBe Map(op(10) -> ClosureOutcome.OpIdTaken)
      after.offers shouldBe Nil
      Settlement.requestUnredeemed(after, sale.invoice, op(10)) shouldBe Right(None)
    }

    "does not create an invoice on decline and finishes unredeemed after the last decline" in {
      val state = offering()
      val next = written(state, Settlement.decline(state, boris.bid, boris.participant, op(11)))
      next.asInstanceOf[Settlement.Open].stage shouldBe SettlementStage.Offering(SettlementOffer(vera))
      val end =
        written(next, Settlement.decline(next, vera.bid, vera.participant, op(12))).asInstanceOf[Settlement.Open]
      end.stage shouldBe SettlementStage.Unredeemed
      end.invoices shouldBe List(SettlementInvoice(sale.invoice, terms))
      Settlement.buyer(end) shouldBe None
      Settlement.decline(end, boris.bid, boris.participant, op(11)) shouldBe Right(None)
    }

    "continues with the remaining candidates when a replacement buyer also fails to redeem" in {
      val state = offering()
      val accepted = written(state, Settlement.accept(state, boris.bid, boris.participant, op(11), calm))
        .asInstanceOf[Settlement.Open]
      val confirmed = Settlement(accepted, Settlement.invoiceConfirmed(accepted, accepted.current.id).get)
      val closing = written(confirmed, Settlement.requestUnredeemed(confirmed, accepted.current.id, op(12)))
      val next =
        Settlement(closing, Settlement.closureCompleted(closing, op(12), ClosureOutcome.Closed).get)
          .asInstanceOf[Settlement.Open]
      next.stage shouldBe SettlementStage.Offering(SettlementOffer(vera))
      next.offers.map(_.offer.candidate.participant) shouldBe List(boris.participant, vera.participant)
    }

    "rejects foreign and stale offers and never applies an operation to a different invoice" in {
      val state = offering()
      Settlement.accept(state, boris.bid, vera.participant, op(11), calm) shouldBe Left(SettlementRefusal.OfferNotFound)
      val next = written(state, Settlement.decline(state, boris.bid, boris.participant, op(11)))
      Settlement.accept(next, boris.bid, boris.participant, op(12), calm) shouldBe Left(SettlementRefusal.StaleOffer)
      Settlement.requestUnredeemed(next, InvoiceId.of(bid(99)), op(10)) shouldBe Left(SettlementRefusal.OpIdTaken)
      Settlement.closureCompleted(next, op(10), ClosureOutcome.Closed) shouldBe None
      Settlement.invoiceConfirmed(next, sale.invoice) shouldBe None
      Settlement.open(next, sale, Nil) shouldBe None
    }
  }

  "invoice closure" should {
    "serializes payment and unredeemed closure in either order without changing the historical terms" in {
      val original = Invoice(Invoice.initial, InvoiceEvent.InvoiceIssued(terms))
      val paid = Invoice(original, Invoice.markPaid(original, op(20)).toOption.get.get)
      Invoice.markUnredeemed(paid, op(21)) shouldBe Left(InvoiceRefusal.InvoiceAlreadyPaid)
      val closed = Invoice(original, Invoice.markUnredeemed(original, op(21)).toOption.get.get)
      Invoice.markPaid(closed, op(20)) shouldBe Left(InvoiceRefusal.InvoiceClosed)
      Invoice.markHandedOver(closed, op(22)) shouldBe Left(InvoiceRefusal.InvoiceClosed)
      Invoice.chooseFulfillment(closed, terms.winner, FulfillmentMethod.Pickup, op(23)) shouldBe
        Left(InvoiceRefusal.InvoiceClosed)
      Invoice.issue(closed, terms.copy(amount = money(5))) shouldBe None
      Invoice.markUnredeemed(closed, op(21)) shouldBe Right(None)
      closed.asInstanceOf[Invoice.Issued].terms shouldBe terms
    }
  }
}
