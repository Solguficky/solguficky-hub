package auction.prediction

import auction.catalog.LotId
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

import java.util.UUID

/** Ядро прогнозов (ADR-067, пп. 4–6): форма прогноза раунда и ход раундов. */
final class PredictionsSpec extends AnyWordSpec with Matchers {

  private def lot(n: Int) = LotId(new UUID(0x0190f2a000007000L, 0x8000000000000000L | n.toLong))

  private def replay(events: PredictionEvent*): Predictions = events.foldLeft(Predictions.initial)(Predictions.apply)

  "a forecast" should {

    "takes any subset of the round's nominations in any order and lists them in nomination order" in {
      val forecast = Forecast
        .parse(
          PredictionRound.Catalog,
          List(Nomination.TotalBids -> Answer.Number(120), Nomination.MostExpensiveLot -> Answer.Lot(lot(1)))
        )
        .toOption
        .get
      forecast.ordered shouldBe List(
        Nomination.MostExpensiveLot -> Answer.Lot(lot(1)),
        Nomination.TotalBids -> Answer.Number(120)
      )
    }

    "takes an empty list as a cleared prediction" in {
      Forecast.parse(PredictionRound.Final, Nil) shouldBe Right(Forecast.empty(PredictionRound.Final))
    }

    "refuses a nomination of the other round, the wrong kind of answer, a repeat and a negative number" in {
      Forecast.parse(PredictionRound.Final, List(Nomination.TotalSales -> Answer.Number(1))) shouldBe
        Left(ForecastInvalid.NominationNotInRound(Nomination.TotalSales))
      Forecast.parse(PredictionRound.Catalog, List(Nomination.TotalSales -> Answer.Lot(lot(1)))) shouldBe
        Left(ForecastInvalid.AnswerKindMismatch(Nomination.TotalSales))
      Forecast.parse(
        PredictionRound.Catalog,
        List(Nomination.MostBidsLot -> Answer.Lot(lot(1)), Nomination.MostBidsLot -> Answer.Lot(lot(2)))
      ) shouldBe Left(ForecastInvalid.DuplicateNomination(Nomination.MostBidsLot))
      Forecast.parse(PredictionRound.Final, List(Nomination.FinalTotalBids -> Answer.Number(-1))) shouldBe
        Left(ForecastInvalid.NegativeNumber(Nomination.FinalTotalBids))
    }

    "names the first answer whose lot is not a lot of the round" in {
      val forecast = Forecast
        .parse(
          PredictionRound.Catalog,
          List(Nomination.MostBiddersLot -> Answer.Lot(lot(3)), Nomination.MostBidsLot -> Answer.Lot(lot(2)))
        )
        .toOption
        .get
      forecast.foreignLot(Set(lot(1), lot(2), lot(3))) shouldBe None
      forecast.foreignLot(Set(lot(1))) shouldBe Some(Nomination.MostBidsLot -> lot(2))
    }
  }

  "the game" should {

    "admits a prediction only while its round is open" in {
      Predictions.admits(Predictions.initial, PredictionRound.Catalog) shouldBe Left(SubmitRejected.RoundNotOpen)
      val open = replay(PredictionEvent.RoundOpened(PredictionRound.Catalog))
      Predictions.admits(open, PredictionRound.Catalog) shouldBe Right(())
      Predictions.admits(open, PredictionRound.Final) shouldBe Left(SubmitRejected.RoundNotOpen)
      val closed = Predictions.apply(open, PredictionEvent.RoundClosed(PredictionRound.Catalog))
      Predictions.admits(closed, PredictionRound.Catalog) shouldBe Left(SubmitRejected.RoundClosed)
    }

    "does not reopen a closed round: an opening that comes after the closing changes nothing" in {
      val closed = replay(PredictionEvent.RoundClosed(PredictionRound.Catalog))
      Predictions.open(closed, PredictionRound.Catalog) shouldBe None
      Predictions.close(Predictions.initial, PredictionRound.Final) shouldBe
        Some(PredictionEvent.RoundClosed(PredictionRound.Final))
      Predictions.close(closed, PredictionRound.Catalog) shouldBe None
    }

    "closes the open round when cancelled and then refuses everything as cancelled" in {
      val cancelled = replay(PredictionEvent.RoundOpened(PredictionRound.Catalog), PredictionEvent.PredictionsCancelled)
      cancelled.catalog shouldBe RoundStatus.Closed
      Predictions.admits(cancelled, PredictionRound.Catalog) shouldBe Left(SubmitRejected.PredictionsCancelled)
      Predictions.open(cancelled, PredictionRound.Final) shouldBe None
      Predictions.cancel(cancelled) shouldBe None
    }

    "starts from a clean sheet after a discard and writes no discard for a game that never started" in {
      val discarded = replay(
        PredictionEvent.RoundOpened(PredictionRound.Catalog),
        PredictionEvent.PredictionsDiscarded
      )
      discarded shouldBe Predictions.initial
      Predictions.discard(discarded) shouldBe None
      Predictions.open(discarded, PredictionRound.Catalog) shouldBe
        Some(PredictionEvent.RoundOpened(PredictionRound.Catalog))
    }
  }

  "the open round" should {

    "is the catalog while only it accepts predictions, and none before it opens and after it closes" in {
      Predictions.openRound(Predictions.initial) shouldBe None
      Predictions.openRound(replay(PredictionEvent.RoundOpened(PredictionRound.Catalog))) shouldBe
        Some(PredictionRound.Catalog)
      Predictions.openRound(
        replay(
          PredictionEvent.RoundOpened(PredictionRound.Catalog),
          PredictionEvent.RoundClosed(PredictionRound.Catalog)
        )
      ) shouldBe None
    }

    "is the final once it opens, even while the catalog is still open" in {
      Predictions.openRound(
        replay(PredictionEvent.RoundOpened(PredictionRound.Catalog), PredictionEvent.RoundOpened(PredictionRound.Final))
      ) shouldBe Some(PredictionRound.Final)
    }

    "is none in a cancelled game" in {
      Predictions.openRound(
        replay(PredictionEvent.RoundOpened(PredictionRound.Final), PredictionEvent.PredictionsCancelled)
      ) shouldBe None
    }
  }
}
