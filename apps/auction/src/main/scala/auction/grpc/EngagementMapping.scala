package auction.grpc

import auction.aggregate.AuctionConfig
import auction.aggregate.AuctionState
import auction.lot.ParticipantId
import auction.prediction.OpenRoundForecasters
import auction.raffle.RaffleState
import auction.v1.auction_service as wire

import java.time.Instant

/**
 * Где регистрация в розыгрыше для аудитории объявления Notifications (PER-777). `Open` несёт действующие регистрации:
 * после закрытия аудиторию розыгрыша больше не спрашивают (PER-768, ответ 3).
 */
enum Registration {
  case NotOpen
  case Open(entries: Vector[ParticipantId])
  case Closed
}

/** Участники розыгрыша и прогнозов аукциона для Notifications (`ListAuctionEngagement`, PER-777). */
object EngagementMapping {

  /**
   * Регистрация открыта по времени, как её принимает розыгрыш (`now < closesAt`, ADR-066, п. 5), а не по состоянию:
   * пул, ещё не зафиксированный после T, регистраций уже не берёт. Розыгрыш, которого аукцион ещё не открыл, откроется
   * с онлайн-торгами, если конфигурация его объявила и момент закрытия впереди; черновик конфигурации ещё не знает.
   */
  def registration(auction: AuctionState, raffle: RaffleState, now: Instant): Registration =
    raffle match {
      case RaffleState.Open(terms, entries) =>
        if (now.isBefore(terms.closesAt)) Registration.Open(entries) else Registration.Closed
      case RaffleState.Initial =>
        auction match {
          case AuctionState.Draft => Registration.NotOpen
          case AuctionState.Scheduled(config) => ahead(config, now)
          case AuctionState.Prebidding(config, _) => ahead(config, now)
          case AuctionState.Initial | AuctionState.Settling(_, _) | AuctionState.Break(_, _) |
              AuctionState.LineupFrozen(_, _, _) | AuctionState.Final(_, _, _, _, _) | AuctionState.Finished(_, _) |
              AuctionState.Cancelled(_, _, _) =>
            Registration.Closed
        }
      case RaffleState.NotHeld(_) | RaffleState.Fixed(_, _) | RaffleState.AwaitingWinner(_, _) |
          RaffleState.Drawn(_, _, _, _) | RaffleState.Assigned(_, _, _, _) | RaffleState.Cancelled(_, _, _) =>
        Registration.Closed
    }

  private def ahead(config: AuctionConfig, now: Instant): Registration =
    if (config.raffleClosesAt.exists(now.isBefore)) Registration.NotOpen else Registration.Closed

  def response(
      registration: Registration,
      forecasters: Option[OpenRoundForecasters]
  ): wire.ListAuctionEngagementResponse =
    wire.ListAuctionEngagementResponse(
      raffleRegistration = registration match {
        case Registration.NotOpen => wire.RaffleRegistration.RAFFLE_REGISTRATION_NOT_OPEN
        case Registration.Open(_) => wire.RaffleRegistration.RAFFLE_REGISTRATION_OPEN
        case Registration.Closed => wire.RaffleRegistration.RAFFLE_REGISTRATION_CLOSED
      },
      raffleRegistrants = registration match {
        case Registration.Open(entries) => entries.map(_.value.toString)
        case Registration.NotOpen | Registration.Closed => Vector.empty
      },
      openPredictionRound = forecasters.map(found => PredictionMapping.roundOf(found.round)),
      forecasters = forecasters.toVector.flatMap(_.participants.toVector.map(_.value.toString).sorted)
    )
}
