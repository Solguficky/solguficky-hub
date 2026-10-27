package auction.aggregate

import auction.lot.OpId

import java.time.Instant
import java.util.UUID

/**
 * Идентификатор периода «Счастливых часов» — UUIDv5 от `op_id` команды, которая его создала ([[HappyHourPeriod.idOf]]).
 */
final case class HappyHourPeriodId(value: UUID)

/**
 * Период «Счастливых часов» аукциона — полуинтервал `[from, until)` внутри онлайн-этапа (ADR-047, дополнение
 * 2026-10-27). Сам период торгов не меняет: условия лотов в нём — шаг и стартовую цену — задаёт следующий лист
 * (PER-786). До начала период можно удалить, с начала он заморожен.
 */
final case class HappyHourPeriod(id: HappyHourPeriodId, from: Instant, until: Instant) {

  /** Период начался: `at` не раньше его начала. */
  def startedAt(at: Instant): Boolean = !at.isBefore(from)
}

object HappyHourPeriod {

  /**
   * Пространство имён UUIDv5 идентификатора периода. Не меняется никогда: другое пространство дало бы повтору той же
   * команды другой период.
   */
  val Namespace: UUID = UUID.fromString("5f0c2a1e-7d43-4b9a-9c6e-3e8b1d2f4a70")

  /** Период команды с этим `op_id`: повтор после потерянного ответа называет тот же период. */
  def idOf(opId: OpId): HappyHourPeriodId = HappyHourPeriodId(Auction.nameBased(Namespace, opId.value.toString))
}

/** Создание периода «Счастливых часов» (ADR-047, дополнение 2026-10-27): начало и конец задаёт администратор. */
final case class CreateHappyHourPeriod(from: Instant, until: Instant, opId: OpId)

/** Удаление периода до его начала (ADR-047, дополнение 2026-10-27). */
final case class DeleteHappyHourPeriod(period: HappyHourPeriodId, opId: OpId)

/**
 * Отказы создания периода в порядке проверки. `PeriodInPast` — начало раньше серверного момента команды: период не
 * действует задним числом. `PeriodEmpty` — конец не позже начала. `PeriodOutsideOnlinePhase` — период не лежит внутри
 * `[opensAt, closesAt]` онлайн-этапа; онлайн-этап без `closesAt` верхней границы не имеет, и ответ тот же.
 */
enum CreateHappyHourPeriodRejected {
  case AuctionNotFound
  case NotInPrebidding
  case PeriodInPast
  case PeriodEmpty
  case PeriodOutsideOnlinePhase
}

/** Отказы удаления периода: периода нет или он удалён, он уже начался. */
enum DeleteHappyHourPeriodRejected {
  case AuctionNotFound
  case NotInPrebidding
  case PeriodNotFound
  case PeriodStarted
}
