package auction.projection

import auction.aggregate.*
import auction.aggregate.AuctionFixtures.config
import auction.catalog.LotId
import auction.entity.AuctionJournal
import auction.entity.Initiator
import auction.entity.JournalFixtures.*
import auction.entity.StoredAuctionEvent
import auction.lot.LotFixtures.op
import auction.lot.LotFixtures.participant
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

/** Чистое ядро проекции аукциона и статус строки read model: без базы и без `ActorSystem`. */
final class AuctionViewSpec extends AnyWordSpec with Matchers {

  private val auctionId = uuid(20)
  private val meetup = MeetupId(uuid(10))
  private val lot = LotId(uuid(11))

  private def stored(event: AuctionEvent, opN: Int): StoredAuctionEvent =
    AuctionJournal.store(uuid(1), uuid(2), op(opN), decidedAt, Initiator.Operator(participant(1)))(event)

  private val journal = List(
    AuctionEvent.AuctionDrafted(meetup),
    AuctionEvent.LotAdded(lot),
    AuctionEvent.AuctionScheduled(config()),
    AuctionEvent.PrebiddingStarted
  ).zipWithIndex.map((event, index) => (index + 1).toLong -> stored(event, index + 1))

  private def rowAfter(events: Int): AuctionViewRow =
    AuctionView.fold(None, auctionId, journal.take(events)) match {
      case Right(Some(row)) => row
      case other => fail(s"expected a row, got $other")
    }

  "auction view" should {

    "gives the row the status of every state the auction reaches" in {
      List(1 -> "draft", 2 -> "draft", 3 -> "scheduled", 4 -> "prebidding").foreach { (events, status) =>
        AuctionViewHandler.status(rowAfter(events).stored) shouldBe status
      }
    }

    "lists an auction as active from scheduling on and never as a draft" in {
      val active = AuctionViews.statuses(AuctionListing.Active)
      active should contain allOf (
        AuctionViewHandler.status(rowAfter(3).stored),
        AuctionViewHandler.status(
          rowAfter(4).stored
        )
      )
      active should not contain AuctionViewHandler.status(rowAfter(1).stored)
    }

    "folds scheduling and the start of prebidding into the same auction the entity holds" in {
      val row = rowAfter(4)
      row.version shouldBe 4
      row.lots shouldBe Set(lot.value)
      AuctionJournal.restoreAuction(row.stored).state shouldBe AuctionState.Prebidding(config(), op(4))
    }

    "skips an event it already holds and reports a gap instead of folding past it" in {
      val (sequence, event) = journal(2)
      AuctionView.project(Some(rowAfter(3)), auctionId, sequence, event) shouldBe Right(None)
      AuctionView.project(Some(rowAfter(2)), auctionId, 4, journal(3)._2) shouldBe
        Left(AuctionViewDefect.Gap(auctionId, 2, 4))
    }
  }
}
