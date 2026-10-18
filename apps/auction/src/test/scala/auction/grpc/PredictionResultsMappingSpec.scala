package auction.grpc

import auction.catalog.LotId
import auction.lot.ParticipantId
import auction.prediction.Nomination
import auction.results.NominationOutcome
import auction.results.NominationValue
import auction.results.ResultRow
import auction.results.ResultsView
import auction.v1.auction as model
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

import java.util.UUID

/**
 * Чтение итогов в типах контракта (ADR-067, пп. 8–9): победители и значения, только свой результат и отменённый аукцион
 * без итогов. Форму снимка держит [[auction.publication.ResultsFactsSpec]] на стороне факта.
 */
final class PredictionResultsMappingSpec extends AnyWordSpec with Matchers {

  private def uuid(n: Int): UUID = new UUID(0x0190f2a000007000L, 0x8000000000000000L | n.toLong)

  private def person(n: Int): ParticipantId = ParticipantId(uuid(100 + n))

  private val lotA = LotId(uuid(11))

  "the prediction results read" should {

    "carry the counted values and the winners, and only the viewer's own result" in {
      val outcomes = List(NominationOutcome(Nomination.MostExpensiveLot, Some(NominationValue.Lots(Set(lotA))), 1))
      val rows = List(
        ResultRow(person(1), Nomination.MostExpensiveLot, guessed = true, None, "@one"),
        ResultRow(person(2), Nomination.MostExpensiveLot, guessed = false, None, "@two")
      )
      val response = PredictionResultsMapping.read(ResultsView.Counted(outcomes, rows), person(1))
      response.outcome.isCounted shouldBe true
      val read = response.outcome.counted.getOrElse(fail("expected counted"))
      read.nominations.map(_.winners) shouldBe List(1)
      read.mine.map(_.nomination) shouldBe List(model.PredictionNomination.PREDICTION_NOMINATION_MOST_EXPENSIVE_LOT)
      read.mine.head.result.isGuessed shouldBe true
    }

    "answer cancelled for a cancelled auction, which carries no results" in {
      PredictionResultsMapping.read(ResultsView.Cancelled, person(1)).outcome.isCancelled shouldBe true
    }

    "answer by_hand for a by-hand marker and after_final for an unsettled one" in {
      PredictionResultsMapping.read(ResultsView.ByHand, person(1)).outcome.isByHand shouldBe true
      PredictionResultsMapping.read(ResultsView.Unsettled, person(1)).outcome.isAfterFinal shouldBe true
    }
  }
}
