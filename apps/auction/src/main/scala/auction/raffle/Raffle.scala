package auction.raffle

import auction.lot.OpId
import auction.lot.ParticipantId

import java.time.Instant

/*
 * Ядро розыгрыша среди участников (ADR-066): `decide` и `apply` чистыми функциями, без актора, журнала и часов. Код
 * этого пакета не знает торгов — ни лота, ни ставки, ни реестра аукциона (ADR-066, п. 1), и держит это тест границы
 * `RaffleBoundarySpec`: участие даёт только право `place_bids`, которое проверяет граница, а не история ставок.
 */

/** Условия, объявленные при открытии регистрации: момент закрытия, seed и раунд маяка. После открытия не меняются. */
final case class RaffleTerms(closesAt: Instant, seed: Seed, round: Long) {
  def commitment: String = seed.commitment
}

/**
 * Где розыгрыш.
 *
 *   - `Initial` — розыгрыша нет: аукцион его не открывал.
 *   - `NotHeld` — открытие пришло не раньше закрытия: регистрация не открывалась, seed не создавался (ADR-066, п. 6).
 *   - `Open` — регистрация по времени `now < closesAt`; `entries` — действующие регистрации в порядке регистрации.
 *   - `Fixed` — пул зафиксирован: билеты 1…N в порядке регистрации. Пустой пул — розыгрыш не состоялся, и маяк не
 *     нужен; непустой ждёт значения раунда.
 *   - `Drawn` — значение раунда получено, жеребьёвка проведена и больше не меняется.
 */
enum RaffleState {
  case Initial
  case NotHeld(closesAt: Instant)
  case Open(terms: RaffleTerms, entries: Vector[ParticipantId])
  case Fixed(terms: RaffleTerms, tickets: Vector[ParticipantId])
  case Drawn(terms: RaffleTerms, tickets: Vector[ParticipantId], randomness: Randomness, at: Instant)
}

/** События журнала розыгрыша. */
enum RaffleEvent {
  case RaffleOpened(closesAt: Instant, seed: Seed, round: Long)
  case RaffleNotHeld(closesAt: Instant)
  case Registered(participant: ParticipantId)
  case RegistrationCancelled(participant: ParticipantId)
  case PoolFixed(tickets: Vector[ParticipantId])
  case RaffleDrawn(randomness: Randomness, at: Instant)
}

final case class RaffleEnvelope(sequence: Long, opId: OpId, event: RaffleEvent)

/** Открытие регистрации по команде аукциона, открывшего онлайн-торги. */
final case class OpenRaffle(closesAt: Instant)

final case class Register(participant: ParticipantId, opId: OpId)

final case class CancelRegistration(participant: ParticipantId, opId: OpId)

/** Фиксация пула в момент закрытия; `excluded` — регистрации тех, кто к закрытию потерял право. */
final case class FixPool(excluded: Set[ParticipantId])

final case class DrawWinner(randomness: Randomness, at: Instant)

/**
 * Исход принятой команды. `Unchanged` — команда принята без события: регистрация уже есть, отменять нечего или розыгрыш
 * уже открыт. `Repeated` — повтор `op_id` получает исходный конверт.
 */
enum RaffleDecision {
  case Accepted(event: RaffleEvent)
  case Repeated(original: RaffleEnvelope)
  case Unchanged
}

/** Отказы регистрации и её отмены: розыгрыша нет, регистрация закрыта или `op_id` занят другой командой. */
enum RegistrationRejected {
  case RaffleNotFound
  case RegistrationClosed
  case OpIdTaken
}

enum FixPoolRejected {
  case NotOpen
  case NotClosedYet
  case AlreadyFixed
}

/** Отказы жеребьёвки: пул не ждёт маяка, жеребьёвка уже проведена (она одна) или билетов нет. */
enum DrawRejected {
  case NotAwaitingBeacon
  case AlreadyDrawn
  case NoTickets
}

/** Розыгрыш и окно дедупликации `op_id`; `seen` пишет только [[Raffle.apply]]. */
final case class Raffle(state: RaffleState, seen: Map[OpId, RaffleEnvelope])

object Raffle {

  val initial: Raffle = Raffle(RaffleState.Initial, Map.empty)

  /**
   * Открытие регистрации. Сравнение — по часам розыгрыша в момент открытия: оно не раньше фактического открытия торгов,
   * поэтому открытие не раньше закрытия здесь значит то же или позже, и регистрация не открывается — иначе значение
   * раунда могло бы существовать раньше seed. Seed создаётся только для принятого открытия. Повтор открытия — без
   * события: условия объявлены один раз.
   */
  def decide(raffle: Raffle, command: OpenRaffle, now: Instant, seed: => Seed): RaffleDecision =
    raffle.state match {
      case RaffleState.Initial =>
        if (now.isBefore(command.closesAt))
          RaffleDecision.Accepted(
            RaffleEvent.RaffleOpened(command.closesAt, seed, Quicknet.roundFor(command.closesAt))
          )
        else RaffleDecision.Accepted(RaffleEvent.RaffleNotHeld(command.closesAt))
      case _ => RaffleDecision.Unchanged
    }

  /**
   * Регистрация принимается по времени — `now < closesAt`, — а не по состоянию: опоздавший таймер закрытия окна не
   * продлевает (ADR-066, п. 5). Повторная регистрация возвращает ту же: второго билета нет.
   */
  def decide(raffle: Raffle, command: Register, now: Instant): Either[RegistrationRejected, RaffleDecision] =
    repeated(raffle, command.opId) {
      case RaffleEvent.Registered(participant) => participant == command.participant
      case _ => false
    }.getOrElse {
      openAt(raffle, now).map { entries =>
        if (entries.contains(command.participant)) RaffleDecision.Unchanged
        else RaffleDecision.Accepted(RaffleEvent.Registered(command.participant))
      }
    }

  /** Отмена до закрытия; отмена без регистрации принята без события. После отмены можно зарегистрироваться снова. */
  def decide(raffle: Raffle, command: CancelRegistration, now: Instant): Either[RegistrationRejected, RaffleDecision] =
    repeated(raffle, command.opId) {
      case RaffleEvent.RegistrationCancelled(participant) => participant == command.participant
      case _ => false
    }.getOrElse {
      openAt(raffle, now).map { entries =>
        if (entries.contains(command.participant))
          RaffleDecision.Accepted(RaffleEvent.RegistrationCancelled(command.participant))
        else RaffleDecision.Unchanged
      }
    }

  /**
   * Фиксация пула (ADR-066, п. 8): действующие регистрации без исключённых получают номера 1…N подряд в порядке
   * регистрации. Только после закрытия и только один раз: после фиксации пул не меняется ни по какой причине.
   */
  def decide(raffle: Raffle, command: FixPool, now: Instant): Either[FixPoolRejected, RaffleEvent] =
    raffle.state match {
      case RaffleState.Initial | RaffleState.NotHeld(_) => Left(FixPoolRejected.NotOpen)
      case RaffleState.Open(terms, _) if now.isBefore(terms.closesAt) => Left(FixPoolRejected.NotClosedYet)
      case RaffleState.Open(_, entries) =>
        Right(RaffleEvent.PoolFixed(entries.filterNot(command.excluded.contains)))
      case RaffleState.Fixed(_, _) | RaffleState.Drawn(_, _, _, _) => Left(FixPoolRejected.AlreadyFixed)
    }

  /** Жеребьёвка одна: повторная отклоняется, и результат неизменяем (ADR-066, п. 9). */
  def decide(raffle: Raffle, command: DrawWinner): Either[DrawRejected, RaffleEvent] =
    raffle.state match {
      case RaffleState.Fixed(_, tickets) if tickets.isEmpty => Left(DrawRejected.NoTickets)
      case RaffleState.Fixed(_, _) => Right(RaffleEvent.RaffleDrawn(command.randomness, command.at))
      case RaffleState.Drawn(_, _, _, _) => Left(DrawRejected.AlreadyDrawn)
      case RaffleState.Initial | RaffleState.NotHeld(_) | RaffleState.Open(_, _) =>
        Left(DrawRejected.NotAwaitingBeacon)
    }

  /**
   * Кого исключить при фиксации: только тех, о ком Identity ответила, что права нет. Неотвеченный остаётся в пуле —
   * правило отказа, выбранное владельцем (PER-499): право подтверждено при регистрации, а выдачу заблокированному
   * решают организаторы.
   */
  def excluded(answers: Map[ParticipantId, Option[Boolean]]): Set[ParticipantId] =
    answers.collect { case (participant, Some(false)) => participant }.toSet

  /**
   * Пришли ли ответы Identity слишком поздно, чтобы менять пул: с времени раунда маяка его значение может быть
   * опубликовано, и исключение по ответу после него давало бы выбрать исход. Тогда пул фиксируется без исключений — то
   * же правило, что при молчании Identity.
   */
  def answeredTooLate(terms: RaffleTerms, now: Instant): Boolean = !now.isBefore(Quicknet.roundAt(terms.round))

  /** Номер билета участника в зафиксированном пуле, с единицы. */
  def ticketOf(tickets: Vector[ParticipantId], participant: ParticipantId): Option[Int] =
    Option(tickets.indexOf(participant)).filter(_ >= 0).map(_ + 1)

  def apply(raffle: Raffle, envelope: RaffleEnvelope): Raffle = {
    val state = (raffle.state, envelope.event) match {
      case (RaffleState.Initial, RaffleEvent.RaffleOpened(closesAt, seed, round)) =>
        RaffleState.Open(RaffleTerms(closesAt, seed, round), Vector.empty)
      case (RaffleState.Initial, RaffleEvent.RaffleNotHeld(closesAt)) => RaffleState.NotHeld(closesAt)
      case (RaffleState.Open(terms, entries), RaffleEvent.Registered(participant)) =>
        RaffleState.Open(terms, entries.filterNot(_ == participant) :+ participant)
      case (RaffleState.Open(terms, entries), RaffleEvent.RegistrationCancelled(participant)) =>
        RaffleState.Open(terms, entries.filterNot(_ == participant))
      case (RaffleState.Open(terms, _), RaffleEvent.PoolFixed(tickets)) => RaffleState.Fixed(terms, tickets)
      case (RaffleState.Fixed(terms, tickets), RaffleEvent.RaffleDrawn(randomness, at)) =>
        RaffleState.Drawn(terms, tickets, randomness, at)
      case (state, event) =>
        throw new IllegalStateException(s"raffle event ${event.getClass.getSimpleName} does not apply to $state")
    }
    Raffle(state, raffle.seen.updated(envelope.opId, envelope))
  }

  def replay(raffle: Raffle, envelopes: Iterable[RaffleEnvelope]): Raffle = envelopes.foldLeft(raffle)(apply)

  /** Повтор `op_id`: исходный конверт своей команде, `OpIdTaken` — чужой. */
  private def repeated(raffle: Raffle, opId: OpId)(
      same: RaffleEvent => Boolean
  ): Option[Either[RegistrationRejected, RaffleDecision]] =
    raffle.seen.get(opId).map { original =>
      if (same(original.event)) Right(RaffleDecision.Repeated(original)) else Left(RegistrationRejected.OpIdTaken)
    }

  /** Действующие регистрации, если регистрация открыта по времени. */
  private def openAt(raffle: Raffle, now: Instant): Either[RegistrationRejected, Vector[ParticipantId]] =
    raffle.state match {
      case RaffleState.Initial => Left(RegistrationRejected.RaffleNotFound)
      // Непроведённый розыгрыш есть, и чтение его показывает: регистрация в нём закрыта, а не отсутствует.
      case RaffleState.NotHeld(_) => Left(RegistrationRejected.RegistrationClosed)
      case RaffleState.Open(terms, entries) =>
        if (now.isBefore(terms.closesAt)) Right(entries) else Left(RegistrationRejected.RegistrationClosed)
      case RaffleState.Fixed(_, _) | RaffleState.Drawn(_, _, _, _) => Left(RegistrationRejected.RegistrationClosed)
    }
}
