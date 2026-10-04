package auction.entity

import auction.aggregate.*
import auction.catalog.LotId
import auction.entity.JournalFixtures.*
import auction.lot.LotFixtures.*
import org.apache.pekko.actor.testkit.typed.scaladsl.ActorTestKit
import org.scalatest.BeforeAndAfterAll
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

import scala.util.Using

final class AuctionJournalSpec extends AnyWordSpec with Matchers with BeforeAndAfterAll {

  private val kit = ActorTestKit("auction-journal", localConfig)

  override protected def afterAll(): Unit = kit.shutdownTestKit()

  private val meetup = MeetupId(uuid(10))
  private val lot = LotId(uuid(11))

  private def golden(name: String): Array[Byte] =
    Using.resource(getClass.getResourceAsStream(s"/journal/$name.json"))(_.readAllBytes())

  private def stored(event: AuctionEvent, opN: Int): StoredAuctionEvent =
    AuctionJournal.store(uuid(1), uuid(2), op(opN), decidedAt, Initiator.Operator(participant(1)))(event)

  /** Эталон пишется так, как его пишет сервис, и сервис читает эталон в то же значение. */
  private def keepsGolden(name: String, value: AnyRef) = {
    val row = write(kit.system, value)
    row.json shouldBe mapper.readTree(golden(name))
    read(kit.system, row.copy(bytes = golden(name))) shouldBe value
  }

  private val drafted = AuctionEnvelope(1, op(1), AuctionEvent.AuctionDrafted(meetup))
  private val added = AuctionEnvelope(2, op(2), AuctionEvent.LotAdded(lot))

  "auction journal" should {

    "keeps the stored form of every auction event equal to its golden file and reads the golden file back" in {
      keepsGolden("auction-drafted", stored(drafted.event, 1))
      keepsGolden("lot-added", stored(added.event, 2))
      keepsGolden("lot-removed", stored(AuctionEvent.LotRemoved(lot), 3))
    }

    "keeps the stored form of an auction snapshot with its registry and window equal to its golden file" in {
      val auction = Auction.replay(Auction.initial, List(drafted, added))
      keepsGolden("auction-snapshot", AuctionJournal.storeAuction(auction, sequence = 2))
      AuctionJournal.restoreAuction(AuctionJournal.storeAuction(auction, sequence = 2)) shouldBe auction
    }

    "restores every event it stored into the same domain event" in {
      List(drafted.event, added.event, AuctionEvent.LotRemoved(lot)).foreach { event =>
        AuctionJournal.envelope(4, stored(event, 4)) shouldBe AuctionEnvelope(4, op(4), event)
      }
    }

    "refuses a snapshot whose meetup breaks the invariant of the auction instead of failing on a later command" in {
      val born = AuctionJournal.storeAuction(Auction.replay(Auction.initial, List(drafted)), sequence = 1)
      a[JournalCorrupted] should be thrownBy AuctionJournal.restoreAuction(born.copy(meetupId = None))
      a[JournalCorrupted] should be thrownBy AuctionJournal.restoreAuction(born.copy(state = "Initial"))
      a[JournalCorrupted] should be thrownBy AuctionJournal.restoreAuction(born.copy(state = "Unknown"))
    }

    "refuses an event whose kind does not match its sections" in {
      val body = stored(added.event, 2).event
      a[JournalCorrupted] should be thrownBy AuctionJournal.restoreEvent(body.copy(kind = "LotRemoved"))
      a[JournalCorrupted] should be thrownBy
        AuctionJournal.restoreEvent(body.copy(auctionDrafted = Some(StoredAuctionDrafted(meetup.value))))
    }
  }
}
