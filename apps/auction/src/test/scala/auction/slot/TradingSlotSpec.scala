package auction.slot

import auction.lot.AuctionId
import org.scalacheck.Gen
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec
import org.scalatestplus.scalacheck.ScalaCheckDrivenPropertyChecks

import java.util.UUID

final class TradingSlotSpec extends AnyWordSpec with Matchers with ScalaCheckDrivenPropertyChecks {

  implicit override val generatorDrivenConfig: PropertyCheckConfiguration =
    PropertyCheckConfiguration(minSuccessful = 100)

  private def auction(n: Int) = AuctionId(new UUID(0x0190f2a000007000L, 0x8000000000000000L | n.toLong))

  private val first = auction(1)
  private val second = auction(2)

  private def held(by: AuctionId) = TradingSlot(SlotState.Held(by))

  private def replay(slot: TradingSlot, events: List[SlotEvent]) = events.foldLeft(slot)(TradingSlot.apply)

  "TradingSlot" should {

    "gives a free slot to the auction that claims it" in {
      TradingSlot.claim(TradingSlot.initial, first) shouldBe ClaimStep.Granted(List(SlotEvent.SlotTaken(first)))
    }

    "answers a repeated claim of the holder without an event" in {
      TradingSlot.claim(held(first), first) shouldBe ClaimStep.Granted(Nil)
    }

    "asks the holder before deciding a claim of another auction" in {
      TradingSlot.claim(held(first), second) shouldBe ClaimStep.AskHolder(first)
    }

    "refuses with the holder when the holder is still trading" in {
      TradingSlot.answered(held(first), second, first, busy = true) shouldBe Left(first)
    }

    "passes the slot to the claimant in one write when the holder is not trading" in {
      val events = TradingSlot.answered(held(first), second, first, busy = false)
      events shouldBe Right(List(SlotEvent.SlotReleased(first), SlotEvent.SlotTaken(second)))
      replay(held(first), events.toOption.get).state shouldBe SlotState.Held(second)
    }

    "ignores an answer of an auction that no longer holds the slot" in {
      TradingSlot.answered(held(second), auction(3), first, busy = false) shouldBe Left(second)
      TradingSlot.answered(TradingSlot.initial, second, first, busy = true) shouldBe
        Right(List(SlotEvent.SlotTaken(second)))
    }

    "frees the slot only on a release of its holder" in {
      TradingSlot.release(held(first), first) shouldBe List(SlotEvent.SlotReleased(first))
      TradingSlot.release(held(first), second) shouldBe empty
      TradingSlot.release(TradingSlot.initial, first) shouldBe empty
      replay(held(first), TradingSlot.release(held(first), first)).state shouldBe SlotState.Free
    }

    "never takes the slot from a trading holder and hands it over only with the release of the holder" in {
      enum Step {
        case Claim(by: Int, busy: Boolean)
        case Release(by: Int)
      }
      val step = Gen.oneOf(
        Gen.zip(Gen.choose(1, 4), Gen.oneOf(true, false)).map(Step.Claim(_, _)),
        Gen.choose(1, 4).map(Step.Release(_))
      )
      forAll(Gen.listOf(step)) { steps =>
        steps.foldLeft(TradingSlot.initial) { (slot, each) =>
          val events = each match {
            case Step.Claim(by, busy) =>
              TradingSlot.claim(slot, auction(by)) match {
                case ClaimStep.Granted(granted) => granted
                case ClaimStep.AskHolder(holder) =>
                  TradingSlot.answered(slot, auction(by), holder, busy).getOrElse(Nil)
              }
            case Step.Release(by) => TradingSlot.release(slot, auction(by))
          }
          val after = replay(slot, events)
          // Слот переходит к новому держателю только с освобождением прежнего: занятого слота никто не перезаписывает.
          (slot.state, after.state) match {
            case (SlotState.Held(before), SlotState.Held(now)) if before != now =>
              events should contain(SlotEvent.SlotReleased(before))
            case _ => ()
          }
          // Держатель, который ответил «занят», слот сохраняет.
          (each, slot.state) match {
            case (Step.Claim(_, true), SlotState.Held(_)) => after.state shouldBe slot.state
            case _ => ()
          }
          after
        }
      }
    }
  }
}
