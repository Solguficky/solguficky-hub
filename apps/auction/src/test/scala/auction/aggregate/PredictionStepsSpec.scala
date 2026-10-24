package auction.aggregate

import auction.aggregate.AuctionFixtures.*
import auction.catalog.LotId
import auction.lot.LotFixtures.op
import auction.prediction.PredictionRound
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

import java.util.UUID

/** Протокол аукциона с прогнозами (ADR-067, п. 4) без актора: какие шаги нужны и когда. */
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

  private val settling = Auction.apply(prebidding, AuctionEnvelope(5, op(5), AuctionEvent.PrebiddingDeadlineReached))

  private val closed = PredictionProgress.empty.copy(catalogClosed = true)

  "prediction steps" should {

    "open the catalog round of a scheduled auction until the predictions confirm it, and nothing before scheduling" in {
      PredictionSteps.due(scheduled, PredictionProgress.empty) shouldBe
        List(PredictionStep.Open(PredictionRound.Catalog))
      PredictionSteps.due(scheduled, PredictionProgress.empty.copy(catalogOpened = true)) shouldBe empty
      PredictionSteps.due(replay(AuctionEvent.AuctionDrafted(meetup)), PredictionProgress.empty) shouldBe empty
    }

    "keep the catalog round open through online trading and open it if no answer came before the start" in {
      PredictionSteps.due(prebidding, PredictionProgress.empty) shouldBe
        List(PredictionStep.Open(PredictionRound.Catalog))
      PredictionSteps.due(prebidding, PredictionProgress.empty.copy(catalogOpened = true)) shouldBe empty
    }

    "close the catalog round at the common deadline until the predictions confirm it" in {
      PredictionSteps.due(settling, PredictionProgress.empty) shouldBe
        List(PredictionStep.Close(PredictionRound.Catalog))
      PredictionSteps.due(settling, closed) shouldBe empty
    }

    "cancel the game of a cancelled auction and not close its round" in {
      val cancelled = Auction.apply(prebidding, AuctionEnvelope(5, op(5), AuctionEvent.AuctionCancelled))
      PredictionSteps.due(cancelled, PredictionProgress.empty) shouldBe List(PredictionStep.Cancel)
      PredictionSteps.due(cancelled, PredictionProgress.empty.copy(cancelled = true)) shouldBe empty
    }
  }
}
