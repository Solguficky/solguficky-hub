package auction.lot

import auction.lot.LotFixtures.*
import org.scalacheck.Gen
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec
import org.scalatestplus.scalacheck.ScalaCheckDrivenPropertyChecks

/**
 * Окно сниженного шага (RFC-011, П-03, дополнение 2026-10-08; кейсы Т-56…Т-72). Окно — данные состояния, а не событие:
 * шаг вычисляется от цены и момента команды, поэтому границы проверяются подставленным `now`, а не часами.
 */
final class StepWindowSpec extends AnyWordSpec with Matchers with ScalaCheckDrivenPropertyChecks {

  /** Окно `[12:00, 14:00)` с шагом 1 при обычном `Fixed 10` и цене 100 — образец Т-56…Т-59. */
  private val happyHours = stepWindow("12:00", "14:00", step = 1)

  private def windowed(price: Long = 100, policy: StepPolicy = fixedTen): Lot =
    trading(price = price, policy = policy, stepWindows = List(happyHours))

  private def bidAt(lot: Lot, amount: Long, time: String): Either[PlaceBidRejected, Decision] =
    Journal.of(lot).submit(placeBid(who = 1, amount = amount, opN = 99), bid(1), now = at(time))._1

  private def placedAmount(result: Either[PlaceBidRejected, Decision]): Option[Money] =
    result match {
      case Right(Decision.Accepted(placed: LotEvent.BidPlaced, _)) => Some(placed.amount)
      case _ => None
    }

  "step window" should {

    "accept a bid at the step of the window at its first instant, which belongs to it (Т-56)" in {
      placedAmount(bidAt(windowed(), 101, "12:00")) shouldBe Some(money(101))
    }

    "refuse the same bid a second before the window with the regular minimum (Т-57)" in {
      bidAt(windowed(), 101, "11:59:59") shouldBe Left(PlaceBidRejected.BidBelowMinimum(money(110)))
    }

    "accept a bid at the step of the window a second before its end (Т-58)" in {
      placedAmount(bidAt(windowed(), 101, "13:59:59")) shouldBe Some(money(101))
    }

    "refuse the same bid at the end of the window, which does not belong to it (Т-59)" in {
      bidAt(windowed(), 101, "14:00") shouldBe Left(PlaceBidRejected.BidBelowMinimum(money(110)))
    }

    "leave a lot outside every window at the regular step inside the interval (Т-60)" in {
      bidAt(trading(price = 100), 101, "13:00") shouldBe Left(PlaceBidRejected.BidBelowMinimum(money(110)))
    }

    "never raise the step above the regular one of the tier the price has reached (Т-61)" in {
      val policy = tiered(0L -> 1L, 200L -> 20L)
      val window = stepWindow("12:00", "14:00", step = 5)

      Lot.minRequired(
        tradingOf(trading(price = 100, policy = policy, stepWindows = List(window))),
        at("13:00")
      ) shouldBe
        money(101)
      Lot.minRequired(
        tradingOf(trading(price = 300, policy = policy, stepWindows = List(window))),
        at("13:00")
      ) shouldBe
        money(305)
    }

    "keep the step at or below the regular step at any price and moment, and equal to it outside the window" in {
      val policy = tiered(0L -> 10L, 500L -> 50L)
      forAll(Gen.choose(0L, 2000L), Gen.choose(0L, 100L), Gen.choose(10, 15)) { (price, step, hour) =>
        val state =
          tradingOf(trading(price = price, policy = policy, stepWindows = List(stepWindow("12:00", "14:00", step))))
        val moment = at(f"$hour%02d:00")
        val base = Lot.baseStep(state, money(price))
        val taken = Lot.step(state, money(price), moment)

        taken.minorUnits should be <= base.minorUnits
        if (hour < 12 || hour >= 14) taken shouldBe base
      }
    }

    "run the proxy series of a limit set inside the window at the step of the window (Т-62)" in {
      val lot = trading(
        price = 110,
        leader = Some(participant(1)),
        limits = Map(participant(1) -> limit(200, setSeq = 3)),
        stepWindows = List(happyHours)
      )
      val (result, journal) = Journal.of(lot).limit(setProxyLimit(who = 2, max = 150, opN = 1), now = at("13:00"))

      result shouldBe Right(
        Decision.Accepted(
          LotEvent.ProxyLimitSet(participant(2), money(150)),
          List(proxied(proxyBid(1), who = 1, amount = 151, previous = Some(1)))
        )
      )
      tradingOf(journal.lot).leader shouldBe Some(participant(1))
    }

    "run the same proxy series at the regular step once the window has ended (Т-63)" in {
      val lot = trading(
        price = 110,
        leader = Some(participant(1)),
        limits = Map(participant(1) -> limit(200, setSeq = 3)),
        stepWindows = List(happyHours)
      )
      val (_, journal) = Journal.of(lot).limit(setProxyLimit(who = 2, max = 150, opN = 1), now = at("14:00"))

      tradingOf(journal.lot).currentPrice shouldBe money(160)
      tradingOf(journal.lot).leader shouldBe Some(participant(1))
    }

    "answer a limit delivered again after the window with the original answer and no new events (Т-64)" in {
      val lot = trading(
        price = 110,
        leader = Some(participant(1)),
        limits = Map(participant(1) -> limit(200, setSeq = 3)),
        stepWindows = List(happyHours)
      )
      val command = setProxyLimit(who = 2, max = 150, opN = 1)
      val (_, first) = Journal.of(lot).limit(command, now = at("13:59:59"))
      val (again, second) = first.limit(command, now = at("14:00:05"))

      again shouldBe Right(Decision.Repeated(first.entries.head))
      second shouldBe first
    }

    "restore the window from LotOpened on replay, so a restart inside it keeps its step (Т-65)" in {
      val (_, opened) = Journal
        .of(scheduled())
        .open(OpenLot(Some(deadline), op(1), List(happyHours)))
      val restored = Lot.replay(scheduled(), opened.entries)

      tradingOf(restored).stepWindows shouldBe List(happyHours)
      placedAmount(bidAt(restored, 101, "13:00")) shouldBe Some(money(101))
    }

    "let an extension past the common deadline run at the regular step (Т-66)" in {
      val lot = trading(price = 100, stepWindows = List(stepWindow("16:00", "18:00", step = 1)))
      val (first, extended) =
        Journal.of(lot).submit(placeBid(who = 1, amount = 101, opN = 1), bid(1), now = at("17:59"))
      val (second, _) = extended.submit(placeBid(who = 2, amount = 102, opN = 2), bid(2), now = at("18:01"))

      first.map {
        case Decision.Accepted(_, derived) => derived
        case repeated => fail(s"not accepted: $repeated")
      } shouldBe Right(List(LotEvent.DeadlineExtended(at("18:02"), 1)))
      second shouldBe Left(PlaceBidRejected.BidBelowMinimum(money(111)))
    }

    "not apply a window in the live final even when the clock is inside it (Т-67)" in {
      val lot = trading(
        price = 1000,
        policy = fixedHundred,
        phase = Phase.Live,
        closesAt = None,
        stepWindows = List(happyHours)
      )

      bidAt(lot, 1001, "13:00") shouldBe Left(PlaceBidRejected.BidNotAtNextPrice(money(1100)))
      Lot.activeWindow(tradingOf(lot), at("13:00")) shouldBe None
      Lot.nextWindow(tradingOf(lot), at("11:00")) shouldBe None
    }

    "drop a window in another currency than the lot when it opens (Т-72)" in {
      val foreign = stepWindow("12:00", "14:00", step = 1, currency = eur)
      val (result, journal) = Journal.of(scheduled()).open(OpenLot(Some(deadline), op(1), List(foreign)))

      result shouldBe Right(Decision.Accepted(LotEvent.LotOpened(money(100), config(), Some(deadline), Nil)))
      bidAt(journal.lot, 101, "13:00") shouldBe Left(PlaceBidRejected.BidBelowMinimum(money(110)))
    }

    "record the windows of the lot in LotOpened in the order they start" in {
      val later = stepWindow("15:00", "16:00", step = 2)
      val (result, journal) = Journal.of(scheduled()).open(OpenLot(Some(deadline), op(1), List(later, happyHours)))

      result shouldBe Right(
        Decision.Accepted(LotEvent.LotOpened(money(100), config(), Some(deadline), List(happyHours, later)))
      )
      tradingOf(journal.lot).stepWindows shouldBe List(happyHours, later)
    }

    "name the window in force and the nearest one that has not started" in {
      val later = stepWindow("15:00", "16:00", step = 2)
      val state = tradingOf(trading(price = 100, stepWindows = List(happyHours, later)))

      Lot.activeWindow(state, at("13:00")) shouldBe Some(happyHours)
      Lot.nextWindow(state, at("13:00")) shouldBe Some(later)
      Lot.activeWindow(state, at("14:30")) shouldBe None
      Lot.nextWindow(state, at("11:00")) shouldBe Some(happyHours)
      Lot.nextWindow(state, at("16:00")) shouldBe None
    }

    "carry no window through the hold, so the lot resumed for the final has none" in {
      val lot = trading(price = 100, markedForFinal = true, stepWindows = List(happyHours))
      val (_, held) = Journal.of(lot).close(closeLot(1), now = deadline)
      val (_, resumed) = held.resume(resumeLot(2))

      tradingOf(resumed.lot).phase shouldBe Phase.Live
      tradingOf(resumed.lot).stepWindows shouldBe Nil
    }
  }
}
