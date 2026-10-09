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

final case class StoredOnlinePhase(opensAt: Instant, closesAt: Option[Instant], closesLots: Boolean)

final case class StoredMixedClosing(onlineByDeadline: Boolean)

/** `kind` — `ByAuctioneer`, `ByDeadline` или `Mixed`; секция `mixed` заполнена ровно у последнего. */
final case class StoredClosingPolicy(kind: String, mixed: Option[StoredMixedClosing])

/** Окно сниженного шага аукциона с его лотами (ADR-047, дополнение 2026-10-08). */
final case class StoredAuctionStepWindow(from: Instant, until: Instant, step: StoredMoney, lots: List[UUID])

/**
 * Payload `AuctionScheduled` и конфигурация в snapshot. `lotDefaults` — та же форма, что конфигурация лота; пусто,
 * когда администратор их не задал (дополнение ADR-047 от 2026-10-06). Строка, записанная до этого, несёт их всегда и
 * читается так же. `stepWindows` пишется только непустым (дополнение 2026-10-08): строка без него — аукцион без окон.
 */
final case class StoredAuctionConfig(
    onlinePhase: Option[StoredOnlinePhase],
    finalBlocks: Int,
    closingPolicy: StoredClosingPolicy,
    lotDefaults: Option[StoredConfig],
    stepWindows: Option[List[StoredAuctionStepWindow]] = None
)

/**
 * `PrebiddingStarted` записан одним `kind` без секции: payload у него пуст (ADR-047). Секция `auctionScheduled`
 * добавлена в конец: строка, записанная до неё, читает её как пустую.
 */
final case class StoredAuctionEventBody(
    kind: String,
    auctionDrafted: Option[StoredAuctionDrafted],
    lotAdded: Option[StoredLotRef],
    lotRemoved: Option[StoredLotRef],
    auctionScheduled: Option[StoredAuctionConfig]
)

object StoredAuctionEventBody {

  /** Событие данного вида без единой секции; заполненную секцию добавляет `copy`. */
  def of(kind: String): StoredAuctionEventBody = StoredAuctionEventBody(kind, None, None, None, None)
}

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

/**
 * Snapshot аукциона целиком, с реестром по возрастанию `lot_id` и окном дедупликации. `config` и `startedBy`
 * необязательны по форме: snapshot, записанный до планирования и открытия торгов, их не несёт и читается как черновик.
 * `config` заполнена с `Scheduled`, `startedBy` — `op_id` команды открытия — только в `Prebidding`.
 */
final case class StoredAuction(
    sequence: Long,
    state: String,
    meetupId: Option[UUID],
    lots: List[UUID],
    seen: List[StoredAuctionSeen],
    config: Option[StoredAuctionConfig],
    startedBy: Option[UUID]
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

  def storeAuction(auction: Auction, sequence: Long): StoredAuction = {
    val (state, config, startedBy) = auction.state match {
      case AuctionState.Initial => ("Initial", None, None)
      case AuctionState.Draft => ("Draft", None, None)
      case AuctionState.Scheduled(config) => ("Scheduled", Some(config), None)
      case AuctionState.Prebidding(config, startedBy) => ("Prebidding", Some(config), Some(startedBy))
    }
    StoredAuction(
      sequence = sequence,
      state = state,
      meetupId = auction.meetup.map(_.value),
      lots = auction.lots.toList.map(_.value).sorted,
      seen = auction.seen.values.toList
        .sortBy(_.sequence)
        .map(envelope => StoredAuctionSeen(envelope.sequence, envelope.opId.value, storeEvent(envelope.event))),
      config = config.map(storeConfig),
      startedBy = startedBy.map(_.value)
    )
  }

  /**
   * Snapshot восстанавливается с инвариантами: сходка пуста ровно в `Initial`, а конфигурация и `op_id` открытия есть
   * ровно у тех состояний, которые их несут.
   */
  def restoreAuction(stored: StoredAuction): Auction = {
    val state = (stored.state, stored.config, stored.startedBy) match {
      case ("Initial", None, None) => AuctionState.Initial
      case ("Draft", None, None) => AuctionState.Draft
      case ("Scheduled", Some(config), None) => AuctionState.Scheduled(restoreConfig(config))
      case ("Prebidding", Some(config), Some(startedBy)) =>
        AuctionState.Prebidding(restoreConfig(config), OpId(startedBy))
      case _ => corrupted(s"auction snapshot of state ${stored.state} with a config or an opening that do not match it")
    }
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
        StoredAuctionEventBody.of("AuctionDrafted").copy(auctionDrafted = Some(StoredAuctionDrafted(meetup.value)))
      case AuctionEvent.LotAdded(lot) =>
        StoredAuctionEventBody.of("LotAdded").copy(lotAdded = Some(StoredLotRef(lot.value)))
      case AuctionEvent.LotRemoved(lot) =>
        StoredAuctionEventBody.of("LotRemoved").copy(lotRemoved = Some(StoredLotRef(lot.value)))
      case AuctionEvent.AuctionScheduled(config) =>
        StoredAuctionEventBody.of("AuctionScheduled").copy(auctionScheduled = Some(storeConfig(config)))
      case AuctionEvent.PrebiddingStarted => StoredAuctionEventBody.of("PrebiddingStarted")
      case AuctionEvent.AuctionDiscarded => StoredAuctionEventBody.of("AuctionDiscarded")
    }

  /**
   * Ровно одна секция, и та, что названа `kind`; у `PrebiddingStarted` и `AuctionDiscarded` — ни одной. Иначе строка
   * испорчена.
   */
  def restoreEvent(stored: StoredAuctionEventBody): AuctionEvent =
    stored match {
      case StoredAuctionEventBody("AuctionDrafted", Some(drafted), None, None, None) =>
        AuctionEvent.AuctionDrafted(MeetupId(drafted.meetupId))
      case StoredAuctionEventBody("LotAdded", None, Some(added), None, None) =>
        AuctionEvent.LotAdded(LotId(added.lotId))
      case StoredAuctionEventBody("LotRemoved", None, None, Some(removed), None) =>
        AuctionEvent.LotRemoved(LotId(removed.lotId))
      case StoredAuctionEventBody("AuctionScheduled", None, None, None, Some(config)) =>
        AuctionEvent.AuctionScheduled(restoreConfig(config))
      case StoredAuctionEventBody("PrebiddingStarted", None, None, None, None) => AuctionEvent.PrebiddingStarted
      case StoredAuctionEventBody("AuctionDiscarded", None, None, None, None) => AuctionEvent.AuctionDiscarded
      case other => corrupted(s"auction event of kind ${other.kind} with sections that do not match it")
    }

  private def storeConfig(config: AuctionConfig): StoredAuctionConfig =
    StoredAuctionConfig(
      onlinePhase = config.onlinePhase.map(phase => StoredOnlinePhase(phase.opensAt, phase.closesAt, phase.closesLots)),
      finalBlocks = config.finalBlocks,
      closingPolicy = config.closingPolicy match {
        case ClosingPolicy.ByAuctioneer => StoredClosingPolicy("ByAuctioneer", None)
        case ClosingPolicy.ByDeadline => StoredClosingPolicy("ByDeadline", None)
        case ClosingPolicy.Mixed(onlineByDeadline) =>
          StoredClosingPolicy("Mixed", Some(StoredMixedClosing(onlineByDeadline)))
      },
      lotDefaults = config.lotDefaults.map(LotJournal.storeConfig),
      stepWindows = Option.when(config.stepWindows.nonEmpty)(config.stepWindows.map { window =>
        StoredAuctionStepWindow(
          window.from,
          window.until,
          LotJournal.storeMoney(window.step),
          window.lots.toList.map(_.value).sorted
        )
      })
    )

  /** Конфигурация восстанавливается через ту же проверку, что и при планировании: журнал `ConfigInvalid` не обходит. */
  private def restoreConfig(stored: StoredAuctionConfig): AuctionConfig = {
    val policy = (stored.closingPolicy.kind, stored.closingPolicy.mixed) match {
      case ("ByAuctioneer", None) => ClosingPolicy.ByAuctioneer
      case ("ByDeadline", None) => ClosingPolicy.ByDeadline
      case ("Mixed", Some(mixed)) => ClosingPolicy.Mixed(mixed.onlineByDeadline)
      case (kind, _) => corrupted(s"closing policy of kind $kind with a section that does not match it")
    }
    AuctionConfig
      .of(
        stored.onlinePhase.map(phase => OnlinePhase(phase.opensAt, phase.closesAt, phase.closesLots)),
        stored.finalBlocks,
        policy,
        stored.lotDefaults.map(LotJournal.restoreConfig),
        stored.stepWindows.getOrElse(Nil).map { window =>
          StepWindowConfig(
            window.from,
            window.until,
            LotJournal.restoreMoney(window.step),
            window.lots.map(LotId(_)).toSet
          )
        }
      )
      .fold(invalid => corrupted(s"auction config violates $invalid"), config => config)
  }

  private def corrupted(message: String): Nothing = throw new JournalCorrupted(message)
}
