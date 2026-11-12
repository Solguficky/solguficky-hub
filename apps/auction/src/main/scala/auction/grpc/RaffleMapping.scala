package auction.grpc

import auction.contract.LotValues
import auction.raffle.AssignRejected
import auction.raffle.ChangePrizeRejected
import auction.raffle.RaffleStatus
import auction.raffle.RaffleView
import auction.raffle.RegistrationRejected
import auction.v1.auction_service as wire
import auction.v1.auction_service.ChangeRafflePrizeRefusal.Reason as PrizeReason
import auction.v1.auction_service.RafflePrizePhotoRefusal.Reason as PhotoReason
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
      rafflePrize = view.prize,
      reveal = view.reveal.map { reveal =>
        wire.RaffleReveal(
          seed = reveal.seed.hex,
          randomness = reveal.draw.fold("")(_.randomness.hex),
          value = reveal.draw.fold("")(_.value),
          winningTicket = reveal.winningTicket
        )
      },
      drawnByHand = view.byHand,
      prizePhoto = view.photo.map(photo => wire.RafflePrizePhoto(photo.photoId.toString, photo.version))
    )

  private def status(value: RaffleStatus): wire.RaffleStatus =
    value match {
      case RaffleStatus.Open => wire.RaffleStatus.RAFFLE_STATUS_OPEN
      case RaffleStatus.Closing => wire.RaffleStatus.RAFFLE_STATUS_CLOSING
      case RaffleStatus.AwaitingBeacon => wire.RaffleStatus.RAFFLE_STATUS_AWAITING_BEACON
      case RaffleStatus.AwaitingWinner => wire.RaffleStatus.RAFFLE_STATUS_AWAITING_WINNER
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

  /** Ручной итог (PER-727): чужой `op_id` — `ALREADY_EXISTS`, остальные отказы — значения ответа. */
  def assign(outcome: Either[AssignRejected, wire.Raffle]): Either[Status, wire.AssignRaffleWinnerResponse] = {
    import wire.AssignRaffleWinnerRefusal.Reason
    def refused(reason: Reason) =
      Right(wire.AssignRaffleWinnerResponse().withRefused(wire.AssignRaffleWinnerRefusal(reason)))
    outcome match {
      case Right(raffle) => Right(wire.AssignRaffleWinnerResponse().withAccepted(raffle))
      case Left(AssignRejected.RaffleNotFound) => refused(Reason.RaffleNotFound(wire.RaffleNotFound()))
      case Left(AssignRejected.NotAwaitingWinner) => refused(Reason.NotAwaitingWinner(wire.RaffleNotAwaitingWinner()))
      case Left(AssignRejected.TicketNotInPool(tickets)) =>
        refused(Reason.TicketNotInPool(wire.RaffleTicketNotInPool(tickets)))
      case Left(AssignRejected.AlreadyDrawn(winningTicket)) =>
        refused(Reason.AlreadyDrawn(wire.RaffleAlreadyDrawn(winningTicket)))
      case Left(AssignRejected.OpIdTaken) => Left(opIdTaken)
    }
  }

  /** Смена приза (PER-737): чужой `op_id` — `ALREADY_EXISTS`, остальные отказы — значения ответа. */
  def changePrize(outcome: Either[ChangePrizeRejected, wire.Raffle]): Either[Status, wire.ChangeRafflePrizeResponse] =
    outcome match {
      case Right(raffle) => Right(wire.ChangeRafflePrizeResponse().withAccepted(raffle))
      case Left(ChangePrizeRejected.RaffleNotFound) =>
        Right(prizeRefused(PrizeReason.RaffleNotFound(wire.RaffleNotFound())))
      case Left(ChangePrizeRejected.AlreadyDrawn(winningTicket)) =>
        Right(prizeRefused(PrizeReason.AlreadyDrawn(wire.RaffleAlreadyDrawn(winningTicket))))
      case Left(ChangePrizeRejected.WithoutResult) =>
        Right(prizeRefused(PrizeReason.WithoutResult(wire.RaffleWithoutResult())))
      case Left(ChangePrizeRejected.OpIdTaken) => Left(opIdTaken)
    }

  /**
   * Фото приза (PER-772): тот же отказ розыгрыша, что у приза. Чужой `op_id` у снятия — `ALREADY_EXISTS`, а у фото id
   * фото — ключ повтора: занятый другими байтами — `photo_conflict`.
   */
  def setPrizePhoto(
      outcome: Either[ChangePrizeRejected, wire.Raffle]
  ): Either[Status, wire.SetRafflePrizePhotoResponse] =
    outcome match {
      case Right(raffle) => Right(wire.SetRafflePrizePhotoResponse().withAccepted(raffle))
      case Left(ChangePrizeRejected.OpIdTaken) =>
        Right(prizePhotoRefused(PhotoReason.PhotoConflict(wire.PhotoConflict())))
      case Left(rejected) => photoRejected(rejected).map(prizePhotoRefused)
    }

  def removePrizePhoto(
      outcome: Either[ChangePrizeRejected, wire.Raffle]
  ): Either[Status, wire.RemoveRafflePrizePhotoResponse] =
    outcome match {
      case Right(raffle) => Right(wire.RemoveRafflePrizePhotoResponse().withAccepted(raffle))
      case Left(rejected) =>
        photoRejected(rejected).map(reason =>
          wire.RemoveRafflePrizePhotoResponse().withRefused(wire.RafflePrizePhotoRefusal(reason))
        )
    }

  def prizePhotoRefused(reason: PhotoReason): wire.SetRafflePrizePhotoResponse =
    wire.SetRafflePrizePhotoResponse().withRefused(wire.RafflePrizePhotoRefusal(reason))

  private def photoRejected(rejected: ChangePrizeRejected): Either[Status, PhotoReason] =
    rejected match {
      case ChangePrizeRejected.RaffleNotFound => Right(PhotoReason.RaffleNotFound(wire.RaffleNotFound()))
      case ChangePrizeRejected.AlreadyDrawn(winningTicket) =>
        Right(PhotoReason.AlreadyDrawn(wire.RaffleAlreadyDrawn(winningTicket)))
      case ChangePrizeRejected.WithoutResult => Right(PhotoReason.WithoutResult(wire.RaffleWithoutResult()))
      case ChangePrizeRejected.OpIdTaken => Left(opIdTaken)
    }

  /** Текст приза отвергнут тем же отказом, что приз конфигурации. */
  def prizeBlank: wire.ChangeRafflePrizeResponse = prizeRefused(PrizeReason.PrizeBlank(wire.RafflePrizeBlank()))

  def prizeTooLong: wire.ChangeRafflePrizeResponse = prizeRefused(PrizeReason.PrizeTooLong(wire.RafflePrizeTooLong()))

  private def prizeRefused(reason: PrizeReason): wire.ChangeRafflePrizeResponse =
    wire.ChangeRafflePrizeResponse().withRefused(wire.ChangeRafflePrizeRefusal(reason))

  private def opIdTaken: Status = Status.ALREADY_EXISTS.withDescription("op_id belongs to another command")
}
