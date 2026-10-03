package auction.projection

import auction.entity.LotJournal
import auction.entity.StoredLot
import auction.entity.StoredLotEvent
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

  /** Между версией read model и номером события пропуск: read model перестала бы совпадать с журналом. */
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
