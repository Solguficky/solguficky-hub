package auction.grpc

import auction.projection.BidRecord
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
      val entry = HistoryMapping.entry(bid)
      entry.sequence shouldBe 7
      entry.occurredAt shouldBe "2026-10-04T12:00:00.123Z"
      entry.getBid.bidId shouldBe bid.bidId.toString
      entry.getBid.participantId shouldBe bid.participant.toString
      entry.getBid.getManual.source shouldBe BidSourceMessage.BID_SOURCE_BOT
    }

    "answers a proxy bid without a channel" in {
      HistoryMapping.entry(bid.copy(origin = "Proxy", source = None)).getBid.origin shouldBe a[
        auction.v1.auction_service.HistoryBid.Origin.Proxy
      ]
    }

    "fails on a row the projection does not write instead of answering a bid without a channel" in {
      an[IllegalStateException] should be thrownBy HistoryMapping.entry(bid.copy(source = None))
      an[IllegalStateException] should be thrownBy HistoryMapping.entry(bid.copy(origin = "Proxy"))
      an[IllegalStateException] should be thrownBy HistoryMapping.entry(bid.copy(source = Some("Phone")))
    }

    "carries no field beyond the bid: the proxy limit has nowhere to go" in {
      LotHistoryEntry.scalaDescriptor.fields.map(_.name) shouldBe Seq("sequence", "occurred_at", "bid")
      auction.v1.auction_service.HistoryBid.scalaDescriptor.fields.map(_.name) shouldBe
        Seq("bid_id", "participant_id", "amount", "manual", "proxy")
    }
  }
}
