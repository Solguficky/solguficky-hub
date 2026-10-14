package auction.contract

import auction.prediction.Nomination
import auction.results.NominationOutcome
import auction.results.NominationValue
import auction.results.ResultRow
import auction.v1.auction as model
import auction.v1.auction_events as bus
import auction.v1.auction_service as wire

/**
 * Значения прогнозов и итогов в типах `auction.proto` — как [[LotValues]] у лота. Номинация — одно значение на оба
 * направления: её несут и запросы игры, и чтение итогов, и факт шины.
 */
object PredictionValues {

  private val nominations: List[(Nomination, model.PredictionNomination)] = List(
    Nomination.MostExpensiveLot -> model.PredictionNomination.PREDICTION_NOMINATION_MOST_EXPENSIVE_LOT,
    Nomination.TotalSales -> model.PredictionNomination.PREDICTION_NOMINATION_TOTAL_SALES,
    Nomination.MostBidsLot -> model.PredictionNomination.PREDICTION_NOMINATION_MOST_BIDS_LOT,
    Nomination.BiggestGrowthLot -> model.PredictionNomination.PREDICTION_NOMINATION_BIGGEST_GROWTH_LOT,
    Nomination.MostBiddersLot -> model.PredictionNomination.PREDICTION_NOMINATION_MOST_BIDDERS_LOT,
    Nomination.TotalBids -> model.PredictionNomination.PREDICTION_NOMINATION_TOTAL_BIDS,
    Nomination.FinalMostExpensiveLot -> model.PredictionNomination.PREDICTION_NOMINATION_FINAL_MOST_EXPENSIVE_LOT,
    Nomination.FinalTotalSales -> model.PredictionNomination.PREDICTION_NOMINATION_FINAL_TOTAL_SALES,
    Nomination.FinalBiggestGrowthLot -> model.PredictionNomination.PREDICTION_NOMINATION_FINAL_BIGGEST_GROWTH_LOT,
    Nomination.FinalTotalBids -> model.PredictionNomination.PREDICTION_NOMINATION_FINAL_TOTAL_BIDS
  )

  def nomination(value: Nomination): model.PredictionNomination = nominations.toMap.apply(value)

  def restore(value: model.PredictionNomination): Option[Nomination] =
    nominations.collectFirst { case (nomination, `value`) => nomination }

  /**
   * Итог одной номинации на шине: значение и число угадавших из журнала, имена угадавших — из строк итогов. Число
   * угадавших остаётся после стирания имени: стирается только строка имени, а не итог.
   */
  def nominationOutcome(outcome: NominationOutcome, rows: List[ResultRow]): bus.NominationOutcome =
    bus.NominationOutcome(
      nomination = nomination(outcome.nomination),
      value = outcome.value match {
        case Some(NominationValue.Lots(lots)) =>
          bus.NominationOutcome.Value.Lots(bus.NominationLots(lots.toList.map(_.value.toString).sorted))
        case Some(NominationValue.Number(number)) => bus.NominationOutcome.Value.Number(number)
        case None => bus.NominationOutcome.Value.Empty
      },
      winners = outcome.winners,
      winnerNames = rows
        .filter(row => row.guessed && row.nomination == outcome.nomination)
        .sortBy(_.participant.value.toString)
        .map(row => bus.WinnerName(row.participant.value.toString, row.name))
    )

  /** Результат каждого участника на шине: номинация и «угадал или нет» по каждой его строке итога. */
  def participants(rows: List[ResultRow]): List[bus.ParticipantResult] =
    rows
      .groupBy(_.participant)
      .toList
      .sortBy(_._1.value.toString)
      .map { (participant, own) =>
        bus.ParticipantResult(
          participantId = participant.value.toString,
          participation = own.sortBy(_.nomination.ordinal).map { row =>
            bus.Participation(nomination(row.nomination), result(row))
          }
        )
      }

  /** Свой результат смотрящего в чтении итогов: та же форма, что у результата участника в факте. */
  def ownResult(row: ResultRow): wire.OwnNominationResult =
    wire.OwnNominationResult(
      nomination(row.nomination),
      if (row.guessed) wire.OwnNominationResult.Result.Guessed(bus.Guessed())
      else wire.OwnNominationResult.Result.Missed(bus.Missed(row.deviation))
    )

  private def result(row: ResultRow): bus.Participation.Result =
    if (row.guessed) bus.Participation.Result.Guessed(bus.Guessed())
    else bus.Participation.Result.Missed(bus.Missed(row.deviation))
}
