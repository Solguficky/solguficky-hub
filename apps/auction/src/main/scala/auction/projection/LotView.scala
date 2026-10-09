package auction.projection

import auction.entity.LotJournal
import auction.entity.StoredLot
import auction.entity.StoredLotEvent
import auction.entity.StoredMoney
import auction.lot.Lot
import auction.lot.LotState

import java.time.Instant
import java.util.UUID

/**
 * Строка read model лота: снимок состояния в модели хранения snapshot (ADR-058) и аукцион, по которому лоты
 * перечисляются. Версия — номер последнего применённого события журнала, `stored.sequence`.
 */
final case class LotViewRow(lotId: UUID, auctionId: UUID, stored: StoredLot) {
  def version: Long = stored.sequence
}

/** Ставка в хронологии лота: строка `lot_bid`, ключ — номер события в журнале лота. */
final case class BidRecord(
    lotId: UUID,
    sequence: Long,
    bidId: UUID,
    participant: UUID,
    minorUnits: Long,
    currency: String,
    origin: String,
    source: Option[String],
    occurredAt: Instant
)

/**
 * Что пишет свёртка нескольких событий лота: строку после последнего применённого события и факты статистики из
 * применённых событий. `participants` — авторы ставок и владельцы принятых прокси-лимитов в порядке журнала, с
 * повторами: отзыв лимита участника не снимает, поэтому строки только добавляются. `startingPrice` — стартовая цена из
 * `LotOpened`: в состоянии лота после открытия её нет, а рост цены статистики считается от неё.
 */
final case class LotViewFold(
    row: Option[LotViewRow],
    bids: List[BidRecord],
    participants: List[UUID],
    startingPrice: Option[StoredMoney]
)

/** Событие, которое свёртка применила, и строка лота сразу после него. */
final case class AppliedEvent(sequence: Long, stored: StoredLotEvent, row: LotViewRow)

/** Что проекция делает с одним событием журнала. */
enum LotViewStep {

  /** Событие уже в read model: повторная доставка после отката транзакции. */
  case Skip

  /** Новая строка лота и, если событие — ставка, строка хронологии. */
  case Write(row: LotViewRow, bid: Option[BidRecord])
}

/**
 * Событие, которое проекция применить не может. Это не ожидаемый отказ, а дефект: обработчик падает, транзакция
 * откатывается, и offset остаётся перед этим событием.
 */
enum LotViewDefect {

  /**
   * Между версией read model и номером события пропуск. Обработчик сначала дочитывает пропущенные события из журнала
   * лота ([[LotView.fold]]); дефектом пропуск остаётся, только если журнал их не держит.
   */
  case Gap(lotId: UUID, version: Long, sequence: Long)

  /** Событие не рождает лот и не применяется к рождённому: журнал лота начат не с `LotDrafted`. */
  case Unborn(lotId: UUID, sequence: Long)
}

/**
 * Чистое ядро проекции лота.
 *
 * Состояние read model меняет тот же `Lot.apply`, что и entity: правило шага, лимиты и переходы статусов не описаны
 * второй раз, и read model совпадает с состоянием entity по построению, а не по тесту.
 */
object LotView {

  def project(
      current: Option[LotViewRow],
      lotId: UUID,
      sequence: Long,
      stored: StoredLotEvent
  ): Either[LotViewDefect, LotViewStep] = {
    val version = current.fold(0L)(_.version)
    if (sequence <= version) Right(LotViewStep.Skip)
    else if (sequence != version + 1) Left(LotViewDefect.Gap(lotId, version, sequence))
    else {
      val before = current.fold(Lot.initial)(row => LotJournal.restoreLot(row.stored))
      val after = Lot.apply(before, LotJournal.envelope(sequence, stored))
      (after.state, after.auction) match {
        case (LotState.Initial, _) | (_, None) => Left(LotViewDefect.Unborn(lotId, sequence))
        case (_, Some(auction)) =>
          val row = LotViewRow(lotId, auction.value, LotJournal.storeLot(after, sequence))
          Right(LotViewStep.Write(row, bid(lotId, sequence, stored)))
      }
    }
  }

  /**
   * Свёртка нескольких событий лота подряд — догонка пропуска вместе с доставленным событием. Итог — строка после
   * последнего применённого события, если хоть одно применилось, и факты всех применённых: ставки, участники и
   * стартовая цена. Повторно доставленное событие фактов не даёт, как и строки.
   */
  def fold(
      current: Option[LotViewRow],
      lotId: UUID,
      events: Seq[(Long, StoredLotEvent)]
  ): Either[LotViewDefect, LotViewFold] =
    replay(current, lotId, events).map { applied =>
      LotViewFold(
        row = applied.lastOption.map(_.row),
        bids = applied.flatMap(step => bid(lotId, step.sequence, step.stored)),
        participants = applied.flatMap(step => participant(step.stored)),
        startingPrice = applied.flatMap(step => step.stored.event.lotOpened.map(_.startingPrice)).lastOption
      )
    }

  /**
   * Участник лота для статистики (`LotStatistics.unique_participant_count`): автор принятой ставки, ручной или
   * производной, и владелец принятого прокси-лимита. Отказанная команда в журнал не попадает, а отзыв лимита участия не
   * снимает.
   */
  def participant(stored: StoredLotEvent): Option[UUID] =
    stored.event.bidPlaced.map(_.participant).orElse(stored.event.proxyLimitSet.map(_.participant))

  /**
   * Та же свёртка, но с состоянием после каждого применённого события, а не только после последнего: публикации нужен
   * снимок на каждый факт. Повторно доставленные события в итог не попадают.
   */
  def replay(
      current: Option[LotViewRow],
      lotId: UUID,
      events: Seq[(Long, StoredLotEvent)]
  ): Either[LotViewDefect, List[AppliedEvent]] =
    events
      .foldLeft[Either[LotViewDefect, (Option[LotViewRow], List[AppliedEvent])]](Right((current, Nil))) {
        case (Right((row, applied)), (sequence, stored)) =>
          project(row, lotId, sequence, stored).map {
            case LotViewStep.Skip => (row, applied)
            case LotViewStep.Write(next, _) => (Some(next), AppliedEvent(sequence, stored, next) :: applied)
          }
        case (failed, _) => failed
      }
      .map((_, applied) => applied.reverse)

  private def bid(lotId: UUID, sequence: Long, stored: StoredLotEvent): Option[BidRecord] =
    stored.event.bidPlaced.map { placed =>
      BidRecord(
        lotId = lotId,
        sequence = sequence,
        bidId = placed.bidId,
        participant = placed.participant,
        minorUnits = placed.amount.minorUnits,
        currency = placed.amount.currency,
        origin = placed.origin,
        source = placed.source,
        occurredAt = stored.occurredAt
      )
    }
}
