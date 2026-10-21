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
  case Cancelled
}

/** Жеребьёвка для пересчёта участником: значение раунда, V и номер выигравшего билета. */
final case class RaffleDrawView(randomness: Randomness, value: String, winningTicket: Int)

/** Что раскрыто после жеребьёвки или после пустого пула: seed всегда, жеребьёвка — только при непустом пуле. */
final case class RaffleReveal(seed: Seed, draw: Option[RaffleDrawView])

final case class RaffleTicketView(number: Int, displayName: Option[String])

/**
 * Розыгрыш, каким его видит смотрящий (ADR-066, п. 11). `commitment` и `round` пусты только у непроведённого. Seed
 * появляется здесь только в `reveal`, а `reveal` — только после фиксации пула без билетов или после жеребьёвки: до
 * этого ни одно чтение seed не отдаёт. `drawnAt` заполнен только у проведённой жеребьёвки, а момент её — тот, что
 * записан ядром в `RaffleState.Drawn`. `prize` — приз, объявленный вместе с моментом закрытия регистрации (дополнение
 * ADR-066 от 2026-10-21); пуст у непроведённого и у розыгрыша без приза.
 */
final case class RaffleView(
    status: RaffleStatus,
    closesAt: Instant,
    drawnAt: Option[Instant],
    commitment: Option[String],
    round: Option[Long],
    registered: Boolean,
    tickets: Vector[RaffleTicketView],
    myTicket: Option[Int],
    reveal: Option[RaffleReveal],
    prize: Option[String] = None
)

object RaffleView {

  /**
   * `names` — снимок «номер — имя» на момент фиксации; номер без имени — имя стёрто или снимок ещё не записан.
   * Розыгрыша нет — `None`.
   */
  def of(raffle: Raffle, viewer: ParticipantId, now: Instant, names: Map[Int, String]): Option[RaffleView] = {
    def numbered(tickets: Vector[ParticipantId]): Vector[RaffleTicketView] =
      tickets.indices.map(index => RaffleTicketView(index + 1, names.get(index + 1))).toVector

    def fixed(
        terms: RaffleTerms,
        tickets: Vector[ParticipantId],
        status: RaffleStatus,
        reveal: Option[RaffleReveal],
        drawnAt: Option[Instant]
    ) =
      RaffleView(
        status = status,
        closesAt = terms.closesAt,
        drawnAt = drawnAt,
        commitment = Some(terms.commitment),
        round = Some(terms.round),
        registered = tickets.contains(viewer),
        tickets = numbered(tickets),
        myTicket = Raffle.ticketOf(tickets, viewer),
        reveal = reveal,
        prize = terms.prize
      )

    raffle.state match {
      case RaffleState.Initial => None
      case RaffleState.NotHeld(closesAt) =>
        Some(RaffleView(RaffleStatus.NotHeld, closesAt, None, None, None, false, Vector.empty, None, None))
      case RaffleState.Open(terms, entries) =>
        Some(
          RaffleView(
            status = if (now.isBefore(terms.closesAt)) RaffleStatus.Open else RaffleStatus.Closing,
            closesAt = terms.closesAt,
            drawnAt = None,
            commitment = Some(terms.commitment),
            round = Some(terms.round),
            registered = entries.contains(viewer),
            tickets = Vector.empty,
            myTicket = None,
            reveal = None,
            prize = terms.prize
          )
        )
      case RaffleState.Fixed(terms, tickets) if tickets.isEmpty =>
        Some(fixed(terms, tickets, RaffleStatus.NoTickets, Some(RaffleReveal(terms.seed, None)), None))
      case RaffleState.Fixed(terms, tickets) =>
        Some(fixed(terms, tickets, RaffleStatus.AwaitingBeacon, None, None))
      case RaffleState.Drawn(terms, tickets, randomness, at) =>
        val draw = RaffleDrawView(
          randomness,
          Draw.value(terms.seed, tickets.size, randomness),
          Draw.winner(terms.seed, tickets.size, randomness)
        )
        Some(fixed(terms, tickets, RaffleStatus.Drawn, Some(RaffleReveal(terms.seed, Some(draw))), Some(at)))
      // Отменённый розыгрыш seed не раскрывает: жеребьёвки не было и не будет. Билеты не показываются — розыгрыша нет.
      case RaffleState.Cancelled(terms, participants, _) =>
        Some(
          RaffleView(
            status = RaffleStatus.Cancelled,
            closesAt = terms.closesAt,
            drawnAt = None,
            commitment = Some(terms.commitment),
            round = Some(terms.round),
            registered = participants.contains(viewer),
            tickets = Vector.empty,
            myTicket = None,
            reveal = None,
            prize = terms.prize
          )
        )
    }
  }
}
