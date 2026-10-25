package auction.raffle

import auction.lot.OpId
import auction.lot.ParticipantId

import java.time.Instant

/*
 * Ядро розыгрыша среди участников (ADR-066): `decide` и `apply` чистыми функциями, без актора, журнала и часов. Код
 * этого пакета не знает торгов — ни лота, ни ставки, ни реестра аукциона (ADR-066, п. 1), и держит это тест границы
 * `RaffleBoundarySpec`: участие даёт только право `place_bids`, которое проверяет граница, а не история ставок.
 */

/**
 * Условия, объявленные при открытии регистрации: момент закрытия, seed, раунд маяка и приз (ADR-066, дополнение
 * 2026-10-21; приза может не быть). После открытия не меняются.
 */
final case class RaffleTerms(closesAt: Instant, seed: Seed, round: Long, prize: Option[String] = None) {
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
 *   - `AwaitingWinner` — пул зафиксирован с ручным итогом (ADR-066, дополнение 2026-10-24): маяк не опрашивается,
 *     победителя называет администратор номером билета. Пул в нём всегда непустой.
 *   - `Drawn` — значение раунда получено, жеребьёвка проведена и больше не меняется.
 *   - `Assigned` — администратор назначил победителя номером билета; итог, как у `Drawn`, больше не меняется.
 *   - `Cancelled` — аукцион отменён до жеребьёвки (ADR-066, дополнение 2026-10-12): регистраций розыгрыш больше не
 *     принимает и маяк не опрашивает. `participants` — регистрации или билеты на момент отмены, `at` — её время.
 */
enum RaffleState {
  case Initial
  case NotHeld(closesAt: Instant)
  case Open(terms: RaffleTerms, entries: Vector[ParticipantId])
  case Fixed(terms: RaffleTerms, tickets: Vector[ParticipantId])
  case AwaitingWinner(terms: RaffleTerms, tickets: Vector[ParticipantId])
  case Drawn(terms: RaffleTerms, tickets: Vector[ParticipantId], randomness: Randomness, at: Instant)
  case Assigned(terms: RaffleTerms, tickets: Vector[ParticipantId], ticket: Int, at: Instant)
  case Cancelled(terms: RaffleTerms, participants: Vector[ParticipantId], at: Instant)
}

/**
 * События журнала розыгрыша. `PoolFixed.byHand` — режим итога, прочитанный из настройки сервиса в момент фиксации:
 * событие его и хранит, поэтому рестарт решения не переигрывает. У пустого пула он всегда `false` — итога нет.
 */
enum RaffleEvent {
  case RaffleOpened(closesAt: Instant, seed: Seed, round: Long, prize: Option[String] = None)
  case RaffleNotHeld(closesAt: Instant)
  case Registered(participant: ParticipantId)
  case RegistrationCancelled(participant: ParticipantId)
  case PoolFixed(tickets: Vector[ParticipantId], byHand: Boolean = false)
  case RaffleDrawn(randomness: Randomness, at: Instant)
  case WinnerAssigned(ticket: Int, at: Instant)
  case RaffleCancelled(at: Instant)
}

final case class RaffleEnvelope(sequence: Long, opId: OpId, event: RaffleEvent)

/** Открытие регистрации по команде аукциона, открывшего онлайн-торги. */
final case class OpenRaffle(closesAt: Instant, prize: Option[String] = None)

final case class Register(participant: ParticipantId, opId: OpId)

final case class CancelRegistration(participant: ParticipantId, opId: OpId)

/**
 * Фиксация пула в момент закрытия; `excluded` — регистрации тех, кто к закрытию потерял право, `byHand` — итог подводит
 * администратор, а не маяк (настройка сервиса, ADR-066, дополнение 2026-10-24).
 */
final case class FixPool(excluded: Set[ParticipantId], byHand: Boolean = false)

final case class DrawWinner(randomness: Randomness, at: Instant)

/** Ручной итог: номер выигравшего билета от администратора, которого право уже проверила граница. */
final case class AssignWinner(ticket: Int, opId: OpId)

/** Отмена розыгрыша по команде аукциона, отменённого после старта торгов; `op_id` выводит аукцион. */
final case class CancelRaffle(opId: OpId)

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

/**
 * Отказы ручного итога: розыгрыша нет, пул не ждёт итога администратора, номера нет в пуле, итог уже есть и это другой
 * билет, `op_id` занят другой командой.
 */
enum AssignRejected {
  case RaffleNotFound
  case NotAwaitingWinner
  case TicketNotInPool(tickets: Int)
  case AlreadyDrawn(winningTicket: Int)
  case OpIdTaken
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
            RaffleEvent.RaffleOpened(command.closesAt, seed, Quicknet.roundFor(command.closesAt), command.prize)
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
        val tickets = entries.filterNot(command.excluded.contains)
        Right(RaffleEvent.PoolFixed(tickets, command.byHand && tickets.nonEmpty))
      case RaffleState.Fixed(_, _) | RaffleState.AwaitingWinner(_, _) | RaffleState.Drawn(_, _, _, _) |
          RaffleState.Assigned(_, _, _, _) =>
        Left(FixPoolRejected.AlreadyFixed)
      case RaffleState.Cancelled(_, _, _) => Left(FixPoolRejected.NotOpen)
    }

  /** Жеребьёвка одна: повторная отклоняется, и результат неизменяем (ADR-066, п. 9). */
  def decide(raffle: Raffle, command: DrawWinner): Either[DrawRejected, RaffleEvent] =
    raffle.state match {
      case RaffleState.Fixed(_, tickets) if tickets.isEmpty => Left(DrawRejected.NoTickets)
      case RaffleState.Fixed(_, _) => Right(RaffleEvent.RaffleDrawn(command.randomness, command.at))
      case RaffleState.Drawn(_, _, _, _) | RaffleState.Assigned(_, _, _, _) => Left(DrawRejected.AlreadyDrawn)
      case RaffleState.Initial | RaffleState.NotHeld(_) | RaffleState.Open(_, _) | RaffleState.AwaitingWinner(_, _) |
          RaffleState.Cancelled(_, _, _) =>
        Left(DrawRejected.NotAwaitingBeacon)
    }

  /**
   * Ручной итог (ADR-066, дополнение 2026-10-24): только у пула, который ждёт администратора, и только номером из 1…N.
   * Итог один: тот же номер после назначения принят без события, другой — `AlreadyDrawn`. Повтор `op_id` получает
   * исходный конверт, если он назначал тот же номер.
   */
  def decide(raffle: Raffle, command: AssignWinner, now: Instant): Either[AssignRejected, RaffleDecision] =
    raffle.seen.get(command.opId) match {
      case Some(original) =>
        original.event match {
          case RaffleEvent.WinnerAssigned(ticket, _) if ticket == command.ticket =>
            Right(RaffleDecision.Repeated(original))
          case _ => Left(AssignRejected.OpIdTaken)
        }
      case None =>
        raffle.state match {
          case RaffleState.AwaitingWinner(_, tickets) =>
            if (command.ticket >= 1 && command.ticket <= tickets.size)
              Right(RaffleDecision.Accepted(RaffleEvent.WinnerAssigned(command.ticket, now)))
            else Left(AssignRejected.TicketNotInPool(tickets.size))
          case RaffleState.Assigned(_, _, ticket, _) =>
            if (ticket == command.ticket) Right(RaffleDecision.Unchanged) else Left(AssignRejected.AlreadyDrawn(ticket))
          case drawn @ RaffleState.Drawn(_, _, _, _) =>
            Left(AssignRejected.AlreadyDrawn(winningTicket(drawn).getOrElse(0)))
          case RaffleState.Initial => Left(AssignRejected.RaffleNotFound)
          case RaffleState.NotHeld(_) | RaffleState.Open(_, _) | RaffleState.Fixed(_, _) |
              RaffleState.Cancelled(_, _, _) =>
            Left(AssignRejected.NotAwaitingWinner)
        }
    }

  /**
   * Отмена вместе с аукционом (ADR-066, дополнение 2026-10-12): что завершилось, остаётся. Отменяется розыгрыш с
   * открытой регистрацией и пул, ждущий маяка или администратора. Без события — розыгрыш, которого нет или который не
   * проводится, пул без билетов, проведённая жеребьёвка и уже отменённый: итог у них есть или его не будет и так.
   * Повтор `op_id` получает исходный конверт.
   */
  def decide(raffle: Raffle, command: CancelRaffle, now: Instant): RaffleDecision =
    raffle.seen.get(command.opId) match {
      case Some(original) => RaffleDecision.Repeated(original)
      case None =>
        raffle.state match {
          case RaffleState.Open(_, _) => RaffleDecision.Accepted(RaffleEvent.RaffleCancelled(now))
          case RaffleState.Fixed(_, tickets) if tickets.nonEmpty =>
            RaffleDecision.Accepted(RaffleEvent.RaffleCancelled(now))
          case RaffleState.AwaitingWinner(_, _) => RaffleDecision.Accepted(RaffleEvent.RaffleCancelled(now))
          case RaffleState.Initial | RaffleState.NotHeld(_) | RaffleState.Fixed(_, _) | RaffleState.Drawn(_, _, _, _) |
              RaffleState.Assigned(_, _, _, _) | RaffleState.Cancelled(_, _, _) =>
            RaffleDecision.Unchanged
        }
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

  /**
   * Номер выигравшего билета, когда итог есть: жеребьёвка по маяку считает его формулой [[Draw.winner]], ручной итог
   * хранит его в состоянии. Экран итога, лог и факт шины берут его отсюда и не расходятся.
   */
  def winningTicket(state: RaffleState): Option[Int] =
    state match {
      case RaffleState.Drawn(terms, tickets, randomness, _) => Some(Draw.winner(terms.seed, tickets.size, randomness))
      case RaffleState.Assigned(_, _, ticket, _) => Some(ticket)
      case RaffleState.Initial | RaffleState.NotHeld(_) | RaffleState.Open(_, _) | RaffleState.Fixed(_, _) |
          RaffleState.AwaitingWinner(_, _) | RaffleState.Cancelled(_, _, _) =>
        None
    }

  /** Номер билета участника в зафиксированном пуле, с единицы. */
  def ticketOf(tickets: Vector[ParticipantId], participant: ParticipantId): Option[Int] =
    Option(tickets.indexOf(participant)).filter(_ >= 0).map(_ + 1)

  def apply(raffle: Raffle, envelope: RaffleEnvelope): Raffle = {
    val state = (raffle.state, envelope.event) match {
      case (RaffleState.Initial, RaffleEvent.RaffleOpened(closesAt, seed, round, prize)) =>
        RaffleState.Open(RaffleTerms(closesAt, seed, round, prize), Vector.empty)
      case (RaffleState.Initial, RaffleEvent.RaffleNotHeld(closesAt)) => RaffleState.NotHeld(closesAt)
      case (RaffleState.Open(terms, entries), RaffleEvent.Registered(participant)) =>
        RaffleState.Open(terms, entries.filterNot(_ == participant) :+ participant)
      case (RaffleState.Open(terms, entries), RaffleEvent.RegistrationCancelled(participant)) =>
        RaffleState.Open(terms, entries.filterNot(_ == participant))
      case (RaffleState.Open(terms, _), RaffleEvent.PoolFixed(tickets, byHand)) =>
        if (byHand) RaffleState.AwaitingWinner(terms, tickets) else RaffleState.Fixed(terms, tickets)
      case (RaffleState.Fixed(terms, tickets), RaffleEvent.RaffleDrawn(randomness, at)) =>
        RaffleState.Drawn(terms, tickets, randomness, at)
      case (RaffleState.AwaitingWinner(terms, tickets), RaffleEvent.WinnerAssigned(ticket, at)) =>
        RaffleState.Assigned(terms, tickets, ticket, at)
      // Ядро жеребьёвку ручному пулу не даёт, но журнал — факт: образ, откаченный до PER-727, читает такой пул ждущим
      // маяка и может провести жеребьёвку. Возврат на новый образ поднимает её итог, а не роняет розыгрыш.
      case (RaffleState.AwaitingWinner(terms, tickets), RaffleEvent.RaffleDrawn(randomness, at)) =>
        RaffleState.Drawn(terms, tickets, randomness, at)
      case (RaffleState.AwaitingWinner(terms, tickets), RaffleEvent.RaffleCancelled(at)) =>
        RaffleState.Cancelled(terms, tickets, at)
      case (RaffleState.Open(terms, entries), RaffleEvent.RaffleCancelled(at)) =>
        RaffleState.Cancelled(terms, entries, at)
      case (RaffleState.Fixed(terms, tickets), RaffleEvent.RaffleCancelled(at)) =>
        RaffleState.Cancelled(terms, tickets, at)
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
      case RaffleState.Fixed(_, _) | RaffleState.AwaitingWinner(_, _) | RaffleState.Drawn(_, _, _, _) |
          RaffleState.Assigned(_, _, _, _) | RaffleState.Cancelled(_, _, _) =>
        Left(RegistrationRejected.RegistrationClosed)
    }
}
