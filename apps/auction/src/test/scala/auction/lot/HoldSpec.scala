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

  private val leaderLimit: Map[ParticipantId, ProxyLimit] = Map(participant(1) -> limit(max = 1500, setSeq = 1))

  /** Лот с лидером 2 по 500 и лимитами двух участников, отмеченный для финала. */
  private def marked: Journal = {
    val limits = Map(participant(2) -> limit(max = 800, setSeq = 1), participant(3) -> limit(max = 450, setSeq = 2))
    val (_, journal) =
      Journal.of(trading(price = 500, leader = Some(participant(2)), limits = limits)).mark(markForFinal(opN = 1))
    journal
  }

  /**
   * Удержанный лот по цене 1000 с шагом 100 и лимитами `(участник -> максимум)`, записанными в удержании по порядку:
   * `setSeq` — место в списке. Лидер, если назван, ставку держит без лимита, пока лимит ему не записан.
   */
  private def heldWith(leader: Option[Int], limits: (Int, Int)*): Lot =
    lotIn(
      LotState.Held(
        HeldState(
          config(fixedHundred),
          money(1000),
          leader.map(participant),
          leader.map(_ => bid(0)),
          limits.zipWithIndex.map { case ((who, max), index) =>
            participant(who) -> limit(max.toLong, index + 1L)
          }.toMap,
          extensionsUsed = 0,
          course = None
        )
      )
    )

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

  "unmarking for the final" should {

    "clear the mark before the deadline, so that the closing by the deadline sells the lot again" in {
      val (result, journal) = marked.unmark(unmarkForFinal(opN = 2))

      result shouldBe Right(Decision.Accepted(LotEvent.LotUnmarkedForFinal))
      tradingOf(journal.lot).markedForFinal shouldBe false
      journal.close(closeLot(opN = 3), deadline)._1 shouldBe
        Right(Decision.Accepted(LotEvent.LotSold(participant(2), money(500), bid(0), deadline)))
    }

    "let the organizer mark a lot again under a new op_id after the mark was cleared" in {
      val (_, unmarked) = marked.unmark(unmarkForFinal(opN = 2))

      val (result, again) = unmarked.mark(markForFinal(opN = 3))

      result shouldBe Right(Decision.Accepted(LotEvent.LotMarkedForFinal))
      again.close(closeLot(opN = 4), deadline)._1 shouldBe Right(Decision.Accepted(LotEvent.LotHeldForFinal(deadline)))
    }

    "judge the race of an unmark and the deadline by the same server time as the mark" in {
      forAll(Gen.choose(-86400L, 86400L)) { offset =>
        val result = Lot.decide(marked.lot, unmarkForFinal(opN = 2), deadline.plusSeconds(offset))
        if (offset < 0) result shouldBe Right(Decision.Accepted(LotEvent.LotUnmarkedForFinal))
        else result shouldBe Left(UnmarkForFinalRejected.DeadlinePassed)
      }
    }

    "refuse to take a held lot out of the final: its deadline has passed" in {
      val (result, after) = holding.unmark(unmarkForFinal(opN = 3), deadline.plusSeconds(60))

      result shouldBe Left(UnmarkForFinalRejected.DeadlinePassed)
      after shouldBe holding
    }

    "refuse to unmark a lot that is not marked" in {
      Lot.decide(trading(price = 100), unmarkForFinal(opN = 1), calm) shouldBe
        Left(UnmarkForFinalRejected.NotMarkedForFinal)
    }

    "refuse to unmark a lot that is not trading" in {
      Lot.decide(Lot.initial, unmarkForFinal(opN = 1), calm) shouldBe Left(UnmarkForFinalRejected.LotNotFound)
      List(drafted, scheduled(), sold(price = 100, winner = participant(1))).foreach { lot =>
        Lot.decide(lot, unmarkForFinal(opN = 1), calm) shouldBe Left(UnmarkForFinalRejected.LotNotOpen)
      }
      Lot.decide(trading(price = 100, phase = Phase.Live, closesAt = None), unmarkForFinal(opN = 1), calm) shouldBe
        Left(UnmarkForFinalRejected.NotInOnlinePhase)
    }

    "answer a repeated unmark with the original response and refuse the op_id of another command" in {
      val (_, unmarked) = marked.unmark(unmarkForFinal(opN = 2))

      Lot.decide(unmarked.lot, unmarkForFinal(opN = 2), deadline.plusSeconds(60)) shouldBe
        Right(Decision.Repeated(unmarked.entries.last))
      Lot.decide(unmarked.lot, unmarkForFinal(opN = 1), calm) shouldBe Left(UnmarkForFinalRejected.OpIdTaken)
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
          extensionsUsed = before.extensionsUsed,
          course = before.course
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
        markedForFinal = false,
        course = held.course
      )
    }

    "take the next live bid after the resume and answer it with the leader's limit on the grid" in {
      val (_, live) = holding.resume(resumeLot(opN = 3))

      live.submit(placeBid(who = 3, amount = 510, opN = 4), bid(1))._1 shouldBe
        Right(
          Decision.Accepted(
            manual(bid(1), 3, 510, Some(2)).copy(overtakenByProxy = true),
            List(proxied(proxyBid(4), 2, 520, Some(3)))
          )
        )
    }

    "recount the limits the hold kept in the transaction of the resume, on the grid (Т-39)" in {
      val waiting = Journal.of(held(price = 100, leader = participant(1)))

      val (kept, limited) = waiting.limit(setProxyLimit(who = 2, max = 150, opN = 1))
      kept shouldBe Right(Decision.Accepted(LotEvent.ProxyLimitSet(participant(2), money(150))))

      val (resumed, live) = limited.resume(resumeLot(opN = 2))
      resumed shouldBe Right(Decision.Accepted(LotEvent.LotResumed, List(proxied(proxyBid(2), 2, 110, Some(1)))))
      tradingOf(live.lot).leader shouldBe Some(participant(2))
      tradingOf(live.lot).currentPrice shouldBe money(110)
    }

    "give a leaderless lot to the strongest limit at the second maximum plus a step" in {
      val waiting = Journal.of(heldWith(None, 1 -> 3000, 2 -> 2500))

      val (resumed, live) = waiting.resume(resumeLot(opN = 1))

      resumed shouldBe Right(Decision.Accepted(LotEvent.LotResumed, List(proxied(proxyBid(1), 1, 2600, None))))
      tradingOf(live.lot).leader shouldBe Some(participant(1))
      tradingOf(live.lot).currentPrice shouldBe money(2600)
    }

    "settle a leaderless lot at the tied maximum for the earlier limit when two limits are equal" in {
      val waiting = Journal.of(heldWith(None, 1 -> 3000, 2 -> 3000))

      waiting.resume(resumeLot(opN = 1))._1 shouldBe
        Right(Decision.Accepted(LotEvent.LotResumed, List(proxied(proxyBid(1), 1, 3000, None))))
    }

    "count a third limit of the hold in the price of the winner" in {
      val waiting = Journal.of(heldWith(None, 1 -> 3000, 2 -> 2500, 3 -> 2000))

      waiting.resume(resumeLot(opN = 1))._1 shouldBe
        Right(Decision.Accepted(LotEvent.LotResumed, List(proxied(proxyBid(1), 1, 2600, None))))
    }

    "round the price of the winner down to the grid when the second maximum plus a step lies between its points" in {
      val waiting = Journal.of(heldWith(None, 1 -> 3050, 2 -> 2540))

      waiting.resume(resumeLot(opN = 1))._1 shouldBe
        Right(Decision.Accepted(LotEvent.LotResumed, List(proxied(proxyBid(1), 1, 2600, None))))
    }

    "price a lone rival over the limit of the leader in live trading as before" in {
      val waiting = Journal.of(heldWith(Some(9), 1 -> 3000))

      waiting.resume(resumeLot(opN = 1))._1 shouldBe
        Right(Decision.Accepted(LotEvent.LotResumed, List(proxied(proxyBid(1), 1, 1100, Some(9)))))
    }

    "price a lone rival over the limit of the leader in online trading as before" in {
      val withLimit = Journal.of(trading(1000, fixedHundred, leader = Some(participant(1)), limits = leaderLimit))
      val without = Journal.of(trading(1000, fixedHundred, leader = Some(participant(1))))

      withLimit.limit(setProxyLimit(who = 2, max = 3000, opN = 1))._1 shouldBe
        Right(
          Decision.Accepted(
            LotEvent.ProxyLimitSet(participant(2), money(3000)),
            List(proxied(proxyBid(1), 2, 1600, Some(1)))
          )
        )
      without.limit(setProxyLimit(who = 2, max = 3000, opN = 1))._1 shouldBe
        Right(
          Decision.Accepted(
            LotEvent.ProxyLimitSet(participant(2), money(3000)),
            List(proxied(proxyBid(1), 2, 1100, Some(1)))
          )
        )
    }

    "outbid a leader without a limit over the second maximum of the limits the hold kept" in {
      val waiting = Journal.of(heldWith(Some(9), 1 -> 3000, 2 -> 2500))

      waiting.resume(resumeLot(opN = 1))._1 shouldBe
        Right(Decision.Accepted(LotEvent.LotResumed, List(proxied(proxyBid(1), 1, 2600, Some(9)))))
    }

    "outbid a leader whose limit is lower than both rivals over the second maximum, not over the leader's limit" in {
      val waiting = Journal.of(heldWith(Some(9), 1 -> 3000, 2 -> 2500, 9 -> 1500))

      waiting.resume(resumeLot(opN = 1))._1 shouldBe
        Right(Decision.Accepted(LotEvent.LotResumed, List(proxied(proxyBid(1), 1, 2600, Some(9)))))
    }

    "keep a leader whose limit is higher than both rivals at the second maximum plus a step" in {
      val waiting = Journal.of(heldWith(Some(9), 1 -> 3000, 2 -> 2500, 9 -> 4000))

      val (resumed, live) = waiting.resume(resumeLot(opN = 1))

      resumed shouldBe Right(Decision.Accepted(LotEvent.LotResumed, List(proxied(proxyBid(1), 9, 3100, Some(9)))))
      tradingOf(live.lot).leader shouldBe Some(participant(9))
    }

    "leave above the price only the limit of the leader after the resume, whatever limits the hold kept" in {
      val limits = Gen.mapOf(Gen.zip(Gen.choose(1, 5), Gen.choose(0, 30)))
      val leaders = Gen.option(Gen.choose(1, 9))
      forAll(limits, leaders) { (kept, leader) =>
        val waiting = Journal.of(heldWith(leader, kept.toList.map((who, steps) => who -> (1000 + 100 * steps))*))

        val (_, live) = waiting.resume(resumeLot(opN = 1))

        val after = tradingOf(live.lot)
        after.proxyLimits.foreach { (who, limit) =>
          if (!after.leader.contains(who)) withClue(s"limit of $who")(limit.max <= after.currentPrice shouldBe true)
        }
      }
    }

    "answer a repeated resume with the original response" in {
      val (_, live) = holding.resume(resumeLot(opN = 3))

      Lot.decide(live.lot, resumeLot(opN = 3), proxyBid(9), calm) shouldBe Right(Decision.Repeated(live.entries.last))
    }

    "refuse a resume under the op_id of another command instead of answering with its envelope" in {
      val (result, after) = holding.resume(resumeLot(opN = 1))

      result shouldBe Left(ResumeLotRejected.OpIdTaken)
      after shouldBe holding
    }

    "refuse to resume a lot that is not held" in {
      Lot.decide(Lot.initial, resumeLot(opN = 1), proxyBid(9), calm) shouldBe Left(ResumeLotRejected.LotNotFound)
      List(drafted, scheduled(), trading(price = 100), sold(price = 100, winner = participant(1))).foreach { lot =>
        Lot.decide(lot, resumeLot(opN = 1), proxyBid(9), calm) shouldBe Left(ResumeLotRejected.LotNotHeld)
      }
    }
  }
}
