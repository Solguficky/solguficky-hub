package auction.grpc

import auction.catalog.LotId
import auction.lot.AuctionId
import auction.lot.OpId
import auction.prediction.Answer
import auction.prediction.Forecast
import auction.prediction.ForecastInvalid
import auction.prediction.MyPredictions
import auction.prediction.Nomination
import auction.prediction.PredictionRound
import auction.prediction.RoundStatus
import auction.prediction.SubmitRejected
import auction.v1.auction_service as wire
import io.grpc.Status

/** Отправка прогноза, отображённая в домен: аукцион, раунд с ответами по форме, `op_id` и смотрящий. */
final case class PredictionCommand(
    auctionId: AuctionId,
    round: PredictionRound,
    answers: List[(Nomination, Answer)],
    opId: OpId,
    acting: Acting
)

/** Чтение своих прогнозов аукциона смотрящим. */
final case class PredictionQuery(auctionId: AuctionId, acting: Acting)

/**
 * Прогнозы в типах контракта (ADR-067). Форма — то, что видно по самому запросу: раунд, номинация, заданный ответ и
 * канонический лот. Номинация чужого раунда, не тот вид ответа, повтор номинации и отрицательное число — тоже форма
 * (`INVALID_ARGUMENT`): их собирает бот, а не участник. Значениями ответа идут только отказы, зависящие от состояния
 * игры и аукциона.
 */
object PredictionMapping {

  def submit(request: wire.SubmitPredictionRequest): Either[FormError, PredictionCommand] =
    for {
      acting <- RequestMapping.acting(request.viewer)
      auction <- auctionOf(request.auctionId)
      round <- roundOf(request.round)
      answers <- request.answers.foldLeft[Either[FormError, List[(Nomination, Answer)]]](Right(Nil)) { (acc, answer) =>
        acc.flatMap(known => answerOf(answer).map(_ :: known))
      }
      op <- RequestMapping.canonicalUuidV7(request.opId).toRight(FormError("op_id"))
    } yield PredictionCommand(auction, round, answers.reverse, OpId(op), acting)

  def mine(request: wire.GetMyPredictionsRequest): Either[FormError, PredictionQuery] =
    for {
      acting <- RequestMapping.acting(request.viewer)
      auction <- auctionOf(request.auctionId)
    } yield PredictionQuery(auction, acting)

  /** Прогноз раунда по форме; ошибку формы граница отдаёт `INVALID_ARGUMENT` с полем `answers`. */
  def forecast(command: PredictionCommand): Either[FormError, Forecast] =
    Forecast.parse(command.round, command.answers).left.map((_: ForecastInvalid) => FormError("answers"))

  def accepted(forecast: Forecast): wire.SubmitPredictionResponse =
    wire.SubmitPredictionResponse().withAccepted(prediction(forecast))

  /** Чужой `op_id` — статус `ALREADY_EXISTS`, как у остальных команд; остальные отказы — значения ответа. */
  def refused(rejected: SubmitRejected): Either[Status, wire.SubmitPredictionResponse] =
    rejected match {
      case SubmitRejected.RoundNotOpen =>
        Right(refusal(wire.PredictionRefusal.Reason.RoundNotOpen(wire.PredictionRoundNotOpen())))
      case SubmitRejected.RoundClosed =>
        Right(refusal(wire.PredictionRefusal.Reason.RoundClosed(wire.PredictionRoundClosed())))
      case SubmitRejected.PredictionsCancelled =>
        Right(refusal(wire.PredictionRefusal.Reason.PredictionsCancelled(wire.PredictionsCancelled())))
      case SubmitRejected.OpIdTaken => Left(Status.ALREADY_EXISTS.withDescription("op_id belongs to another command"))
    }

  val displayNameNotChosen: wire.SubmitPredictionResponse =
    refusal(wire.PredictionRefusal.Reason.DisplayNameNotChosen(wire.DisplayNameNotChosen()))

  def lotNotInRound(nomination: Nomination, lot: LotId): wire.SubmitPredictionResponse =
    refusal(
      wire.PredictionRefusal.Reason.LotNotInRound(
        wire.PredictionLotNotInRound(nominationOf(nomination), lot.value.toString)
      )
    )

  /** Оба раунда, каталог первым; ответы — только смотрящего. */
  def mine(found: MyPredictions): wire.GetMyPredictionsResponse =
    wire.GetMyPredictionsResponse(
      List(PredictionRound.Catalog, PredictionRound.Final).map { round =>
        val status =
          if (found.game.cancelled) wire.PredictionRoundStatus.PREDICTION_ROUND_STATUS_CANCELLED
          else
            found.game.status(round) match {
              case RoundStatus.NotOpen => wire.PredictionRoundStatus.PREDICTION_ROUND_STATUS_NOT_OPEN
              case RoundStatus.Open => wire.PredictionRoundStatus.PREDICTION_ROUND_STATUS_OPEN
              case RoundStatus.Closed => wire.PredictionRoundStatus.PREDICTION_ROUND_STATUS_CLOSED
            }
        wire.PredictionRoundView(
          roundOf(round),
          status,
          found.forecasts.get(round).fold(Nil)(answers)
        )
      }
    )

  private def prediction(forecast: Forecast): wire.Prediction =
    wire.Prediction(roundOf(forecast.round), answers(forecast))

  private def answers(forecast: Forecast): List[wire.PredictionAnswer] =
    forecast.ordered.map { (nomination, answer) =>
      wire.PredictionAnswer(
        nominationOf(nomination),
        answer match {
          case Answer.Lot(lot) => wire.PredictionAnswer.Answer.LotId(lot.value.toString)
          case Answer.Number(value) => wire.PredictionAnswer.Answer.Number(value)
        }
      )
    }

  private def refusal(reason: wire.PredictionRefusal.Reason): wire.SubmitPredictionResponse =
    wire.SubmitPredictionResponse().withRefused(wire.PredictionRefusal(reason))

  /** Прогнозы есть только у аукциона сходки: раунды открывает журнал аукциона. */
  private def auctionOf(value: String): Either[FormError, AuctionId] =
    RequestMapping.canonicalUuidV5(value).map(AuctionId(_)).toRight(FormError("auction_id"))

  private def answerOf(message: wire.PredictionAnswer): Either[FormError, (Nomination, Answer)] =
    for {
      nomination <- nominationFrom(message.nomination)
      answer <- message.answer match {
        case wire.PredictionAnswer.Answer.LotId(raw) =>
          RequestMapping.canonicalUuidV7(raw).map(lot => Answer.Lot(LotId(lot))).toRight(FormError("answers.lot_id"))
        case wire.PredictionAnswer.Answer.Number(value) => Right(Answer.Number(value))
        case wire.PredictionAnswer.Answer.Empty => Left(FormError("answers.answer"))
      }
    } yield nomination -> answer

  private def roundOf(value: wire.PredictionRound): Either[FormError, PredictionRound] =
    value match {
      case wire.PredictionRound.PREDICTION_ROUND_CATALOG => Right(PredictionRound.Catalog)
      case wire.PredictionRound.PREDICTION_ROUND_FINAL => Right(PredictionRound.Final)
      case _ => Left(FormError("round"))
    }

  private def roundOf(round: PredictionRound): wire.PredictionRound =
    round match {
      case PredictionRound.Catalog => wire.PredictionRound.PREDICTION_ROUND_CATALOG
      case PredictionRound.Final => wire.PredictionRound.PREDICTION_ROUND_FINAL
    }

  private val nominations: List[(Nomination, wire.PredictionNomination)] = List(
    Nomination.MostExpensiveLot -> wire.PredictionNomination.PREDICTION_NOMINATION_MOST_EXPENSIVE_LOT,
    Nomination.TotalSales -> wire.PredictionNomination.PREDICTION_NOMINATION_TOTAL_SALES,
    Nomination.MostBidsLot -> wire.PredictionNomination.PREDICTION_NOMINATION_MOST_BIDS_LOT,
    Nomination.BiggestGrowthLot -> wire.PredictionNomination.PREDICTION_NOMINATION_BIGGEST_GROWTH_LOT,
    Nomination.MostBiddersLot -> wire.PredictionNomination.PREDICTION_NOMINATION_MOST_BIDDERS_LOT,
    Nomination.TotalBids -> wire.PredictionNomination.PREDICTION_NOMINATION_TOTAL_BIDS,
    Nomination.FinalMostExpensiveLot -> wire.PredictionNomination.PREDICTION_NOMINATION_FINAL_MOST_EXPENSIVE_LOT,
    Nomination.FinalTotalSales -> wire.PredictionNomination.PREDICTION_NOMINATION_FINAL_TOTAL_SALES,
    Nomination.FinalBiggestGrowthLot -> wire.PredictionNomination.PREDICTION_NOMINATION_FINAL_BIGGEST_GROWTH_LOT,
    Nomination.FinalTotalBids -> wire.PredictionNomination.PREDICTION_NOMINATION_FINAL_TOTAL_BIDS
  )

  private def nominationOf(nomination: Nomination): wire.PredictionNomination = nominations.toMap.apply(nomination)

  private def nominationFrom(value: wire.PredictionNomination): Either[FormError, Nomination] =
    nominations.collectFirst { case (nomination, `value`) => nomination }.toRight(FormError("answers.nomination"))
}
