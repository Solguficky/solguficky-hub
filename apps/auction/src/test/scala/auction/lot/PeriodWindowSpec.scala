package auction.lot

import auction.lot.LotFixtures.*
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

import java.util.UUID

/**
 * Окно лота в периоде «Счастливых часов» (ADR-047, дополнение 2026-10-27, PER-786): лот заменяет и снимает окно периода
 * по его идентификатору, только пока момент команды раньше начала окна. Часы — подставленный `now`.
 */
final class PeriodWindowSpec extends AnyWordSpec with Matchers {

  private val period = WindowPeriod(new UUID(7L, 1L))
  private val otherPeriod = WindowPeriod(new UUID(7L, 2L))

  /** Окно периода `[12:00, 14:00)` со стартовой ценой 60 при обычной стартовой 100 и `Fixed 10`. */
  private val terms = StepWindow(at("12:00"), at("14:00"), step = None, start = Some(money(60)), period = Some(period))

  private def set(window: StepWindow = terms, opN: Int = 20): SetPeriodWindow = SetPeriodWindow(window, op(opN))

  private def clear(opN: Int = 30, of: WindowPeriod = period): ClearPeriodWindow = ClearPeriodWindow(of, op(opN))

  private def windowsOf(lot: Lot): List[StepWindow] = tradingOf(lot).stepWindows

  /** Решение по команде и журнал после него; `None` — принято без записи, и журнал не меняется. */
  private def written(
      journal: Journal,
      opId: OpId,
      result: Either[PeriodWindowRejected, Option[Decision]],
      time: String
  ): (Either[PeriodWindowRejected, Option[Decision]], Journal) =
    result match {
      case Right(Some(decision)) => (result, journal.record(opId, Right(decision), at(time))._2)
      case _ => (result, journal)
    }

  private def setAt(journal: Journal, command: SetPeriodWindow, time: String) =
    written(journal, command.opId, Lot.decide(journal.lot, command, at(time)), time)

  private def clearAt(journal: Journal, command: ClearPeriodWindow, time: String) =
    written(journal, command.opId, Lot.decide(journal.lot, command, at(time)), time)

  /** Лот без ставок с историей торгов, как его поднимает entity: окна периода ложатся и в неё. */
  private val opening: Journal = Journal.of(trading(price = 100, course = Some(Course.opened(money(100), Nil))))

  "terms of a lot in a period" should {

    "write the window of the period before the period starts" in {
      val (result, after) = setAt(opening, set(), "11:00")

      result shouldBe Right(Some(Decision.Accepted(LotEvent.PeriodWindowSet(terms))))
      windowsOf(after.lot) shouldBe List(terms)
    }

    "replace the window of the same period and keep one window for it" in {
      val (_, once) = setAt(opening, set(), "10:00")
      val replaced = terms.copy(step = Some(money(5)), start = Some(money(50)))
      val (result, twice) = setAt(once, set(replaced, opN = 21), "11:59:59")

      result shouldBe Right(Some(Decision.Accepted(LotEvent.PeriodWindowSet(replaced))))
      windowsOf(twice.lot) shouldBe List(replaced)
      tradingOf(twice.lot).course.map(_.addedWindows.map(_.window)) shouldBe Some(Vector(replaced))
    }

    "keep the window of another period next to it" in {
      val (_, once) = setAt(opening, set(), "10:00")
      val later = StepWindow(at("15:00"), at("16:00"), Some(money(5)), None, Some(otherPeriod))
      val (_, twice) = setAt(once, set(later, opN = 21), "10:30")

      windowsOf(twice.lot) shouldBe List(terms, later)
    }

    "refuse once the period has started and leave the window as it was" in {
      val (_, once) = setAt(opening, set(), "10:00")
      val replaced = terms.copy(start = Some(money(50)))

      for (time <- List("12:00", "13:00", "14:30"))
        Lot.decide(once.lot, set(replaced, opN = 21), at(time)) shouldBe Left(PeriodWindowRejected.PeriodStarted)
      windowsOf(once.lot) shouldBe List(terms)
    }

    "accept the window it already has without a second event" in {
      val (_, once) = setAt(opening, set(), "10:00")

      Lot.decide(once.lot, set(opN = 21), at("11:00")) shouldBe Right(None)
    }

    "accept without a record a window in another currency or one meeting a window of another kind" in {
      val foreign = terms.copy(start = Some(Money(60, eur)))
      val announced = trading(price = 100, stepWindows = List(stepWindow("13:00", "15:00", 1)))

      Lot.decide(opening.lot, set(foreign), at("11:00")) shouldBe Right(None)
      Lot.decide(announced, set(), at("11:00")) shouldBe Right(None)
    }

    "answer a repeated op_id with the original event and another command under it with OpIdTaken" in {
      val (result, once) = setAt(opening, set(), "10:00")
      val original = once.entries.last

      Lot.decide(once.lot, set(), at("13:00")) shouldBe Right(Some(Decision.Repeated(original)))
      Lot.decide(once.lot, clear(opN = 20), at("11:00")) shouldBe Left(PeriodWindowRejected.OpIdTaken)
      result.isRight shouldBe true
    }

    "refuse a lot that is not trading online" in {
      for (lot <- List(scheduled(), held(100, participant(1)), trading(price = 100, phase = Phase.Live)))
        Lot.decide(lot, set(), at("11:00")) shouldBe Left(PeriodWindowRejected.LotNotOpen)
      Lot.decide(Lot.initial, set(), at("11:00")) shouldBe Left(PeriodWindowRejected.LotNotFound)
    }

    "give the first bid in the period the starting price of the replaced window" in {
      val (_, once) = setAt(opening, set(), "10:00")
      val (_, twice) = setAt(once, set(terms.copy(start = Some(money(50))), opN = 21), "11:00")

      Lot.minRequired(tradingOf(twice.lot), at("12:30")) shouldBe money(50)
    }
  }

  "removal of the terms of a lot in a period" should {

    "remove the window of the period before it starts, from the history too" in {
      val (_, once) = setAt(opening, set(), "10:00")
      val (result, cleared) = clearAt(once, clear(), "11:59:59")

      result shouldBe Right(Some(Decision.Accepted(LotEvent.PeriodWindowCleared(period))))
      windowsOf(cleared.lot) shouldBe empty
      tradingOf(cleared.lot).course.map(_.addedWindows) shouldBe Some(Vector.empty)
      Lot.minRequired(tradingOf(cleared.lot), at("12:30")) shouldBe money(100)
    }

    "refuse once the period has started and leave the window as it was" in {
      val (_, once) = setAt(opening, set(), "10:00")

      Lot.decide(once.lot, clear(), at("12:00")) shouldBe Left(PeriodWindowRejected.PeriodStarted)
      windowsOf(once.lot) shouldBe List(terms)
    }

    "accept without a record a period the lot has no window of" in {
      val (_, once) = setAt(opening, set(), "10:00")

      Lot.decide(opening.lot, clear(), at("11:00")) shouldBe Right(None)
      Lot.decide(once.lot, clear(of = otherPeriod), at("11:00")) shouldBe Right(None)
    }

    "refuse a lot that is not trading online" in {
      Lot.decide(sold(100, participant(1)), clear(), at("11:00")) shouldBe Left(PeriodWindowRejected.LotNotOpen)
    }
  }
}
