package auction.persistence

import auction.lot.AuctionId
import auction.lot.ParticipantId
import auction.prediction.Nomination
import auction.results.ResultRow
import auction.results.ResultsJournal
import auction.results.ResultsStore
import org.apache.pekko.actor.typed.ActorSystem
import org.apache.pekko.persistence.jdbc.db.SlickExtension
import slick.jdbc.GetResult
import slick.jdbc.JdbcBackend.Database
import slick.jdbc.PostgresProfile.api.*

import java.util.UUID
import scala.concurrent.ExecutionContext
import scala.concurrent.Future

/**
 * Итоги прогнозов в таблице `auction_result` через пул плагина журнала — по той же причине, что каталог лота и
 * прогнозы. Имя номинации в строке — формат хранения, общий с журналом итогов ([[ResultsJournal]]): его переименование
 * делает строки нечитаемыми.
 *
 * Повтор записи не перезаписывает строку: снимок имён сделан при подсчёте, и `ON CONFLICT DO NOTHING` держит первый
 * снимок, если подсчёт повторился после сбоя между записью строк и событием.
 */
final class SlickResultsStore(database: Database)(using ExecutionContext) extends ResultsStore {

  private given GetResult[ResultRow] = GetResult { row =>
    ResultRow(
      ParticipantId(UUID.fromString(row.<<)),
      ResultsJournal.restoreNomination(row.<<),
      row.<<,
      row.<<?,
      row.<<
    )
  }

  def record(auction: AuctionId, rows: List[ResultRow]): Future[Unit] =
    database.run(DBIO.sequence(rows.map(insert(auction, _))).transactionally).map(_ => ())

  def read(auction: AuctionId): Future[List[ResultRow]] =
    database.run(
      sql"""SELECT participant_id::text, nomination, guessed, deviation, name FROM auction_result
            WHERE auction_id = ${auction.value.toString}::uuid
            ORDER BY participant_id, nomination""".as[ResultRow].map(_.toList)
    )

  def erase(participant: ParticipantId): Future[Unit] =
    database
      .run(sqlu"DELETE FROM auction_result WHERE participant_id = ${participant.value.toString}::uuid")
      .map(_ => ())

  def discard(auction: AuctionId): Future[Unit] =
    database
      .run(sqlu"DELETE FROM auction_result WHERE auction_id = ${auction.value.toString}::uuid")
      .map(_ => ())

  private def insert(auction: AuctionId, row: ResultRow): DBIO[Int] =
    sqlu"""INSERT INTO auction_result (auction_id, participant_id, nomination, guessed, deviation, name)
           VALUES (${auction.value.toString}::uuid, ${row.participant.value.toString}::uuid,
                   ${ResultsJournal.nominationName(row.nomination)}, ${row.guessed}, ${row.deviation}, ${row.name})
           ON CONFLICT (auction_id, participant_id, nomination) DO NOTHING"""
}

object SlickResultsStore {

  def apply(system: ActorSystem[?]): SlickResultsStore = {
    val database = SlickExtension(system).database(system.settings.config.getConfig("jdbc-journal")).database
    new SlickResultsStore(database)(using system.executionContext)
  }
}
