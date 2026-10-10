package auction.persistence

import auction.lot.AuctionId
import auction.lot.ParticipantId
import auction.naming.DisplayNameCommands
import auction.raffle.RaffleTickets
import org.apache.pekko.actor.typed.ActorSystem
import org.apache.pekko.persistence.jdbc.db.SlickExtension
import slick.jdbc.JdbcBackend.Database
import slick.jdbc.PostgresProfile.api.*

import java.sql.Timestamp
import java.time.Instant
import scala.concurrent.ExecutionContext
import scala.concurrent.Future

/**
 * Снимок имён билетов розыгрыша в таблице `raffle_ticket` через пул плагина журнала — по той же причине, что каталог
 * лота. Имя берётся тем же рендером, что у хронологии ставок (`DisplayNameCommands.names`), включая звёздочку
 * псевдонима, и только чтением: регистрация имя не замораживает.
 */
final class SlickRaffleTickets(database: Database, displayNames: DisplayNameCommands)(using ExecutionContext)
    extends RaffleTickets {

  def record(auction: AuctionId, tickets: Vector[ParticipantId]): Future[Unit] =
    if (tickets.isEmpty) Future.unit
    else
      displayNames.names(auction, tickets.toSet).flatMap { names =>
        val rows = tickets.zipWithIndex.map { (participant, index) =>
          val name = names.get(participant).map(_.text)
          sqlu"""INSERT INTO raffle_ticket (auction_id, number, display_name)
                 VALUES (${auction.value.toString}::uuid, ${index + 1}, $name)
                 ON CONFLICT (auction_id, number) DO NOTHING"""
        }
        database.run(DBIO.sequence(rows).transactionally).map(_ => ())
      }

  def names(auction: AuctionId): Future[Map[Int, String]] =
    database
      .run(
        sql"""SELECT number, display_name FROM raffle_ticket
              WHERE auction_id = ${auction.value.toString}::uuid AND display_name IS NOT NULL"""
          .as[(Int, String)]
      )
      .map(_.toMap)

  def expireAt(auction: AuctionId, at: Instant): Future[Unit] =
    database
      .run(
        sqlu"""UPDATE raffle_ticket SET erase_after = ${Timestamp.from(at)}
               WHERE auction_id = ${auction.value.toString}::uuid AND erase_after IS NULL"""
      )
      .map(_ => ())

  /** Стирает имена, чей срок хранения истёк к `now`; номера остаются. Отдаёт число стёртых. */
  def eraseExpired(now: Instant): Future[Int] =
    database.run(
      sqlu"""UPDATE raffle_ticket SET display_name = NULL
             WHERE display_name IS NOT NULL AND erase_after <= ${Timestamp.from(now)}"""
    )
}

object SlickRaffleTickets {

  def apply(system: ActorSystem[?], displayNames: DisplayNameCommands): SlickRaffleTickets = {
    val database = SlickExtension(system).database(system.settings.config.getConfig("jdbc-journal")).database
    new SlickRaffleTickets(database, displayNames)(using system.executionContext)
  }
}
