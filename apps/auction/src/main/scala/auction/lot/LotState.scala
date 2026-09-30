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
 * Состояния лота, которые различают открытие и приём ставки. Сумма запечатана: `Draft`, `Scheduled` и остальные
 * терминальные добавятся случаями, а исчерпывающий `match` в [[Lot.decide]] покажет, где их обработать.
 *
 * `NotOpened` — временное начальное состояние: «в журнале лота ещё ничего нет». В RFC-011 его нет — там лот до торгов
 * проходит `Draft` и `Scheduled`, и их приносит PER-410, заменяя этот случай. Состояние ничего не несёт и в журнал не
 * попадает: из него выходит только `LotOpened`.
 */
enum LotState {
  case NotOpened
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
 * Открытие торгов лота. По RFC-011 вход — только `deadline?`, а стартовая цена и конфигурация берутся из `Scheduled`;
 * пока `Scheduled` нет (PER-410), команда несёт их сама. Сужается вход команды, а не событие: `LotOpened` уже несёт всю
 * конфигурацию торгов (ADR-047), и журнал от смены входа не меняется.
 */
final case class OpenLot(startingPrice: Money, config: LotConfig, deadline: Option[Instant], opId: OpId)

/**
 * События лота. `LotOpened` несёт всю конфигурацию торгов, чтобы состояние восстанавливалось из журнала без обращения
 * наружу (И-07). `previousLeader` при первой ставке отсутствует, а не равен нулю (RFC-011, П-01).
 */
enum LotEvent {
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

/**
 * Именованные отказы `OpenLot`. `LotNotScheduled` — ответ лоту, который уже не ждёт открытия. `CurrencyMismatch` —
 * стартовая цена в чужой валюте; вместе со входом команды он переедет к `ScheduleLot` (PER-410), где RFC-011 его и
 * держит. `AnotherLotActive` проверяет аукцион, а не лот (PER-325).
 */
enum OpenLotRejected {
  case LotNotScheduled
  case CurrencyMismatch
}

/**
 * Именованные отказы `PlaceBid` (RFC-011, «Команды и события»). Отказ событий не пишет и повтором не защищён (П-06).
 */
enum PlaceBidRejected {
  case LotNotOpen
  case LotOnHold
  case CurrencyMismatch
  case BidderIsLeader
  case BidNotAtNextPrice(expected: Money)
  case BidBelowMinimum(minRequired: Money)
}
