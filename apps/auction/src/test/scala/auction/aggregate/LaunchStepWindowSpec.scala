package auction.aggregate

import auction.aggregate.AuctionFixtures.*
import auction.catalog.LotId
import auction.lot.LotFixtures.eur
import auction.lot.LotFixtures.money
import auction.lot.LotFixtures.op
import auction.lot.Money
import auction.lot.StepWindow
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

import java.time.Instant
import java.util.UUID

/**
 * Запуск окна сниженного шага по ходу торгов (ADR-047, дополнение 2026-10-12): решение аукциона и доставка окна лотам
 * парой «команда — подтверждение» (И-14), без акторов и журнала. Часы — подставленный `now`.
 */
final class LaunchStepWindowSpec extends AnyWordSpec with Matchers {

  private val meetup = MeetupId(new UUID(6L, 1L))
  private val first = LotId(new UUID(5L, 1L))
  private val second = LotId(new UUID(5L, 2L))
  private val outsider = LotId(new UUID(5L, 9L))

  /** Сутки онлайн-торгов: окно от `now` раньше конца недели. */
  private val now: Instant = opensAt.plusSeconds(24 * 3600)

  private def hours(n: Long): Instant = opensAt.plusSeconds(n * 3600)

  private def prebidding(input: AuctionConfigInput = configInput()): Auction =
    Auction(AuctionState.Prebidding(config(input), op(3)), Some(meetup), Set(first, second), Map.empty)

  private def launch(
      from: Option[Instant] = Some(hours(30)),
      until: Instant = hours(32),
      step: Money = money(1),
      lots: List[LotId] = List(first),
      opN: Int = 7
  ): LaunchStepWindow = LaunchStepWindow(from, until, step, lots, op(opN))

  private def decide(
      auction: Auction,
      command: LaunchStepWindow = launch(),
      active: Set[LotId] = Set(first, second)
  ): Either[LaunchStepWindowRejected, AuctionDecision] = Auction.decide(auction, command, now, active)

  private def written(auction: Auction, command: LaunchStepWindow): Auction =
    decide(auction, command) match {
      case Right(AuctionDecision.Accepted(event)) =>
        Auction.apply(auction, AuctionEnvelope(auction.seen.size.toLong + 1, command.opId, event))
      case other => fail(s"the launch was not accepted: $other")
    }

  "step window launch" should {

    "record a window from the future on the lots it names" in {
      decide(prebidding()) shouldBe Right(
        AuctionDecision.Accepted(
          AuctionEvent.StepWindowLaunched(StepWindowConfig(hours(30), hours(32), money(1), Set(first)))
        )
      )
    }

    "start a window without from at the instant the server decides the command" in {
      decide(prebidding(), launch(from = None)) shouldBe Right(
        AuctionDecision.Accepted(
          AuctionEvent.StepWindowLaunched(StepWindowConfig(now, hours(32), money(1), Set(first)))
        )
      )
    }

    "keep the launched windows in the order they were recorded with the op_id of each" in {
      val once = written(prebidding(), launch(opN = 7))
      val twice = written(once, launch(from = Some(hours(40)), until = hours(41), opN = 8))

      twice.launched.map(_.opId) shouldBe List(op(7), op(8))
    }

    "answer a repeated op_id with the original before the phase, the clock and the overlap" in {
      val once = written(prebidding(), launch(from = None))
      val original = once.seen(op(7))
      val later = once.copy(state = AuctionState.Settling(config(), op(3)))

      Auction.decide(once, launch(from = None), now.plusSeconds(3600), Set.empty) shouldBe
        Right(AuctionDecision.Repeated(original))
      Auction.decide(later, launch(from = None), now, Set(first)) shouldBe Right(AuctionDecision.Repeated(original))
    }

    "refuse an auction that is not trading online" in {
      for (state <- List(AuctionState.Scheduled(config()), AuctionState.Settling(config(), op(3))))
        decide(prebidding().copy(state = state)) shouldBe Left(LaunchStepWindowRejected.NotInPrebidding)
      decide(Auction.initial) shouldBe Left(LaunchStepWindowRejected.AuctionNotFound)
    }

    "refuse a from earlier than the instant of the command" in {
      decide(prebidding(), launch(from = Some(now.minusSeconds(1)))) shouldBe
        Left(LaunchStepWindowRejected.StepWindowInPast)
    }

    "refuse a window outside the online phase" in {
      for (command <- List(launch(until = hours(30)), launch(until = closesAt.plusSeconds(1))))
        decide(prebidding(), command) shouldBe Left(LaunchStepWindowRejected.StepWindowOutsideOnlinePhase)
      Auction.decide(prebidding(), launch(from = None), opensAt.minusSeconds(60), Set(first)) shouldBe
        Left(LaunchStepWindowRejected.StepWindowOutsideOnlinePhase)
      decide(prebidding(byAuctioneer)) shouldBe Left(LaunchStepWindowRejected.StepWindowOutsideOnlinePhase)
    }

    "refuse a step that is not positive or not in the currency of the lots" in {
      for (step <- List(money(0), Money(1, eur)))
        decide(prebidding(), launch(step = step)) shouldBe Left(LaunchStepWindowRejected.StepWindowStepInvalid)
      decide(prebidding(configInput(lotDefaults = None)), launch(step = Money(1, eur))) shouldBe
        Left(LaunchStepWindowRejected.StepWindowStepInvalid)
    }

    "refuse a window that names no lot" in {
      decide(prebidding(), launch(lots = Nil)) shouldBe Left(LaunchStepWindowRejected.StepWindowLotsEmpty)
    }

    "name the first lot of the request that is not in the registry" in {
      decide(prebidding(), launch(lots = List(first, outsider))) shouldBe
        Left(LaunchStepWindowRejected.LotNotInAuction(outsider))
    }

    "refuse a lot whose opening the auction has not confirmed" in {
      decide(prebidding(), launch(lots = List(first, second)), active = Set(first)) shouldBe
        Left(LaunchStepWindowRejected.LotNotOpen(second))
    }

    "refuse a window overlapping an announced window on a common lot" in {
      val announced = window(29, 31, Set(second, first))
      val auction = prebidding(configInput(stepWindows = List(announced)))

      decide(auction) shouldBe Left(LaunchStepWindowRejected.StepWindowsOverlap(first, announced))
    }

    "refuse a window overlapping an earlier launched window on a common lot" in {
      val once = written(prebidding(), launch(lots = List(first, second)))

      decide(once, launch(from = Some(hours(31)), until = hours(33), lots = List(second), opN = 8)) shouldBe
        Left(
          LaunchStepWindowRejected.StepWindowsOverlap(
            second,
            StepWindowConfig(hours(30), hours(32), money(1), Set(first, second))
          )
        )
    }

    "accept windows that meet at a boundary or share no lot" in {
      val once = written(prebidding(), launch())

      decide(once, launch(from = Some(hours(32)), until = hours(33), opN = 8)).isRight shouldBe true
      decide(once, launch(lots = List(second), opN = 9)).isRight shouldBe true
    }
  }

  "step window delivery" should {

    val launched = written(prebidding(), launch(lots = List(first, second)))
    val delivery = launched.launched.head

    "send the window to every lot of it under an op_id derived from the launch and the lot" in {
      val (roster, instructions) = LotRoster.launched(launched, LotRoster.empty, op(7))

      instructions should contain theSameElementsAs List(
        LotInstruction.AddWindow(first, op(7), LotRoster.windowOf(delivery, first)),
        LotInstruction.AddWindow(second, op(7), LotRoster.windowOf(delivery, second))
      )
      roster.deliveries.values.toSet shouldBe Set(WindowDelivery.Sending)
      LotRoster.windowOf(delivery, first).window shouldBe StepWindow(hours(30), hours(32), money(1))
      LotRoster.windowOf(delivery, first).opId should not be LotRoster.windowOf(delivery, second).opId
      LotRoster.windowOf(delivery, first) shouldBe LotRoster.windowOf(delivery, first)
    }

    "not send the window again to a lot that answered or is still answering" in {
      val (sending, _) = LotRoster.launched(launched, LotRoster.empty, op(7))
      val answered = LotRoster.windowAnswered(sending, op(7), first)

      LotRoster.launched(launched, answered, op(7))._2 shouldBe empty
    }

    "send the window again to a lot that did not answer, on the next check" in {
      val (sending, _) = LotRoster.launched(launched, LotRoster.empty, op(7))
      val silent = LotRoster.windowUnanswered(LotRoster.windowAnswered(sending, op(7), first), op(7), second)

      LotRoster.recheck(launched, silent)._2 shouldBe List(
        LotInstruction.AddWindow(second, op(7), LotRoster.windowOf(delivery, second))
      )
    }

    "send every launched window to every lot of it again after a restart, as the survey of the registry" in {
      val (_, instructions) = LotRoster.survey(launched)

      instructions.collect { case window: LotInstruction.AddWindow => window.lot } should contain theSameElementsAs
        List(first, second)
    }

    "send no window once the online phase is over or the auction is cancelled" in {
      for (state <- List(AuctionState.Settling(config(), op(3)), AuctionState.Cancelled(config(), op(3), op(9)))) {
        val after = launched.copy(state = state)
        LotRoster.survey(after)._2.collect { case window: LotInstruction.AddWindow => window } shouldBe empty
        LotRoster.launched(after, LotRoster.empty, op(7))._2 shouldBe empty
      }
    }

    "send nothing for an op_id under which no window was launched" in {
      LotRoster.launched(launched, LotRoster.empty, op(3))._2 shouldBe empty
    }

    "keep an answer it does not wait for out of what it knows" in {
      LotRoster.windowAnswered(LotRoster.empty, op(7), first) shouldBe LotRoster.empty
      LotRoster.windowUnanswered(LotRoster.empty, op(7), first) shouldBe LotRoster.empty
    }
  }
}
