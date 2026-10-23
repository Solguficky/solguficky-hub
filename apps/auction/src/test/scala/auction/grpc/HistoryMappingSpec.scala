package auction.grpc

import auction.projection.BidRecord
import auction.projection.HistoryRecord
import auction.v1.auction.BidSource as BidSourceMessage
import auction.v1.auction_service.LotHistoryEntry
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

import java.time.Instant
import java.util.UUID

final class HistoryMappingSpec extends AnyWordSpec with Matchers {

  private val bid = BidRecord(
    lotId = UUID.fromString("01890a5d-ac97-7c2b-9f3a-0d1b2c3d4e5f"),
    sequence = 7,
    bidId = UUID.fromString("01890a5d-ac98-7aaa-8bbb-cccccccccccc"),
    participant = UUID.fromString("01890a5d-ac96-774b-bcce-b302099a8057"),
    minorUnits = 12500,
    currency = "RUB",
    origin = "Manual",
    source = Some("Bot"),
    occurredAt = Instant.parse("2026-10-04T12:00:00.123Z")
  )

  "history mapping" should {

    "carries the journal position, the instant and the bid as the projection recorded them" in {
      val entry = HistoryMapping.entry(HistoryRecord.Bid(bid))
      entry.sequence shouldBe 7
      entry.occurredAt shouldBe "2026-10-04T12:00:00.123Z"
      entry.getBid.bidId shouldBe bid.bidId.toString
      entry.getBid.participantId shouldBe bid.participant.toString
      entry.getBid.getManual.source shouldBe BidSourceMessage.BID_SOURCE_BOT
    }

    "answers a proxy bid without a channel" in {
      HistoryMapping.entry(HistoryRecord.Bid(bid.copy(origin = "Proxy", source = None))).getBid.origin shouldBe a[
        auction.v1.auction_service.HistoryBid.Origin.Proxy
      ]
    }

    "fails on a row the projection does not write instead of answering a bid without a channel" in {
      an[IllegalStateException] should be thrownBy HistoryMapping.entry(HistoryRecord.Bid(bid.copy(source = None)))
      an[IllegalStateException] should be thrownBy HistoryMapping.entry(HistoryRecord.Bid(bid.copy(origin = "Proxy")))
      an[IllegalStateException] should be thrownBy HistoryMapping.entry(
        HistoryRecord.Bid(bid.copy(source = Some("Phone")))
      )
    }

    "marks a bid of a participant removed from the lot and leaves the others unmarked" in {
      HistoryMapping.entry(HistoryRecord.Bid(bid.copy(removed = true))).getBid.removed shouldBe true
      HistoryMapping.entry(HistoryRecord.Bid(bid)).getBid.removed shouldBe false
    }

    "carries a removal as the price and the leader the lot went on with, and no leader when none was left" in {
      val leader = UUID.fromString("01890a5d-ac96-774b-bcce-b302099a8058")
      val at = Instant.parse("2026-10-04T12:00:00Z")
      val removal = HistoryMapping.entry(HistoryRecord.Removal(9, 21000, "RUB", Some(leader), at))
      val emptied = HistoryMapping.entry(HistoryRecord.Removal(9, 10000, "RUB", None, at))

      (removal.sequence, removal.occurredAt) shouldBe (9L, "2026-10-04T12:00:00Z")
      (removal.getRemoval.getPrice.minorUnits, removal.getRemoval.leaderId) shouldBe (21000L, Some(leader.toString))
      emptied.getRemoval.leaderId shouldBe None
    }

    "carries no field beyond the bid and the removal: the proxy limit and who was removed have nowhere to go" in {
      LotHistoryEntry.scalaDescriptor.fields.map(_.name) shouldBe Seq("sequence", "occurred_at", "bid", "removal")
      auction.v1.auction_service.HistoryBid.scalaDescriptor.fields.map(_.name) shouldBe
        Seq("bid_id", "participant_id", "amount", "manual", "proxy", "removed")
      auction.v1.auction_service.HistoryRemoval.scalaDescriptor.fields.map(_.name) shouldBe Seq("price", "leader_id")
    }
  }
}
