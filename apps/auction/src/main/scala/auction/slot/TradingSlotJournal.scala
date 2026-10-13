package auction.slot

import auction.entity.JournalCorrupted
import auction.entity.JournalSerializable
import auction.lot.AuctionId

import java.time.Instant
import java.util.UUID

/**
 * Строка журнала слота (ADR-058) — модель хранения, а не доменный тип: имя класса — manifest строки, имена полей —
 * ключи JSON. Оба события несут один `auction_id`, поэтому секций по виду, как у лота и аукциона, нет. Snapshot у слота
 * не пишется: на аукцион приходится два события, и журнал за годы — десятки строк.
 */
final case class StoredSlotEvent(eventId: UUID, occurredAt: Instant, kind: String, auctionId: UUID)
    extends JournalSerializable

object TradingSlotJournal {

  def store(eventId: UUID, occurredAt: Instant)(event: SlotEvent): StoredSlotEvent =
    event match {
      case SlotEvent.SlotTaken(auction) => StoredSlotEvent(eventId, occurredAt, "SlotTaken", auction.value)
      case SlotEvent.SlotReleased(auction) => StoredSlotEvent(eventId, occurredAt, "SlotReleased", auction.value)
    }

  def restore(stored: StoredSlotEvent): SlotEvent = {
    val auction = Option(stored.auctionId).map(AuctionId(_)).getOrElse(corrupted("trading slot event without auction"))
    stored.kind match {
      case "SlotTaken" => SlotEvent.SlotTaken(auction)
      case "SlotReleased" => SlotEvent.SlotReleased(auction)
      case other => corrupted(s"trading slot event of unknown kind $other")
    }
  }

  private def corrupted(message: String): Nothing = throw new JournalCorrupted(message)
}
