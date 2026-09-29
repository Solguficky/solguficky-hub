package auction.lot

import java.time.Instant
import java.util.UUID

/** Участник — идентификатор платформы, а не Telegram user id (RFC-011, «Идентичность»). */
final case class ParticipantId(value: UUID)

/** Ставка адресуема: на неё ссылаются лидерство, продажа и уведомление. */
final case class BidId(value: UUID)

/** Ключ идемпотентности команды; генерирует отправитель, проверяет домен (П-06). */
final case class OpId(value: UUID)

/**
 * Конфигурация торгов, замороженная на входе в `Trading` (И-10).
 *
 * Здесь только то, что читает приём ставки. Параметры анти-снайпа и признак прокси придут вместе с правилами, которые
 * их читают. Валюта политики шага совпадает с валютой лота по построению: иначе шаг складывался бы с ценой другой
 * валюты (И-04).
 */
final case class LotConfig private[lot] (currency: CurrencyCode, stepPolicy: StepPolicy)

object LotConfig {

  def of(currency: CurrencyCode, stepPolicy: StepPolicy): Either[StepPolicyInvalid, LotConfig] =
    if (stepPolicy.currency != currency) Left(StepPolicyInvalid.MixedCurrency)
    else Right(LotConfig(currency, stepPolicy))
}

/** Фаза торгов: `Online` из открытия лота, `Live` из возврата в финал; меняет правило приёма ставки (ADR-049). */
enum Phase {
  case Online
  case Live
}

/**
 * Состояние лота в торгах (RFC-011, «Состояние лота»).
 *
 * До первой ставки `currentPrice` — стартовая цена, а `leader` пуст (И-02). Прокси-лимиты, дедлайн, счётчик продлений и
 * отметка финала не представлены: их читают соседние правила, и они появятся вместе с ними.
 */
final case class TradingState(
    config: LotConfig,
    currentPrice: Money,
    ask: Option[Money],
    leader: Option[ParticipantId],
    leadingBidId: Option[BidId],
    phase: Phase
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
 * Состояния лота, которые различает приём ставки. Сумма запечатана: состояния до торгов и остальные терминальные
 * добавятся случаями, а исчерпывающий `match` в [[Lot.decide]] покажет, где их обработать.
 */
enum LotState {
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

/** События лота. `previousLeader` при первой ставке отсутствует, а не равен нулю (RFC-011, П-01). */
enum LotEvent {
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
