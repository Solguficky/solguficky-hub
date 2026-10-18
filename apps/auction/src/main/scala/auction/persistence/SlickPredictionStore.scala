package auction.persistence

import auction.catalog.LotId
import auction.lot.AuctionId
import auction.lot.OpId
import auction.lot.ParticipantId
import auction.prediction.Answer
import auction.prediction.Forecast
import auction.prediction.Nomination
import auction.prediction.PredictionRound
import auction.prediction.PredictionStore
import auction.prediction.SubmitForecast
import auction.prediction.SubmitRejected
import org.apache.pekko.actor.typed.ActorSystem
import org.apache.pekko.persistence.jdbc.db.SlickExtension
import slick.jdbc.GetResult
import slick.jdbc.JdbcBackend.Database
import slick.jdbc.PostgresProfile.api.*

import java.util.UUID
import scala.concurrent.ExecutionContext
import scala.concurrent.Future

/** Строка ответа на одну номинацию: ровно одно из двух — лот или число. */
private final case class PredictionRow(round: String, nomination: String, lot: Option[String], number: Option[Long])

/** Строка окна отправок: кто отправил, в какой раунд и что — исходный ответ повтору. */
private final case class SentPrediction(participant: UUID, round: String, answers: String)

/** Строка прогноза с участником: прогнозы всех участников для подсчёта итогов. */
private final case class StoredPrediction(
    participant: String,
    round: String,
    nomination: String,
    lot: Option[String],
    number: Option[Long]
)

/**
 * Прогнозы в таблицах `auction_prediction` и `auction_prediction_op` через пул плагина журнала — по той же причине, что
 * каталог лота. Имена раунда и номинаций в строке — формат хранения: их переименование делает строки нечитаемыми,
 * поэтому они перечислены здесь, а не выводятся из имён доменных типов.
 *
 * Окно отправок хранит и сам отправленный прогноз: повтор `op_id` получает исходный ответ, даже если участник с тех пор
 * прогноз поправил. Формат — `<номинация>=lot:<uuid>` или `<номинация>=number:<n>` через запятую, пустая строка —
 * очищенный прогноз.
 */
final class SlickPredictionStore(database: Database)(using ExecutionContext) extends PredictionStore {

  private given GetResult[PredictionRow] = GetResult(row => PredictionRow(row.<<, row.<<, row.<<?, row.<<?))

  private given GetResult[SentPrediction] = GetResult(row => SentPrediction(UUID.fromString(row.<<), row.<<, row.<<))

  private given GetResult[StoredPrediction] =
    GetResult(row => StoredPrediction(row.<<, row.<<, row.<<, row.<<?, row.<<?))

  def submit(auction: AuctionId, command: SubmitForecast): Future[Either[SubmitRejected.OpIdTaken.type, Forecast]] = {
    val write = operation(auction, command.opId).flatMap {
      case Some(sent) => DBIO.successful(repeated(command.participant, command.round, sent))
      case None =>
        val rows = command.forecast.ordered.map { (nomination, answer) =>
          val (lot, number) = answer match {
            case Answer.Lot(value) => (Some(value.value.toString), None)
            case Answer.Number(value) => (None, Some(value))
          }
          sqlu"""INSERT INTO auction_prediction (auction_id, round, participant_id, nomination, lot_id, number)
                 VALUES (${auction.value.toString}::uuid, ${roundName(command.round)},
                         ${command.participant.value.toString}::uuid, ${nominationName(nomination)},
                         $lot::uuid, $number)"""
        }
        for {
          _ <- sqlu"""INSERT INTO auction_prediction_op (auction_id, op_id, participant_id, round, answers)
                      VALUES (${auction.value.toString}::uuid, ${command.opId.value.toString}::uuid,
                              ${command.participant.value.toString}::uuid, ${roundName(command.round)},
                              ${encode(command.forecast)})"""
          _ <- sqlu"""DELETE FROM auction_prediction
                      WHERE auction_id = ${auction.value.toString}::uuid AND round = ${roundName(command.round)}
                        AND participant_id = ${command.participant.value.toString}::uuid"""
          _ <- DBIO.sequence(rows)
        } yield Right(command.forecast)
    }
    database.run(write.transactionally)
  }

  def recall(
      auction: AuctionId,
      participant: ParticipantId,
      round: PredictionRound,
      opId: OpId
  ): Future[Option[Either[SubmitRejected.OpIdTaken.type, Forecast]]] =
    database.run(operation(auction, opId)).map(_.map(repeated(participant, round, _)))

  def mine(auction: AuctionId, participant: ParticipantId): Future[Map[PredictionRound, Forecast]] =
    database
      .run(
        sql"""SELECT round, nomination, lot_id::text, number FROM auction_prediction
              WHERE auction_id = ${auction.value.toString}::uuid
                AND participant_id = ${participant.value.toString}::uuid"""
          .as[PredictionRow]
      )
      .map { rows =>
        rows.groupBy(_.round).map { (name, answers) =>
          val round = restoreRound(name)
          round -> forecast(
            round,
            answers.toList.map(row => restoreNomination(row.nomination) -> answerOf(row.lot, row.number))
          )
        }
      }

  def all(auction: AuctionId): Future[Map[PredictionRound, Map[ParticipantId, Forecast]]] =
    database
      .run(
        sql"""SELECT participant_id::text, round, nomination, lot_id::text, number FROM auction_prediction
              WHERE auction_id = ${auction.value.toString}::uuid"""
          .as[StoredPrediction]
      )
      .map { rows =>
        rows.groupBy(_.round).map { (name, ofRound) =>
          val round = restoreRound(name)
          round -> ofRound.groupBy(_.participant).map { (participant, ofParticipant) =>
            ParticipantId(UUID.fromString(participant)) -> forecast(
              round,
              ofParticipant.toList.map(row => restoreNomination(row.nomination) -> answerOf(row.lot, row.number))
            )
          }
        }
      }

  def discard(auction: AuctionId): Future[Unit] =
    database
      .run(
        DBIO
          .seq(
            sqlu"DELETE FROM auction_prediction WHERE auction_id = ${auction.value.toString}::uuid",
            sqlu"DELETE FROM auction_prediction_op WHERE auction_id = ${auction.value.toString}::uuid"
          )
          .transactionally
      )

  def erase(participant: ParticipantId): Future[Unit] =
    database
      .run(
        DBIO
          .seq(
            sqlu"DELETE FROM auction_prediction WHERE participant_id = ${participant.value.toString}::uuid",
            sqlu"DELETE FROM auction_prediction_op WHERE participant_id = ${participant.value.toString}::uuid"
          )
          .transactionally
      )

  private def operation(auction: AuctionId, opId: OpId): DBIO[Option[SentPrediction]] =
    sql"""SELECT participant_id::text, round, answers FROM auction_prediction_op
          WHERE auction_id = ${auction.value.toString}::uuid AND op_id = ${opId.value.toString}::uuid"""
      .as[SentPrediction]
      .headOption

  /** Своему повтору — исходный прогноз отправки; `op_id` другого участника или раунда — отказ. */
  private def repeated(
      participant: ParticipantId,
      round: PredictionRound,
      sent: SentPrediction
  ): Either[SubmitRejected.OpIdTaken.type, Forecast] =
    if (sent.participant != participant.value || sent.round != roundName(round)) Left(SubmitRejected.OpIdTaken)
    else Right(forecast(round, decode(sent.answers)))

  private def answerOf(lot: Option[String], number: Option[Long]): Answer =
    (lot, number) match {
      case (Some(value), None) => Answer.Lot(LotId(UUID.fromString(value)))
      case (None, Some(value)) => Answer.Number(value)
      case _ => throw new IllegalStateException("prediction row holds neither a lot nor a number")
    }

  private def encode(forecast: Forecast): String =
    forecast.ordered
      .map {
        case (nomination, Answer.Lot(lot)) => s"${nominationName(nomination)}=lot:${lot.value}"
        case (nomination, Answer.Number(value)) => s"${nominationName(nomination)}=number:$value"
      }
      .mkString(",")

  private def decode(text: String): List[(Nomination, Answer)] =
    if (text.isEmpty) Nil
    else
      text.split(',').toList.map { pair =>
        pair.split('=') match {
          case Array(nomination, value) if value.startsWith("lot:") =>
            restoreNomination(nomination) -> Answer.Lot(LotId(UUID.fromString(value.stripPrefix("lot:"))))
          case Array(nomination, value) if value.startsWith("number:") =>
            restoreNomination(nomination) -> Answer.Number(value.stripPrefix("number:").toLong)
          case _ => throw new IllegalStateException("prediction op row holds an unreadable answer")
        }
      }

  private def forecast(round: PredictionRound, answers: List[(Nomination, Answer)]): Forecast =
    Forecast
      .parse(round, answers)
      .fold(
        invalid => throw new IllegalStateException(s"prediction rows do not form a forecast: $invalid"),
        forecast => forecast
      )

  private def roundName(round: PredictionRound): String =
    round match {
      case PredictionRound.Catalog => "catalog"
      case PredictionRound.Final => "final"
    }

  private def restoreRound(name: String): PredictionRound =
    name match {
      case "catalog" => PredictionRound.Catalog
      case "final" => PredictionRound.Final
      case _ => throw new IllegalStateException("prediction round is neither catalog nor final")
    }

  private val nominationNames: Map[Nomination, String] = Map(
    Nomination.MostExpensiveLot -> "most_expensive_lot",
    Nomination.TotalSales -> "total_sales",
    Nomination.MostBidsLot -> "most_bids_lot",
    Nomination.BiggestGrowthLot -> "biggest_growth_lot",
    Nomination.MostBiddersLot -> "most_bidders_lot",
    Nomination.TotalBids -> "total_bids",
    Nomination.FinalMostExpensiveLot -> "final_most_expensive_lot",
    Nomination.FinalTotalSales -> "final_total_sales",
    Nomination.FinalBiggestGrowthLot -> "final_biggest_growth_lot",
    Nomination.FinalTotalBids -> "final_total_bids"
  )

  private val nominationsByName: Map[String, Nomination] = nominationNames.map(_.swap)

  private def nominationName(nomination: Nomination): String = nominationNames(nomination)

  private def restoreNomination(name: String): Nomination =
    nominationsByName.getOrElse(name, throw new IllegalStateException("prediction row names an unknown nomination"))
}

object SlickPredictionStore {

  def apply(system: ActorSystem[?]): SlickPredictionStore = {
    val database = SlickExtension(system).database(system.settings.config.getConfig("jdbc-journal")).database
    new SlickPredictionStore(database)(using system.executionContext)
  }
}
