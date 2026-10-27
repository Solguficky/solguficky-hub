package auction.aggregate

import auction.aggregate.AuctionFixtures.config
import auction.catalog.LotId
import auction.lot.LotFixtures.op
import auction.lot.OpId
import auction.lot.LotFixtures.participant
import org.scalacheck.Gen
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec
import org.scalatestplus.scalacheck.ScalaCheckDrivenPropertyChecks

import java.util.UUID

final class LotSetsSpec extends AnyWordSpec with Matchers with ScalaCheckDrivenPropertyChecks {

  implicit override val generatorDrivenConfig: PropertyCheckConfiguration =
    PropertyCheckConfiguration(minSuccessful = 100)

  private val meetup = MeetupId(UUID.fromString("0190a0e0-0000-7000-8000-000000000001"))

  private def lot(n: Int): LotId = LotId(new UUID(5L, n.toLong))

  private def set(n: Int): LotSetId = LotSetId(new UUID(6L, n.toLong))

  private def name(raw: String): LotSetName =
    LotSetName(raw).fold(rejected => fail(s"образец названия: $rejected"), n => n)

  private val red = name("Красный сет")

  /** Следующая строка журнала: номер — за последним в окне `seen`, `op_id` — свой у каждой строки. */
  private def next(auction: Auction, event: AuctionEvent): Auction = {
    val sequence = auction.seen.values.map(_.sequence).maxOption.getOrElse(0L) + 1
    Auction.apply(auction, AuctionEnvelope(sequence, op(100 + sequence.toInt), event))
  }

  /** Аукцион в `Draft` с лотами 1–4 в реестре. */
  private def drafted: Auction =
    (1 to 4).foldLeft(next(Auction.initial, AuctionEvent.AuctionDrafted(meetup)))((auction, n) =>
      next(auction, AuctionEvent.LotAdded(lot(n)))
    )

  private def accepted(decision: Either[?, AuctionDecision]): AuctionEvent =
    decision match {
      case Right(AuctionDecision.Accepted(event)) => event
      case other => fail(s"expected an event, got $other")
    }

  private def defined(auction: Auction, id: LotSetId, lots: LotId*): Auction =
    next(auction, accepted(Auction.decide(auction, SaveLotSet(id, red, lots.toList, op(50)))))

  private def started(auction: Auction): Auction =
    next(next(auction, AuctionEvent.AuctionScheduled(config())), AuctionEvent.PrebiddingStarted)

  private def opening(of: Auction): OpId = of.state.started.fold(fail("торги не открыты"))((_, startedBy) => startedBy)

  "lot set" should {

    "is defined with its lots in the order of the organizer, a repeated lot counting once" in {
      val auction = defined(drafted, set(1), lot(3), lot(1), lot(3))
      auction.sets shouldBe Map(set(1) -> LotSet(red, List(lot(3), lot(1))))
    }

    "replaces its name and lots as a whole under the same id" in {
      val first = defined(drafted, set(1), lot(1), lot(2))
      val renamed = name("Синий сет")
      val after =
        next(first, accepted(Auction.decide(first, SaveLotSet(set(1), renamed, List(lot(2), lot(3)), op(51)))))
      after.sets shouldBe Map(set(1) -> LotSet(renamed, List(lot(2), lot(3))))
    }

    "accepts a set of fewer than two lots and keeps it incomplete" in {
      val auction = defined(drafted, set(1), lot(1))
      auction.sets(set(1)).complete shouldBe false
      LotSets.awaiting(started(auction)) shouldBe empty
    }

    "refuses a lot outside the registry and names the first such lot" in {
      Auction.decide(drafted, SaveLotSet(set(1), red, List(lot(1), lot(9), lot(8)), op(50))) shouldBe
        Left(SaveLotSetRejected.LotNotInAuction(lot(9)))
    }

    "refuses a lot that is already in another set and names that set" in {
      val auction = defined(drafted, set(1), lot(1), lot(2))
      Auction.decide(auction, SaveLotSet(set(2), red, List(lot(3), lot(2)), op(52))) shouldBe
        Left(SaveLotSetRejected.LotInAnotherSet(lot(2), set(1)))
    }

    "refuses a blank name, spaces of any kind included" in {
      LotSetName("  \t") shouldBe Left(SaveLotSetRejected.NameEmpty)
      LotSetName("") shouldBe Left(SaveLotSetRejected.NameEmpty)
    }

    "is frozen with the registry once prebidding started" in {
      val auction = started(defined(drafted, set(1), lot(1), lot(2)))
      Auction.decide(auction, SaveLotSet(set(1), red, List(lot(3), lot(4)), op(60))) shouldBe
        Left(SaveLotSetRejected.LotsFrozen)
      Auction.decide(auction, DeleteLotSet(set(1), op(61))) shouldBe Left(DeleteLotSetRejected.LotsFrozen)
    }

    "refuses set commands before the auction is born" in {
      Auction.decide(Auction.initial, SaveLotSet(set(1), red, Nil, op(50))) shouldBe
        Left(SaveLotSetRejected.AuctionNotFound)
      Auction.decide(Auction.initial, DeleteLotSet(set(1), op(50))) shouldBe Left(DeleteLotSetRejected.AuctionNotFound)
    }

    "is deleted and refuses to delete a set it does not have" in {
      val auction = defined(drafted, set(1), lot(1), lot(2))
      next(auction, accepted(Auction.decide(auction, DeleteLotSet(set(1), op(53))))).sets shouldBe empty
      Auction.decide(auction, DeleteLotSet(set(2), op(54))) shouldBe Left(DeleteLotSetRejected.LotSetNotFound)
    }

    "answers a repeated op_id with the original envelope" in {
      val auction = defined(drafted, set(1), lot(1), lot(2))
      val original = auction.seen.values.maxBy(_.sequence)
      Auction.decide(auction, SaveLotSet(set(1), red, List(lot(3)), original.opId)) shouldBe
        Right(AuctionDecision.Repeated(original))
      Auction.decide(auction, DeleteLotSet(set(1), original.opId)) shouldBe Right(AuctionDecision.Repeated(original))
    }

    "loses a lot removed from the registry and does not get it back when the lot is added again" in {
      val auction = defined(drafted, set(1), lot(1), lot(2), lot(3))
      val removed = next(auction, AuctionEvent.LotRemoved(lot(2)))
      removed.sets(set(1)).lots shouldBe List(lot(1), lot(3))
      next(removed, AuctionEvent.LotAdded(lot(2))).sets(set(1)).lots shouldBe List(lot(1), lot(3))
    }

    "becomes incomplete when the registry leaves it one lot" in {
      val auction = next(defined(drafted, set(1), lot(1), lot(2)), AuctionEvent.LotRemoved(lot(1)))
      auction.sets(set(1)).complete shouldBe false
    }

    "is wiped together with the registry when the auction is discarded" in {
      val auction = next(defined(drafted, set(1), lot(1), lot(2)), AuctionEvent.AuctionDiscarded)
      auction.sets shouldBe empty
      next(auction, AuctionEvent.AuctionDrafted(meetup)).sets shouldBe empty
    }
  }

  "collector of a lot set" should {

    val winner = participant(1)
    val other = participant(2)

    "is the participant every lot of the set was sold to" in {
      LotSets.verdict(
        LotSet(red, List(lot(1), lot(2))),
        Map(lot(1) -> LotOutcome.Sold(winner), lot(2) -> LotOutcome.Sold(winner))
      ) shouldBe Some(LotSetSettlement.Collected(winner))
    }

    "is nobody when the lots went to different participants" in {
      LotSets.verdict(
        LotSet(red, List(lot(1), lot(2))),
        Map(lot(1) -> LotOutcome.Sold(winner), lot(2) -> LotOutcome.Sold(other))
      ) shouldBe Some(LotSetSettlement.NotCollected)
    }

    "is nobody when a lot of the set was not sold, was withdrawn or never opened" in {
      forAll(Gen.oneOf(LotOutcome.Unsold, LotOutcome.Withdrawn, LotOutcome.NotOpened)) { ended =>
        LotSets.verdict(
          LotSet(red, List(lot(1), lot(2))),
          Map(lot(1) -> LotOutcome.Sold(winner), lot(2) -> ended)
        ) shouldBe Some(LotSetSettlement.NotCollected)
      }
    }

    "is not decided while any lot of the set has not ended, whatever the others did" in {
      val outcome =
        Gen.oneOf(Gen.const(LotOutcome.Sold(winner)), Gen.const(LotOutcome.Unsold), Gen.const(LotOutcome.Withdrawn))
      forAll(outcome, outcome) { (first, third) =>
        LotSets.verdict(LotSet(red, List(lot(1), lot(2), lot(3))), Map(lot(1) -> first, lot(3) -> third)) shouldBe None
      }
    }

    "is recorded once, after prebidding started, and never changes" in {
      val auction = started(defined(drafted, set(1), lot(1), lot(2)))
      val sold = Map(lot(1) -> LotOutcome.Sold(winner), lot(2) -> LotOutcome.Sold(winner))
      val settle = SettleLotSet(set(1), sold, LotSets.settlementOf(opening(auction), set(1)))
      val after = next(auction, accepted(Auction.decide(auction, settle)))
      after.sets(set(1)).settlement shouldBe Some(LotSetSettlement.Collected(winner))
      LotSets.awaiting(after) shouldBe empty
      val other = Map(lot(1) -> LotOutcome.Sold(participant(3)), lot(2) -> LotOutcome.Sold(participant(3)))
      Auction.decide(after, SettleLotSet(set(1), other, op(70))) shouldBe Left(SettleLotSetRejected.AlreadySettled)
    }

    "waits while a lot of the set is still trading" in {
      val auction = started(defined(drafted, set(1), lot(1), lot(2)))
      Auction.decide(auction, SettleLotSet(set(1), Map(lot(1) -> LotOutcome.Sold(winner)), op(70))) shouldBe
        Left(SettleLotSetRejected.NotTerminal)
    }

    "is not recorded before prebidding started or for an incomplete set" in {
      val sold = Map(lot(1) -> LotOutcome.Sold(winner), lot(2) -> LotOutcome.Sold(winner))
      Auction.decide(defined(drafted, set(1), lot(1), lot(2)), SettleLotSet(set(1), sold, op(70))) shouldBe
        Left(SettleLotSetRejected.NotStarted)
      Auction.decide(started(defined(drafted, set(1), lot(1))), SettleLotSet(set(1), sold, op(70))) shouldBe
        Left(SettleLotSetRejected.LotSetNotFound)
    }

    "is recorded in a cancelled auction, where withdrawn lots leave the set uncollected" in {
      val auction = next(started(defined(drafted, set(1), lot(1), lot(2))), AuctionEvent.AuctionCancelled)
      val ended = Map(lot(1) -> LotOutcome.Sold(winner), lot(2) -> LotOutcome.Withdrawn)
      accepted(Auction.decide(auction, SettleLotSet(set(1), ended, op(70)))) shouldBe
        AuctionEvent.LotSetSettled(set(1), LotSetSettlement.NotCollected)
    }

    "has an op_id derived from the opening and the set, a version 5 uuid that differs between sets" in {
      forAll(Gen.uuid, Gen.uuid, Gen.uuid) { (opening, a, b) =>
        val id = LotSets.settlementOf(OpId(opening), LotSetId(a)).value
        id.version shouldBe 5
        LotSets.settlementOf(OpId(opening), LotSetId(a)).value shouldBe id
        if (a != b) LotSets.settlementOf(OpId(opening), LotSetId(b)).value should not be id
      }
    }
  }
}
