package auction.projection

import auction.aggregate.Auction
import auction.aggregate.AuctionState
import auction.entity.AuctionJournal
import auction.entity.StoredAuction
import auction.entity.StoredAuctionEvent

import java.util.UUID

/**
 * Строка read model аукциона: снимок в модели хранения snapshot (ADR-058) и сходка, по которой аукцион ищется. Версия —
 * номер последнего применённого события журнала аукциона.
 */
final case class AuctionViewRow(auctionId: UUID, meetupId: UUID, stored: StoredAuction) {
  def version: Long = stored.sequence
  def lots: Set[UUID] = stored.lots.toSet
}

/** Событие аукциона, которое проекция применить не может: обработчик падает, offset остаётся перед ним. */
enum AuctionViewDefect {
  case Gap(auctionId: UUID, version: Long, sequence: Long)
  case Unborn(auctionId: UUID, sequence: Long)
}

/**
 * Чистое ядро проекции аукциона — то же устройство, что [[LotView]]: состояние меняет тот же [[Auction.apply]], что и
 * entity, повтор пропускается по версии, пропуск номера — дефект, который обработчик сначала пробует дочитать из
 * журнала.
 */
object AuctionView {

  /** Строка после события, `None` — событие уже в read model. */
  def project(
      current: Option[AuctionViewRow],
      auctionId: UUID,
      sequence: Long,
      stored: StoredAuctionEvent
  ): Either[AuctionViewDefect, Option[AuctionViewRow]] = {
    val version = current.fold(0L)(_.version)
    if (sequence <= version) Right(None)
    else if (sequence != version + 1) Left(AuctionViewDefect.Gap(auctionId, version, sequence))
    else {
      val before = current.fold(Auction.initial)(row => AuctionJournal.restoreAuction(row.stored))
      val after = Auction.apply(before, AuctionJournal.envelope(sequence, stored))
      (after.state, after.meetup) match {
        case (AuctionState.Initial, _) | (_, None) => Left(AuctionViewDefect.Unborn(auctionId, sequence))
        case (_, Some(meetup)) =>
          Right(Some(AuctionViewRow(auctionId, meetup.value, AuctionJournal.storeAuction(after, sequence))))
      }
    }
  }

  /** Свёртка нескольких событий подряд — догонка пропуска вместе с доставленным. */
  def fold(
      current: Option[AuctionViewRow],
      auctionId: UUID,
      events: Seq[(Long, StoredAuctionEvent)]
  ): Either[AuctionViewDefect, Option[AuctionViewRow]] =
    events.foldLeft[Either[AuctionViewDefect, Option[AuctionViewRow]]](Right(current)) {
      case (Right(row), (sequence, stored)) => project(row, auctionId, sequence, stored).map(_.orElse(row))
      case (failed, _) => failed
    }
}
