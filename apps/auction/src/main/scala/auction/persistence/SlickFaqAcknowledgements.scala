package auction.persistence

import auction.lot.ParticipantId
import auction.onboarding.FaqAcknowledgements
import org.apache.pekko.actor.typed.ActorSystem
import org.apache.pekko.persistence.jdbc.db.SlickExtension
import slick.jdbc.JdbcBackend.Database
import slick.jdbc.PostgresProfile.api.*

import scala.concurrent.ExecutionContext
import scala.concurrent.Future

/** Отдельная строка, без событий и истории просмотров; пул тот же, что у каталога и журнала. */
final class SlickFaqAcknowledgements(database: Database)(using ExecutionContext) extends FaqAcknowledgements {

  def acknowledged(participant: ParticipantId): Future[Boolean] =
    database.run(
      sql"SELECT EXISTS (SELECT 1 FROM auction_faq_acknowledgement WHERE participant_id = ${participant.value.toString}::uuid)"
        .as[Boolean]
        .head
    )

  def acknowledge(participant: ParticipantId): Future[Unit] =
    database
      .run(
        sqlu"""INSERT INTO auction_faq_acknowledgement (participant_id)
               VALUES (${participant.value.toString}::uuid)
               ON CONFLICT (participant_id) DO NOTHING"""
      )
      .map(_ => ())
}

object SlickFaqAcknowledgements {
  def apply(system: ActorSystem[?]): SlickFaqAcknowledgements = {
    val database = SlickExtension(system).database(system.settings.config.getConfig("jdbc-journal")).database
    new SlickFaqAcknowledgements(database)(using system.executionContext)
  }
}
