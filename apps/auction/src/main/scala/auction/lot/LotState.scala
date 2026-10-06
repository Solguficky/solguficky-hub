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

/** Аукцион, которому принадлежит лот (RFC-011, «Идентичность»; до PER-423 — «торговая сессия»). */
final case class AuctionId(value: UUID)

/**
 * Параметры анти-снайпа (П-04): ставка за `window` до дедлайна продлевает его на `extension`, не больше `maxExtensions`
 * раз. Лежат в конфигурации, потому что `LotOpened` несёт её целиком (ADR-047): правило не читает настроек снаружи.
 */
final case class AntiSnipe(window: Duration, extension: Duration, maxExtensions: Int)

/**
 * Конфигурация торгов, замороженная на входе в `Trading` (И-10) и пришедшая целиком из `LotOpened` (RFC-011, И-07).
 *
 * Анти-снайп читают ставка и прокси-лимит, признак прокси — `SetProxyLimit`. Валюта политики шага совпадает с валютой
 * лота по построению: иначе шаг складывался бы с ценой другой валюты (И-04).
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
 * Действующий прокси-лимит участника (RFC-011, «Состояние лота»).
 *
 * `setSeq` — `sequence` события `ProxyLimitSet`, которое его записало: в payload он не входит, а берётся из конверта
 * (ADR-047), и им П-02 решает равенство максимумов (П-07). `setAt` из RFC не хранится: ни одно правило его не читает, а
 * время конверта ядро не видит.
 */
final case class ProxyLimit(max: Money, setSeq: Long)

/**
 * Состояние лота в торгах (RFC-011, «Состояние лота»).
 *
 * До первой ставки `currentPrice` — стартовая цена, а `leader` пуст (И-02). `deadline` пуст, если лот ведёт человек.
 * `proxyLimits` держит И-03 по построению: ключ — участник, и новый лимит заменяет прежний. `extensionsUsed` — сколько
 * раз анти-снайп уже продлил дедлайн (П-04); он лежит рядом с дедлайном, чтобы лимит продлений восстанавливался из
 * журнала вместе с ним (ПП-2). `markedForFinal` — лот отмечен для финала (П-09): торги идут как обычно, а закрытие по
 * дедлайну удержит его вместо продажи. Это состояние, а не настройка: `false` из `LotOpened` и `LotResumed`, `true` из
 * `LotMarkedForFinal` (И-10).
 */
final case class TradingState(
    config: LotConfig,
    currentPrice: Money,
    ask: Option[Money],
    leader: Option[ParticipantId],
    leadingBidId: Option[BidId],
    phase: Phase,
    deadline: Option[Instant],
    extensionsUsed: Int,
    proxyLimits: Map[ParticipantId, ProxyLimit],
    markedForFinal: Boolean
)

/**
 * Лот удержан для живого финала: те же цена, лидер, лимиты и счётчик продлений, что были в торгах на момент дедлайна,
 * дедлайна и ask нет (П-09). Лимит, записанный в удержании, ждёт финала: пересчёт П-02 здесь не запускается.
 */
final case class HeldState(
    config: LotConfig,
    currentPrice: Money,
    leader: Option[ParticipantId],
    leadingBidId: Option[BidId],
    proxyLimits: Map[ParticipantId, ProxyLimit],
    extensionsUsed: Int
)

final case class Sale(winner: ParticipantId, price: Money, bidId: BidId, at: Instant)

/** Почему лот закрылся без продажи. Резервной цены в модели нет, поэтому причина одна (RFC-011, О-2). */
enum UnsoldReason {
  case NoBids
}

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
  case Unsold(reason: UnsoldReason)
}

/** Кто отправил ставку: участник из бота или аукционист за зал. */
enum BidSource {
  case Bot
  case Floor
}

/**
 * Происхождение ставки: ручная команда или производная ставка прокси (П-02). Ручная несёт канал, через который её
 * поставили; у производной канала нет — её поставила система в пределах лимита (`ProxyBid` в `auction_events.proto`).
 */
enum BidOrigin {
  case Manual(source: BidSource)
  case Proxy
}

final case class PlaceBid(participant: ParticipantId, amount: Money, opId: OpId, source: BidSource)

/** Прокси-лимит участника на лот: новый заменяет прежний, каким бы он ни был (И-03). */
final case class SetProxyLimit(participant: ParticipantId, max: Money, opId: OpId)

/** Снятие прокси-лимита участником, в том числе лидером (RFC-011, О-3). */
final case class WithdrawProxyLimit(participant: ParticipantId, opId: OpId)

/**
 * Рождение лота. Отправляет аукцион после своего `LotAdded`, и лот с этой минуты принадлежит ему: аукцион — часть
 * рождения, а не отдельная привязка (RFC-011, «Команды и события»).
 */
final case class DraftLot(auction: AuctionId, opId: OpId)

/** Условия торгов целиком: каждая правка до `LotOpened` заменяет прежние, а не дополняет их. */
final case class ScheduleLot(startingPrice: Money, config: LotConfigInput, opId: OpId)

/**
 * Открытие торгов лота. Стартовая цена и конфигурация берутся из `Scheduled`, а дедлайн приходит от аукциона, которому
 * он принадлежит (RFC-011, «Вход и выход команд»).
 */
final case class OpenLot(deadline: Option[Instant], opId: OpId)

/**
 * Почему лот закрывают: наступил дедлайн — тогда наступил ли он, решает сам лот (RFC-011, П-05), — или закрывает
 * ведущий, и дедлайн не проверяется.
 */
enum CloseReason {
  case DeadlineReached
  case ByAuctioneer
}

/** Закрытие лота. По дедлайну его шлёт аукцион, когда наступает дедлайн лота (ADR-045); время решения — серверное. */
final case class CloseLot(reason: CloseReason, opId: OpId)

/**
 * Отметка лота для финала (RFC-011, П-09). Шлёт аукцион по выбору организатора (PER-320); отметка торгов не
 * останавливает, а меняет исход закрытия по дедлайну.
 */
final case class MarkForFinal(opId: OpId)

/**
 * Снятие отметки для финала (PER-320, ADR-047, дополнение 2026-10-06). Подчиняется тому же дедлайну, что отметка:
 * снятая до него отметка возвращает лоту обычное закрытие, а удержанный лот с финала этой командой не снимается.
 */
final case class UnmarkForFinal(opId: OpId)

/** Возврат удержанного лота в торги живого финала (П-09): без дедлайна и ask, в фазе `Live`. */
final case class ResumeLot(opId: OpId)

/**
 * События лота. `LotOpened` несёт всю конфигурацию торгов, чтобы состояние восстанавливалось из журнала без обращения
 * наружу (И-07). `previousLeader` при первой ставке отсутствует, а не равен нулю (RFC-011, П-01).
 *
 * У `LotDrafted` payload нет (ADR-047): аукцион лежит в конверте строки. В доменном событии он полем, потому что
 * принадлежность лота аукциону восстанавливает `apply`, а конверт ядро не читает. `LotScheduled` несёт `Schedule`
 * снимком.
 *
 * `DeadlineExtended` собственной команды не имеет (ADR-047): его пишет ставка или прокси-лимит последним событием своей
 * транзакции. Он несёт итог — новый дедлайн и счётчик, а не приращение, поэтому свёртка не зависит от того, с какого
 * snapshot она началась.
 *
 * `LotMarkedForFinal` и `LotResumed` payload не несут, `LotHeldForFinal` — только время удержания (ADR-047, дополнение
 * 2026-09-24): цена, лидер и лимиты удержанного лота — те, что свёрнуты из журнала до него. `LotUnmarkedForFinal` тоже
 * без payload (дополнение 2026-10-06): он только снимает признак.
 *
 * `overtakenByProxy` у ручной ставки — её той же командой перебила производная ставка другого участника, и лидерство,
 * взятое ею, команду не пережило. Свёртка его не читает: это знание о транзакции для потребителей факта, которое
 * проекция публикации, видящая по одному событию, иначе не получила бы (PER-473). У производной ставки всегда `false`.
 */
enum LotEvent {
  case LotDrafted(auction: AuctionId)
  case LotScheduled(schedule: Schedule)
  case LotOpened(startingPrice: Money, config: LotConfig, deadline: Option[Instant])
  case BidPlaced(
      bidId: BidId,
      participant: ParticipantId,
      amount: Money,
      previousLeader: Option[ParticipantId],
      origin: BidOrigin,
      overtakenByProxy: Boolean = false
  )
  case ProxyLimitSet(participant: ParticipantId, max: Money)
  case ProxyLimitWithdrawn(participant: ParticipantId)
  case DeadlineExtended(newDeadline: Instant, extensionsUsed: Int)
  case LotSold(winner: ParticipantId, price: Money, bidId: BidId, at: Instant)
  case LotUnsold(reason: UnsoldReason)
  case LotMarkedForFinal
  case LotHeldForFinal(at: Instant)
  case LotResumed
  case LotUnmarkedForFinal
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
 * нарушение И-15, `CurrencyMismatch` — стартовую цену в валюте, отличной от конфигурации. `OpIdTaken` — `op_id` уже
 * записан под другим событием лота; как у команд участника, на границе это статус, а не значение ответа.
 */
enum ScheduleLotRejected {
  case LotNotFound
  case OpIdTaken
  case SchedulingClosed
  case StepPolicyInvalid(reason: auction.lot.StepPolicyInvalid)
  case CurrencyMismatch
}

/**
 * Отказы `OpenLot`. `LotNotScheduled` — ответ лоту без условий торгов или уже открытому. `AnotherLotActive` проверяет
 * аукцион, а не лот: это отказ `StartNextLot` в финале (PER-334), в онлайн-торгах лоты открыты одновременно.
 */
enum OpenLotRejected {
  case LotNotFound
  case LotNotScheduled
}

/**
 * Именованные отказы `PlaceBid` (RFC-011, «Команды и события»). Отказ событий не пишет и повтором не защищён (П-06).
 *
 * `OpIdTaken` у трёх команд участника — `op_id` уже записан под другой командой: чужого участника или другого вида
 * (ADR-047, дополнение 2026-10-05). Как и `LotNotFound`, на границе это статус, а не значение ответа.
 */
enum PlaceBidRejected {
  case LotNotFound
  case OpIdTaken
  case LotNotOpen
  case LotOnHold(currentPrice: Money)
  case CurrencyMismatch
  case BidderIsLeader(currentPrice: Money)
  case BidNotAtNextPrice(expected: Money)
  case BidBelowMinimum(minRequired: Money)
}

/**
 * Отказы `SetProxyLimit` (ADR-047). `ProxyDisabledForLot` от входа не зависит и проверяется первым; валюта — до
 * сравнения с ценой, потому что суммы разных валют не сравниваются (И-04). `ProxyBelowCurrentPrice` — лимит ниже нижней
 * границы торга; лимит, равный ей, принимается: лидер вправе опустить свой лимит вплоть до текущей цены (RFC-011, О-3).
 */
enum SetProxyLimitRejected {
  case LotNotFound
  case OpIdTaken
  case LotNotOpen
  case ProxyDisabledForLot
  case CurrencyMismatch
  case ProxyBelowCurrentPrice(minLimit: Money)
}

/**
 * Отказы `CloseLot` (RFC-011, П-05). `LotNotOpen` — лот не в торгах и не удержан, в том числе уже закрытый (И-05).
 * `DeadlineNotReached` — закрытие по дедлайну, которого у лота нет или который ещё не наступил: планировщик лишь
 * присылает команду, а наступил ли момент, решает лот.
 */
enum CloseLotRejected {
  case LotNotFound
  case LotNotOpen
  case DeadlineNotReached
}

/**
 * Отказы `MarkForFinal` (RFC-011, П-09). `LotNotOpen` — лот не в торгах, в том числе удержанный или закрытый.
 * `NotInOnlinePhase` — лот уже в живом финале. `DeadlinePassed` — дедлайн наступил, даже если закрытие ещё не пришло:
 * гонку отметки и закрытия судит лот, а не планировщик. `OpIdTaken` — `op_id` уже записан под другим событием лота.
 */
enum MarkForFinalRejected {
  case LotNotFound
  case OpIdTaken
  case LotNotOpen
  case NotInOnlinePhase
  case AlreadyMarkedForFinal
  case DeadlinePassed
}

/**
 * Отказы `UnmarkForFinal` (ADR-047, дополнение 2026-10-06). `LotNotOpen` — лот ещё не в торгах или уже закрыт.
 * `DeadlinePassed` — дедлайн наступил, в том числе у удержанного лота: снять финалиста после дедлайна значило бы
 * продать лот задним числом. `NotMarkedForFinal` — отметки нет, снимать нечего.
 */
enum UnmarkForFinalRejected {
  case LotNotFound
  case OpIdTaken
  case LotNotOpen
  case NotInOnlinePhase
  case NotMarkedForFinal
  case DeadlinePassed
}

/** Отказы `ResumeLot`: вернуть в торги можно только удержанный лот; `OpIdTaken` — как у отметки. */
enum ResumeLotRejected {
  case LotNotFound
  case OpIdTaken
  case LotNotHeld
}

/** Отказы `WithdrawProxyLimit`: у участника нет действующего лимита на этот лот. */
enum WithdrawProxyLimitRejected {
  case LotNotFound
  case OpIdTaken
  case NoActiveProxyLimit
}
