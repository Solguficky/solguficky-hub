package auction.entity

import auction.aggregate.*
import auction.catalog.LotId
import auction.lot.OpId
import org.apache.pekko.persistence.typed.SnapshotAdapter

import java.time.Instant
import java.util.UUID

/*
 * Модель хранения аукциона (ADR-058) — та же форма, что у лота: доменные типы в базу не пишутся, имя класса — manifest
 * строки, имена полей — ключи JSON, взаимоисключающие варианты — поле `kind` и одна заполненная секция.
 */

final case class StoredAuctionDrafted(meetupId: UUID)

final case class StoredLotRef(lotId: UUID)

final case class StoredAuctionEventBody(
    kind: String,
    auctionDrafted: Option[StoredAuctionDrafted],
    lotAdded: Option[StoredLotRef],
    lotRemoved: Option[StoredLotRef]
)

/**
 * Строка журнала аукциона: конверт ADR-047 и событие. Аукцион строки — её `persistence_id`, поэтому, в отличие от лота,
 * отдельного поля аукциона в конверте нет.
 */
final case class StoredAuctionEvent(
    eventId: UUID,
    transactionId: UUID,
    opId: UUID,
    occurredAt: Instant,
    actor: StoredActor,
    event: StoredAuctionEventBody
) extends JournalSerializable

final case class StoredAuctionSeen(sequence: Long, opId: UUID, event: StoredAuctionEventBody)

/** Snapshot аукциона целиком, с реестром по возрастанию `lot_id` и окном дедупликации. */
final case class StoredAuction(
    sequence: Long,
    state: String,
    meetupId: Option[UUID],
    lots: List[UUID],
    seen: List[StoredAuctionSeen]
) extends JournalSerializable

object AuctionJournal {

  def store(eventId: UUID, transactionId: UUID, opId: OpId, occurredAt: Instant, initiator: Initiator)(
      event: AuctionEvent
  ): StoredAuctionEvent =
    StoredAuctionEvent(
      eventId = eventId,
      transactionId = transactionId,
      opId = opId.value,
      occurredAt = occurredAt,
      actor = LotJournal.storeInitiator(initiator),
      event = storeEvent(event)
    )

  def envelope(sequence: Long, stored: StoredAuctionEvent): AuctionEnvelope =
    AuctionEnvelope(sequence, OpId(stored.opId), restoreEvent(stored.event))

  def storeAuction(auction: Auction, sequence: Long): StoredAuction =
    StoredAuction(
      sequence = sequence,
      state = storeState(auction.state),
      meetupId = auction.meetup.map(_.value),
      lots = auction.lots.toList.map(_.value).sorted,
      seen = auction.seen.values.toList
        .sortBy(_.sequence)
        .map(envelope => StoredAuctionSeen(envelope.sequence, envelope.opId.value, storeEvent(envelope.event)))
    )

  /** Snapshot восстанавливается с инвариантом: сходка пуста ровно в `Initial`. */
  def restoreAuction(stored: StoredAuction): Auction = {
    val state = restoreState(stored.state)
    val meetup = stored.meetupId.map(MeetupId(_))
    if ((state == AuctionState.Initial) != meetup.isEmpty)
      corrupted(s"auction snapshot of state ${stored.state} with meetup ${stored.meetupId}")
    Auction(
      state = state,
      meetup = meetup,
      lots = stored.lots.map(LotId(_)).toSet,
      seen = stored.seen.map { seen =>
        val envelope = AuctionEnvelope(seen.sequence, OpId(seen.opId), restoreEvent(seen.event))
        envelope.opId -> envelope
      }.toMap
    )
  }

  val snapshotAdapter: SnapshotAdapter[AuctionEntity.State] = new SnapshotAdapter[AuctionEntity.State] {
    override def toJournal(state: AuctionEntity.State): Any = storeAuction(state.auction, state.sequence)

    override def fromJournal(from: Any): AuctionEntity.State =
      from match {
        case stored: StoredAuction => AuctionEntity.State(restoreAuction(stored), stored.sequence)
        case other => corrupted(s"auction snapshot of unexpected type ${other.getClass.getName}")
      }
  }

  def storeEvent(event: AuctionEvent): StoredAuctionEventBody =
    event match {
      case AuctionEvent.AuctionDrafted(meetup) =>
        StoredAuctionEventBody("AuctionDrafted", Some(StoredAuctionDrafted(meetup.value)), None, None)
      case AuctionEvent.LotAdded(lot) => StoredAuctionEventBody("LotAdded", None, Some(StoredLotRef(lot.value)), None)
      case AuctionEvent.LotRemoved(lot) =>
        StoredAuctionEventBody("LotRemoved", None, None, Some(StoredLotRef(lot.value)))
    }

  /** Ровно одна секция, и та, что названа `kind`. Иначе строка испорчена. */
  def restoreEvent(stored: StoredAuctionEventBody): AuctionEvent =
    stored match {
      case StoredAuctionEventBody("AuctionDrafted", Some(drafted), None, None) =>
        AuctionEvent.AuctionDrafted(MeetupId(drafted.meetupId))
      case StoredAuctionEventBody("LotAdded", None, Some(added), None) => AuctionEvent.LotAdded(LotId(added.lotId))
      case StoredAuctionEventBody("LotRemoved", None, None, Some(removed)) =>
        AuctionEvent.LotRemoved(LotId(removed.lotId))
      case other => corrupted(s"auction event of kind ${other.kind} with sections that do not match it")
    }

  private def storeState(state: AuctionState): String =
    state match {
      case AuctionState.Initial => "Initial"
      case AuctionState.Draft => "Draft"
    }

  private def restoreState(stored: String): AuctionState =
    stored match {
      case "Initial" => AuctionState.Initial
      case "Draft" => AuctionState.Draft
      case other => corrupted(s"auction state $other")
    }

  private def corrupted(message: String): Nothing = throw new JournalCorrupted(message)
}
