package auction.publication

import auction.aggregate.*
import auction.aggregate.AuctionFixtures.config
import auction.catalog.LotId
import auction.entity.AuctionJournal
import auction.entity.Initiator
import auction.entity.JournalFixtures.*
import auction.entity.StoredAuctionEvent
import auction.lot.LotFixtures.op
import auction.lot.LotFixtures.participant
import auction.projection.AuctionView
import auction.projection.AuctionViewRow
import auction.v1.auction_events as bus
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

/** Факты аукциона на шине: повод, subject и снимок после события — без базы и без `ActorSystem`. */
final class AuctionFactsSpec extends AnyWordSpec with Matchers {

  private val auctionId = uuid(20)
  private val meetup = MeetupId(uuid(10))
  private val lot = LotId(uuid(11))
  private val other = LotId(uuid(12))

  private def stored(event: AuctionEvent, opN: Int): StoredAuctionEvent =
    AuctionJournal.store(uuid(opN), uuid(100 + opN), op(opN), decidedAt, Initiator.Operator(participant(1)))(event)

  private val journal = List(
    AuctionEvent.AuctionDrafted(meetup),
    AuctionEvent.LotAdded(lot),
    AuctionEvent.LotAdded(other),
    AuctionEvent.AuctionScheduled(config()),
    AuctionEvent.PrebiddingStarted,
    AuctionEvent.PrebiddingDeadlineReached,
    AuctionEvent.PrebiddingEnded(finished = false),
    AuctionEvent.FinalLineupFrozen(List(other, lot)),
    AuctionEvent.FinalStarted,
    AuctionEvent.FinalLotActivated(other)
  ).zipWithIndex.map((event, index) => (index + 1).toLong -> stored(event, index + 1))

  /** Факт каждого события журнала, как его кладёт проекция публикации: снимок — строка сразу после события. */
  private def facts(events: List[(Long, StoredAuctionEvent)]): List[Option[Fact]] =
    events
      .foldLeft((Option.empty[AuctionViewRow], List.empty[Option[Fact]])) { case ((row, out), (sequence, event)) =>
        AuctionView.project(row, auctionId, sequence, event) match {
          case Right(Some(after)) => (Some(after), out :+ AuctionFacts.fact(sequence, event, after))
          case other => fail(s"expected a row, got $other")
        }
      }
      ._2

  private def message(fact: Option[Fact]): bus.AuctionEvent =
    bus.AuctionEvent.parseFrom(fact.getOrElse(fail("expected a published fact")).payload)

  "auction facts" should {

    "publish every event of the auction on the subject named after the oneof branch the body carries" in {
      val published = facts(journal)
      published.map(_.map(_.subject)) shouldBe List(
        "auction_drafted",
        "lot_added",
        "lot_added",
        "auction_scheduled",
        "prebidding_started",
        "prebidding_deadline_reached",
        "prebidding_ended",
        "final_lineup_frozen",
        "final_started",
        "final_lot_activated"
      ).map(name => Some(LotFacts.SubjectPrefix + name))
      published.foreach { fact =>
        val body = message(fact)
        val branch = bus.AuctionEvent.scalaDescriptor.fields.find(_.number == body.occasion.number).map(_.name)
        fact.map(_.subject) shouldBe branch.map(LotFacts.SubjectPrefix + _)
      }
    }

    "carry the envelope of the journal row: event_id, auction, version and the time of the decision" in {
      val (sequence, row) = journal(6)
      val body = message(facts(journal.take(7)).last)
      body.eventId shouldBe row.eventId.toString
      body.auctionId shouldBe auctionId.toString
      body.version shouldBe sequence
      body.occurredAt shouldBe decidedAt.toString
      body.getState.meetupId shouldBe meetup.value.toString
    }

    "name no finalist before the lineup is frozen and the order and the active lot after it" in {
      val published = facts(journal).map(message)
      published(5).getState.status.isSettling shouldBe true
      published(6).getState.status.isOnBreak shouldBe true
      published(7).getState.getLineupFrozen.order shouldBe List(other, lot).map(_.value.toString)
      published(8).getState.getInFinal.activeLotId shouldBe None
      published(9).getState.getInFinal.activeLotId shouldBe Some(other.value.toString)
      published(9).getState.lotIds shouldBe List(lot, other).map(_.value).sorted.map(_.toString)
      published(9).getState.config shouldBe defined
    }

    "finish an auction without finalists with the end of prebidding itself" in {
      val withoutFinal = journal.take(6) :+ (7L -> stored(AuctionEvent.PrebiddingEnded(finished = true), 7))
      val ended = facts(withoutFinal).last
      ended.map(_.subject) shouldBe Some(LotFacts.SubjectPrefix + "prebidding_ended")
      message(ended).getState.status.isFinished shouldBe true
    }

    "keep the discard of an auction off the bus: the contract has no branch for it" in {
      AuctionFacts.occasion(AuctionEvent.AuctionDiscarded) shouldBe None
      val discarded = journal.take(4) :+ (5L -> stored(AuctionEvent.AuctionDiscarded, 5))
      facts(discarded).last shouldBe None
    }
  }
}
