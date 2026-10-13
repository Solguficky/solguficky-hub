package auction.publication

import auction.contract.LotValues
import auction.raffle.Draw
import auction.raffle.Raffle
import auction.raffle.RaffleEvent
import auction.raffle.RaffleJournal
import auction.raffle.RaffleState
import auction.raffle.StoredRaffleEvent
import auction.v1.auction_events as bus

import java.util.UUID

/**
 * Отображение строки журнала розыгрыша в публичный факт на шине (integration.md, «Auction NATS», PER-620), та же форма,
 * что [[AuctionFacts]]: конверт — `event_id`, аукцион розыгрыша, номер события в журнале розыгрыша и время решения,
 * тело — снимок розыгрыша сразу после события. Публикуется только жеребьёвка: регистрации, их отмена и фиксация пула —
 * не поводы. Номер выигравшего билета журнал не хранит, и факт считает его той же формулой [[Draw.winner]], что экран
 * итога (`RaffleView`), поэтому сообщение и экран не расходятся.
 */
object RaffleFacts {

  /** `after` — розыгрыш сразу после события `stored`, свёрнутый из его журнала. */
  def fact(auctionId: UUID, sequence: Long, stored: StoredRaffleEvent, after: Raffle): Option[Fact] =
    occasion(RaffleJournal.restoreEvent(stored.event)).flatMap { (name, occasion) =>
      after.state match {
        case RaffleState.Drawn(terms, tickets, randomness, _) if tickets.nonEmpty =>
          val message = bus.RaffleEvent(
            eventId = stored.eventId.toString,
            raffleId = auctionId.toString,
            version = sequence,
            occurredAt = LotValues.instant(stored.occurredAt),
            state = Some(
              bus.RaffleState(
                tickets = tickets.map(_.value.toString),
                winningTicket = Draw.winner(terms.seed, tickets.size, randomness)
              )
            ),
            occasion = occasion
          )
          Some(Fact(stored.eventId, LotFacts.SubjectPrefix + name, message.toByteArray))
        case _ =>
          throw new IllegalStateException(s"raffle of auction $auctionId is not drawn after a $name event")
      }
    }

  /**
   * Повод события и имя его subject'а, как у [[AuctionFacts.occasion]]: match без ветки по умолчанию, и новое событие
   * розыгрыша не скомпилируется, пока ему не решат повод.
   */
  def occasion(event: RaffleEvent): Option[(String, bus.RaffleEvent.Occasion)] =
    event match {
      case RaffleEvent.RaffleDrawn(_, _) =>
        Some("raffle_drawn" -> bus.RaffleEvent.Occasion.RaffleDrawn(bus.RaffleDrawn()))
      case RaffleEvent.RaffleOpened(_, _, _) | RaffleEvent.RaffleNotHeld(_) | RaffleEvent.Registered(_) |
          RaffleEvent.RegistrationCancelled(_) | RaffleEvent.PoolFixed(_) | RaffleEvent.RaffleCancelled(_) =>
        None
    }
}
