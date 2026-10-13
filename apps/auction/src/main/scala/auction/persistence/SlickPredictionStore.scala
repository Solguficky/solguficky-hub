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
import slick.jdbc.JdbcBackend.Database
import slick.jdbc.PostgresProfile.api.*

import java.util.UUID
import scala.concurrent.ExecutionContext
import scala.concurrent.Future

/**
 * Прогнозы в таблицах `auction_prediction` и `auction_prediction_op` через пул плагина журнала — по той же причине, что
 * каталог лота. Имена раунда и номинаций в строке — формат хранения: их переименование делает строки нечитаемыми,
 * поэтому они перечислены здесь, а не выводятся из имён доменных типов.
 */
final class SlickPredictionStore(database: Database)(using ExecutionContext) extends PredictionStore {

  def submit(auction: AuctionId, command: SubmitForecast): Future[Either[SubmitRejected.OpIdTaken.type, Forecast]] = {
    val write = operation(auction, command.opId).flatMap {
      case Some(sent) => repeated(auction, command.participant, command.round, sent)
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
          _ <- sqlu"""INSERT INTO auction_prediction_op (auction_id, op_id, participant_id, round)
                      VALUES (${auction.value.toString}::uuid, ${command.opId.value.toString}::uuid,
                              ${command.participant.value.toString}::uuid, ${roundName(command.round)})"""
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
    database.run(
      operation(auction, opId).flatMap {
        case Some(sent) => repeated(auction, participant, round, sent).map(Some(_))
        case None => DBIO.successful(None)
      }.transactionally
    )

  def mine(auction: AuctionId, participant: ParticipantId): Future[Map[PredictionRound, Forecast]] =
    database
      .run(
        sql"""SELECT round, nomination, lot_id::text, number FROM auction_prediction
              WHERE auction_id = ${auction.value.toString}::uuid
                AND participant_id = ${participant.value.toString}::uuid"""
          .as[(String, String, Option[String], Option[Long])]
      )
      .map { rows =>
        rows
          .groupBy(_._1)
          .map((round, answers) => restoreRound(round) -> forecast(restoreRound(round), answers))
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

  private def operation(auction: AuctionId, opId: OpId): DBIO[Option[(String, String)]] =
    sql"""SELECT participant_id::text, round FROM auction_prediction_op
          WHERE auction_id = ${auction.value.toString}::uuid AND op_id = ${opId.value.toString}::uuid"""
      .as[(String, String)]
      .headOption

  /** Своему повтору — текущий прогноз раунда, как у повтора регистрации в розыгрыше; чужому `op_id` — отказ. */
  private def repeated(
      auction: AuctionId,
      participant: ParticipantId,
      round: PredictionRound,
      sent: (String, String)
  ): DBIO[Either[SubmitRejected.OpIdTaken.type, Forecast]] =
    if (UUID.fromString(sent._1) != participant.value || sent._2 != roundName(round))
      DBIO.successful(Left(SubmitRejected.OpIdTaken))
    else
      sql"""SELECT round, nomination, lot_id::text, number FROM auction_prediction
            WHERE auction_id = ${auction.value.toString}::uuid AND round = ${roundName(round)}
              AND participant_id = ${participant.value.toString}::uuid"""
        .as[(String, String, Option[String], Option[Long])]
        .map(rows => Right(forecast(round, rows)))

  private def forecast(round: PredictionRound, rows: Seq[(String, String, Option[String], Option[Long])]): Forecast = {
    val answers = rows.toList.map { (_, nomination, lot, number) =>
      val answer = (lot, number) match {
        case (Some(value), None) => Answer.Lot(LotId(UUID.fromString(value)))
        case (None, Some(value)) => Answer.Number(value)
        case _ => throw new IllegalStateException("prediction row holds neither a lot nor a number")
      }
      restoreNomination(nomination) -> answer
    }
    Forecast
      .parse(round, answers)
      .fold(
        invalid => throw new IllegalStateException(s"prediction rows do not form a forecast: $invalid"),
        forecast => forecast
      )
  }

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
