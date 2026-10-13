package auction.prediction

import auction.catalog.LotId
import auction.lot.OpId
import auction.lot.ParticipantId

/*
 * Ядро прогнозов аукциона (ADR-067): `decide` и `apply` чистыми функциями, без актора, журнала и часов. Код этого
 * пакета не знает торгов — ни лота, ни ставки, ни журнала лота (п. 1), и держит это тест границы
 * `PredictionBoundarySpec`: лоты раунда приносит граница, а пакет хранит их идентификаторы непрозрачно.
 *
 * Журнал прогнозов несёт только ход раундов — открыт, закрыт, игра отменена или удалена. Ни участника, ни его ответов в
 * журнале и snapshot нет: прогнозы живут строками рядом с журналом ([[PredictionStore]]), и стирание по запросу
 * субъекта — удаление строк, которое восстановление по журналу вернуть не может (п. 10).
 */

/** Раунд игры (ADR-067, п. 4): каталог — до открытия торгов, финал — от заморозки состава до старта финала. */
enum PredictionRound {
  case Catalog
  case Final
}

/** Какой ответ ждёт номинация: лот или неотрицательное число. */
enum AnswerKind {
  case Lot
  case Number
}

/** Десять номинаций ADR-067, п. 6: раунд и вид ответа заданы номинацией. */
enum Nomination(val round: PredictionRound, val kind: AnswerKind) {
  case MostExpensiveLot extends Nomination(PredictionRound.Catalog, AnswerKind.Lot)
  case TotalSales extends Nomination(PredictionRound.Catalog, AnswerKind.Number)
  case MostBidsLot extends Nomination(PredictionRound.Catalog, AnswerKind.Lot)
  case BiggestGrowthLot extends Nomination(PredictionRound.Catalog, AnswerKind.Lot)
  case MostBiddersLot extends Nomination(PredictionRound.Catalog, AnswerKind.Lot)
  case TotalBids extends Nomination(PredictionRound.Catalog, AnswerKind.Number)
  case FinalMostExpensiveLot extends Nomination(PredictionRound.Final, AnswerKind.Lot)
  case FinalTotalSales extends Nomination(PredictionRound.Final, AnswerKind.Number)
  case FinalBiggestGrowthLot extends Nomination(PredictionRound.Final, AnswerKind.Lot)
  case FinalTotalBids extends Nomination(PredictionRound.Final, AnswerKind.Number)
}

enum Answer {
  case Lot(lot: LotId)
  case Number(value: Long)

  def kind: AnswerKind =
    this match {
      case Lot(_) => AnswerKind.Lot
      case Number(_) => AnswerKind.Number
    }
}

/** Почему набор ответов не прогноз раунда: эти ошибки видны по самому запросу, без состояния игры. */
enum ForecastInvalid {
  case NominationNotInRound(nomination: Nomination)
  case AnswerKindMismatch(nomination: Nomination)
  case DuplicateNomination(nomination: Nomination)
  case NegativeNumber(nomination: Nomination)
}

/**
 * Прогноз одного раунда (ADR-067, п. 5): любой объём номинаций своего раунда, каждая не больше одного раза, вид ответа
 * — тот, что ждёт номинация. Пустой прогноз — очищенный. Конструктор закрыт: значение даёт только [[Forecast.parse]] и
 * восстановление из строк хранилища.
 */
final case class Forecast private (round: PredictionRound, answers: Map[Nomination, Answer]) {

  /** Ответы в порядке номинаций. */
  def ordered: List[(Nomination, Answer)] = answers.toList.sortBy(_._1.ordinal)

  /** Первый ответ, чей лот не лот раунда, в порядке номинаций (ADR-067, п. 4: «выбор лота»). */
  def foreignLot(lots: Set[LotId]): Option[(Nomination, LotId)] =
    ordered.collectFirst { case (nomination, Answer.Lot(lot)) if !lots.contains(lot) => (nomination, lot) }
}

object Forecast {

  def empty(round: PredictionRound): Forecast = Forecast(round, Map.empty)

  def parse(round: PredictionRound, answers: List[(Nomination, Answer)]): Either[ForecastInvalid, Forecast] =
    answers
      .foldLeft[Either[ForecastInvalid, Map[Nomination, Answer]]](Right(Map.empty)) {
        case (Left(invalid), _) => Left(invalid)
        case (Right(_), (nomination, _)) if nomination.round != round =>
          Left(ForecastInvalid.NominationNotInRound(nomination))
        case (Right(_), (nomination, answer)) if answer.kind != nomination.kind =>
          Left(ForecastInvalid.AnswerKindMismatch(nomination))
        case (Right(_), (nomination, Answer.Number(value))) if value < 0 =>
          Left(ForecastInvalid.NegativeNumber(nomination))
        case (Right(seen), (nomination, _)) if seen.contains(nomination) =>
          Left(ForecastInvalid.DuplicateNomination(nomination))
        case (Right(seen), (nomination, answer)) => Right(seen.updated(nomination, answer))
      }
      .map(Forecast(round, _))
}

/** Где раунд. `Closed` — прогноз зафиксирован; раунд, закрытый раньше открытия, тоже `Closed`. */
enum RoundStatus {
  case NotOpen
  case Open
  case Closed
}

/** События журнала прогнозов: только ход раундов, без людей и ответов. */
enum PredictionEvent {
  case RoundOpened(round: PredictionRound)
  case RoundClosed(round: PredictionRound)
  case PredictionsCancelled
  case PredictionsDiscarded
}

/** Отправка прогноза участником; `forecast` уже проверен по форме, лоты раунда — границей. */
final case class SubmitForecast(participant: ParticipantId, forecast: Forecast, opId: OpId) {
  def round: PredictionRound = forecast.round
}

/** Почему раунд прогноз не принимает. Повтор `op_id` проверяется раньше и получает исходный ответ. */
enum SubmitRejected {
  case RoundNotOpen
  case RoundClosed
  case PredictionsCancelled
  case OpIdTaken
}

/**
 * Игра аукциона: раунды и отмена. Окна `op_id` в журнале нет: команды аукциона идемпотентны по состоянию, а окно
 * отправок участника — строка хранилища рядом с прогнозом, потому что несёт участника.
 */
final case class Predictions(catalog: RoundStatus, final_ : RoundStatus, cancelled: Boolean) {

  def status(round: PredictionRound): RoundStatus =
    round match {
      case PredictionRound.Catalog => catalog
      case PredictionRound.Final => final_
    }

  private def withStatus(round: PredictionRound, status: RoundStatus): Predictions =
    round match {
      case PredictionRound.Catalog => copy(catalog = status)
      case PredictionRound.Final => copy(final_ = status)
    }
}

object Predictions {

  val initial: Predictions = Predictions(RoundStatus.NotOpen, RoundStatus.NotOpen, cancelled = false)

  /**
   * Открытие раунда по факту аукциона: каталог — после планирования, финал — после заморозки состава. Раунд, уже
   * открытый или закрытый, повторно не открывается: открытие, опоздавшее за закрытием, ничего не меняет. Отменённая
   * игра раундов не открывает.
   */
  def open(predictions: Predictions, round: PredictionRound): Option[PredictionEvent] =
    if (predictions.cancelled || predictions.status(round) != RoundStatus.NotOpen) None
    else Some(PredictionEvent.RoundOpened(round))

  /**
   * Закрытие раунда. Неоткрытый раунд закрывается тоже: так открытие, пришедшее позже закрытия, его уже не откроет.
   * Закрытый и отменённый — без события.
   */
  def close(predictions: Predictions, round: PredictionRound): Option[PredictionEvent] =
    if (predictions.cancelled || predictions.status(round) == RoundStatus.Closed) None
    else Some(PredictionEvent.RoundClosed(round))

  /** Отмена вместе с аукционом (п. 4): открытый раунд закрывается, итогов у игры не будет. */
  def cancel(predictions: Predictions): Option[PredictionEvent] =
    if (predictions.cancelled) None else Some(PredictionEvent.PredictionsCancelled)

  /** Удаление вместе с аукционом до торгов (п. 4): аукцион, рождённый заново, начинает с пустого листа. */
  def discard(predictions: Predictions): Option[PredictionEvent] =
    if (predictions == initial) None else Some(PredictionEvent.PredictionsDiscarded)

  /** Принимает ли раунд прогноз сейчас; повтор `op_id` решает хранилище раньше этого правила. */
  def admits(predictions: Predictions, round: PredictionRound): Either[SubmitRejected, Unit] =
    if (predictions.cancelled) Left(SubmitRejected.PredictionsCancelled)
    else
      predictions.status(round) match {
        case RoundStatus.NotOpen => Left(SubmitRejected.RoundNotOpen)
        case RoundStatus.Open => Right(())
        case RoundStatus.Closed => Left(SubmitRejected.RoundClosed)
      }

  def apply(predictions: Predictions, event: PredictionEvent): Predictions =
    event match {
      case PredictionEvent.RoundOpened(round) => predictions.withStatus(round, RoundStatus.Open)
      case PredictionEvent.RoundClosed(round) => predictions.withStatus(round, RoundStatus.Closed)
      case PredictionEvent.PredictionsCancelled =>
        val closed = List(PredictionRound.Catalog, PredictionRound.Final).foldLeft(predictions) { (game, round) =>
          if (game.status(round) == RoundStatus.Open) game.withStatus(round, RoundStatus.Closed) else game
        }
        closed.copy(cancelled = true)
      case PredictionEvent.PredictionsDiscarded => initial
    }
}
