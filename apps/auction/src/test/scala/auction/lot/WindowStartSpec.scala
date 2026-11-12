package auction.lot

import auction.lot.LotFixtures.*
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

/**
 * Стартовая цена окна «Счастливых часов» (ADR-047, дополнение 2026-10-27): у лота без ставок в момент ставки внутри
 * окна фазы `Online` минимум — стартовая окна, иначе обычная. Как и шаг окна, она вычисляется от момента команды,
 * поэтому границы проверяются подставленным `now`.
 */
final class WindowStartSpec extends AnyWordSpec with Matchers {

  /** Окно `[12:00, 14:00)` со стартовой ценой 60 и без шага при обычной стартовой 100 и `Fixed 10`. */
  private val happyHours = StepWindow(at("12:00"), at("14:00"), step = None, start = Some(money(60)))

  private def opening(windows: List[StepWindow] = List(happyHours), phase: Phase = Phase.Online): Lot =
    trading(price = 100, phase = phase, stepWindows = windows)

  private def bidAt(journal: Journal, who: Int, amount: Long, time: String) =
    journal.submit(placeBid(who = who, amount = amount, opN = 90 + who), bid(who), now = at(time))

  private def placedAmount(result: Either[PlaceBidRejected, Decision]): Option[Money] =
    result match {
      case Right(Decision.Accepted(placed: LotEvent.BidPlaced, _)) => Some(placed.amount)
      case _ => None
    }

  "starting price of a window" should {

    "accept the first bid at the starting price of the window inside it" in {
      placedAmount(bidAt(Journal.of(opening()), 1, 60, "12:00")._1) shouldBe Some(money(60))
      placedAmount(bidAt(Journal.of(opening()), 1, 60, "13:59:59")._1) shouldBe Some(money(60))
    }

    "refuse the same first bid outside the window with the regular minimum" in {
      bidAt(Journal.of(opening()), 1, 60, "11:59:59")._1 shouldBe Left(PlaceBidRejected.BidBelowMinimum(money(100)))
      bidAt(Journal.of(opening()), 1, 60, "14:00")._1 shouldBe Left(PlaceBidRejected.BidBelowMinimum(money(100)))
    }

    "refuse a first bid below the starting price of the window with that price" in {
      bidAt(Journal.of(opening()), 1, 59, "13:00")._1 shouldBe Left(PlaceBidRejected.BidBelowMinimum(money(60)))
    }

    "affect nothing once the lot has its first bid" in {
      val (_, after) = bidAt(Journal.of(opening()), 1, 60, "12:30")

      bidAt(after, 2, 61, "13:00")._1 shouldBe Left(PlaceBidRejected.BidBelowMinimum(money(70)))
      placedAmount(bidAt(after, 2, 70, "13:00")._1) shouldBe Some(money(70))
      val led = trading(price = 100, leader = Some(participant(9)), stepWindows = List(happyHours))
      bidAt(Journal.of(led), 1, 60, "13:00")._1 shouldBe Left(PlaceBidRejected.BidBelowMinimum(money(110)))
    }

    "leave the regular starting price when the window does not set one below it" in {
      val same = happyHours.copy(start = Some(money(100)))
      val above = happyHours.copy(start = Some(money(150)))
      val stepOnly = StepWindow(at("12:00"), at("14:00"), money(1))

      for (window <- List(same, above, stepOnly))
        Lot.minRequired(tradingOf(opening(List(window))), at("13:00")) shouldBe money(100)
    }

    "keep the regular step in a window without a step" in {
      val led = tradingOf(trading(price = 100, leader = Some(participant(9)), stepWindows = List(happyHours)))

      Lot.step(led, money(100), at("13:00")) shouldBe money(10)
    }

    "take the first bid at the starting price and the next at the step of a window that sets both" in {
      val both = happyHours.copy(step = Some(money(1)))
      val (first, after) = bidAt(Journal.of(opening(List(both))), 1, 60, "12:30")

      placedAmount(first) shouldBe Some(money(60))
      placedAmount(bidAt(after, 2, 61, "13:00")._1) shouldBe Some(money(61))
    }

    "let a proxy limit set inside the window reach the starting price of the window" in {
      val (result, journal) = Journal.of(opening()).limit(setProxyLimit(who = 1, max = 80, opN = 1), now = at("13:00"))

      result shouldBe Right(
        Decision.Accepted(
          LotEvent.ProxyLimitSet(participant(1), money(80)),
          List(proxied(proxyBid(1), who = 1, amount = 60, previous = None))
        )
      )
      tradingOf(journal.lot).currentPrice shouldBe money(60)
    }

    "refuse the same limit outside the window with the regular starting price" in {
      Journal.of(opening()).limit(setProxyLimit(who = 1, max = 80, opN = 1), now = at("14:00"))._1 shouldBe Left(
        SetProxyLimitRejected.ProxyBelowCurrentPrice(money(100))
      )
    }

    "let a limit that reaches the starting price of the window answer the first manual bid at it" in {
      val withLimit = trading(
        price = 100,
        limits = Map(participant(1) -> limit(70, setSeq = 3)),
        stepWindows = List(happyHours)
      )
      val (result, journal) = bidAt(Journal.of(withLimit), 2, 60, "13:00")

      placedAmount(result) shouldBe Some(money(60))
      tradingOf(journal.lot).leader shouldBe Some(participant(1))
      tradingOf(journal.lot).currentPrice shouldBe money(70)
    }

    "not apply in the live final" in {
      Lot.minRequired(tradingOf(opening(phase = Phase.Live)), at("13:00")) shouldBe money(100)
    }
  }
}
