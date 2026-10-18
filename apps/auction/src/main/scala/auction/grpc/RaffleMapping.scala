package auction.grpc

import auction.contract.LotValues
import auction.raffle.RaffleStatus
import auction.raffle.RaffleView
import auction.raffle.RegistrationRejected
import auction.v1.auction_service as wire
import io.grpc.Status

/**
 * Розыгрыш в типах контракта (ADR-066, п. 11). Seed попадает в ответ только из `reveal` представления, а его ядро
 * заполняет лишь после жеребьёвки или пустого пула.
 */
object RaffleMapping {

  def raffle(auctionId: java.util.UUID, view: RaffleView): wire.Raffle =
    wire.Raffle(
      auctionId = auctionId.toString,
      status = status(view.status),
      closesAt = LotValues.instant(view.closesAt),
      drawnAt = view.drawnAt.map(LotValues.instant),
      commitment = view.commitment.getOrElse(""),
      beaconRound = view.round.getOrElse(0L),
      registered = view.registered,
      tickets = view.tickets.map(ticket => wire.RaffleTicket(ticket.number, ticket.displayName)),
      myTicket = view.myTicket,
      reveal = view.reveal.map { reveal =>
        wire.RaffleReveal(
          seed = reveal.seed.hex,
          randomness = reveal.draw.fold("")(_.randomness.hex),
          value = reveal.draw.fold("")(_.value),
          winningTicket = reveal.draw.map(_.winningTicket)
        )
      }
    )

  private def status(value: RaffleStatus): wire.RaffleStatus =
    value match {
      case RaffleStatus.Open => wire.RaffleStatus.RAFFLE_STATUS_OPEN
      case RaffleStatus.Closing => wire.RaffleStatus.RAFFLE_STATUS_CLOSING
      case RaffleStatus.AwaitingBeacon => wire.RaffleStatus.RAFFLE_STATUS_AWAITING_BEACON
      case RaffleStatus.Drawn => wire.RaffleStatus.RAFFLE_STATUS_DRAWN
      case RaffleStatus.NoTickets => wire.RaffleStatus.RAFFLE_STATUS_NO_TICKETS
      case RaffleStatus.NotHeld => wire.RaffleStatus.RAFFLE_STATUS_NOT_HELD
      case RaffleStatus.Cancelled => wire.RaffleStatus.RAFFLE_STATUS_CANCELLED
    }

  /** Чужой `op_id` — статус `ALREADY_EXISTS`, как у остальных команд; остальные отказы — значения ответа. */
  def register(outcome: Either[RegistrationRejected, wire.Raffle]): Either[Status, wire.RegisterForRaffleResponse] = {
    def refused(reason: wire.RaffleRegistrationRefusal.Reason) =
      Right(wire.RegisterForRaffleResponse().withRefused(wire.RaffleRegistrationRefusal(reason)))
    outcome match {
      case Right(raffle) => Right(wire.RegisterForRaffleResponse().withAccepted(raffle))
      case Left(RegistrationRejected.RaffleNotFound) =>
        refused(wire.RaffleRegistrationRefusal.Reason.RaffleNotFound(wire.RaffleNotFound()))
      case Left(RegistrationRejected.RegistrationClosed) =>
        refused(wire.RaffleRegistrationRefusal.Reason.RegistrationClosed(wire.RaffleRegistrationClosed()))
      case Left(RegistrationRejected.OpIdTaken) => Left(opIdTaken)
    }
  }

  val displayNameNotChosen: wire.RegisterForRaffleResponse =
    wire
      .RegisterForRaffleResponse()
      .withRefused(
        wire.RaffleRegistrationRefusal(
          wire.RaffleRegistrationRefusal.Reason.DisplayNameNotChosen(wire.DisplayNameNotChosen())
        )
      )

  def cancel(
      outcome: Either[RegistrationRejected, wire.Raffle]
  ): Either[Status, wire.CancelRaffleRegistrationResponse] = {
    def refused(reason: wire.RaffleCancellationRefusal.Reason) =
      Right(wire.CancelRaffleRegistrationResponse().withRefused(wire.RaffleCancellationRefusal(reason)))
    outcome match {
      case Right(raffle) => Right(wire.CancelRaffleRegistrationResponse().withAccepted(raffle))
      case Left(RegistrationRejected.RaffleNotFound) =>
        refused(wire.RaffleCancellationRefusal.Reason.RaffleNotFound(wire.RaffleNotFound()))
      case Left(RegistrationRejected.RegistrationClosed) =>
        refused(wire.RaffleCancellationRefusal.Reason.RegistrationClosed(wire.RaffleRegistrationClosed()))
      case Left(RegistrationRejected.OpIdTaken) => Left(opIdTaken)
    }
  }

  private def opIdTaken: Status = Status.ALREADY_EXISTS.withDescription("op_id belongs to another command")
}
