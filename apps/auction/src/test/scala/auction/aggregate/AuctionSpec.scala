package auction.aggregate

import auction.catalog.LotId
import auction.lot.LotFixtures.*
import org.scalacheck.Gen
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec
import org.scalatestplus.scalacheck.ScalaCheckDrivenPropertyChecks

import java.util.UUID

final class AuctionSpec extends AnyWordSpec with Matchers with ScalaCheckDrivenPropertyChecks {

  implicit override val generatorDrivenConfig: PropertyCheckConfiguration =
    PropertyCheckConfiguration(minSuccessful = 100)

  private val meetup = MeetupId(UUID.fromString("0190a0e0-0000-7000-8000-000000000001"))
  private val lot = LotId(new UUID(5L, 1L))

  private def born: Auction =
    Auction.apply(Auction.initial, AuctionEnvelope(1, op(1), AuctionEvent.AuctionDrafted(meetup)))

  private def applied(auction: Auction, decision: AuctionDecision, sequence: Long, opN: Int): Auction =
    decision match {
      case AuctionDecision.Accepted(event) => Auction.apply(auction, AuctionEnvelope(sequence, op(opN), event))
      case other => fail(s"expected an event, got $other")
    }

  "auction id of a meetup" should {

    "keeps the vector fixed by the contract" in {
      Auction.idOf(meetup).value.toString shouldBe "daef05c7-cd68-5048-b03d-cb4860e8dc73"
    }

    "is a canonical version 5 uuid, the same for one meetup and different for another" in {
      forAll(Gen.uuid, Gen.uuid) { (a, b) =>
        val id = Auction.idOf(MeetupId(a)).value
        id.version shouldBe 5
        id.variant shouldBe 2
        Auction.idOf(MeetupId(a)) shouldBe Auction.idOf(MeetupId(a))
        if (a != b) Auction.idOf(MeetupId(b)) should not be Auction.idOf(MeetupId(a))
      }
    }
  }

  "auction" should {

    "is born at its meetup and keeps that meetup" in {
      Auction.decide(Auction.initial, DraftAuction(meetup, op(1))) shouldBe
        AuctionDecision.Accepted(AuctionEvent.AuctionDrafted(meetup))
      born.state shouldBe AuctionState.Draft
      born.meetup shouldBe Some(meetup)
    }

    "answers a repeated op_id with the original envelope and a new enabling without an event" in {
      Auction.decide(born, DraftAuction(meetup, op(1))) shouldBe
        AuctionDecision.Repeated(AuctionEnvelope(1, op(1), AuctionEvent.AuctionDrafted(meetup)))
      Auction.decide(born, DraftAuction(meetup, op(2))) shouldBe AuctionDecision.Unchanged
    }

    "refuses registry commands before it is born" in {
      Auction.decide(Auction.initial, AddLot(lot, op(2))) shouldBe Left(AddLotRejected.AuctionNotFound)
      Auction.decide(Auction.initial, RemoveLot(lot, op(2))) shouldBe Left(RemoveLotRejected.AuctionNotFound)
      Auction.inspect(Auction.initial, op(2)) shouldBe Inspection.Absent
    }

    "adds a lot, records a repeated addition of it, removes it and refuses to remove a lot it does not hold" in {
      val withLot = applied(born, Auction.decide(born, AddLot(lot, op(2))).toOption.get, 2, 2)
      withLot.lots shouldBe Set(lot)
      // Повторное добавление пишет событие, чтобы его op_id попал в окно: ответ без события повтором не защищён.
      Auction.decide(withLot, AddLot(lot, op(3))) shouldBe Right(AuctionDecision.Accepted(AuctionEvent.LotAdded(lot)))
      Auction.inspect(withLot, op(2)) shouldBe Inspection.Repeated(
        AuctionEnvelope(2, op(2), AuctionEvent.LotAdded(lot))
      )
      Auction.inspect(withLot, op(3)) shouldBe Inspection.Present(meetup)
      val without = applied(withLot, Auction.decide(withLot, RemoveLot(lot, op(3))).toOption.get, 3, 3)
      // Запоздавший повтор добавления, записанного событием, лот после снятия не возвращает.
      val twice = applied(withLot, Auction.decide(withLot, AddLot(lot, op(5))).toOption.get, 3, 5)
      val removed = applied(twice, Auction.decide(twice, RemoveLot(lot, op(6))).toOption.get, 4, 6)
      Auction.decide(removed, AddLot(lot, op(5))) shouldBe
        Right(AuctionDecision.Repeated(AuctionEnvelope(3, op(5), AuctionEvent.LotAdded(lot))))
      without.lots shouldBe empty
      Auction.decide(without, RemoveLot(lot, op(4))) shouldBe Left(RemoveLotRejected.LotNotInAuction)
    }

    "folds the same journal into the same auction whatever order its rows arrive in" in {
      val journal = List(
        AuctionEnvelope(1, op(1), AuctionEvent.AuctionDrafted(meetup)),
        AuctionEnvelope(2, op(2), AuctionEvent.LotAdded(lot)),
        AuctionEnvelope(3, op(3), AuctionEvent.LotRemoved(lot)),
        AuctionEnvelope(4, op(4), AuctionEvent.LotAdded(lot))
      )
      forAll(Gen.oneOf(journal.permutations.toList)) { shuffled =>
        Auction.replay(Auction.initial, shuffled) shouldBe Auction.replay(Auction.initial, journal)
      }
      Auction.replay(Auction.initial, journal).lots shouldBe Set(lot)
    }
  }
}
