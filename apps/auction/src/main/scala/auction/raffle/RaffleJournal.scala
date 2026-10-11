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

final case class StoredRaffleOpened(closesAt: Instant, seed: String, round: Long)

final case class StoredRaffleNotHeld(closesAt: Instant)

final case class StoredRaffleParticipant(participantId: UUID)

final case class StoredPoolFixed(tickets: List[UUID])

final case class StoredRaffleDrawn(randomness: String, at: Instant)

final case class StoredRaffleEventBody(
    kind: String,
    raffleOpened: Option[StoredRaffleOpened],
    raffleNotHeld: Option[StoredRaffleNotHeld],
    registered: Option[StoredRaffleParticipant],
    registrationCancelled: Option[StoredRaffleParticipant],
    poolFixed: Option[StoredPoolFixed],
    raffleDrawn: Option[StoredRaffleDrawn]
)

object StoredRaffleEventBody {
  def of(kind: String): StoredRaffleEventBody = StoredRaffleEventBody(kind, None, None, None, None, None, None)
}

/** Строка журнала розыгрыша. Аукцион строки — её `persistence_id`; участник — в секции события, которое его несёт. */
final case class StoredRaffleEvent(eventId: UUID, opId: UUID, occurredAt: Instant, event: StoredRaffleEventBody)
    extends JournalSerializable

final case class StoredRaffleSeen(sequence: Long, opId: UUID, event: StoredRaffleEventBody)

final case class StoredRaffleTerms(closesAt: Instant, seed: String, round: Long)

/**
 * Snapshot розыгрыша. `closesAt` заполнен только у непроведённого, `terms` — с открытия, `participants` — регистрации
 * открытого или билеты зафиксированного пула по порядку, `drawn` — только после жеребьёвки.
 */
final case class StoredRaffle(
    sequence: Long,
    state: String,
    closesAt: Option[Instant],
    terms: Option[StoredRaffleTerms],
    participants: List[UUID],
    drawn: Option[StoredRaffleDrawn],
    seen: List[StoredRaffleSeen]
) extends JournalSerializable

object RaffleJournal {

  def store(eventId: UUID, opId: OpId, occurredAt: Instant)(event: RaffleEvent): StoredRaffleEvent =
    StoredRaffleEvent(eventId, opId.value, occurredAt, storeEvent(event))

  def envelope(sequence: Long, stored: StoredRaffleEvent): RaffleEnvelope =
    RaffleEnvelope(sequence, OpId(stored.opId), restoreEvent(stored.event))

  def storeEvent(event: RaffleEvent): StoredRaffleEventBody =
    event match {
      case RaffleEvent.RaffleOpened(closesAt, seed, round) =>
        StoredRaffleEventBody
          .of("RaffleOpened")
          .copy(raffleOpened = Some(StoredRaffleOpened(closesAt, seed.hex, round)))
      case RaffleEvent.RaffleNotHeld(closesAt) =>
        StoredRaffleEventBody.of("RaffleNotHeld").copy(raffleNotHeld = Some(StoredRaffleNotHeld(closesAt)))
      case RaffleEvent.Registered(participant) =>
        StoredRaffleEventBody.of("Registered").copy(registered = Some(StoredRaffleParticipant(participant.value)))
      case RaffleEvent.RegistrationCancelled(participant) =>
        StoredRaffleEventBody
          .of("RegistrationCancelled")
          .copy(registrationCancelled = Some(StoredRaffleParticipant(participant.value)))
      case RaffleEvent.PoolFixed(tickets) =>
        StoredRaffleEventBody.of("PoolFixed").copy(poolFixed = Some(StoredPoolFixed(tickets.toList.map(_.value))))
      case RaffleEvent.RaffleDrawn(randomness, at) =>
        StoredRaffleEventBody.of("RaffleDrawn").copy(raffleDrawn = Some(StoredRaffleDrawn(randomness.hex, at)))
    }

  /** Ровно одна секция, и та, что названа `kind`. Иначе строка испорчена. */
  def restoreEvent(stored: StoredRaffleEventBody): RaffleEvent =
    stored match {
      case StoredRaffleEventBody("RaffleOpened", Some(opened), None, None, None, None, None) =>
        RaffleEvent.RaffleOpened(opened.closesAt, seed(opened.seed), opened.round)
      case StoredRaffleEventBody("RaffleNotHeld", None, Some(notHeld), None, None, None, None) =>
        RaffleEvent.RaffleNotHeld(notHeld.closesAt)
      case StoredRaffleEventBody("Registered", None, None, Some(registered), None, None, None) =>
        RaffleEvent.Registered(ParticipantId(registered.participantId))
      case StoredRaffleEventBody("RegistrationCancelled", None, None, None, Some(cancelled), None, None) =>
        RaffleEvent.RegistrationCancelled(ParticipantId(cancelled.participantId))
      case StoredRaffleEventBody("PoolFixed", None, None, None, None, Some(fixed), None) =>
        RaffleEvent.PoolFixed(fixed.tickets.map(ParticipantId(_)).toVector)
      case StoredRaffleEventBody("RaffleDrawn", None, None, None, None, None, Some(drawn)) =>
        RaffleEvent.RaffleDrawn(randomness(drawn.randomness), drawn.at)
      case other => corrupted(s"raffle event of kind ${other.kind} with sections that do not match it")
    }

  def storeRaffle(raffle: Raffle, sequence: Long): StoredRaffle = {
    def terms(value: RaffleTerms) = Some(StoredRaffleTerms(value.closesAt, value.seed.hex, value.round))
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
      case RaffleState.Drawn(value, tickets, drawn, at) =>
        StoredRaffle(sequence, "Drawn", None, terms(value), ids(tickets), Some(StoredRaffleDrawn(drawn.hex, at)), seen)
    }
  }

  /** Snapshot восстанавливается с инвариантами: у каждого состояния ровно те секции, которые оно несёт. */
  def restoreRaffle(stored: StoredRaffle): Raffle = {
    def participants = stored.participants.map(ParticipantId(_)).toVector
    def terms(value: StoredRaffleTerms) = RaffleTerms(value.closesAt, seed(value.seed), value.round)
    val state = (stored.state, stored.closesAt, stored.terms, stored.drawn) match {
      case ("Initial", None, None, None) if stored.participants.isEmpty => RaffleState.Initial
      case ("NotHeld", Some(closesAt), None, None) if stored.participants.isEmpty => RaffleState.NotHeld(closesAt)
      case ("Open", None, Some(value), None) => RaffleState.Open(terms(value), participants)
      case ("Fixed", None, Some(value), None) => RaffleState.Fixed(terms(value), participants)
      case ("Drawn", None, Some(value), Some(drawn)) =>
        RaffleState.Drawn(terms(value), participants, randomness(drawn.randomness), drawn.at)
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
