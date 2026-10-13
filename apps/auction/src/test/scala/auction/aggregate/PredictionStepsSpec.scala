package auction.aggregate

import auction.aggregate.AuctionFixtures.*
import auction.catalog.LotId
import auction.lot.LotFixtures.op
import auction.prediction.PredictionRound
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

import java.util.UUID

/** Протокол аукциона с прогнозами (ADR-067, п. 4) без актора: какие шаги нужны и что придерживает подтверждение. */
final class PredictionStepsSpec extends AnyWordSpec with Matchers {

  private val lot = LotId(UUID.fromString("0190f2a0-0000-7000-8000-00000000000b"))
  private val meetup = MeetupId(UUID.fromString("0190f2a0-0000-7000-8000-00000000000a"))

  private def replay(events: AuctionEvent*): Auction =
    Auction.replay(
      Auction.initial,
      events.toList.zipWithIndex.map((event, index) => AuctionEnvelope(index + 1L, op(index + 1), event))
    )

  private val scheduled =
    replay(AuctionEvent.AuctionDrafted(meetup), AuctionEvent.LotAdded(lot), AuctionEvent.AuctionScheduled(config()))

  private val prebidding = replay(
    AuctionEvent.AuctionDrafted(meetup),
    AuctionEvent.LotAdded(lot),
    AuctionEvent.AuctionScheduled(config()),
    AuctionEvent.PrebiddingStarted
  )

  private val closed = PredictionProgress.empty.copy(catalogClosed = true)

  "prediction steps" should {

    "open the catalog round of a scheduled auction until the predictions confirm it, and nothing before scheduling" in {
      PredictionSteps.due(scheduled, PredictionProgress.empty) shouldBe
        List(PredictionStep.Open(PredictionRound.Catalog))
      PredictionSteps.due(scheduled, PredictionProgress.empty.copy(catalogOpened = true)) shouldBe empty
      PredictionSteps.due(replay(AuctionEvent.AuctionDrafted(meetup)), PredictionProgress.empty) shouldBe empty
    }

    "close the catalog round of an auction that started trading until the predictions confirm it" in {
      PredictionSteps.due(prebidding, PredictionProgress.empty) shouldBe
        List(PredictionStep.Close(PredictionRound.Catalog))
      PredictionSteps.due(prebidding, closed) shouldBe empty
    }

    "cancel the game of a cancelled auction and not close its round" in {
      val cancelled = Auction.apply(prebidding, AuctionEnvelope(5, op(5), AuctionEvent.AuctionCancelled))
      PredictionSteps.due(cancelled, PredictionProgress.empty) shouldBe List(PredictionStep.Cancel)
      PredictionSteps.due(cancelled, PredictionProgress.empty.copy(cancelled = true)) shouldBe empty
    }

    "hold the opening of lots until the catalog round is confirmed closed" in {
      PredictionSteps.holdsOpening(PredictionProgress.empty) shouldBe true
      PredictionSteps.holdsOpening(closed) shouldBe false
    }

    "hold the common deadline only while trading has not begun" in {
      PredictionSteps.holdsDeadline(prebidding, PredictionProgress.empty, LotRoster.empty) shouldBe true
      PredictionSteps.holdsDeadline(
        prebidding,
        PredictionProgress.empty,
        LotRoster(Map(lot -> LotStanding.Active))
      ) shouldBe
        false
      PredictionSteps.holdsDeadline(prebidding, closed, LotRoster.empty) shouldBe false
    }

    "release the held lots only on the first confirmed closing while the auction still waits for its lots" in {
      val close = PredictionStep.Close(PredictionRound.Catalog)
      PredictionSteps.releases(prebidding, PredictionProgress.empty, close) shouldBe true
      PredictionSteps.releases(prebidding, closed, close) shouldBe false
      PredictionSteps.releases(scheduled, PredictionProgress.empty, close) shouldBe false
      PredictionSteps.releases(
        prebidding,
        PredictionProgress.empty,
        PredictionStep.Open(PredictionRound.Final)
      ) shouldBe
        false
    }
  }
}
