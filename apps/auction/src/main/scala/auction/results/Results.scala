package auction.results

import auction.catalog.LotId
import auction.lot.ParticipantId
import auction.prediction.Answer
import auction.prediction.Forecast
import auction.prediction.Nomination
import auction.prediction.PredictionRound

/*
 * Ядро итогов прогнозов аукциона (ADR-067, пп. 6–8): `count`, `settle` и `apply` чистыми функциями, без актора, журнала
 * и часов. Код этого пакета не знает торгов сверх снимка исходов лотов, который приносит граница
 * ([[ResultsOutcomes]]), и держит это тест границы `ResultsBoundarySpec`: лот здесь — идентификатор, а деньги — минорные
 * единицы (`Long`), а не `Money` торгов.
 *
 * Итог считается один раз и дальше не меняется (п. 8): состояние `Counted` или `ByHand` повторный подсчёт не трогает, а
 * имён и участников в журнале нет — они живут строками рядом ([[ResultsStore]]), как прогнозы.
 */

/** Значение номинации: лоты, делившие первое место, или число. */
enum NominationValue {
  case Lots(lots: Set[LotId])
  case Number(value: Long)
}

/**
 * Исход одного лота реестра на момент подсчёта: цена продажи, стартовая цена, принятые ставки, различные участники и
 * рост. Деньги — минорные единицы, `None` — величины нет (лот не продан, не открывался или вне состава). `inLineup` —
 * лот состава финала (`auction_lineup`), `terminal` — конечное состояние (продан, закрыт без продажи или снят): снимок
 * полон, только когда `terminal` у каждого лота реестра (ADR-067, п. 8).
 */
final case class LotOutcome(
    lot: LotId,
    sold: Option[Long],
    startingPrice: Option[Long],
    bids: Long,
    participants: Long,
    priceGrowth: Option[Long],
    finalGrowth: Option[Long],
    finalBids: Option[Long],
    inLineup: Boolean,
    terminal: Boolean
)

/** Результат участника по одной номинации: угадал или нет; у числа — своё отклонение от итога. */
enum Participation {
  case Guessed
  case Missed(deviation: Option[Long])
}

/** Итог одной номинации: значение и число угадавших. Имён здесь нет — они в строках итогов. */
final case class NominationOutcome(nomination: Nomination, value: Option[NominationValue], winners: Int)

/** Результат участника по номинациям, на которые он ответил; неотвеченная номинация сюда не входит. */
final case class ParticipantOutcome(participant: ParticipantId, perNomination: List[(Nomination, Participation)])

/** Итог подсчёта: номинации — в журнал, участники — в строки с именами. */
final case class Settlement(outcomes: List[NominationOutcome], participants: List[ParticipantOutcome])

/**
 * Состояние игры: `Unsettled` — итог не подведён, `Counted` — посчитан (номинации для журнала), `ByHand` — подведён
 * вручную, автоподсчёт пропускается. Отменённый аукцион итогов не получает и сюда не попадает: он не зовёт подсчёт, и
 * `Cancelled` решает граница по состоянию аукциона.
 */
enum Results {
  case Unsettled
  case Counted(outcomes: List[NominationOutcome])
  case ByHand
}

/** События журнала итогов: подсчёт (номинации), ручная отметка и удаление вместе с аукционом. */
enum ResultsEvent {
  case ResultsSettled(outcomes: List[NominationOutcome])
  case ResultsRecordedManually
  case ResultsDiscarded
}

/** Почему подсчёт не состоялся: снимок исходов лотов неполон или пуст (ADR-067, п. 8). Повтор на тике переспроса. */
enum SettleRefused {
  case NotComplete
}

object Results {

  val initial: Results = Results.Unsettled

  /**
   * Десять номинаций ADR-067 (пп. 6–7). Точность ответа «лот» двоична: угадал каждый, кто назвал любой из лотов,
   * деливших первое место. У ответа «число» побеждают все с минимальным `|прогноз − итог|` в любую сторону. Номинация,
   * в области которой нет продаж, не разыгрывается: у неё нет ни значения, ни победителей, — и это же правило для 1.6 и
   * 2.4. Порядок номинаций — порядок объявления [[Nomination]], то есть порядок таблицы ADR.
   */
  def count(lots: List[LotOutcome], forecasts: Map[PredictionRound, Map[ParticipantId, Forecast]]): Settlement = {
    val sold = lots.filter(_.sold.isDefined)
    val lineupSold = lots.filter(outcome => outcome.inLineup && outcome.sold.isDefined)
    val lineup = lots.filter(_.inLineup)

    def value(nomination: Nomination): Option[NominationValue] =
      nomination match {
        case Nomination.MostExpensiveLot => firstPlace(sold)(_.sold)
        case Nomination.TotalSales => total(sold)(_.sold)
        case Nomination.MostBidsLot => firstPlace(sold)(outcome => Some(outcome.bids))
        case Nomination.BiggestGrowthLot => firstPlace(sold)(_.priceGrowth)
        case Nomination.MostBiddersLot => firstPlace(sold)(outcome => Some(outcome.participants))
        // 1.6 и 2.4 — суммы по всем лотам своей области, но разыгрываются только при продаже в ней.
        case Nomination.TotalBids => if (sold.isEmpty) None else Some(NominationValue.Number(lots.map(_.bids).sum))
        case Nomination.FinalMostExpensiveLot => firstPlace(lineupSold)(_.sold)
        case Nomination.FinalTotalSales => total(lineupSold)(_.sold)
        case Nomination.FinalBiggestGrowthLot => firstPlace(lineupSold)(_.finalGrowth)
        case Nomination.FinalTotalBids =>
          if (lineupSold.isEmpty) None
          else Some(NominationValue.Number(lineup.map(_.finalBids.getOrElse(0L)).sum))
      }

    val perNomination = Nomination.values.toList.map { nomination =>
      val answers = forecasts
        .getOrElse(nomination.round, Map.empty)
        .toList
        .flatMap((participant, forecast) => forecast.answers.get(nomination).map(participant -> _))
      (nomination, value(nomination), participation(value(nomination), answers))
    }

    val outcomes = perNomination.collect { case (nomination, Some(total), results) =>
      NominationOutcome(nomination, Some(total), results.count(_._2 == Participation.Guessed))
    }

    val participants = perNomination
      .flatMap { case (nomination, _, results) =>
        results.map((participant, result) => participant -> (nomination -> result))
      }
      .groupBy(_._1)
      .toList
      .sortBy(_._1.value.toString)
      .map { (participant, answered) =>
        ParticipantOutcome(participant, answered.map(_._2).sortBy(_._1.ordinal))
      }

    Settlement(outcomes, participants)
  }

  /** Подсчёт один раз (п. 8): посчитанное или подведённое вручную повтор не меняет и второго события не пишет. */
  def settle(results: Results, outcomes: List[NominationOutcome]): Option[ResultsEvent] =
    results match {
      case Results.Unsettled => Some(ResultsEvent.ResultsSettled(outcomes))
      case Results.Counted(_) | Results.ByHand => None
    }

  /** Ручная отметка подавляет автоподсчёт (п. 8): на посчитанном и уже отмеченном — принято без события. */
  def recordByHand(results: Results): Option[ResultsEvent] =
    results match {
      case Results.Unsettled => Some(ResultsEvent.ResultsRecordedManually)
      case Results.Counted(_) | Results.ByHand => None
    }

  /** Удаление вместе с аукционом до торгов: рождённый заново под тем же идентификатором начинает с пустого листа. */
  def discard(results: Results): Option[ResultsEvent] =
    if (results == Results.Unsettled) None else Some(ResultsEvent.ResultsDiscarded)

  def apply(results: Results, event: ResultsEvent): Results =
    event match {
      case ResultsEvent.ResultsSettled(outcomes) => Results.Counted(outcomes)
      case ResultsEvent.ResultsRecordedManually => Results.ByHand
      case ResultsEvent.ResultsDiscarded => Results.Unsettled
    }

  /** Лоты с наибольшей метрикой; `None` — метрики нет ни у одного лота области, и номинация не разыгрывается. */
  private def firstPlace(from: List[LotOutcome])(metric: LotOutcome => Option[Long]): Option[NominationValue] =
    from.flatMap(outcome => metric(outcome).map(outcome.lot -> _)) match {
      case Nil => None
      case measured =>
        val best = measured.map(_._2).max
        Some(NominationValue.Lots(measured.collect { case (lot, value) if value == best => lot }.toSet))
    }

  /** Сумма метрики по области; `None` — область пуста или метрики нет ни у одного её лота. */
  private def total(from: List[LotOutcome])(metric: LotOutcome => Option[Long]): Option[NominationValue] =
    from.flatMap(metric) match {
      case Nil => None
      case values => Some(NominationValue.Number(values.sum))
    }

  private def participation(
      total: Option[NominationValue],
      answers: List[(ParticipantId, Answer)]
  ): List[(ParticipantId, Participation)] =
    total match {
      // Номинация не разыгрывается: у неё нет итога, и все ответившие не угадали. Отклонения числа нет — итога нет.
      case None => answers.map((participant, _) => participant -> Participation.Missed(None))
      case Some(NominationValue.Lots(winners)) =>
        answers.map {
          case (participant, Answer.Lot(lot)) =>
            participant -> (if (winners.contains(lot)) Participation.Guessed else Participation.Missed(None))
          // Вид ответа задан номинацией (`Forecast.parse`), поэтому сюда ветка не доходит; на всякий случай — не угадал.
          case (participant, Answer.Number(_)) => participant -> Participation.Missed(None)
        }
      case Some(NominationValue.Number(value)) =>
        val best = answers.collect { case (_, Answer.Number(forecast)) => math.abs(forecast - value) }.minOption
        answers.map {
          case (participant, Answer.Number(forecast)) =>
            val deviation = math.abs(forecast - value)
            participant -> (if (best.contains(deviation)) Participation.Guessed
                            else Participation.Missed(Some(deviation)))
          case (participant, Answer.Lot(_)) => participant -> Participation.Missed(None)
        }
    }
}
