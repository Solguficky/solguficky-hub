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
      case Right(Decision.Accepted(placed: LotEvent.BidPlaced)) => Some(placed)
      case _ => None
    }

  "lot" should {

    "open trading at the starting price with no leader, the online phase and the deadline of the command" in {
      val command = openLot(opN = 1, startingPrice = 500)

      val decision = Lot.decide(Lot.notOpened, command)
      val opened = decision match {
        case Right(Decision.Accepted(event)) => Lot.apply(Lot.notOpened, Envelope(1, command.opId, event))
        case other => fail(s"открытие не принято: $other")
      }

      tradingOf(opened) shouldBe TradingState(
        config = config(),
        currentPrice = money(500),
        ask = None,
        leader = None,
        leadingBidId = None,
        phase = Phase.Online,
        deadline = Some(deadline)
      )
    }

    "open a lot led by a person without a deadline" in {
      val command = openLot(opN = 1, deadline = None)

      Lot.decide(Lot.notOpened, command) shouldBe
        Right(Decision.Accepted(LotEvent.LotOpened(money(100), config(), None)))
    }

    "refuse to open a lot that is already open and leave it as it was" in {
      Lot.decide(trading(price = 100), openLot(opN = 1)) shouldBe Left(OpenLotRejected.LotNotScheduled)
      Lot.decide(sold(price = 100, winner = participant(1)), openLot(opN = 1)) shouldBe
        Left(OpenLotRejected.LotNotScheduled)
    }

    "refuse to open at a starting price in another currency" in {
      val command = openLot(opN = 1).copy(startingPrice = Money(100, eur))

      Lot.decide(Lot.notOpened, command) shouldBe Left(OpenLotRejected.CurrencyMismatch)
    }

    "answer a repeated opening with the original response instead of a refusal" in {
      val command = openLot(opN = 1)
      val envelope = Lot.decide(Lot.notOpened, command) match {
        case Right(Decision.Accepted(event)) => Envelope(1, command.opId, event)
        case other => fail(s"открытие не принято: $other")
      }
      val opened = Lot.apply(Lot.notOpened, envelope)

      Lot.decide(opened, command) shouldBe Right(Decision.Repeated(envelope))
    }

    "refuse a bid on a lot that is not open yet" in {
      Lot.decide(Lot.notOpened, placeBid(who = 1, amount = 110, opN = 1), bid(1)) shouldBe
        Left(PlaceBidRejected.LotNotOpen)
    }

    "accept a first bid at the starting price plus the step (Т-01)" in {
      val (result, journal) = Journal.of(trading(price = 100)).submit(placeBid(who = 1, amount = 110, opN = 1), bid(1))

      result shouldBe Right(
        Decision.Accepted(
          LotEvent.BidPlaced(bid(1), participant(1), money(110), None, BidOrigin.Manual, BidSource.Bot)
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

      Lot.decide(lot, placeBid(who = 1, amount = 150, opN = 1), bid(1)) shouldBe
        Left(PlaceBidRejected.BidderIsLeader)
    }

    "reject a bid in another currency (Т-04)" in {
      Lot.decide(trading(price = 100), placeBid(who = 1, amount = 110, opN = 1, currency = eur), bid(1)) shouldBe
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

      Lot.minRequired(tradingOf(journal.lot)) shouldBe money(220)
    }

    "answer a bid above the last tier bound with the step of that tier (Т-32)" in {
      val lot = trading(price = 300, policy = tiered(0L -> 10L, 200L -> 20L))

      Lot.decide(lot, placeBid(who = 1, amount = 310, opN = 1), bid(1)) shouldBe
        Left(PlaceBidRejected.BidBelowMinimum(money(320)))
      accepted(Lot.decide(lot, placeBid(who = 1, amount = 320, opN = 1), bid(1))).map(_.amount) shouldBe
        Some(money(320))
    }

    "accept a floor bid equal to the announced ask (Т-30)" in {
      val lot = trading(price = 200, ask = Some(500))

      accepted(Lot.decide(lot, placeBid(who = 1, amount = 500, opN = 1), bid(1))).map(_.amount) shouldBe
        Some(money(500))
      Lot.decide(lot, placeBid(who = 1, amount = 490, opN = 1), bid(1)) shouldBe
        Left(PlaceBidRejected.BidBelowMinimum(money(500)))
    }

    "accept any amount above the next price while online (Т-43)" in {
      accepted(Lot.decide(trading(price = 100), placeBid(who = 1, amount = 137, opN = 1), bid(1)))
        .map(_.amount) shouldBe
        Some(money(137))
    }

    "reject a live bid above the next price and name that price (Т-40)" in {
      val lot = trading(price = 1000, policy = fixedHundred, phase = Phase.Live)

      Lot.decide(lot, placeBid(who = 1, amount = 1150, opN = 1), bid(1)) shouldBe
        Left(PlaceBidRejected.BidNotAtNextPrice(money(1100)))
    }

    "reject a live bid below the next price with the same refusal" in {
      val lot = trading(price = 1000, policy = fixedHundred, phase = Phase.Live)

      Lot.decide(lot, placeBid(who = 1, amount = 1050, opN = 1), bid(1)) shouldBe
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
      Lot.decide(held(price = 300, leader = participant(1)), placeBid(who = 2, amount = 310, opN = 1), bid(1)) shouldBe
        Left(PlaceBidRejected.LotOnHold)
    }

    "check the currency before the leadership" in {
      val lot = trading(price = 110, leader = Some(participant(1)))

      Lot.decide(lot, placeBid(who = 1, amount = 120, opN = 1, currency = eur), bid(1)) shouldBe
        Left(PlaceBidRejected.CurrencyMismatch)
    }

    "refuse a live bid from the leader as a leader, not as an off-grid price" in {
      val lot = trading(price = 1000, phase = Phase.Live, leader = Some(participant(1)))

      Lot.decide(lot, placeBid(who = 1, amount = 1500, opN = 1), bid(1)) shouldBe
        Left(PlaceBidRejected.BidderIsLeader)
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

      Lot.decide(heldLot, command, bid(2)) shouldBe Right(Decision.Repeated(journal.entries.head))
    }

    "evaluate a repeat of a refused command afresh (Т-31)" in {
      val refused = placeBid(who = 1, amount = 130, opN = 2)
      val (results, _) = Journal
        .of(trading(price = 100))
        .submitAll(Seq(placeBid(1, 110, 1), refused, placeBid(2, 120, 3), refused))

      results(1) shouldBe Left(PlaceBidRejected.BidderIsLeader)
      accepted(results(3)).map(bid => (bid.participant, bid.amount)) shouldBe Some((participant(1), money(130)))
    }

    "recover the deduplication window from the journal alone" in {
      val command = placeBid(who = 1, amount = 110, opN = 1)
      val start = trading(price = 100)
      val (_, journal) = Journal.of(start).submit(command, bid(1))

      val recovered = Lot.replay(start, journal.entries)

      recovered shouldBe journal.lot
      Lot.decide(recovered, command, bid(2)) shouldBe Right(Decision.Repeated(journal.entries.head))
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
        val price = Lot.minRequired(tradingOf(start)).minorUnits
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
  }
}
