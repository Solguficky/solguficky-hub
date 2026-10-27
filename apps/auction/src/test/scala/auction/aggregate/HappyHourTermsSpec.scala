package auction.aggregate

import auction.aggregate.AuctionFixtures.*
import auction.catalog.LotId
import auction.lot.ClearPeriodWindow
import auction.lot.LotFixtures.money
import auction.lot.LotFixtures.op
import auction.lot.LotFixtures.rub
import auction.lot.Money
import auction.lot.OpId
import auction.lot.SetPeriodWindow
import auction.lot.StepWindow
import auction.lot.WindowPeriod
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

import java.time.Instant
import java.util.UUID

/**
 * Условия лота в периоде «Счастливых часов» (ADR-047, дополнение 2026-10-27, PER-786): решение аукциона, свёртка и
 * доставка лотам, без акторов и журнала. Часы — подставленный `now`, обычные условия лота — подставленные `regulars`.
 */
final class HappyHourTermsSpec extends AnyWordSpec with Matchers {

  private val meetup = MeetupId(new UUID(6L, 1L))
  private val first = LotId(new UUID(5L, 1L))
  private val second = LotId(new UUID(5L, 2L))
  private val outsider = LotId(new UUID(5L, 9L))

  /** Сутки онлайн-торгов: период от `now` раньше конца недели. */
  private val now: Instant = opensAt.plusSeconds(24 * 3600)

  /** Обычные условия лота: стартовая 1 000, шаг 100 при текущей цене. */
  private val regulars = LotRegulars(rub, money(1000), money(100))

  private def hours(n: Long): Instant = opensAt.plusSeconds(n * 3600)

  private def prebidding(input: AuctionConfigInput = configInput()): Auction =
    Auction(AuctionState.Prebidding(config(input), op(3)), Some(meetup), Set(first, second), Map.empty)

  /** Аукцион с периодом `[30 ч, 32 ч)` под `op(7)` и, по желанию, вторым `[40 ч, 41 ч)` под `op(8)`. */
  private def withPeriods(auction: Auction = prebidding(), twoPeriods: Boolean = false): Auction = {
    val once = created(auction, hours(30), hours(32), 7)
    if (twoPeriods) created(once, hours(40), hours(41), 8) else once
  }

  private def created(auction: Auction, from: Instant, until: Instant, opN: Int): Auction =
    applied(auction, op(opN), Auction.decide(auction, CreateHappyHourPeriod(from, until, op(opN)), now))

  private val period = HappyHourPeriod.idOf(op(7))
  private val laterPeriod = HappyHourPeriod.idOf(op(8))

  private def set(
      lot: LotId = first,
      step: Option[Long] = Some(50),
      start: Option[Long] = Some(600),
      opN: Int = 20,
      of: HappyHourPeriodId = period
  ): SetHappyHourLotTerms =
    SetHappyHourLotTerms(of, lot, step.map(money), start.map(money), op(opN))

  private def clear(lot: LotId = first, opN: Int = 30, of: HappyHourPeriodId = period): ClearHappyHourLotTerms =
    ClearHappyHourLotTerms(of, lot, op(opN))

  private def decide(
      auction: Auction,
      command: SetHappyHourLotTerms = set(),
      at: Instant = now,
      active: Set[LotId] = Set(first, second),
      lot: Option[LotRegulars] = Some(regulars)
  ): Either[SetHappyHourLotTermsRejected, AuctionDecision] =
    Auction.decide(auction, command, at, active, lot)

  private def applied[R](auction: Auction, opId: OpId, decision: Either[R, AuctionDecision]): Auction =
    decision match {
      case Right(AuctionDecision.Accepted(event)) =>
        Auction.apply(auction, AuctionEnvelope(auction.seen.size.toLong + 1, opId, event))
      case other => fail(s"the command was not accepted: $other")
    }

  private def written(auction: Auction, command: SetHappyHourLotTerms): Auction =
    applied(auction, command.opId, decide(auction, command))

  private def terms(step: Option[Long] = Some(50), start: Option[Long] = Some(600)): HappyHourTerms =
    HappyHourTerms(step.map(money), start.map(money))

  "terms of a lot in a happy hour period" should {

    "record the terms of an open lot before the period starts" in {
      decide(withPeriods()) shouldBe Right(
        AuctionDecision.Accepted(AuctionEvent.HappyHourLotTermsSet(period, first, terms()))
      )
      Auction.termsOf(written(withPeriods(), set()), period) shouldBe List(first -> terms())
    }

    "replace the terms of the lot in the same period and keep one entry for it" in {
      val once = written(withPeriods(), set())
      val twice = written(once, set(step = None, start = Some(500), opN = 21))

      Auction.termsOf(twice, period) shouldBe List(first -> terms(step = None, start = Some(500)))
      twice.periodTerms.map(_.change) shouldBe List(op(21))
    }

    "answer a repeated op_id with the original before the period and the clock" in {
      val once = written(withPeriods(), set())

      decide(once, set(), at = hours(31)) shouldBe Right(AuctionDecision.Repeated(once.seen(op(20))))
    }

    "refuse the terms once the period has started" in {
      for (moment <- List(hours(30), hours(31)))
        decide(withPeriods(), at = moment) shouldBe Left(SetHappyHourLotTermsRejected.PeriodStarted)
    }

    "refuse a period the auction does not have, including a deleted one" in {
      val deleted = applied(
        withPeriods(),
        op(9),
        Auction.decide(withPeriods(), DeleteHappyHourPeriod(period, op(9)), now)
      )

      decide(prebidding()) shouldBe Left(SetHappyHourLotTermsRejected.PeriodNotFound)
      decide(deleted) shouldBe Left(SetHappyHourLotTermsRejected.PeriodNotFound)
    }

    "refuse terms that set neither a step nor a starting price" in {
      decide(withPeriods(), set(step = None, start = None)) shouldBe Left(SetHappyHourLotTermsRejected.TermsEmpty)
    }

    "refuse a lot outside the registry and a lot the auction does not know to be trading online" in {
      decide(withPeriods(), set(lot = outsider)) shouldBe Left(SetHappyHourLotTermsRejected.LotNotInAuction)
      decide(withPeriods(), active = Set(second)) shouldBe Left(SetHappyHourLotTermsRejected.LotNotOpen)
      decide(withPeriods(), lot = None) shouldBe Left(SetHappyHourLotTermsRejected.LotNotOpen)
    }

    "refuse an amount that is not positive or not in the currency of the lot" in {
      decide(withPeriods(), set(step = Some(0))) shouldBe Left(SetHappyHourLotTermsRejected.AmountInvalid)
      val foreign = set().copy(start = Some(Money(600, auction.lot.LotFixtures.eur)))
      decide(withPeriods(), foreign) shouldBe Left(SetHappyHourLotTermsRejected.AmountInvalid)
    }

    "refuse a step or a starting price that is not lower than the regular one, naming it" in {
      decide(withPeriods(), set(step = Some(100))) shouldBe
        Left(SetHappyHourLotTermsRejected.StepNotLower(money(100)))
      decide(withPeriods(), set(start = Some(1000))) shouldBe
        Left(SetHappyHourLotTermsRejected.StartNotLower(money(1000)))
    }

    "refuse a period meeting an announced or a launched window of the lot" in {
      val announced = withPeriods(prebidding(configInput(stepWindows = List(window(31, 33, Set(first))))))
      val launch = LaunchStepWindow(Some(hours(29)), hours(31), money(1), List(first), op(10))
      val launched = applied(withPeriods(), op(10), Auction.decide(withPeriods(), launch, now, Set(first, second)))

      decide(announced) shouldBe Left(SetHappyHourLotTermsRejected.WindowsOverlap(hours(31), hours(33)))
      decide(launched) shouldBe Left(SetHappyHourLotTermsRejected.WindowsOverlap(hours(29), hours(31)))
      decide(announced, set(lot = second)).isRight shouldBe true
    }

    "refuse terms in a period meeting the terms of the lot in another period" in {
      val once = written(created(withPeriods(), hours(31), hours(33), 8), set())

      decide(once, set(of = laterPeriod, opN = 21)) shouldBe
        Left(SetHappyHourLotTermsRejected.WindowsOverlap(hours(30), hours(32)))
      decide(once, set(lot = second, of = laterPeriod, opN = 21)).isRight shouldBe true
    }

    "refuse an auction that is not trading online" in {
      val settling = withPeriods().copy(state = AuctionState.Settling(config(), op(3)))

      decide(settling) shouldBe Left(SetHappyHourLotTermsRejected.NotInPrebidding)
      decide(Auction.initial) shouldBe Left(SetHappyHourLotTermsRejected.AuctionNotFound)
    }

    "refuse a launched window meeting the terms of a lot in a period" in {
      val once = written(withPeriods(), set())
      val launch = LaunchStepWindow(Some(hours(31)), hours(33), money(1), List(second, first), op(10))

      Auction.decide(once, launch, now, Set(first, second)) shouldBe
        Left(LaunchStepWindowRejected.StepWindowsOverlap(first, hours(30), hours(32)))
    }
  }

  "removal of the terms of a lot in a happy hour period" should {

    "remove the terms before the period starts and keep the removal to deliver it" in {
      val once = written(withPeriods(), set())
      val decision = Auction.decide(once, clear(), now)

      decision shouldBe Right(AuctionDecision.Accepted(AuctionEvent.HappyHourLotTermsCleared(period, first)))
      val cleared = applied(once, op(30), decision)
      Auction.termsOf(cleared, period) shouldBe empty
      cleared.periodTerms shouldBe List(PeriodLotTerms(period, first, None, op(30)))
    }

    "answer a repeated op_id of a removal with the original even once the period has started" in {
      val once = written(withPeriods(), set())
      val cleared = applied(once, op(30), Auction.decide(once, clear(), now))

      Auction.decide(cleared, clear(), hours(31)) shouldBe Right(AuctionDecision.Repeated(cleared.seen(op(30))))
    }

    "change nothing when the lot has no terms in the period" in {
      Auction.decide(withPeriods(), clear(), now) shouldBe Right(AuctionDecision.Unchanged)
    }

    "refuse once the period has started and keep the terms" in {
      val once = written(withPeriods(), set())

      Auction.decide(once, clear(), hours(30)) shouldBe Left(ClearHappyHourLotTermsRejected.PeriodStarted)
      Auction.termsOf(once, period) shouldBe List(first -> terms())
    }

    "refuse a period the auction does not have and a lot outside the registry" in {
      Auction.decide(prebidding(), clear(), now) shouldBe Left(ClearHappyHourLotTermsRejected.PeriodNotFound)
      Auction.decide(withPeriods(), clear(lot = outsider), now) shouldBe
        Left(ClearHappyHourLotTermsRejected.LotNotInAuction)
    }
  }

  "deletion of a happy hour period" should {

    "remove the terms of every lot of the period under the op_id of the deletion" in {
      val both = written(written(withPeriods(twoPeriods = true), set()), set(lot = second, opN = 21))
      val inLater = written(both, set(of = laterPeriod, opN = 22))
      val deleted = applied(inLater, op(9), Auction.decide(inLater, DeleteHappyHourPeriod(period, op(9)), now))

      Auction.termsOf(deleted, laterPeriod) shouldBe List(first -> terms())
      deleted.periodTerms shouldBe List(
        PeriodLotTerms(period, first, None, op(9)),
        PeriodLotTerms(period, second, None, op(9)),
        PeriodLotTerms(laterPeriod, first, Some(terms()), op(22))
      )
    }
  }

  "delivery of the terms to the lots" should {

    val window = StepWindow(hours(30), hours(32), Some(money(50)), Some(money(600)), Some(WindowPeriod(period.value)))

    "send the window of the period to the lot under an op_id derived from the change and the lot" in {
      val once = written(withPeriods(), set())
      val (roster, instructions) = LotRoster.termsChanged(once, LotRoster.empty, op(20))

      val command = SetPeriodWindow(window, derived(op(20), first))
      instructions shouldBe List(LotInstruction.SetTerms(first, op(20), command))
      roster.deliveries shouldBe Map((op(20), first) -> WindowDelivery.Sending)
      LotRoster.termsChanged(once, roster, op(20))._2 shouldBe empty
    }

    "send a removal to each lot of a deleted period" in {
      val both = written(written(withPeriods(), set()), set(lot = second, opN = 21))
      val deleted = applied(both, op(9), Auction.decide(both, DeleteHappyHourPeriod(period, op(9)), now))
      val clearing = ClearPeriodWindow(WindowPeriod(period.value), _)

      LotRoster.termsChanged(deleted, LotRoster.empty, op(9))._2 shouldBe List(
        LotInstruction.ClearTerms(first, op(9), clearing(derived(op(9), first))),
        LotInstruction.ClearTerms(second, op(9), clearing(derived(op(9), second)))
      )
    }

    "send only the last change of a lot after a restart and none of the change it replaced" in {
      val replaced = written(written(withPeriods(), set()), set(start = Some(500), opN = 21))

      LotRoster.termsChanged(replaced, LotRoster.empty, op(20))._2 shouldBe empty
      LotRoster.survey(replaced)._2.collect { case terms: LotInstruction.SetTerms => terms.change } shouldBe
        List(op(21))
    }

    "send again a change the lot did not answer and not one it answered" in {
      val once = written(withPeriods(), set())
      val (sent, _) = LotRoster.termsChanged(once, LotRoster.empty, op(20))

      val silent = LotRoster.windowUnanswered(sent, op(20), first)
      LotRoster.recheck(once, silent)._2.collect { case terms: LotInstruction.SetTerms => terms.change } shouldBe
        List(op(20))
      val answered = LotRoster.windowAnswered(sent, op(20), first)
      LotRoster.recheck(once, answered)._2.collect { case terms: LotInstruction.SetTerms => terms } shouldBe empty
    }

    "send nothing outside the online phase" in {
      val once = written(withPeriods(), set())
      val settling = once.copy(state = AuctionState.Settling(config(), op(3)))

      LotRoster.termsChanged(settling, LotRoster.empty, op(20))._2 shouldBe empty
    }
  }

  private def derived(change: OpId, lot: LotId): OpId =
    OpId(Auction.nameBased(LotRoster.TermsNamespace, s"${change.value}/${lot.value}"))
}
