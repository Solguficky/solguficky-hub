package auction.publication

import auction.catalog.LotId
import auction.lot.ParticipantId
import auction.prediction.Nomination
import auction.results.NominationOutcome
import auction.results.NominationValue
import auction.results.ResultRow
import auction.results.Results
import auction.results.ResultsEvent
import auction.results.ResultsJournal
import auction.results.StoredResultsEvent
import auction.v1.auction as model
import auction.v1.auction_events as bus
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

import java.time.Instant
import java.util.UUID

/**
 * Итоги прогнозов на шине: повод, subject и снимок после подсчёта и после ручной отметки — без базы и `ActorSystem`.
 */
final class ResultsFactsSpec extends AnyWordSpec with Matchers {

  private def uuid(n: Int): UUID = new UUID(0x0190f2a000007000L, 0x8000000000000000L | n.toLong)

  private def person(n: Int): ParticipantId = ParticipantId(uuid(100 + n))

  private val auctionId = uuid(20)
  private val at = Instant.parse("2026-10-29T18:00:00Z")
  private val lotA = LotId(uuid(11))

  private val outcomes = List(
    NominationOutcome(Nomination.MostExpensiveLot, Some(NominationValue.Lots(Set(lotA))), 1),
    NominationOutcome(Nomination.TotalSales, Some(NominationValue.Number(30000)), 2)
  )

  private val rows = List(
    ResultRow(person(1), Nomination.MostExpensiveLot, guessed = true, None, "@one"),
    ResultRow(person(1), Nomination.TotalSales, guessed = true, None, "@one"),
    ResultRow(person(2), Nomination.TotalSales, guessed = true, None, "@two"),
    ResultRow(person(3), Nomination.MostExpensiveLot, guessed = false, None, "@three")
  )

  private def stored(event: ResultsEvent, n: Int): StoredResultsEvent = ResultsJournal.store(uuid(n), at)(event)

  private def message(fact: Option[Fact]): bus.PredictionResultsEvent =
    bus.PredictionResultsEvent.parseFrom(fact.getOrElse(fail("expected a published fact")).payload)

  "results facts" should {

    "publish the count on the subject named after its oneof branch" in {
      val event = stored(ResultsEvent.ResultsSettled(outcomes), 1)
      val after = Results.apply(Results.Unsettled, ResultsEvent.ResultsSettled(outcomes))
      val fact = ResultsFacts.fact(auctionId, 1L, event, after, rows)
      fact.map(_.subject) shouldBe Some("events.auction.prediction_results_settled")
      message(fact).occasion.isPredictionResultsSettled shouldBe true
    }

    "carry the envelope of the journal row: event_id, the auction, the position and the time" in {
      val event = stored(ResultsEvent.ResultsSettled(outcomes), 1)
      val after = Results.apply(Results.Unsettled, ResultsEvent.ResultsSettled(outcomes))
      val body = message(ResultsFacts.fact(auctionId, 1L, event, after, rows))
      body.eventId shouldBe uuid(1).toString
      body.predictionResultsId shouldBe auctionId.toString
      body.version shouldBe 1L
      body.occurredAt shouldBe "2026-10-29T18:00:00Z"
    }

    "name the values and the winners of each nomination from the journal and the rows" in {
      val event = stored(ResultsEvent.ResultsSettled(outcomes), 1)
      val after = Results.apply(Results.Unsettled, ResultsEvent.ResultsSettled(outcomes))
      val state = message(ResultsFacts.fact(auctionId, 1L, event, after, rows)).state.getOrElse(fail("expected state"))
      state.auctionId shouldBe auctionId.toString
      state.manual shouldBe false
      state.nominations.map(_.nomination) shouldBe List(
        model.PredictionNomination.PREDICTION_NOMINATION_MOST_EXPENSIVE_LOT,
        model.PredictionNomination.PREDICTION_NOMINATION_TOTAL_SALES
      )
      val expensive = state.nominations.head
      expensive.value shouldBe bus.NominationOutcome.Value.Lots(bus.NominationLots(List(lotA.value.toString)))
      expensive.winners shouldBe 1
      expensive.winnerNames.map(_.name) shouldBe List("@one")
      state.nominations(1).value shouldBe bus.NominationOutcome.Value.Number(30000L)
      state.nominations(1).winnerNames.map(_.name) shouldBe List("@one", "@two")
    }

    "carry every participant who answered, with their own result" in {
      val event = stored(ResultsEvent.ResultsSettled(outcomes), 1)
      val after = Results.apply(Results.Unsettled, ResultsEvent.ResultsSettled(outcomes))
      val state = message(ResultsFacts.fact(auctionId, 1L, event, after, rows)).state.getOrElse(fail("expected state"))
      state.participants.map(_.participantId) shouldBe
        List(person(1).value.toString, person(2).value.toString, person(3).value.toString)
      val third = state.participants.last
      third.participation.map(_.nomination) shouldBe List(
        model.PredictionNomination.PREDICTION_NOMINATION_MOST_EXPENSIVE_LOT
      )
      third.participation.head.result.isMissed shouldBe true
    }

    "publish a by-hand marker with no nominations and no participants, marked manual" in {
      val event = stored(ResultsEvent.ResultsRecordedManually, 2)
      val fact = ResultsFacts.fact(auctionId, 2L, event, Results.ByHand, Nil)
      fact.map(_.subject) shouldBe Some("events.auction.prediction_results_settled")
      val state = message(fact).state.getOrElse(fail("expected state"))
      state.manual shouldBe true
      state.nominations shouldBe empty
      state.participants shouldBe empty
    }

    "publish nothing for a discard, which is not an occasion" in {
      val event = stored(ResultsEvent.ResultsDiscarded, 3)
      ResultsFacts.fact(auctionId, 3L, event, Results.Unsettled, Nil) shouldBe None
    }
  }
}
