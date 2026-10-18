package auction.onboarding

import auction.lot.ParticipantId

import scala.concurrent.Future

/** Одно ознакомление для всех аукционов. Состояние целевое; повтор подтверждения — успех. */
trait FaqAcknowledgements {
  def acknowledged(participant: ParticipantId): Future[Boolean]
  def acknowledge(participant: ParticipantId): Future[Unit]
}
