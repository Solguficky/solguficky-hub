package auction.aggregate

/** Жизненный цикл сходки из ответа `CheckMeetupAuthority` (ADR-047, дополнение 2026-10-12). */
enum MeetupLifecycle {
  case Planned
  case Held
  case Cancelled
}

/** Видимость сходки из того же ответа. */
enum MeetupVisibility {
  case Hidden
  case Visible
}

/** Состояние сходки, на котором стоят ворота: аукцион наследует его, а реплики сходки у Auction нет. */
final case class MeetupStanding(lifecycle: MeetupLifecycle, visibility: MeetupVisibility)

/**
 * Что команда администратора требует от состояния сходки (ADR-047, дополнение 2026-10-12, «Ворота»). Отменённая сходка
 * закрывает любую команду, кроме удаления и отмены аукциона, скрытая — открытие торгов.
 */
enum MeetupGate {

  /** Сходка не отменена. */
  case NotCancelled

  /** Сходка не отменена и видна: открытие торгов. */
  case Published

  /** Состояние не смотрится: удаление и отмена аукциона, чтение пульта и ставка зала. */
  case Unconditional
}

object MeetupGate {

  /**
   * Решение ворот по состоянию из ответа Meetups. Состояния нет — Meetups старее Auction или ответ без него — команде,
   * которой оно нужно, это `Unavailable`, а не «видна и не отменена»: иначе выкладка Auction раньше Meetups открыла бы
   * торги у отменённой сходки.
   */
  def admit(gate: MeetupGate, standing: Option[MeetupStanding]): Option[Denial] =
    gate match {
      case MeetupGate.Unconditional => None
      case MeetupGate.NotCancelled | MeetupGate.Published =>
        standing match {
          case None => Some(Denial.Unavailable)
          case Some(MeetupStanding(MeetupLifecycle.Cancelled, _)) => Some(Denial.MeetupCancelled)
          case Some(MeetupStanding(_, MeetupVisibility.Hidden)) if gate == MeetupGate.Published =>
            Some(Denial.MeetupHidden)
          case Some(_) => None
        }
    }
}
