package auction.grpc

import auction.contract.PredictionValues
import auction.lot.ParticipantId
import auction.results.ResultsView
import auction.v1.auction_service as wire

/**
 * Итоги прогнозов в типах контракта (ADR-067, пп. 8–9): чтение несёт победителей по именам и результат смотрящего, но
 * не чужие прогнозы. Отменённый аукцион — `cancelled`: у игры нет итогов и не будет (п. 4). Ручная отметка отдаётся
 * отдельным значением `by_hand` без подсчитанных значений: их у неё нет.
 */
object PredictionResultsMapping {

  def read(found: ResultsView, viewer: ParticipantId): wire.GetPredictionResultsResponse =
    found match {
      case ResultsView.Counted(outcomes, rows) =>
        wire
          .GetPredictionResultsResponse()
          .withCounted(
            wire.PredictionResultsRead(
              nominations = outcomes.map(PredictionValues.nominationOutcome(_, rows)),
              mine = rows
                .filter(_.participant == viewer)
                .sortBy(_.nomination.ordinal)
                .map(PredictionValues.ownResult)
            )
          )
      case ResultsView.ByHand => wire.GetPredictionResultsResponse().withByHand(wire.PredictionResultsByHand())
      case ResultsView.Unsettled =>
        wire.GetPredictionResultsResponse().withAfterFinal(wire.PredictionResultsAfterFinal())
      case ResultsView.Cancelled => wire.GetPredictionResultsResponse().withCancelled(wire.PredictionsCancelled())
    }
}
