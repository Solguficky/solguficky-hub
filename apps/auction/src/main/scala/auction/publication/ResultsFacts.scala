package auction.publication

import auction.contract.LotValues
import auction.contract.PredictionValues
import auction.results.ResultRow
import auction.results.Results
import auction.results.ResultsEvent
import auction.results.ResultsJournal
import auction.results.StoredResultsEvent
import auction.v1.auction_events as bus

import java.util.UUID

/**
 * Отображение строки журнала итогов в публичный факт на шине (integration.md, «Auction NATS», PER-490), та же форма,
 * что [[AuctionFacts]] и [[RaffleFacts]]: конверт — `event_id`, аукцион итогов, номер события в журнале итогов и время
 * решения, тело — снимок итогов сразу после события. Публикуется подсчёт и ручная отметка — оба одним поводом
 * `prediction_results_settled` (ручную отметку отличает `manual`); удаление повода не имеет.
 *
 * Номинации и число угадавших журнал несёт сам, а имена угадавших и результаты участников берутся из строк итогов
 * (ADR-067, п. 10): имя в журнал не пишется, и стирание субъекта уносит только его строку.
 */
object ResultsFacts {

  /** `after` — итоги сразу после события `stored`, свёрнутые из их журнала; `rows` — строки участников аукциона. */
  def fact(
      auctionId: UUID,
      sequence: Long,
      stored: StoredResultsEvent,
      after: Results,
      rows: List[ResultRow]
  ): Option[Fact] =
    occasion(ResultsJournal.restoreEvent(stored.event)).map { (name, occasion) =>
      val message = bus.PredictionResultsEvent(
        eventId = stored.eventId.toString,
        predictionResultsId = auctionId.toString,
        version = sequence,
        occurredAt = LotValues.instant(stored.occurredAt),
        state = Some(state(auctionId, after, rows)),
        occasion = occasion
      )
      Fact(stored.eventId, LotFacts.SubjectPrefix + name, message.toByteArray)
    }

  /**
   * Повод события и имя его subject'а, как у [[AuctionFacts.occasion]]: match без ветки по умолчанию, и новое событие
   * итогов не скомпилируется, пока ему не решат повод.
   */
  def occasion(event: ResultsEvent): Option[(String, bus.PredictionResultsEvent.Occasion)] =
    event match {
      case ResultsEvent.ResultsSettled(_) | ResultsEvent.ResultsRecordedManually =>
        Some(
          "prediction_results_settled" ->
            bus.PredictionResultsEvent.Occasion.PredictionResultsSettled(bus.PredictionResultsSettled())
        )
      case ResultsEvent.ResultsDiscarded => None
    }

  /** Публичные итоги аукциона: номинации и число угадавших из журнала, участники и имена — из строк. */
  def state(auctionId: UUID, after: Results, rows: List[ResultRow]): bus.PredictionResultsState = {
    val (outcomes, manual) = after match {
      case Results.Counted(outcomes) => (outcomes, false)
      case Results.ByHand => (Nil, true)
      case Results.Unsettled =>
        throw new IllegalStateException(s"results of auction $auctionId published without being settled")
    }
    bus.PredictionResultsState(
      auctionId = auctionId.toString,
      nominations = outcomes.map(PredictionValues.nominationOutcome(_, rows)),
      participants = PredictionValues.participants(rows),
      manual = manual
    )
  }
}
