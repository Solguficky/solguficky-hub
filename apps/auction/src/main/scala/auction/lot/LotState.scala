package auction.lot

import java.time.Duration
import java.time.Instant
import java.util.UUID

/** Участник — идентификатор платформы, а не Telegram user id (RFC-011, «Идентичность»). */
final case class ParticipantId(value: UUID)

/** Ставка адресуема: на неё ссылаются лидерство, продажа и уведомление. */
final case class BidId(value: UUID)

/** Ключ идемпотентности команды; генерирует отправитель, проверяет домен (П-06). */
final case class OpId(value: UUID)

/** Торговая сессия, которой принадлежит лот (RFC-011, «Идентичность»). */
final case class SessionId(value: UUID)

/**
 * Параметры анти-снайпа (П-04): ставка за `window` до дедлайна продлевает его на `extension`, не больше `maxExtensions`
 * раз. Правило, которое их читает, — лист анти-снайпа; здесь они уже лежат в конфигурации, потому что `LotOpened` несёт
 * её целиком (ADR-047), и журнал не должен меняться, когда правило появится.
 */
final case class AntiSnipe(window: Duration, extension: Duration, maxExtensions: Int)

/**
 * Конфигурация торгов, замороженная на входе в `Trading` (И-10) и пришедшая целиком из `LotOpened` (RFC-011, И-07).
 *
 * Анти-снайп и признак прокси приём ставки пока не читает: их правила — соседние листья. Валюта политики шага совпадает
 * с валютой лота по построению: иначе шаг складывался бы с ценой другой валюты (И-04).
 */
final case class LotConfig private[lot] (
    currency: CurrencyCode,
    stepPolicy: StepPolicy,
    antiSnipe: AntiSnipe,
    proxyEnabled: Boolean
)

object LotConfig {

  def of(
      currency: CurrencyCode,
      stepPolicy: StepPolicy,
      antiSnipe: AntiSnipe,
      proxyEnabled: Boolean
  ): Either[StepPolicyInvalid, LotConfig] =
    if (stepPolicy.currency != currency) Left(StepPolicyInvalid.MixedCurrency)
    else Right(LotConfig(currency, stepPolicy, antiSnipe, proxyEnabled))

  /** Проверка И-15 на входе `ScheduleLot`: политика строится теми же конструкторами, что закрывают её тип. */
  def parse(input: LotConfigInput): Either[StepPolicyInvalid, LotConfig] = {
    val policy = input.stepPolicy match {
      case StepPolicyInput.Fixed(step) => StepPolicy.fixed(step)
      case StepPolicyInput.Tiered(tiers) => StepPolicy.tiered(tiers)
    }
    policy.flatMap(of(input.currency, _, input.antiSnipe, input.proxyEnabled))
  }
}

/**
 * Политика шага, как её прислал организатор, до проверки И-15. Проверенная [[StepPolicy]] противоречивой быть не может,
 * поэтому отказ `StepPolicyInvalid` у `ScheduleLot` возможен, только если вход несёт непроверенную форму.
 */
enum StepPolicyInput {
  case Fixed(step: Money)
  case Tiered(tiers: List[StepPolicy.Tier])
}

/** Конфигурация торгов во входе `ScheduleLot` до проверки: [[LotConfig.parse]] превращает её в [[LotConfig]]. */
final case class LotConfigInput(
    currency: CurrencyCode,
    stepPolicy: StepPolicyInput,
    antiSnipe: AntiSnipe,
    proxyEnabled: Boolean
)

/**
 * Условия торгов, которые лот знает до открытия: та часть `LotOpened`, что без дедлайна (ADR-047, `Schedule`).
 * Стартовая цена в валюте конфигурации по построению — иначе `OpenLot` получил бы отказ, которого у него нет (RFC-011,
 * «Как лот попадает в Draft и Scheduled»).
 */
final case class Schedule private[lot] (startingPrice: Money, config: LotConfig)

object Schedule {

  def of(startingPrice: Money, config: LotConfig): Either[ScheduleLotRejected, Schedule] =
    if (startingPrice.currency != config.currency) Left(ScheduleLotRejected.CurrencyMismatch)
    else Right(Schedule(startingPrice, config))
}

/** Фаза торгов: `Online` из открытия лота, `Live` из возврата в финал; меняет правило приёма ставки (ADR-049). */
enum Phase {
  case Online
  case Live
}

/**
 * Состояние лота в торгах (RFC-011, «Состояние лота»).
 *
 * До первой ставки `currentPrice` — стартовая цена, а `leader` пуст (И-02). `deadline` пуст, если лот ведёт человек.
 * Прокси-лимиты, счётчик продлений и отметка финала не представлены: их читают соседние правила, и они появятся вместе
 * с ними.
 */
final case class TradingState(
    config: LotConfig,
    currentPrice: Money,
    ask: Option[Money],
    leader: Option[ParticipantId],
    leadingBidId: Option[BidId],
    phase: Phase,
    deadline: Option[Instant]
)

/** Лот удержан для живого финала: те же цена и лидер, дедлайна и ask нет (П-09). */
final case class HeldState(
    config: LotConfig,
    currentPrice: Money,
    leader: Option[ParticipantId],
    leadingBidId: Option[BidId]
)

final case class Sale(winner: ParticipantId, price: Money, bidId: BidId, at: Instant)

/**
 * Состояния лота (RFC-011, «Состояние лота»). Сумма запечатана: остальные терминальные добавятся случаями, а
 * исчерпывающий `match` в [[Lot.decide]] покажет, где их обработать.
 *
 * `Initial` — «в журнале лота ещё ничего нет». В RFC-011 такого состояния нет: там до `LotDrafted` лота не существует.
 * Под шардингом entity поднимается на любой `lot_id`, и лот без журнала — это `Initial`; из него выводит только
 * `LotDrafted`, а любая другая команда получает `LotNotFound`. В журнал и snapshot он не попадает.
 */
enum LotState {
  case Initial
  case Draft
  case Scheduled(schedule: Schedule)
  case Trading(state: TradingState)
  case Held(state: HeldState)
  case Sold(sale: Sale)
}

/** Кто отправил ставку: участник из бота или аукционист за зал. */
enum BidSource {
  case Bot
  case Floor
}

/** Происхождение ставки: ручная команда или производная ставка прокси (П-02). */
enum BidOrigin {
  case Manual
  case Proxy
}

final case class PlaceBid(participant: ParticipantId, amount: Money, opId: OpId, source: BidSource)

/**
 * Рождение лота. Отправляет сессия после своего `LotAdded`, и лот с этой минуты принадлежит ей: сессия — часть
 * рождения, а не отдельная привязка (RFC-011, «Команды и события»).
 */
final case class DraftLot(session: SessionId, opId: OpId)

/** Условия торгов целиком: каждая правка до `LotOpened` заменяет прежние, а не дополняет их. */
final case class ScheduleLot(startingPrice: Money, config: LotConfigInput, opId: OpId)

/**
 * Открытие торгов лота. Стартовая цена и конфигурация берутся из `Scheduled`, а дедлайн приходит от сессии, которой он
 * принадлежит (RFC-011, «Вход и выход команд»).
 */
final case class OpenLot(deadline: Option[Instant], opId: OpId)

/**
 * События лота. `LotOpened` несёт всю конфигурацию торгов, чтобы состояние восстанавливалось из журнала без обращения
 * наружу (И-07). `previousLeader` при первой ставке отсутствует, а не равен нулю (RFC-011, П-01).
 *
 * У `LotDrafted` payload нет (ADR-047): сессия лежит в конверте строки. В доменном событии она полем, потому что
 * принадлежность лота сессии восстанавливает `apply`, а конверт ядро не читает. `LotScheduled` несёт `Schedule`
 * снимком.
 */
enum LotEvent {
  case LotDrafted(session: SessionId)
  case LotScheduled(schedule: Schedule)
  case LotOpened(startingPrice: Money, config: LotConfig, deadline: Option[Instant])
  case BidPlaced(
      bidId: BidId,
      participant: ParticipantId,
      amount: Money,
      previousLeader: Option[ParticipantId],
      origin: BidOrigin,
      source: BidSource
  )
}

/**
 * Строка журнала агрегата в той части конверта, которую читает ядро.
 *
 * `sequence` назначает не ядро, а тот, кто пишет журнал: на рабочем пути это номер события в Pekko Persistence. Ядро
 * только сворачивает журнал в его порядке (П-07); второго счётчика рядом с журнальным нет.
 */
final case class Envelope(sequence: Long, opId: OpId, event: LotEvent)

/*
 * `LotNotFound` — ответ лоту в `Initial` на любую команду, кроме `DraftLot`: «тот же ответ, что и команде к
 * неизвестному `lot_id`» (RFC-011, «Команды и события»). Под шардингом это одно и то же.
 */

/** Отказ `DraftLot`: лот уже родился, в каком бы состоянии он ни был. */
enum DraftLotRejected {
  case LotAlreadyExists
}

/**
 * Отказы `ScheduleLot`. `SchedulingClosed` — после `LotOpened` условия заморожены (И-10). `StepPolicyInvalid` называет
 * нарушение И-15, `CurrencyMismatch` — стартовую цену в валюте, отличной от конфигурации.
 */
enum ScheduleLotRejected {
  case LotNotFound
  case SchedulingClosed
  case StepPolicyInvalid(reason: auction.lot.StepPolicyInvalid)
  case CurrencyMismatch
}

/**
 * Отказы `OpenLot`. `LotNotScheduled` — ответ лоту без условий торгов или уже открытому. `AnotherLotActive` проверяет
 * сессия, а не лот (PER-325).
 */
enum OpenLotRejected {
  case LotNotFound
  case LotNotScheduled
}

/**
 * Именованные отказы `PlaceBid` (RFC-011, «Команды и события»). Отказ событий не пишет и повтором не защищён (П-06).
 */
enum PlaceBidRejected {
  case LotNotFound
  case LotNotOpen
  case LotOnHold
  case CurrencyMismatch
  case BidderIsLeader
  case BidNotAtNextPrice(expected: Money)
  case BidBelowMinimum(minRequired: Money)
}
