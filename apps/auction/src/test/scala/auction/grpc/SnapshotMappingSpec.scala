package auction.grpc

import auction.catalog.ImageVersion
import auction.catalog.LotCard
import auction.catalog.LotId
import auction.catalog.LotTitle
import auction.lot.*
import auction.lot.LotFixtures.*
import auction.projection.LotSnapshotView
import auction.v1.auction as model
import auction.v1.auction_service as wire
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

import java.util.UUID

final class SnapshotMappingSpec extends AnyWordSpec with Matchers {

  private val lotId = new UUID(7L, 1L)

  private def view(lot: Lot, card: Option[LotCard] = None): LotSnapshotView =
    LotSnapshotView(lotId, auctionId(1).value, 4, lot, card)

  private def rub(minorUnits: Long): model.Money = model.Money(minorUnits, "RUB")

  /** Окно `[12:00, 14:00)` с шагом 1 и следующее `[15:00, 16:00)` с шагом 2 при обычном `Fixed 10` и цене 100. */
  private val windowed = trading(
    price = 100,
    stepWindows = List(stepWindow("12:00", "14:00", step = 1), stepWindow("15:00", "16:00", step = 2))
  )

  private def lotWindow(from: String, until: String, step: Long): wire.LotStepWindow =
    wire.LotStepWindow(s"2026-10-07T$from:00Z", s"2026-10-07T$until:00Z", Some(rub(step)))

  "snapshot mapping" should {

    "answer the next price, the regular step and the windows at the instant of the answer" in {
      val inside = SnapshotMapping.snapshot(view(windowed), participant(1), at("13:59:59"))
      inside.nextPrice shouldBe Some(rub(101))
      inside.baseStep shouldBe Some(rub(10))
      inside.activeWindow shouldBe Some(lotWindow("12:00", "14:00", 1))
      inside.nextWindow shouldBe Some(lotWindow("15:00", "16:00", 2))

      // Та же версия лота через секунду: окно кончилось, перезапуска для этого не нужно.
      val after = SnapshotMapping.snapshot(view(windowed), participant(1), at("14:00"))
      after.version shouldBe inside.version
      after.nextPrice shouldBe Some(rub(110))
      after.activeWindow shouldBe None
      after.nextWindow shouldBe Some(lotWindow("15:00", "16:00", 2))

      val before = SnapshotMapping.snapshot(view(windowed), participant(1), at("11:59:59"))
      before.nextPrice shouldBe Some(rub(110))
      before.activeWindow shouldBe None
      before.nextWindow shouldBe Some(lotWindow("12:00", "14:00", 1))
    }

    "carry the step in force in the active window, never above the regular step" in {
      val lot = trading(price = 100, policy = fixedTen, stepWindows = List(stepWindow("12:00", "14:00", step = 50)))
      val snapshot = SnapshotMapping.snapshot(view(lot), participant(1), at("13:00"))

      snapshot.activeWindow.flatMap(_.step) shouldBe Some(rub(10))
      snapshot.nextPrice shouldBe Some(rub(110))
    }

    "carry no window in the live final, in a held lot and before trading" in {
      val live =
        trading(price = 100, phase = Phase.Live, closesAt = None, stepWindows = tradingOf(windowed).stepWindows)
      for (lot <- List(live, held(price = 100, leader = participant(1)), scheduled())) {
        val snapshot = SnapshotMapping.snapshot(view(lot), participant(1), at("13:00"))
        snapshot.activeWindow shouldBe None
        snapshot.nextWindow shouldBe None
      }
      SnapshotMapping.snapshot(view(scheduled()), participant(1), at("13:00")).baseStep shouldBe None
    }

    "shows the viewer its own proxy limit and nobody else's" in {
      val lot = trading(price = 100, limits = Map(participant(1) -> limit(300, 4), participant(2) -> limit(500, 5)))
      SnapshotMapping.snapshot(view(lot), participant(1), calm).viewerProxyLimit shouldBe Some(rub(300))
      SnapshotMapping.snapshot(view(lot), participant(3), calm).viewerProxyLimit shouldBe None
    }

    "answers the next price by the step rule while the lot is trading" in {
      SnapshotMapping.snapshot(view(trading(price = 100, ask = Some(150))), participant(1), calm).nextPrice shouldBe
        Some(rub(150))
      SnapshotMapping.snapshot(view(trading(price = 100)), participant(1), calm).nextPrice shouldBe Some(rub(110))
    }

    "leaves the next price unset outside trading" in {
      SnapshotMapping
        .snapshot(view(held(price = 100, leader = participant(1))), participant(1), calm)
        .nextPrice shouldBe None
      SnapshotMapping.snapshot(view(scheduled()), participant(1), calm).nextPrice shouldBe None
    }

    "carries the trading state, the version and the auction of the lot" in {
      val snapshot =
        SnapshotMapping.snapshot(view(trading(price = 120, leader = Some(participant(2)))), participant(1), calm)
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
        participant(1),
        calm
      )
      snapshot.getScheduled.startingPrice shouldBe Some(rub(100))
      snapshot.getConfig.getStepPolicy.getTiered.tiers shouldBe Seq(
        model.StepTier(Some(rub(0)), Some(rub(10))),
        model.StepTier(Some(rub(1000)), Some(rub(50)))
      )
      snapshot.getConfig.getAntiSnipe shouldBe model.AntiSnipe(120, 120, 3)
    }

    "leaves the config unset on a draft" in {
      val snapshot = SnapshotMapping.snapshot(view(drafted), participant(1), calm)
      snapshot.status.isDraft shouldBe true
      snapshot.config shouldBe None
    }

    "attaches the catalog card when the lot has one" in {
      val card = LotCard(LotId(lotId), LotTitle("Лот").toOption.get, "описание", None)
      SnapshotMapping.snapshot(view(drafted, Some(card)), participant(1), calm).card.map(_.title) shouldBe Some("Лот")
      SnapshotMapping.snapshot(view(drafted), participant(1), calm).card shouldBe None
    }

    "names the image of the card by its version and leaves it unset without one" in {
      val bare = LotCard(LotId(lotId), LotTitle("Лот").toOption.get, "", None)
      val pictured = bare.copy(image = Some(ImageVersion("v1")))
      SnapshotMapping.snapshot(view(drafted, Some(pictured)), participant(1), calm).card.flatMap(_.image) shouldBe
        Some(wire.LotImageRef("v1"))
      SnapshotMapping.snapshot(view(drafted, Some(bare)), participant(1), calm).card.flatMap(_.image) shouldBe None
    }
  }
}
