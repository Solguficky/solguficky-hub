package auction.raffle

import auction.lot.ParticipantId

import java.time.Instant

/** Где розыгрыш с точки зрения смотрящего: `Closing` — закрытие наступило по часам, а пул ещё не зафиксирован. */
enum RaffleStatus {
  case Open
  case Closing
  case AwaitingBeacon
  case Drawn
  case NoTickets
  case NotHeld
}

/** Жеребьёвка для пересчёта участником: значение раунда, V и номер выигравшего билета. */
final case class RaffleDrawView(randomness: Randomness, value: String, winningTicket: Int)

/** Что раскрыто после жеребьёвки или после пустого пула: seed всегда, жеребьёвка — только при непустом пуле. */
final case class RaffleReveal(seed: Seed, draw: Option[RaffleDrawView])

final case class RaffleTicketView(number: Int, displayName: Option[String])

/**
 * Розыгрыш, каким его видит смотрящий (ADR-066, п. 11). `commitment` и `round` пусты только у непроведённого. Seed
 * появляется здесь только в `reveal`, а `reveal` — только после фиксации пула без билетов или после жеребьёвки: до
 * этого ни одно чтение seed не отдаёт.
 */
final case class RaffleView(
    status: RaffleStatus,
    closesAt: Instant,
    commitment: Option[String],
    round: Option[Long],
    registered: Boolean,
    tickets: Vector[RaffleTicketView],
    myTicket: Option[Int],
    reveal: Option[RaffleReveal]
)

object RaffleView {

  /**
   * `names` — снимок «номер — имя» на момент фиксации; номер без имени — имя стёрто или снимок ещё не записан.
   * Розыгрыша нет — `None`.
   */
  def of(raffle: Raffle, viewer: ParticipantId, now: Instant, names: Map[Int, String]): Option[RaffleView] = {
    def numbered(tickets: Vector[ParticipantId]): Vector[RaffleTicketView] =
      tickets.indices.map(index => RaffleTicketView(index + 1, names.get(index + 1))).toVector

    def fixed(terms: RaffleTerms, tickets: Vector[ParticipantId], status: RaffleStatus, reveal: Option[RaffleReveal]) =
      RaffleView(
        status = status,
        closesAt = terms.closesAt,
        commitment = Some(terms.commitment),
        round = Some(terms.round),
        registered = tickets.contains(viewer),
        tickets = numbered(tickets),
        myTicket = Raffle.ticketOf(tickets, viewer),
        reveal = reveal
      )

    raffle.state match {
      case RaffleState.Initial => None
      case RaffleState.NotHeld(closesAt) =>
        Some(RaffleView(RaffleStatus.NotHeld, closesAt, None, None, false, Vector.empty, None, None))
      case RaffleState.Open(terms, entries) =>
        Some(
          RaffleView(
            status = if (now.isBefore(terms.closesAt)) RaffleStatus.Open else RaffleStatus.Closing,
            closesAt = terms.closesAt,
            commitment = Some(terms.commitment),
            round = Some(terms.round),
            registered = entries.contains(viewer),
            tickets = Vector.empty,
            myTicket = None,
            reveal = None
          )
        )
      case RaffleState.Fixed(terms, tickets) if tickets.isEmpty =>
        Some(fixed(terms, tickets, RaffleStatus.NoTickets, Some(RaffleReveal(terms.seed, None))))
      case RaffleState.Fixed(terms, tickets) => Some(fixed(terms, tickets, RaffleStatus.AwaitingBeacon, None))
      case RaffleState.Drawn(terms, tickets, randomness, _) =>
        val draw = RaffleDrawView(
          randomness,
          Draw.value(terms.seed, tickets.size, randomness),
          Draw.winner(terms.seed, tickets.size, randomness)
        )
        Some(fixed(terms, tickets, RaffleStatus.Drawn, Some(RaffleReveal(terms.seed, Some(draw)))))
    }
  }
}
