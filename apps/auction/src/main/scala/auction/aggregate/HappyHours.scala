package auction.aggregate

import auction.catalog.LotId
import auction.lot.CurrencyCode
import auction.lot.Lot
import auction.lot.LotState
import auction.lot.Money
import auction.lot.OpId
import auction.lot.Phase
import auction.lot.StepWindow
import auction.lot.WindowPeriod

import java.time.Instant
import java.util.UUID

/**
 * Идентификатор периода «Счастливых часов» — UUIDv5 от `op_id` команды, которая его создала ([[HappyHourPeriod.idOf]]).
 */
final case class HappyHourPeriodId(value: UUID)

/**
 * Период «Счастливых часов» аукциона — полуинтервал `[from, until)` внутри онлайн-этапа (ADR-047, дополнение
 * 2026-10-27). Сам период торгов не меняет: условия лотов в нём — шаг и стартовую цену — задаются отдельно
 * ([[SetHappyHourLotTerms]], PER-786). До начала период можно удалить, а условия лотов в нём — задать, заменить и
 * снять; с начала он заморожен.
 */
final case class HappyHourPeriod(id: HappyHourPeriodId, from: Instant, until: Instant) {

  /** Период начался: `at` не раньше его начала. */
  def startedAt(at: Instant): Boolean = !at.isBefore(from)

  /**
   * Окно лота с условиями `terms` в этом периоде: те же границы и идентификатор периода, по которому лот его узнает.
   */
  def windowOf(terms: HappyHourTerms): StepWindow =
    StepWindow(from, until, terms.step, terms.start, Some(WindowPeriod(id.value)))
}

/** Условия лота в периоде «Счастливых часов»: шаг и стартовая цена для лота без ставок, хотя бы одно из двух. */
final case class HappyHourTerms(step: Option[Money], start: Option[Money]) {
  require(step.isDefined || start.isDefined, "happy hour terms set a step, a starting price or both")
}

/**
 * Что аукцион записал об условиях лота `lot` в периоде `period` последней правкой (PER-786). `terms` пуст — условия
 * сняты: командой или удалением периода. `change` — `op_id` этой правки, от него выводится `op_id` доставки лоту
 * ([[LotRoster.periodWindowOf]]), поэтому после рестарта лот получает только последнюю правку, а не историю. Снятые
 * условия аукцион помнит, пока помнит журнал: лот мог не получить снятия до рестарта.
 */
final case class PeriodLotTerms(period: HappyHourPeriodId, lot: LotId, terms: Option[HappyHourTerms], change: OpId)

/**
 * Обычные условия лота в торгах онлайн-этапа, против которых сверяются условия в периоде (PER-786): валюта, стартовая
 * цена и обычный шаг при текущей цене. Аукцион условий лота не знает, поэтому их читают у лота до команды; шаг
 * сверяется с моментом команды — цена лота могла вырасти потом, и тогда правило шага берёт меньший из двух.
 */
final case class LotRegulars(currency: CurrencyCode, start: Money, step: Money)

object LotRegulars {

  /** Обычные условия лота в торгах онлайн-этапа; иначе их нет — лот не принимает условий периода. */
  def of(state: LotState): Option[LotRegulars] =
    state match {
      case LotState.Trading(trading) if trading.phase == Phase.Online =>
        val start = trading.course.fold(trading.currentPrice)(_.startingPrice)
        Some(LotRegulars(trading.config.currency, start, Lot.baseStep(trading, trading.currentPrice)))
      case _ => None
    }
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

/**
 * Задать или заменить условия лота в периоде до его начала (ADR-047, дополнение 2026-10-27, PER-786): шаг, стартовая
 * цена или оба. Ни одного — отказ: снятие — отдельная команда.
 */
final case class SetHappyHourLotTerms(
    period: HappyHourPeriodId,
    lot: LotId,
    step: Option[Money],
    start: Option[Money],
    opId: OpId
)

/** Снять условия лота в периоде до его начала (PER-786). Условий нет — принято без события. */
final case class ClearHappyHourLotTerms(period: HappyHourPeriodId, lot: LotId, opId: OpId)

/**
 * Отказы условий лота в периоде в порядке проверки. `PeriodNotFound` — периода нет или он удалён, `PeriodStarted` —
 * серверный момент команды не раньше его начала. `LotNotOpen` — аукцион не знает, что лот в торгах (И-14), или лот
 * ответил, что уже не в торгах онлайн-этапа. `AmountInvalid` — сумма не положительна или не в валюте лота.
 * `StepNotLower` и `StartNotLower` несут обычное значение, с которым сверились. `WindowsOverlap` — период пересекается
 * с другим окном того же лота: объявленным, запущенным или условиями другого периода (И-21).
 */
enum SetHappyHourLotTermsRejected {
  case AuctionNotFound
  case NotInPrebidding
  case PeriodNotFound
  case PeriodStarted
  case TermsEmpty
  case LotNotInAuction
  case LotNotOpen
  case AmountInvalid
  case StepNotLower(regular: Money)
  case StartNotLower(regular: Money)
  case WindowsOverlap(from: Instant, until: Instant)
}

/** Отказы снятия условий лота в периоде в порядке проверки — те же случаи, что у [[SetHappyHourLotTermsRejected]]. */
enum ClearHappyHourLotTermsRejected {
  case AuctionNotFound
  case NotInPrebidding
  case PeriodNotFound
  case PeriodStarted
  case LotNotInAuction
}
