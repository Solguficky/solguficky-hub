package auction.persistence

import auction.lot.AuctionId
import auction.lot.ParticipantId
import auction.projection.FinalBids
import org.apache.pekko.actor.typed.ActorSystem
import org.apache.pekko.persistence.jdbc.db.SlickExtension
import slick.jdbc.JdbcBackend.Database
import slick.jdbc.PostgresProfile.api.*

import java.sql.Timestamp
import java.time.Instant
import java.util.UUID
import scala.concurrent.ExecutionContext
import scala.concurrent.Future

/**
 * Ставки финала аукциона по участникам (PER-653): момент последней ставки каждого, кто ставил в лоте состава после
 * возврата его в торги. Строку `lot_resume` пишет `LotResumed`, `auction_lineup` — заморозка состава, а `lot_bid` —
 * принятая ставка; всё это read model, поэтому ответ согласован в конечном счёте, как и остальные чтения.
 */
final class SlickFinalBids(database: Database)(using ExecutionContext) extends FinalBids {

  def lastBids(auction: AuctionId): Future[Map[ParticipantId, Instant]] =
    database
      .run(
        sql"""SELECT b.participant_id::text, MAX(b.occurred_at)
              FROM lot_bid b
              JOIN lot_resume r ON r.lot_id = b.lot_id
              JOIN auction_lineup l ON l.lot_id = b.lot_id
              WHERE l.auction_id = ${auction.value.toString}::uuid AND b.sequence > r.sequence
              GROUP BY b.participant_id""".as[(String, Timestamp)]
      )
      .map(_.map((id, at) => ParticipantId(UUID.fromString(id)) -> at.toInstant).toMap)
}

object SlickFinalBids {

  def apply(system: ActorSystem[?]): SlickFinalBids = {
    val database = SlickExtension(system).database(system.settings.config.getConfig("jdbc-journal")).database
    new SlickFinalBids(database)(using system.executionContext)
  }
}
