package auction.lot

import auction.lot.LotFixtures.*
import org.scalacheck.Gen
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec
import org.scalatestplus.scalacheck.ScalaCheckDrivenPropertyChecks

import java.time.Duration
import java.time.Instant

final class HoldSpec extends AnyWordSpec with Matchers with ScalaCheckDrivenPropertyChecks {

  implicit override val generatorDrivenConfig: PropertyCheckConfiguration =
    PropertyCheckConfiguration(minSuccessful = 200)

  private val oneMinuteBefore: Instant = deadline.minus(Duration.ofMinutes(1))

  /** Лот с лидером 2 по 500 и лимитами двух участников, отмеченный для финала. */
  private def marked: Journal = {
    val limits = Map(participant(2) -> limit(max = 800, setSeq = 1), participant(3) -> limit(max = 450, setSeq = 2))
    val (_, journal) =
      Journal.of(trading(price = 500, leader = Some(participant(2)), limits = limits)).mark(markForFinal(opN = 1))
    journal
  }

  /** Тот же лот, удержанный закрытием по наступившему дедлайну. */
  private def holding: Journal = marked.close(closeLot(opN = 2), deadline)._2

  "marking for the final" should {

    "mark a lot before its deadline and let trading go on (Т-34)" in {
      val (result, journal) = Journal.of(trading(price = 100)).mark(markForFinal(opN = 1))

      result shouldBe Right(Decision.Accepted(LotEvent.LotMarkedForFinal))
      tradingOf(journal.lot).markedForFinal shouldBe true

      val (bidden, after) = journal.submit(placeBid(who = 1, amount = 150, opN = 2), bid(1))

      bidden shouldBe Right(Decision.Accepted(manual(bid(1), 1, 150, None)))
      tradingOf(after.lot).currentPrice shouldBe money(150)
      tradingOf(after.lot).markedForFinal shouldBe true
    }

    "keep extending the deadline of a marked lot by anti-sniping" in {
      val (_, journal) = Journal.of(trading(price = 100)).mark(markForFinal(opN = 1))

      val (_, after) = journal.submit(placeBid(who = 1, amount = 110, opN = 2), bid(1), oneMinuteBefore)

      tradingOf(after.lot).deadline shouldBe Some(deadline.plus(Duration.ofMinutes(2)))
      tradingOf(after.lot).markedForFinal shouldBe true
    }

    "refuse a mark once the deadline came, though no closing arrived, and sell on the closing after it (Т-36)" in {
      val before = Journal.of(trading(price = 500, leader = Some(participant(2))))

      val (result, after) = before.mark(markForFinal(opN = 1), deadline)

      result shouldBe Left(MarkForFinalRejected.DeadlinePassed)
      after shouldBe before
      after.close(closeLot(opN = 2), deadline)._1 shouldBe
        Right(Decision.Accepted(LotEvent.LotSold(participant(2), money(500), bid(0), deadline)))
    }

    "judge the race of a mark and the deadline by the server time alone" in {
      forAll(Gen.choose(-86400L, 86400L)) { offset =>
        val result = Lot.decide(trading(price = 100), markForFinal(opN = 1), deadline.plusSeconds(offset))
        if (offset < 0) result shouldBe Right(Decision.Accepted(LotEvent.LotMarkedForFinal))
        else result shouldBe Left(MarkForFinalRejected.DeadlinePassed)
      }
    }

    "mark a lot that a person closes at any moment of its trading" in {
      Lot.decide(trading(price = 100, closesAt = None), markForFinal(opN = 1), deadline.plusSeconds(3600)) shouldBe
        Right(Decision.Accepted(LotEvent.LotMarkedForFinal))
    }

    "refuse a mark after the lot is sold and write nothing (Т-37)" in {
      val (_, sold) = Journal.of(trading(price = 500, leader = Some(participant(2)))).close(closeLot(opN = 1), deadline)

      val (result, after) = sold.mark(markForFinal(opN = 2))

      result shouldBe Left(MarkForFinalRejected.LotNotOpen)
      after shouldBe sold
    }

    "refuse a mark of a lot that is not in trading" in {
      Lot.decide(Lot.initial, markForFinal(opN = 1), calm) shouldBe Left(MarkForFinalRejected.LotNotFound)
      List(drafted, scheduled(), held(price = 100, leader = participant(1))).foreach { lot =>
        Lot.decide(lot, markForFinal(opN = 1), calm) shouldBe Left(MarkForFinalRejected.LotNotOpen)
      }
    }

    "refuse a mark of a lot already in the live final" in {
      Lot.decide(trading(price = 100, phase = Phase.Live, closesAt = None), markForFinal(opN = 1), calm) shouldBe
        Left(MarkForFinalRejected.NotInOnlinePhase)
    }

    "refuse a second mark under another op_id" in {
      Lot.decide(marked.lot, markForFinal(opN = 9), calm) shouldBe Left(MarkForFinalRejected.AlreadyMarkedForFinal)
    }

    "answer a repeated mark with the original response even after the lot is held" in {
      Lot.decide(holding.lot, markForFinal(opN = 1), deadline.plusSeconds(60)) shouldBe
        Right(Decision.Repeated(marked.entries.last))
    }

    "refuse a mark under the op_id of another command instead of answering with its envelope" in {
      val (_, bidden) = Journal.of(trading(price = 100)).submit(placeBid(who = 1, amount = 110, opN = 1), bid(1))

      val (result, after) = bidden.mark(markForFinal(opN = 1))

      result shouldBe Left(MarkForFinalRejected.OpIdTaken)
      after shouldBe bidden
    }
  }

  "holding for the final" should {

    "hold a marked lot at its deadline with the price, leader, limits and extensions it had, without a sale (Т-35)" in {
      val before = tradingOf(marked.lot)

      val (result, journal) = marked.close(closeLot(opN = 2), deadline)

      result shouldBe Right(Decision.Accepted(LotEvent.LotHeldForFinal(deadline)))
      journal.lot.state shouldBe LotState.Held(
        HeldState(
          config = before.config,
          currentPrice = before.currentPrice,
          leader = before.leader,
          leadingBidId = before.leadingBidId,
          proxyLimits = before.proxyLimits,
          extensionsUsed = before.extensionsUsed
        )
      )
    }

    "hold a marked lot without bids rather than close it unsold, since the mark is read before the leader" in {
      val (_, journal) = Journal.of(trading(price = 100)).mark(markForFinal(opN = 1))

      val (result, after) = journal.close(closeLot(opN = 2), deadline)

      result shouldBe Right(Decision.Accepted(LotEvent.LotHeldForFinal(deadline)))
      heldOf(after.lot).leader shouldBe None
      heldOf(after.lot).currentPrice shouldBe money(100)
    }

    "keep the extensions a held lot spent before its deadline" in {
      val (_, journal) = Journal.of(trading(price = 100, extensionsUsed = 2)).mark(markForFinal(opN = 1))

      val (_, after) = journal.close(closeLot(opN = 2), deadline)

      heldOf(after.lot).extensionsUsed shouldBe 2
    }

    "sell a marked lot that the auctioneer closes before its deadline" in {
      marked.close(closeLot(opN = 2, reason = CloseReason.ByAuctioneer), calm)._1 shouldBe
        Right(Decision.Accepted(LotEvent.LotSold(participant(2), money(500), bid(0), calm)))
    }

    "refuse to close a marked lot by a deadline that has not come" in {
      marked.close(closeLot(opN = 2), deadline.minusSeconds(1))._1 shouldBe Left(CloseLotRejected.DeadlineNotReached)
    }

    "reject a bid in the held lot (Т-38)" in {
      val (result, after) = holding.submit(placeBid(who = 3, amount = 600, opN = 3), bid(1))

      result shouldBe Left(PlaceBidRejected.LotOnHold(money(500)))
      after shouldBe holding
    }

    "refuse to close a held lot by a deadline (Т-49)" in {
      val (result, after) = holding.close(closeLot(opN = 3), deadline.plusSeconds(3600))

      result shouldBe Left(CloseLotRejected.DeadlineNotReached)
      after shouldBe holding
    }

    "take a proxy limit in the held lot without a derived bid or a price change" in {
      val (result, after) = holding.limit(setProxyLimit(who = 3, max = 900, opN = 3))

      result shouldBe Right(Decision.Accepted(LotEvent.ProxyLimitSet(participant(3), money(900))))
      heldOf(after.lot).currentPrice shouldBe money(500)
      heldOf(after.lot).leader shouldBe Some(participant(2))
      heldOf(after.lot).proxyLimits(participant(3)) shouldBe limit(max = 900, setSeq = 3)
    }
  }

  "resuming in the live final" should {

    "return a held lot to live trading without a deadline or an ask and with the mark cleared" in {
      val held = heldOf(holding.lot)

      val (result, journal) = holding.resume(resumeLot(opN = 3))

      result shouldBe Right(Decision.Accepted(LotEvent.LotResumed))
      tradingOf(journal.lot) shouldBe TradingState(
        config = held.config,
        currentPrice = held.currentPrice,
        ask = None,
        leader = held.leader,
        leadingBidId = held.leadingBidId,
        phase = Phase.Live,
        deadline = None,
        extensionsUsed = held.extensionsUsed,
        proxyLimits = held.proxyLimits,
        markedForFinal = false
      )
    }

    "take the next live bid after the resume" in {
      val (_, live) = holding.resume(resumeLot(opN = 3))

      live.submit(placeBid(who = 3, amount = 510, opN = 4), bid(1))._1 shouldBe
        Right(Decision.Accepted(manual(bid(1), 3, 510, Some(2))))
    }

    "answer a repeated resume with the original response" in {
      val (_, live) = holding.resume(resumeLot(opN = 3))

      Lot.decide(live.lot, resumeLot(opN = 3)) shouldBe Right(Decision.Repeated(live.entries.last))
    }

    "refuse a resume under the op_id of another command instead of answering with its envelope" in {
      val (result, after) = holding.resume(resumeLot(opN = 1))

      result shouldBe Left(ResumeLotRejected.OpIdTaken)
      after shouldBe holding
    }

    "refuse to resume a lot that is not held" in {
      Lot.decide(Lot.initial, resumeLot(opN = 1)) shouldBe Left(ResumeLotRejected.LotNotFound)
      List(drafted, scheduled(), trading(price = 100), sold(price = 100, winner = participant(1))).foreach { lot =>
        Lot.decide(lot, resumeLot(opN = 1)) shouldBe Left(ResumeLotRejected.LotNotHeld)
      }
    }
  }
}
