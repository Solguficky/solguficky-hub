package auction.raffle

import auction.entity.JournalCorrupted
import auction.entity.JournalSerializable
import auction.lot.OpId
import auction.lot.ParticipantId
import org.apache.pekko.persistence.typed.SnapshotAdapter

import java.time.Instant
import java.util.UUID

/*
 * Модель хранения розыгрыша (ADR-058) — та же форма, что у лота и аукциона: доменные типы в базу не пишутся, имя класса
 * — manifest строки, имена полей — ключи JSON, взаимоисключающие варианты — поле `kind` и одна заполненная секция.
 * Имён участников в журнале нет: журнал не усекается, а снимок имён стирается через срок хранения (ADR-066, п. 12),
 * поэтому имена живут только строкой `raffle_ticket`.
 */

/** `prize` добавлен в конец (PER-649): строка без него — розыгрыш без приза. */
final case class StoredRaffleOpened(closesAt: Instant, seed: String, round: Long, prize: Option[String] = None)

final case class StoredRaffleNotHeld(closesAt: Instant)

final case class StoredRaffleParticipant(participantId: UUID)

/**
 * `byHand` добавлен в конец (PER-727) и пишется только у ручного итога: строка без него — пул, ждущий маяка, и строка
 * автоматического режима совпадает с прежней.
 */
final case class StoredPoolFixed(tickets: List[UUID], byHand: Option[Boolean] = None)

final case class StoredRaffleDrawn(randomness: String, at: Instant)

/** Ручной итог (PER-727): номер выигравшего билета и время назначения. */
final case class StoredWinnerAssigned(ticket: Int, at: Instant)

final case class StoredRaffleCancelled(at: Instant)

final case class StoredRaffleEventBody(
    kind: String,
    raffleOpened: Option[StoredRaffleOpened],
    raffleNotHeld: Option[StoredRaffleNotHeld],
    registered: Option[StoredRaffleParticipant],
    registrationCancelled: Option[StoredRaffleParticipant],
    poolFixed: Option[StoredPoolFixed],
    raffleDrawn: Option[StoredRaffleDrawn],
    raffleCancelled: Option[StoredRaffleCancelled] = None,
    winnerAssigned: Option[StoredWinnerAssigned] = None
)

object StoredRaffleEventBody {
  def of(kind: String): StoredRaffleEventBody = StoredRaffleEventBody(kind, None, None, None, None, None, None)
}

/** Строка журнала розыгрыша. Аукцион строки — её `persistence_id`; участник — в секции события, которое его несёт. */
final case class StoredRaffleEvent(eventId: UUID, opId: UUID, occurredAt: Instant, event: StoredRaffleEventBody)
    extends JournalSerializable

final case class StoredRaffleSeen(sequence: Long, opId: UUID, event: StoredRaffleEventBody)

/** `prize` добавлен в конец (PER-649): снимок прежней формы читается розыгрышем без приза. */
final case class StoredRaffleTerms(closesAt: Instant, seed: String, round: Long, prize: Option[String] = None)

/**
 * Snapshot розыгрыша. `closesAt` заполнен только у непроведённого, `terms` — с открытия, `participants` — регистрации
 * открытого или билеты зафиксированного пула по порядку, `drawn` — только после жеребьёвки, `cancelledAt` — только у
 * отменённого, `assigned` — только у ручного итога (PER-727); оба добавлены в конец, и snapshot прежней формы читает их
 * пустыми. Пул, ждущий администратора, — своё состояние `AwaitingWinner`.
 */
final case class StoredRaffle(
    sequence: Long,
    state: String,
    closesAt: Option[Instant],
    terms: Option[StoredRaffleTerms],
    participants: List[UUID],
    drawn: Option[StoredRaffleDrawn],
    seen: List[StoredRaffleSeen],
    cancelledAt: Option[Instant] = None,
    assigned: Option[StoredWinnerAssigned] = None
) extends JournalSerializable

object RaffleJournal {

  def store(eventId: UUID, opId: OpId, occurredAt: Instant)(event: RaffleEvent): StoredRaffleEvent =
    StoredRaffleEvent(eventId, opId.value, occurredAt, storeEvent(event))

  def envelope(sequence: Long, stored: StoredRaffleEvent): RaffleEnvelope =
    RaffleEnvelope(sequence, OpId(stored.opId), restoreEvent(stored.event))

  def storeEvent(event: RaffleEvent): StoredRaffleEventBody =
    event match {
      case RaffleEvent.RaffleOpened(closesAt, seed, round, prize) =>
        StoredRaffleEventBody
          .of("RaffleOpened")
          .copy(raffleOpened = Some(StoredRaffleOpened(closesAt, seed.hex, round, prize)))
      case RaffleEvent.RaffleNotHeld(closesAt) =>
        StoredRaffleEventBody.of("RaffleNotHeld").copy(raffleNotHeld = Some(StoredRaffleNotHeld(closesAt)))
      case RaffleEvent.Registered(participant) =>
        StoredRaffleEventBody.of("Registered").copy(registered = Some(StoredRaffleParticipant(participant.value)))
      case RaffleEvent.RegistrationCancelled(participant) =>
        StoredRaffleEventBody
          .of("RegistrationCancelled")
          .copy(registrationCancelled = Some(StoredRaffleParticipant(participant.value)))
      case RaffleEvent.PoolFixed(tickets, byHand) =>
        StoredRaffleEventBody
          .of("PoolFixed")
          .copy(poolFixed = Some(StoredPoolFixed(tickets.toList.map(_.value), Option.when(byHand)(true))))
      case RaffleEvent.RaffleDrawn(randomness, at) =>
        StoredRaffleEventBody.of("RaffleDrawn").copy(raffleDrawn = Some(StoredRaffleDrawn(randomness.hex, at)))
      case RaffleEvent.WinnerAssigned(ticket, at) =>
        StoredRaffleEventBody.of("WinnerAssigned").copy(winnerAssigned = Some(StoredWinnerAssigned(ticket, at)))
      case RaffleEvent.RaffleCancelled(at) =>
        StoredRaffleEventBody.of("RaffleCancelled").copy(raffleCancelled = Some(StoredRaffleCancelled(at)))
    }

  /** Ровно одна секция, и та, что названа `kind`. Иначе строка испорчена. */
  def restoreEvent(stored: StoredRaffleEventBody): RaffleEvent =
    stored match {
      case StoredRaffleEventBody("RaffleOpened", Some(opened), None, None, None, None, None, None, None) =>
        RaffleEvent.RaffleOpened(opened.closesAt, seed(opened.seed), opened.round, opened.prize)
      case StoredRaffleEventBody("RaffleNotHeld", None, Some(notHeld), None, None, None, None, None, None) =>
        RaffleEvent.RaffleNotHeld(notHeld.closesAt)
      case StoredRaffleEventBody("Registered", None, None, Some(registered), None, None, None, None, None) =>
        RaffleEvent.Registered(ParticipantId(registered.participantId))
      case StoredRaffleEventBody("RegistrationCancelled", None, None, None, Some(cancelled), None, None, None, None) =>
        RaffleEvent.RegistrationCancelled(ParticipantId(cancelled.participantId))
      case StoredRaffleEventBody("PoolFixed", None, None, None, None, Some(fixed), None, None, None) =>
        RaffleEvent.PoolFixed(fixed.tickets.map(ParticipantId(_)).toVector, fixed.byHand.contains(true))
      case StoredRaffleEventBody("RaffleDrawn", None, None, None, None, None, Some(drawn), None, None) =>
        RaffleEvent.RaffleDrawn(randomness(drawn.randomness), drawn.at)
      case StoredRaffleEventBody("RaffleCancelled", None, None, None, None, None, None, Some(cancelled), None) =>
        RaffleEvent.RaffleCancelled(cancelled.at)
      case StoredRaffleEventBody("WinnerAssigned", None, None, None, None, None, None, None, Some(assigned)) =>
        RaffleEvent.WinnerAssigned(assigned.ticket, assigned.at)
      case other => corrupted(s"raffle event of kind ${other.kind} with sections that do not match it")
    }

  def storeRaffle(raffle: Raffle, sequence: Long): StoredRaffle = {
    def terms(value: RaffleTerms) = Some(StoredRaffleTerms(value.closesAt, value.seed.hex, value.round, value.prize))
    def ids(participants: Vector[ParticipantId]) = participants.toList.map(_.value)
    val seen = raffle.seen.values.toList
      .sortBy(_.sequence)
      .map(envelope => StoredRaffleSeen(envelope.sequence, envelope.opId.value, storeEvent(envelope.event)))
    raffle.state match {
      case RaffleState.Initial => StoredRaffle(sequence, "Initial", None, None, Nil, None, seen)
      case RaffleState.NotHeld(closesAt) => StoredRaffle(sequence, "NotHeld", Some(closesAt), None, Nil, None, seen)
      case RaffleState.Open(value, entries) =>
        StoredRaffle(sequence, "Open", None, terms(value), ids(entries), None, seen)
      case RaffleState.Fixed(value, tickets) =>
        StoredRaffle(sequence, "Fixed", None, terms(value), ids(tickets), None, seen)
      case RaffleState.AwaitingWinner(value, tickets) =>
        StoredRaffle(sequence, "AwaitingWinner", None, terms(value), ids(tickets), None, seen)
      case RaffleState.Drawn(value, tickets, drawn, at) =>
        StoredRaffle(sequence, "Drawn", None, terms(value), ids(tickets), Some(StoredRaffleDrawn(drawn.hex, at)), seen)
      case RaffleState.Assigned(value, tickets, ticket, at) =>
        StoredRaffle(
          sequence,
          "Assigned",
          None,
          terms(value),
          ids(tickets),
          None,
          seen,
          assigned = Some(StoredWinnerAssigned(ticket, at))
        )
      case RaffleState.Cancelled(value, participants, at) =>
        StoredRaffle(sequence, "Cancelled", None, terms(value), ids(participants), None, seen, cancelledAt = Some(at))
    }
  }

  /** Snapshot восстанавливается с инвариантами: у каждого состояния ровно те секции, которые оно несёт. */
  def restoreRaffle(stored: StoredRaffle): Raffle = {
    def participants = stored.participants.map(ParticipantId(_)).toVector
    def terms(value: StoredRaffleTerms) = RaffleTerms(value.closesAt, seed(value.seed), value.round, value.prize)
    val state = (stored.state, stored.closesAt, stored.terms, stored.drawn, stored.cancelledAt, stored.assigned) match {
      case ("Initial", None, None, None, None, None) if stored.participants.isEmpty => RaffleState.Initial
      case ("NotHeld", Some(closesAt), None, None, None, None) if stored.participants.isEmpty =>
        RaffleState.NotHeld(closesAt)
      case ("Open", None, Some(value), None, None, None) => RaffleState.Open(terms(value), participants)
      case ("Fixed", None, Some(value), None, None, None) => RaffleState.Fixed(terms(value), participants)
      case ("AwaitingWinner", None, Some(value), None, None, None) if stored.participants.nonEmpty =>
        RaffleState.AwaitingWinner(terms(value), participants)
      case ("Drawn", None, Some(value), Some(drawn), None, None) =>
        RaffleState.Drawn(terms(value), participants, randomness(drawn.randomness), drawn.at)
      case ("Assigned", None, Some(value), None, None, Some(assigned))
          if assigned.ticket >= 1 && assigned.ticket <= stored.participants.size =>
        RaffleState.Assigned(terms(value), participants, assigned.ticket, assigned.at)
      case ("Cancelled", None, Some(value), None, Some(at), None) =>
        RaffleState.Cancelled(terms(value), participants, at)
      case _ => corrupted(s"raffle snapshot of state ${stored.state} with sections that do not match it")
    }
    Raffle(
      state,
      stored.seen.map { seen =>
        val envelope = RaffleEnvelope(seen.sequence, OpId(seen.opId), restoreEvent(seen.event))
        envelope.opId -> envelope
      }.toMap
    )
  }

  val snapshotAdapter: SnapshotAdapter[RaffleEntity.State] = new SnapshotAdapter[RaffleEntity.State] {
    override def toJournal(state: RaffleEntity.State): Any = storeRaffle(state.raffle, state.sequence)

    override def fromJournal(from: Any): RaffleEntity.State =
      from match {
        case stored: StoredRaffle => RaffleEntity.State(restoreRaffle(stored), stored.sequence)
        case other => corrupted(s"raffle snapshot of unexpected type ${other.getClass.getName}")
      }
  }

  private def seed(hex: String): Seed = Seed.fromHex(hex).getOrElse(corrupted("raffle seed is not 64 lowercase hex"))

  private def randomness(hex: String): Randomness =
    Randomness.fromHex(hex).getOrElse(corrupted("raffle randomness is not 64 lowercase hex"))

  private def corrupted(message: String): Nothing = throw new JournalCorrupted(message)
}
