package auction.lot

import auction.lot.LotFixtures.*
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

/**
 * Снятие лота отменённым аукционом (ADR-047, дополнение 2026-10-12): что завершилось, остаётся, что идёт, обрывается, а
 * `Withdrawn` терминален.
 */
final class WithdrawSpec extends AnyWordSpec with Matchers {

  private val withdrawn = LotState.Withdrawn(WithdrawnReason.AuctionCancelled)

  "withdrawing a lot" should {

    "withdraw a lot without an outcome, from the draft to the hold, with the reason of the command" in {
      val lots = List(
        drafted,
        scheduled(),
        trading(price = 500, leader = Some(participant(2))),
        held(price = 500, leader = participant(2))
      )
      lots.foreach { lot =>
        val (result, journal) = Journal.of(lot).withdrawLot(withdrawLot(opN = 1))
        result shouldBe Right(Decision.Accepted(LotEvent.LotWithdrawn(WithdrawnReason.AuctionCancelled)))
        journal.lot.state shouldBe withdrawn
      }
    }

    "leave a sold, an unsold and an already withdrawn lot as it was" in {
      val unsold = lotIn(LotState.Unsold(UnsoldReason.NoBids))
      val (_, gone) = Journal.of(scheduled()).withdrawLot(withdrawLot(opN = 1))
      List(sold(price = 700, winner = participant(2)), unsold, gone.lot).foreach { lot =>
        val (result, journal) = Journal.of(lot).withdrawLot(withdrawLot(opN = 2))
        result shouldBe Left(WithdrawLotRejected.LotAlreadyClosed)
        journal.entries shouldBe empty
      }
    }

    "answer a repeated withdrawal with the original envelope and refuse its op_id to another command" in {
      val (_, journal) = Journal.of(trading(price = 500)).withdrawLot(withdrawLot(opN = 1))
      val (repeated, again) = journal.withdrawLot(withdrawLot(opN = 1))
      repeated shouldBe Right(Decision.Repeated(journal.entries.head))
      again.entries should have size 1
      val (_, bidden) = Journal.of(trading(price = 500)).submit(placeBid(who = 2, amount = 510, opN = 1), bid(1))
      bidden.withdrawLot(withdrawLot(opN = 1))._1 shouldBe Left(WithdrawLotRejected.OpIdTaken)
    }

    "answer a lot without a journal with LotNotFound" in {
      Journal.of(Lot.initial).withdrawLot(withdrawLot(opN = 1))._1 shouldBe Left(WithdrawLotRejected.LotNotFound)
    }

    "refuse a late opening, a bid, a proxy limit and a closing once the lot is withdrawn" in {
      val (_, opened) = Journal.of(trading(price = 500)).withdrawLot(withdrawLot(opN = 1))
      val (_, unopened) = Journal.of(scheduled()).withdrawLot(withdrawLot(opN = 1))
      unopened.open(openLot(opN = 2))._1 shouldBe Left(OpenLotRejected.LotNotScheduled)
      unopened.lot.state shouldBe withdrawn
      opened.submit(placeBid(who = 2, amount = 510, opN = 3), bid(1))._1 shouldBe Left(PlaceBidRejected.LotNotOpen)
      opened.limit(setProxyLimit(who = 2, max = 900, opN = 4))._1 shouldBe Left(SetProxyLimitRejected.LotNotOpen)
      opened.close(closeLot(opN = 5), deadline)._1 shouldBe Left(CloseLotRejected.LotNotOpen)
      opened.close(closeLot(opN = 6, CloseReason.ByAuctioneer), deadline)._1 shouldBe Left(CloseLotRejected.LotNotOpen)
    }

    "keep the sale that the journal recorded first and withdraw the lot whose closing came second" in {
      val leading = trading(price = 500, leader = Some(participant(2)))
      val (_, closedFirst) = Journal.of(leading).close(closeLot(opN = 1), deadline)
      closedFirst.withdrawLot(withdrawLot(opN = 2))._1 shouldBe Left(WithdrawLotRejected.LotAlreadyClosed)
      closedFirst.lot.state shouldBe a[LotState.Sold]
      val (_, withdrawnFirst) = Journal.of(leading).withdrawLot(withdrawLot(opN = 2))
      withdrawnFirst.close(closeLot(opN = 1), deadline)._1 shouldBe Left(CloseLotRejected.LotNotOpen)
      withdrawnFirst.lot.state shouldBe withdrawn
    }
  }
}
