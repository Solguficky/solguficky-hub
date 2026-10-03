package auction.grpc

import auction.catalog.LotCard
import auction.catalog.LotId
import auction.catalog.LotTitle
import auction.lot.*
import auction.lot.LotFixtures.*
import auction.projection.LotSnapshotView
import auction.v1.auction as model
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

import java.util.UUID

final class SnapshotMappingSpec extends AnyWordSpec with Matchers {

  private val lotId = new UUID(7L, 1L)

  private def view(lot: Lot, card: Option[LotCard] = None): LotSnapshotView =
    LotSnapshotView(lotId, auctionId(1).value, 4, lot, card)

  private def rub(minorUnits: Long): model.Money = model.Money(minorUnits, "RUB")

  "snapshot mapping" should {

    "shows the viewer its own proxy limit and nobody else's" in {
      val lot = trading(price = 100, limits = Map(participant(1) -> limit(300, 4), participant(2) -> limit(500, 5)))
      SnapshotMapping.snapshot(view(lot), participant(1)).viewerProxyLimit shouldBe Some(rub(300))
      SnapshotMapping.snapshot(view(lot), participant(3)).viewerProxyLimit shouldBe None
    }

    "answers the next price by the step rule while the lot is trading" in {
      SnapshotMapping.snapshot(view(trading(price = 100, ask = Some(150))), participant(1)).nextPrice shouldBe
        Some(rub(150))
      SnapshotMapping.snapshot(view(trading(price = 100)), participant(1)).nextPrice shouldBe Some(rub(110))
    }

    "leaves the next price unset outside trading" in {
      SnapshotMapping.snapshot(view(held(price = 100, leader = participant(1))), participant(1)).nextPrice shouldBe None
      SnapshotMapping.snapshot(view(scheduled()), participant(1)).nextPrice shouldBe None
    }

    "carries the trading state, the version and the auction of the lot" in {
      val snapshot = SnapshotMapping.snapshot(view(trading(price = 120, leader = Some(participant(2)))), participant(1))
      snapshot.version shouldBe 4
      snapshot.auctionId shouldBe auctionId(1).value.toString
      snapshot.getTrading shouldBe model.LotTrading(
        currentPrice = Some(rub(120)),
        leaderId = Some(participant(2).value.toString),
        leadingBidId = Some(bid(0).value.toString),
        deadline = Some("2026-10-07T18:00:00Z"),
        phase = model.LotPhase.LOT_PHASE_ONLINE
      )
    }

    "lists tiered steps from the zero bound and keeps the config of a scheduled lot" in {
      val snapshot = SnapshotMapping.snapshot(
        view(lotIn(LotState.Scheduled(schedule(policy = tiered((0, 10), (1000, 50)))))),
        participant(1)
      )
      snapshot.getScheduled.startingPrice shouldBe Some(rub(100))
      snapshot.getConfig.getStepPolicy.getTiered.tiers shouldBe Seq(
        model.StepTier(Some(rub(0)), Some(rub(10))),
        model.StepTier(Some(rub(1000)), Some(rub(50)))
      )
      snapshot.getConfig.getAntiSnipe shouldBe model.AntiSnipe(120, 120, 3)
    }

    "leaves the config unset on a draft" in {
      val snapshot = SnapshotMapping.snapshot(view(drafted), participant(1))
      snapshot.status.isDraft shouldBe true
      snapshot.config shouldBe None
    }

    "attaches the catalog card when the lot has one" in {
      val card = LotCard(LotId(lotId), LotTitle("Лот").toOption.get, "описание")
      SnapshotMapping.snapshot(view(drafted, Some(card)), participant(1)).card.map(_.title) shouldBe Some("Лот")
      SnapshotMapping.snapshot(view(drafted), participant(1)).card shouldBe None
    }
  }
}
