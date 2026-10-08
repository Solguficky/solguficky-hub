package auction.lot

import auction.lot.LotFixtures.*
import org.scalacheck.Gen
import org.scalacheck.Shrink
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec
import org.scalatestplus.scalacheck.ScalaCheckDrivenPropertyChecks

import scala.util.Random

final class LotSpec extends AnyWordSpec with Matchers with ScalaCheckDrivenPropertyChecks {

  // Умолчание моста — десять проверок, поэтому число задаётся явно.
  implicit override val generatorDrivenConfig: PropertyCheckConfiguration =
    PropertyCheckConfiguration(minSuccessful = 200)

  // Сценарии — последовательности команд, где важен порядок; сжатие по умолчанию переставляло бы их и меняло смысл
  // контрпримера, поэтому оно выключено.
  implicit def noShrink[T]: Shrink[T] = Shrink.shrinkAny

  private def accepted(result: Either[PlaceBidRejected, Decision]): Option[LotEvent.BidPlaced] =
    result match {
      case Right(Decision.Accepted(placed: LotEvent.BidPlaced, _)) => Some(placed)
      case _ => None
    }

  "lot" should {

    "be born a draft that belongs to the auction which drafted it" in {
      val (result, journal) = Journal.of(Lot.initial).draft(draftLot(opN = 1, of = auctionId(7)))

      result shouldBe Right(Decision.Accepted(LotEvent.LotDrafted(auctionId(7))))
      journal.lot.state shouldBe LotState.Draft
      journal.lot.auction shouldBe Some(auctionId(7))
    }

    "refuse a second draft in any state with LotAlreadyExists" in {
      List(drafted, scheduled(), trading(price = 100), held(price = 100, leader = participant(1)))
        .appended(sold(price = 100, winner = participant(1)))
        .foreach(lot => Lot.decide(lot, draftLot(opN = 9)) shouldBe Left(DraftLotRejected.LotAlreadyExists))
    }

    "answer a repeated draft with the original response instead of a refusal" in {
      val (_, journal) = Journal.of(Lot.initial).draft(draftLot(opN = 1))

      Lot.decide(journal.lot, draftLot(opN = 1)) shouldBe Right(Decision.Repeated(journal.entries.head))
    }

    "answer every command but the draft to a lot that was never drafted with LotNotFound" in {
      Lot.decide(Lot.initial, scheduleLot(opN = 1)) shouldBe Left(ScheduleLotRejected.LotNotFound)
      Lot.decide(Lot.initial, openLot(opN = 1)) shouldBe Left(OpenLotRejected.LotNotFound)
      Lot.decide(Lot.initial, placeBid(who = 1, amount = 110, opN = 1), bid(1), proxyBid(1), calm) shouldBe
        Left(PlaceBidRejected.LotNotFound)
    }

    "schedule a draft with the whole schedule of the command" in {
      val (result, journal) = Journal.of(drafted).schedule(scheduleLot(opN = 1, startingPrice = 500))

      result shouldBe Right(Decision.Accepted(LotEvent.LotScheduled(schedule(startingPrice = 500))))
      journal.lot.state shouldBe LotState.Scheduled(schedule(startingPrice = 500))
      journal.lot.auction shouldBe drafted.auction
    }

    "write every change before the opening as a whole schedule and replay to the last one" in {
      val tieredInput = configInput(StepPolicyInput.Tiered(tiers((0, 50), (10000, 100))))
      val (_, afterDraft) = Journal.of(Lot.initial).draft(draftLot(opN = 1))
      val (_, afterFirst) = afterDraft.schedule(scheduleLot(opN = 2, startingPrice = 100))
      val (_, afterSecond) = afterFirst.schedule(scheduleLot(opN = 3, startingPrice = 200, input = tieredInput))

      afterSecond.entries.map(_.event).collect { case scheduled: LotEvent.LotScheduled => scheduled } shouldBe Vector(
        LotEvent.LotScheduled(schedule(startingPrice = 100)),
        LotEvent.LotScheduled(schedule(startingPrice = 200, policy = tiered((0, 50), (10000, 100))))
      )
      val replayed = Lot.replay(Lot.initial, Random.shuffle(afterSecond.entries))
      replayed shouldBe afterSecond.lot
      replayed.state shouldBe LotState.Scheduled(schedule(startingPrice = 200, policy = tiered((0, 50), (10000, 100))))
    }

    "refuse to schedule a lot after its opening and keep its config (Т-20, Т-52)" in {
      val (_, afterDraft) = Journal.of(Lot.initial).draft(draftLot(opN = 1))
      val (_, afterSchedule) = afterDraft.schedule(scheduleLot(opN = 2))
      val (_, opened) = afterSchedule.open(openLot(opN = 3))

      val (result, after) = opened.schedule(scheduleLot(opN = 4, startingPrice = 900))

      result shouldBe Left(ScheduleLotRejected.SchedulingClosed)
      after shouldBe opened
      tradingOf(after.lot).config shouldBe config()
      List(held(price = 100, leader = participant(1)), sold(price = 100, winner = participant(1)))
        .foreach(lot => Lot.decide(lot, scheduleLot(opN = 5)) shouldBe Left(ScheduleLotRejected.SchedulingClosed))
    }

    "refuse a step policy that breaks И-15 with its reason and keep the lot as it was" in {
      val cases = List(
        StepPolicyInput.Tiered(Nil) -> StepPolicyInvalid.Empty,
        StepPolicyInput.Tiered(tiers((10, 10))) -> StepPolicyInvalid.FirstBoundNotZero,
        StepPolicyInput.Tiered(tiers((0, 10), (0, 20))) -> StepPolicyInvalid.BoundsNotAscending,
        StepPolicyInput.Fixed(money(0)) -> StepPolicyInvalid.StepNotPositive,
        StepPolicyInput.Fixed(Money(10, eur)) -> StepPolicyInvalid.MixedCurrency
      )

      forAll(Gen.oneOf(cases), Gen.oneOf(drafted, scheduled())) { (sample, lot) =>
        val (policy, reason) = sample
        val (result, after) = Journal.of(lot).schedule(scheduleLot(opN = 1, input = configInput(policy)))

        result shouldBe Left(ScheduleLotRejected.StepPolicyInvalid(reason))
        after.lot shouldBe lot
      }
    }

    "refuse a starting price in another currency than the config and keep the lot as it was" in {
      val command = ScheduleLot(Money(100, eur), configInput(), op(1))
      val (result, after) = Journal.of(drafted).schedule(command)

      result shouldBe Left(ScheduleLotRejected.CurrencyMismatch)
      after.lot shouldBe drafted
    }

    "answer a repeated schedule with the original response instead of scheduling again" in {
      val (_, journal) = Journal.of(drafted).schedule(scheduleLot(opN = 1))

      Lot.decide(journal.lot, scheduleLot(opN = 1, startingPrice = 900)) shouldBe
        Right(Decision.Repeated(journal.entries.head))
    }

    "refuse a schedule under the op_id of another command instead of answering with its envelope" in {
      val (_, born) = Journal.of(Lot.initial).draft(draftLot(opN = 1))

      val (result, after) = born.schedule(scheduleLot(opN = 1))

      result shouldBe Left(ScheduleLotRejected.OpIdTaken)
      after shouldBe born
    }

    "open trading from the schedule at its starting price with no leader, the online phase and the given deadline" in {
      val (result, journal) = Journal.of(scheduled(startingPrice = 500)).open(openLot(opN = 1))

      result shouldBe Right(Decision.Accepted(LotEvent.LotOpened(money(500), config(), Some(deadline))))
      tradingOf(journal.lot) shouldBe TradingState(
        config = config(),
        currentPrice = money(500),
        ask = None,
        leader = None,
        leadingBidId = None,
        phase = Phase.Online,
        deadline = Some(deadline),
        extensionsUsed = 0,
        proxyLimits = Map.empty,
        markedForFinal = false
      )
    }

    "open a lot led by a person without a deadline" in {
      Lot.decide(scheduled(), openLot(opN = 1, deadline = None)) shouldBe
        Right(Decision.Accepted(LotEvent.LotOpened(money(100), config(), None)))
    }

    "refuse to open a lot without a schedule or one that is already open" in {
      List(drafted, trading(price = 100), sold(price = 100, winner = participant(1)))
        .foreach(lot => Lot.decide(lot, openLot(opN = 1)) shouldBe Left(OpenLotRejected.LotNotScheduled))
    }

    "answer a repeated opening with the original response instead of a refusal" in {
      val (_, journal) = Journal.of(scheduled()).open(openLot(opN = 1))

      Lot.decide(journal.lot, openLot(opN = 1)) shouldBe Right(Decision.Repeated(journal.entries.head))
    }

    "refuse a bid on a lot that is not open yet" in {
      List(drafted, scheduled()).foreach { lot =>
        Lot.decide(lot, placeBid(who = 1, amount = 110, opN = 1), bid(1), proxyBid(1), calm) shouldBe Left(
          PlaceBidRejected.LotNotOpen
        )
      }
    }

    "give the row of a draft the drafting auction and every later row the auction of the lot" in {
      Lot.auctionOf(Lot.initial, LotEvent.LotDrafted(auctionId(7))) shouldBe Some(auctionId(7))
      Lot.auctionOf(scheduled(), LotEvent.LotOpened(money(100), config(), None)) shouldBe Some(auctionId(1))
      Lot.auctionOf(Lot.initial, LotEvent.LotOpened(money(100), config(), None)) shouldBe None
    }

    "bring no lot to life from a journal that starts with an opening" in {
      val opened = Envelope(1, op(1), LotEvent.LotOpened(money(100), config(), Some(deadline)))

      val replayed = Lot.replay(Lot.initial, List(opened))

      (replayed.state, replayed.auction) shouldBe (LotState.Initial, None)
    }

    "accept a first bid at the starting price plus the step (Т-01)" in {
      val (result, journal) = Journal.of(trading(price = 100)).submit(placeBid(who = 1, amount = 110, opN = 1), bid(1))

      result shouldBe Right(
        Decision.Accepted(
          LotEvent.BidPlaced(bid(1), participant(1), money(110), None, BidOrigin.Manual(BidSource.Bot))
        )
      )
      tradingOf(journal.lot).currentPrice shouldBe money(110)
      tradingOf(journal.lot).leader shouldBe Some(participant(1))
      tradingOf(journal.lot).leadingBidId shouldBe Some(bid(1))
    }

    "reject a bid below the next price and leave the lot unchanged (Т-02)" in {
      val before = Journal.of(trading(price = 100))

      val (result, after) = before.submit(placeBid(who = 1, amount = 105, opN = 1), bid(1))

      result shouldBe Left(PlaceBidRejected.BidBelowMinimum(money(110)))
      after shouldBe before
    }

    "reject a leader bidding over their own bid (Т-03)" in {
      val lot = trading(price = 110, leader = Some(participant(1)))

      Lot.decide(lot, placeBid(who = 1, amount = 150, opN = 1), bid(1), proxyBid(1), calm) shouldBe
        Left(PlaceBidRejected.BidderIsLeader(money(110)))
    }

    "reject a bid in another currency (Т-04)" in {
      Lot.decide(
        trading(price = 100),
        placeBid(who = 1, amount = 110, opN = 1, currency = eur),
        bid(1),
        proxyBid(1),
        calm
      ) shouldBe
        Left(PlaceBidRejected.CurrencyMismatch)
    }

    "name the previous leader in the event that takes the lead from them" in {
      val (_, journal) = Journal.of(trading(price = 100)).submitAll(Seq(placeBid(1, 110, 1), placeBid(2, 120, 2)))

      journal.entries.map(_.event).collect { case placed: LotEvent.BidPlaced => placed.previousLeader } shouldBe
        Vector(None, Some(participant(1)))
    }

    "take the step from the tier the current price has reached (Т-08)" in {
      val (_, journal) = Journal
        .of(trading(price = 190, policy = tiered(0L -> 10L, 200L -> 20L)))
        .submit(placeBid(who = 1, amount = 200, opN = 1), bid(1))

      Lot.minRequired(tradingOf(journal.lot), calm) shouldBe money(220)
    }

    "answer a bid above the last tier bound with the step of that tier (Т-32)" in {
      val lot = trading(price = 300, policy = tiered(0L -> 10L, 200L -> 20L))

      Lot.decide(lot, placeBid(who = 1, amount = 310, opN = 1), bid(1), proxyBid(1), calm) shouldBe
        Left(PlaceBidRejected.BidBelowMinimum(money(320)))
      accepted(Lot.decide(lot, placeBid(who = 1, amount = 320, opN = 1), bid(1), proxyBid(1), calm))
        .map(_.amount) shouldBe
        Some(money(320))
    }

    "accept a floor bid equal to the announced ask (Т-30)" in {
      val lot = trading(price = 200, ask = Some(500))

      accepted(Lot.decide(lot, placeBid(who = 1, amount = 500, opN = 1), bid(1), proxyBid(1), calm))
        .map(_.amount) shouldBe
        Some(money(500))
      Lot.decide(lot, placeBid(who = 1, amount = 490, opN = 1), bid(1), proxyBid(1), calm) shouldBe
        Left(PlaceBidRejected.BidBelowMinimum(money(500)))
    }

    "accept any amount above the next price while online (Т-43)" in {
      accepted(Lot.decide(trading(price = 100), placeBid(who = 1, amount = 137, opN = 1), bid(1), proxyBid(1), calm))
        .map(_.amount) shouldBe
        Some(money(137))
    }

    "reject a live bid above the next price and name that price (Т-40)" in {
      val lot = trading(price = 1000, policy = fixedHundred, phase = Phase.Live)

      Lot.decide(lot, placeBid(who = 1, amount = 1150, opN = 1), bid(1), proxyBid(1), calm) shouldBe
        Left(PlaceBidRejected.BidNotAtNextPrice(money(1100)))
    }

    "reject a live bid below the next price with the same refusal" in {
      val lot = trading(price = 1000, policy = fixedHundred, phase = Phase.Live)

      Lot.decide(lot, placeBid(who = 1, amount = 1050, opN = 1), bid(1), proxyBid(1), calm) shouldBe
        Left(PlaceBidRejected.BidNotAtNextPrice(money(1100)))
    }

    "turn the second of two equal live bids into a refusal with the new price (Т-41)" in {
      val lot = trading(price = 1000, policy = fixedHundred, phase = Phase.Live)

      val (results, _) = Journal.of(lot).submitAll(Seq(placeBid(1, 1100, 1), placeBid(2, 1100, 2)))

      accepted(results(0)).map(_.participant) shouldBe Some(participant(1))
      results(1) shouldBe Left(PlaceBidRejected.BidNotAtNextPrice(money(1200)))
    }

    "reject a bid after the lot is sold and write nothing (Т-17)" in {
      val before = Journal.of(sold(price = 300, winner = participant(1)))

      val (result, after) = before.submit(placeBid(who = 2, amount = 400, opN = 1), bid(1))

      result shouldBe Left(PlaceBidRejected.LotNotOpen)
      after shouldBe before
    }

    "reject a bid while the lot is held for the final" in {
      Lot.decide(
        held(price = 300, leader = participant(1)),
        placeBid(who = 2, amount = 310, opN = 1),
        bid(1),
        proxyBid(1),
        calm
      ) shouldBe
        Left(PlaceBidRejected.LotOnHold(money(300)))
    }

    "check the currency before the leadership" in {
      val lot = trading(price = 110, leader = Some(participant(1)))

      Lot.decide(lot, placeBid(who = 1, amount = 120, opN = 1, currency = eur), bid(1), proxyBid(1), calm) shouldBe
        Left(PlaceBidRejected.CurrencyMismatch)
    }

    "refuse a live bid from the leader as a leader, not as an off-grid price" in {
      val lot = trading(price = 1000, phase = Phase.Live, leader = Some(participant(1)))

      Lot.decide(lot, placeBid(who = 1, amount = 1500, opN = 1), bid(1), proxyBid(1), calm) shouldBe
        Left(PlaceBidRejected.BidderIsLeader(money(1000)))
    }

    "answer a repeated command with the original response and write one event (Т-14)" in {
      val command = placeBid(who = 1, amount = 110, opN = 1)
      val (_, once) = Journal.of(trading(price = 100)).submit(command, bid(1))

      val (repeat, twice) = once.submit(command, bid(2))

      repeat shouldBe Right(Decision.Repeated(once.entries.head))
      twice shouldBe once
    }

    "answer a repeated accepted bid with the original response even after the lot is held" in {
      val command = placeBid(who = 1, amount = 110, opN = 1)
      val (_, journal) = Journal.of(trading(price = 100)).submit(command, bid(1))
      val heldLot = journal.lot.copy(state = held(price = 110, leader = participant(1)).state)

      Lot.decide(heldLot, command, bid(2), proxyBid(2), calm) shouldBe Right(Decision.Repeated(journal.entries.head))
    }

    "evaluate a repeat of a refused command afresh (Т-31)" in {
      val refused = placeBid(who = 1, amount = 130, opN = 2)
      val (results, _) = Journal
        .of(trading(price = 100))
        .submitAll(Seq(placeBid(1, 110, 1), refused, placeBid(2, 120, 3), refused))

      results(1) shouldBe Left(PlaceBidRejected.BidderIsLeader(money(110)))
      accepted(results(3)).map(bid => (bid.participant, bid.amount)) shouldBe Some((participant(1), money(130)))
    }

    "recover the deduplication window from the journal alone" in {
      val command = placeBid(who = 1, amount = 110, opN = 1)
      val start = trading(price = 100)
      val (_, journal) = Journal.of(start).submit(command, bid(1))

      val recovered = Lot.replay(start, journal.entries)

      recovered shouldBe journal.lot
      Lot.decide(recovered, command, bid(2), proxyBid(2), calm) shouldBe Right(Decision.Repeated(journal.entries.head))
    }

    "refuse another participant's bid under a taken op_id with OpIdTaken, write nothing and leak no bid_id" in {
      val (_, journal) = Journal.of(trading(price = 100)).submit(placeBid(who = 1, amount = 110, opN = 1), bid(1))

      val (foreign, after) = journal.submit(placeBid(who = 2, amount = 120, opN = 1), bid(2))

      foreign shouldBe Left(PlaceBidRejected.OpIdTaken)
      after shouldBe journal
    }

    "tell the owner's repeat from another participant's after the window is replayed from the journal" in {
      val start = trading(price = 100)
      val command = placeBid(who = 1, amount = 110, opN = 1)
      val (_, journal) = Journal.of(start).submit(command, bid(1))

      val recovered = Lot.replay(start, journal.entries)

      Lot.decide(recovered, command, bid(2), proxyBid(2), calm) shouldBe Right(Decision.Repeated(journal.entries.head))
      Lot.decide(recovered, placeBid(who = 2, amount = 120, opN = 1), bid(2), proxyBid(2), calm) shouldBe
        Left(PlaceBidRejected.OpIdTaken)
    }

    "leave exactly one leader after a volley of equal bids in any order (Т-15)" in {
      val volleys = for {
        size <- Gen.chooseNum(2, 10)
        seed <- Gen.long
        phase <- Gen.oneOf(Phase.Online, Phase.Live)
      } yield (new Random(seed).shuffle((1 to size).toList), phase)

      forAll(volleys) { (volley: (List[Int], Phase)) =>
        val (order, phase) = volley
        val start = trading(price = 100, phase = phase)
        val price = Lot.minRequired(tradingOf(start), calm).minorUnits
        val commands = order.map(who => placeBid(who, price, opN = who))

        val (results, journal) = Journal.of(start).submitAll(commands)

        results.flatMap(accepted).map(_.participant) shouldBe Vector(participant(order.head))
        journal.entries.map(_.sequence) shouldBe Vector(1L)
        tradingOf(journal.lot).leader shouldBe Some(participant(order.head))
        val refusal = phase match {
          case Phase.Online => PlaceBidRejected.BidBelowMinimum(money(price + 10))
          case Phase.Live => PlaceBidRejected.BidNotAtNextPrice(money(price + 10))
        }
        results.drop(1).toSet shouldBe Set(Left(refusal))
      }
    }
    "refuse to close a lot by its deadline before the deadline came (Т-11)" in {
      Lot.decide(trading(price = 100), closeLot(opN = 9), deadline.minusSeconds(1)) shouldBe
        Left(CloseLotRejected.DeadlineNotReached)
    }

    "refuse to close by deadline a lot that a person closes" in {
      val ledByPerson = lotIn(LotState.Trading(tradingOf(trading(price = 100)).copy(deadline = None)))

      Lot.decide(ledByPerson, closeLot(opN = 9), deadline.plusSeconds(3600)) shouldBe
        Left(CloseLotRejected.DeadlineNotReached)
    }

    "sell the lot to the leader at the current price once the deadline came (Т-12)" in {
      val leading = trading(price = 500, leader = Some(participant(2)))
      val (result, journal) = Journal.of(leading).close(closeLot(opN = 9), deadline)

      result shouldBe Right(Decision.Accepted(LotEvent.LotSold(participant(2), money(500), bid(0), deadline)))
      journal.lot.state shouldBe LotState.Sold(Sale(participant(2), money(500), bid(0), deadline))
    }

    "close the lot without a sale once the deadline came and nobody bid (Т-13)" in {
      val (result, journal) = Journal.of(trading(price = 100)).close(closeLot(opN = 9), deadline.plusSeconds(60))

      result shouldBe Right(Decision.Accepted(LotEvent.LotUnsold(UnsoldReason.NoBids)))
      journal.lot.state shouldBe LotState.Unsold(UnsoldReason.NoBids)
    }

    "decide whether the deadline came by the server time alone, whatever the closing time" in {
      forAll(Gen.choose(-86400L, 86400L)) { offset =>
        val now = deadline.plusSeconds(offset)
        val result = Lot.decide(trading(price = 100), closeLot(opN = 9), now)
        if (offset < 0) result shouldBe Left(CloseLotRejected.DeadlineNotReached)
        else result shouldBe Right(Decision.Accepted(LotEvent.LotUnsold(UnsoldReason.NoBids)))
      }
    }

    "keep a closed lot terminal and refuse every trading command after it (Т-17)" in {
      val leading = trading(price = 500, leader = Some(participant(2)))
      for (
        closed <- List(Journal.of(leading), Journal.of(trading(price = 100)))
          .map(_.close(closeLot(opN = 9), deadline)._2.lot)
      ) {
        Lot.decide(closed, placeBid(who = 3, amount = 600, opN = 10), bid(10), proxyBid(10), calm) shouldBe
          Left(PlaceBidRejected.LotNotOpen)
        Lot.decide(closed, setProxyLimit(who = 3, max = 900, opN = 10), 9, proxyBid(10), calm) shouldBe
          Left(SetProxyLimitRejected.LotNotOpen)
        Lot.decide(closed, openLot(opN = 10)) shouldBe Left(OpenLotRejected.LotNotScheduled)
        Lot.decide(closed, closeLot(opN = 10), deadline) shouldBe Left(CloseLotRejected.LotNotOpen)
      }
    }

    "answer a repeated closing with the original response after the lot closed" in {
      val (_, journal) = Journal.of(trading(price = 100)).close(closeLot(opN = 9), deadline)

      Lot.decide(journal.lot, closeLot(opN = 9), deadline.plusSeconds(60)) shouldBe
        Right(Decision.Repeated(journal.entries.last))
    }

    "close a held lot only by the auctioneer, at the price it survived the deadline with" in {
      val holding = held(price = 700, leader = participant(3))

      Lot.decide(holding, closeLot(opN = 9), deadline.plusSeconds(60)) shouldBe
        Left(CloseLotRejected.DeadlineNotReached)
      Lot.decide(holding, closeLot(opN = 9, reason = CloseReason.ByAuctioneer), deadline) shouldBe
        Right(Decision.Accepted(LotEvent.LotSold(participant(3), money(700), bid(0), deadline)))
    }

    "refuse to close a lot that never opened" in {
      Lot.decide(Lot.initial, closeLot(opN = 9), deadline) shouldBe Left(CloseLotRejected.LotNotFound)
      List(drafted, scheduled()).foreach { lot =>
        Lot.decide(lot, closeLot(opN = 9, reason = CloseReason.ByAuctioneer), deadline) shouldBe
          Left(CloseLotRejected.LotNotOpen)
      }
    }
  }
}
