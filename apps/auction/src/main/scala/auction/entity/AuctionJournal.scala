package auction.entity

import auction.aggregate.*
import auction.catalog.LotId
import auction.lot.OpId
import auction.lot.ParticipantId
import org.apache.pekko.persistence.typed.SnapshotAdapter

import java.time.Duration
import java.time.Instant
import java.util.UUID

/*
 * Модель хранения аукциона (ADR-058) — та же форма, что у лота: доменные типы в базу не пишутся, имя класса — manifest
 * строки, имена полей — ключи JSON, взаимоисключающие варианты — поле `kind` и одна заполненная секция.
 */

/**
 * `hidden` добавлен в конец (ADR-047, дополнение 2026-10-20): строка без него записана до признака видимости, и аукцион
 * из неё видим участникам.
 */
final case class StoredAuctionDrafted(meetupId: UUID, hidden: Option[Boolean] = None)

final case class StoredLotRef(lotId: UUID)

/** Payload `PrebiddingEnded`: перерыв (`false`) или конец аукциона без финалистов (`true`). */
final case class StoredPrebiddingEnded(finished: Boolean)

/** Payload `FinalLineupFrozen`: удержанные лоты в порядке выхода. */
final case class StoredLineup(order: List[UUID])

/**
 * `raffleClosesAt` добавлен в конец (PER-499): строка без него — аукцион без розыгрыша. `rafflePrize` добавлен в конец
 * (PER-649): строка без него — розыгрыш без приза.
 */
final case class StoredOnlinePhase(
    opensAt: Instant,
    closesAt: Option[Instant],
    closesLots: Boolean,
    raffleClosesAt: Option[Instant] = None,
    rafflePrize: Option[String] = None
)

final case class StoredMixedClosing(onlineByDeadline: Boolean)

/** `kind` — `ByAuctioneer`, `ByDeadline` или `Mixed`; секция `mixed` заполнена ровно у последнего. */
final case class StoredClosingPolicy(kind: String, mixed: Option[StoredMixedClosing])

/**
 * Окно сниженного шага аукциона с его лотами (ADR-047, дополнение 2026-10-08): окно конфигурации и payload
 * `StepWindowLaunched` (дополнение 2026-10-12).
 */
final case class StoredAuctionStepWindow(from: Instant, until: Instant, step: StoredMoney, lots: List[UUID])

/** Окно, запущенное по ходу торгов, в snapshot: `op_id` запуска и само окно (ADR-047, дополнение 2026-10-12). */
final case class StoredLaunchedWindow(opId: UUID, window: StoredAuctionStepWindow)

/**
 * Payload `FinalTimeSet`: ориентировочное время финала (ADR-040, дополнение 2026-10-19). Снятие времени — событие без
 * payload, как `AuctionPublished`.
 */
final case class StoredFinalTime(at: Instant)

/**
 * Payload `PaymentInstructionsSet`: текст администратора «как оплатить и получить» (PER-322). Снятие текста — событие
 * без payload, как `FinalTimeCleared`.
 */
final case class StoredPaymentInstructions(text: String)

/** Payload `LotSetDefined` (ADR-073): сет, его название и лоты в порядке организатора. */
final case class StoredLotSetDefined(lotSetId: UUID, name: String, lots: List[UUID])

final case class StoredLotSetRef(lotSetId: UUID)

/** Payload `LotSetSettled`: `collector` — собравший сет; пусто — сет не собран никем. */
final case class StoredLotSetSettled(lotSetId: UUID, collector: Option[UUID])

/** Раздел ленты (PER-719): номер, который выбрал вызывающий, название и лоты в порядке администратора. */
final case class StoredLotSection(sectionId: Int, name: String, lots: List[UUID])

/**
 * Payload `LotLayoutSet` и раскладка в snapshot (PER-719): лоты вне разделов и разделы, каждые в порядке
 * администратора.
 */
final case class StoredLotLayout(lots: List[UUID], sections: List[StoredLotSection])

/** Сет в snapshot: определение и, после итога, `settled` с собравшим или без него. */
final case class StoredLotSet(
    lotSetId: UUID,
    name: String,
    lots: List[UUID],
    settled: Boolean,
    collector: Option[UUID]
)

/**
 * Payload `AuctionScheduled` и конфигурация в snapshot. `lotDefaults` — та же форма, что конфигурация лота; пусто,
 * когда администратор их не задал (дополнение ADR-047 от 2026-10-06). Строка, записанная до этого, несёт их всегда и
 * читается так же. `stepWindows` пишется только непустым (дополнение 2026-10-08): строка без него — аукцион без окон.
 * `paymentTerm` добавлен в конец (дополнение 2026-10-21) и пишется всегда: строка без него — аукцион, запланированный
 * до срока оплаты, и он получает срок платформы.
 */
final case class StoredAuctionConfig(
    onlinePhase: Option[StoredOnlinePhase],
    finalBlocks: Int,
    closingPolicy: StoredClosingPolicy,
    lotDefaults: Option[StoredConfig],
    stepWindows: Option[List[StoredAuctionStepWindow]] = None,
    paymentTerm: Option[Duration] = None
)

/**
 * `PrebiddingStarted` записан одним `kind` без секции: payload у него пуст (ADR-047). Секция `auctionScheduled`
 * добавлена в конец: строка, записанная до неё, читает её как пустую. Так же в конец добавлены секции перерыва и финала
 * (PER-334), секция завершения лота финала (PER-607) и секция запущенного окна (ADR-047, дополнение 2026-10-12);
 * `PrebiddingDeadlineReached`, `FinalStarted`, `AuctionCancelled`, `AuctionFinished`, `AuctionPublished` и
 * `AuctionHidden` пишутся одним `kind`. Секция `finalTime` добавлена в конец (ADR-040, дополнение 2026-10-19): строка,
 * записанная до неё, читается без ориентировочного времени финала. Секции сета лотов добавлены за ней (ADR-073), а за
 * секцией текста оплаты — секция раскладки ленты (PER-719).
 */
final case class StoredAuctionEventBody(
    kind: String,
    auctionDrafted: Option[StoredAuctionDrafted],
    lotAdded: Option[StoredLotRef],
    lotRemoved: Option[StoredLotRef],
    auctionScheduled: Option[StoredAuctionConfig],
    prebiddingEnded: Option[StoredPrebiddingEnded] = None,
    finalLineupFrozen: Option[StoredLineup] = None,
    finalLotActivated: Option[StoredLotRef] = None,
    finalLotCompleted: Option[StoredLotRef] = None,
    stepWindowLaunched: Option[StoredAuctionStepWindow] = None,
    finalTime: Option[StoredFinalTime] = None,
    lotSetDefined: Option[StoredLotSetDefined] = None,
    lotSetDeleted: Option[StoredLotSetRef] = None,
    lotSetSettled: Option[StoredLotSetSettled] = None,
    paymentInstructions: Option[StoredPaymentInstructions] = None,
    lotLayout: Option[StoredLotLayout] = None
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
 * `config` заполнена с `Scheduled`, `startedBy` — `op_id` команды открытия — с `Prebidding`. `order` — состав финала с
 * заморозки, `activated` — возвращённые в торги лоты финала; оба добавлены в конец (PER-334). `cancelledBy` — `op_id`
 * отмены, только у `Cancelled`; добавлен в конец (PER-601). `completed` — завершённые лоты финала, только у `Final` и
 * только непустым; добавлен в конец (PER-607): snapshot финала без него читается без завершённых лотов. `launched` —
 * окна, запущенные по ходу торгов, в порядке записи и только непустым; добавлен в конец (ADR-047, дополнение
 * 2026-10-12): snapshot без него читается без запущенных окон. `hidden` — аукцион скрыт от участников, только у `Draft`
 * и `Scheduled` и только `true`; добавлен в конец (ADR-047, дополнение 2026-10-20): snapshot без него — видимый
 * аукцион. `finalAt` — ориентировочное время финала (ADR-040, дополнение 2026-10-19); добавлен в конец: snapshot без
 * него — аукцион без времени финала. `sets` — сеты лотов по возрастанию идентификатора и только непустым; добавлен в
 * конец (ADR-073): snapshot без него — аукцион без сетов. `paymentInstructions` — текст «как оплатить и получить»;
 * добавлен в конец (PER-322): snapshot без него — аукцион без текста. `layout` — порядок и разделы ленты, только
 * непустым; добавлен в конец (PER-719): snapshot без него — лента в порядке создания.
 */
final case class StoredAuction(
    sequence: Long,
    state: String,
    meetupId: Option[UUID],
    lots: List[UUID],
    seen: List[StoredAuctionSeen],
    config: Option[StoredAuctionConfig],
    startedBy: Option[UUID],
    order: Option[List[UUID]] = None,
    activated: Option[List[UUID]] = None,
    cancelledBy: Option[UUID] = None,
    completed: Option[List[UUID]] = None,
    launched: Option[List[StoredLaunchedWindow]] = None,
    hidden: Option[Boolean] = None,
    finalAt: Option[Instant] = None,
    sets: Option[List[StoredLotSet]] = None,
    paymentInstructions: Option[String] = None,
    layout: Option[StoredLotLayout] = None
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
      case AuctionState.Settling(config, startedBy) => ("Settling", Some(config), Some(startedBy))
      case AuctionState.Break(config, startedBy) => ("Break", Some(config), Some(startedBy))
      case AuctionState.LineupFrozen(config, startedBy, _) => ("LineupFrozen", Some(config), Some(startedBy))
      case AuctionState.Final(config, startedBy, _, _, _) => ("Final", Some(config), Some(startedBy))
      case AuctionState.Finished(config, startedBy) => ("Finished", Some(config), Some(startedBy))
      case AuctionState.Cancelled(config, startedBy, _) => ("Cancelled", Some(config), Some(startedBy))
    }
    val cancelledBy = auction.state match {
      case AuctionState.Cancelled(_, _, cancelledBy) => Some(cancelledBy.value)
      case _ => None
    }
    val (order, activated) = auction.state match {
      case AuctionState.LineupFrozen(_, _, order) => (Some(order), None)
      case AuctionState.Final(_, _, order, activated, _) => (Some(order), Some(activated))
      case _ => (None, None)
    }
    val completed = auction.state match {
      case AuctionState.Final(_, _, _, _, completed) if completed.nonEmpty => Some(completed.map(_.value))
      case _ => None
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
      startedBy = startedBy.map(_.value),
      order = order.map(_.map(_.value)),
      activated = activated.map(_.map(_.value)),
      cancelledBy = cancelledBy,
      completed = completed,
      launched = Option.when(auction.launched.nonEmpty)(
        auction.launched.map(launch => StoredLaunchedWindow(launch.opId.value, storeWindow(launch.window)))
      ),
      hidden = Option.when(auction.hidden)(true),
      finalAt = auction.finalAt,
      sets = Option.when(auction.sets.nonEmpty)(
        auction.sets.toList.sortBy(_._1.value).map((id, set) => storeLotSet(id, set))
      ),
      paymentInstructions = auction.paymentInstructions.map(_.value),
      layout = Option.unless(auction.layout.isEmpty)(storeLayout(auction.layout))
    )
  }

  private def storeLayout(layout: LotLayout): StoredLotLayout =
    StoredLotLayout(
      lots = layout.lots.map(_.value),
      sections = layout.sections.map(section =>
        StoredLotSection(section.id.value, section.name.value, section.lots.map(_.value))
      )
    )

  /** Раскладка восстанавливается через ту же проверку формы, что у команды: журнал лот в двух местах не обходит. */
  private def restoreLayout(stored: StoredLotLayout): LotLayout =
    LotLayout
      .of(stored.lots.map(LotId(_)), stored.sections.map(restoreSection))
      .fold(invalid => corrupted(s"lot layout violates $invalid"), layout => layout)

  private def restoreSection(stored: StoredLotSection): LotSection = {
    def broken(what: String): Nothing = corrupted(s"lot section ${stored.sectionId} $what")
    LotSection(
      LotSectionId(stored.sectionId).getOrElse(broken("out of range")),
      LotSectionName(stored.name).getOrElse(broken("with a blank name")),
      stored.lots.map(LotId(_))
    )
  }

  private def storeLotSet(id: LotSetId, set: LotSet): StoredLotSet =
    StoredLotSet(
      lotSetId = id.value,
      name = set.name.value,
      lots = set.lots.map(_.value),
      settled = set.settlement.isDefined,
      collector = set.settlement.collect { case LotSetSettlement.Collected(by) => by.value }
    )

  private def restoreLotSet(stored: StoredLotSet): (LotSetId, LotSet) = {
    val settlement = (stored.settled, stored.collector) match {
      case (false, None) => None
      case (true, None) => Some(LotSetSettlement.NotCollected)
      case (true, Some(collector)) => Some(LotSetSettlement.Collected(ParticipantId(collector)))
      case (false, Some(_)) =>
        corrupted(s"auction snapshot with a collector of the unsettled lot set ${stored.lotSetId}")
    }
    LotSetId(stored.lotSetId) -> LotSet(
      restoreName(stored.lotSetId, stored.name),
      lots(stored.lotSetId, stored.lots),
      settlement
    )
  }

  // Название и лоты сета журнал проверяет тем же правилом, что команда (ADR-058): пустое название и повтор лота в
  // базе — испорченная строка, а не сет.
  private def restoreName(set: UUID, raw: String): LotSetName =
    LotSetName(raw).getOrElse(corrupted(s"lot set $set with a blank name"))

  private def lots(set: UUID, ids: List[UUID]): List[LotId] =
    if (ids.distinct.size == ids.size) ids.map(LotId(_)) else corrupted(s"lot set $set with a repeated lot")

  /**
   * Snapshot восстанавливается с инвариантами: сходка пуста ровно в `Initial`, а конфигурация, `op_id` открытия,
   * состав, возвращённые лоты финала и `op_id` отмены есть ровно у тех состояний, которые их несут.
   */
  def restoreAuction(stored: StoredAuction): Auction = {
    val lots = (ids: List[UUID]) => ids.map(LotId(_))
    val state =
      (stored.state, stored.config, stored.startedBy, stored.order, stored.activated, stored.cancelledBy) match {
        case ("Initial", None, None, None, None, None) => AuctionState.Initial
        case ("Draft", None, None, None, None, None) => AuctionState.Draft
        case ("Scheduled", Some(config), None, None, None, None) => AuctionState.Scheduled(restoreConfig(config))
        case ("Prebidding", Some(config), Some(startedBy), None, None, None) =>
          AuctionState.Prebidding(restoreConfig(config), OpId(startedBy))
        case ("Settling", Some(config), Some(startedBy), None, None, None) =>
          AuctionState.Settling(restoreConfig(config), OpId(startedBy))
        case ("Break", Some(config), Some(startedBy), None, None, None) =>
          AuctionState.Break(restoreConfig(config), OpId(startedBy))
        case ("LineupFrozen", Some(config), Some(startedBy), Some(order), None, None) if order.nonEmpty =>
          AuctionState.LineupFrozen(restoreConfig(config), OpId(startedBy), lots(order))
        case ("Final", Some(config), Some(startedBy), Some(order), Some(activated), None)
            if order.nonEmpty && stored.completed.getOrElse(Nil).forall(activated.contains) =>
          AuctionState.Final(
            restoreConfig(config),
            OpId(startedBy),
            lots(order),
            lots(activated),
            lots(stored.completed.getOrElse(Nil))
          )
        case ("Finished", Some(config), Some(startedBy), None, None, None) =>
          AuctionState.Finished(restoreConfig(config), OpId(startedBy))
        case ("Cancelled", Some(config), Some(startedBy), None, None, Some(cancelledBy)) =>
          AuctionState.Cancelled(restoreConfig(config), OpId(startedBy), OpId(cancelledBy))
        case _ =>
          corrupted(
            s"auction snapshot of state ${stored.state} with a config, an opening or a lineup that do not match it"
          )
      }
    if (stored.completed.isDefined && stored.state != "Final")
      corrupted(s"auction snapshot of state ${stored.state} with completed lots of a final")
    val hidden = stored.hidden.getOrElse(false)
    if (hidden && stored.state != "Draft" && stored.state != "Scheduled")
      corrupted(s"auction snapshot of state ${stored.state} hidden from participants")
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
      }.toMap,
      launched = stored.launched.getOrElse(Nil).map { launch =>
        LaunchedWindow(OpId(launch.opId), restoreWindow(launch.window))
      },
      hidden = hidden,
      finalAt = stored.finalAt,
      sets = restoreSets(stored),
      paymentInstructions = stored.paymentInstructions.map(PaymentInstructions.of),
      layout = restoreSnapshotLayout(stored)
    )
  }

  /** Раскладка snapshot с инвариантом агрегата: лоты раскладки — лоты реестра (PER-719). */
  private def restoreSnapshotLayout(stored: StoredAuction): LotLayout =
    stored.layout.fold(LotLayout.empty) { layout =>
      val restored = restoreLayout(layout)
      if (!restored.members.forall(lot => stored.lots.contains(lot.value)))
        corrupted(s"auction snapshot with a lot layout outside its registry")
      restored
    }

  /** Сеты snapshot с инвариантами агрегата: лоты сета — лоты реестра, и лот не больше чем в одном сете (ADR-073). */
  private def restoreSets(stored: StoredAuction): Map[LotSetId, LotSet] = {
    val sets = stored.sets.getOrElse(Nil).map(restoreLotSet)
    val members = sets.flatMap((_, set) => set.lots)
    if (!members.forall(lot => stored.lots.contains(lot.value)))
      corrupted(s"auction snapshot with a lot set outside its registry")
    if (members.distinct.size != members.size) corrupted(s"auction snapshot with a lot in two lot sets")
    sets.toMap
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
      case AuctionEvent.AuctionDrafted(meetup, hidden) =>
        StoredAuctionEventBody
          .of("AuctionDrafted")
          .copy(auctionDrafted = Some(StoredAuctionDrafted(meetup.value, Some(hidden))))
      case AuctionEvent.AuctionPublished => StoredAuctionEventBody.of("AuctionPublished")
      case AuctionEvent.AuctionHidden => StoredAuctionEventBody.of("AuctionHidden")
      case AuctionEvent.LotAdded(lot) =>
        StoredAuctionEventBody.of("LotAdded").copy(lotAdded = Some(StoredLotRef(lot.value)))
      case AuctionEvent.LotRemoved(lot) =>
        StoredAuctionEventBody.of("LotRemoved").copy(lotRemoved = Some(StoredLotRef(lot.value)))
      case AuctionEvent.AuctionScheduled(config) =>
        StoredAuctionEventBody.of("AuctionScheduled").copy(auctionScheduled = Some(storeConfig(config)))
      case AuctionEvent.PrebiddingStarted => StoredAuctionEventBody.of("PrebiddingStarted")
      case AuctionEvent.AuctionDiscarded => StoredAuctionEventBody.of("AuctionDiscarded")
      case AuctionEvent.AuctionCancelled => StoredAuctionEventBody.of("AuctionCancelled")
      case AuctionEvent.PrebiddingDeadlineReached => StoredAuctionEventBody.of("PrebiddingDeadlineReached")
      case AuctionEvent.PrebiddingEnded(finished) =>
        StoredAuctionEventBody.of("PrebiddingEnded").copy(prebiddingEnded = Some(StoredPrebiddingEnded(finished)))
      case AuctionEvent.FinalLineupFrozen(order) =>
        StoredAuctionEventBody.of("FinalLineupFrozen").copy(finalLineupFrozen = Some(StoredLineup(order.map(_.value))))
      case AuctionEvent.FinalStarted => StoredAuctionEventBody.of("FinalStarted")
      case AuctionEvent.FinalLotActivated(lot) =>
        StoredAuctionEventBody.of("FinalLotActivated").copy(finalLotActivated = Some(StoredLotRef(lot.value)))
      case AuctionEvent.FinalLotCompleted(lot) =>
        StoredAuctionEventBody.of("FinalLotCompleted").copy(finalLotCompleted = Some(StoredLotRef(lot.value)))
      case AuctionEvent.AuctionFinished => StoredAuctionEventBody.of("AuctionFinished")
      case AuctionEvent.StepWindowLaunched(window) =>
        StoredAuctionEventBody.of("StepWindowLaunched").copy(stepWindowLaunched = Some(storeWindow(window)))
      case AuctionEvent.FinalTimeSet(at) =>
        StoredAuctionEventBody.of("FinalTimeSet").copy(finalTime = Some(StoredFinalTime(at)))
      case AuctionEvent.FinalTimeCleared => StoredAuctionEventBody.of("FinalTimeCleared")
      case AuctionEvent.PaymentInstructionsSet(text) =>
        StoredAuctionEventBody
          .of("PaymentInstructionsSet")
          .copy(paymentInstructions = Some(StoredPaymentInstructions(text.value)))
      case AuctionEvent.PaymentInstructionsCleared => StoredAuctionEventBody.of("PaymentInstructionsCleared")
      case AuctionEvent.LotSetDefined(set, name, lots) =>
        StoredAuctionEventBody
          .of("LotSetDefined")
          .copy(lotSetDefined = Some(StoredLotSetDefined(set.value, name.value, lots.map(_.value))))
      case AuctionEvent.LotSetDeleted(set) =>
        StoredAuctionEventBody.of("LotSetDeleted").copy(lotSetDeleted = Some(StoredLotSetRef(set.value)))
      case AuctionEvent.LotSetSettled(set, settlement) =>
        val collector = settlement match {
          case LotSetSettlement.Collected(by) => Some(by.value)
          case LotSetSettlement.NotCollected => None
        }
        StoredAuctionEventBody.of("LotSetSettled").copy(lotSetSettled = Some(StoredLotSetSettled(set.value, collector)))
      case AuctionEvent.LotLayoutSet(layout) =>
        StoredAuctionEventBody.of("LotLayoutSet").copy(lotLayout = Some(storeLayout(layout)))
    }

  /**
   * Ровно одна секция, и та, что названа `kind`; у событий без payload — ни одной. Иначе строка испорчена.
   */
  def restoreEvent(stored: StoredAuctionEventBody): AuctionEvent =
    stored match {
      case StoredAuctionEventBody(
            "AuctionDrafted",
            Some(drafted),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None
          ) =>
        AuctionEvent.AuctionDrafted(MeetupId(drafted.meetupId), drafted.hidden.getOrElse(false))
      case StoredAuctionEventBody(
            "AuctionPublished",
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None
          ) =>
        AuctionEvent.AuctionPublished
      case StoredAuctionEventBody(
            "AuctionHidden",
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None
          ) =>
        AuctionEvent.AuctionHidden
      case StoredAuctionEventBody(
            "LotAdded",
            None,
            Some(added),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None
          ) =>
        AuctionEvent.LotAdded(LotId(added.lotId))
      case StoredAuctionEventBody(
            "LotRemoved",
            None,
            None,
            Some(removed),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None
          ) =>
        AuctionEvent.LotRemoved(LotId(removed.lotId))
      case StoredAuctionEventBody(
            "AuctionScheduled",
            None,
            None,
            None,
            Some(config),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None
          ) =>
        AuctionEvent.AuctionScheduled(restoreConfig(config))
      case StoredAuctionEventBody(
            "PrebiddingStarted",
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None
          ) =>
        AuctionEvent.PrebiddingStarted
      case StoredAuctionEventBody(
            "AuctionDiscarded",
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None
          ) =>
        AuctionEvent.AuctionDiscarded
      case StoredAuctionEventBody(
            "AuctionCancelled",
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None
          ) =>
        AuctionEvent.AuctionCancelled
      case StoredAuctionEventBody(
            "PrebiddingDeadlineReached",
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None
          ) =>
        AuctionEvent.PrebiddingDeadlineReached
      case StoredAuctionEventBody(
            "PrebiddingEnded",
            None,
            None,
            None,
            None,
            Some(ended),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None
          ) =>
        AuctionEvent.PrebiddingEnded(ended.finished)
      case StoredAuctionEventBody(
            "FinalLineupFrozen",
            None,
            None,
            None,
            None,
            None,
            Some(lineup),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None
          ) if lineup.order.nonEmpty && lineup.order.distinct.size == lineup.order.size =>
        AuctionEvent.FinalLineupFrozen(lineup.order.map(LotId(_)))
      case StoredAuctionEventBody(
            "FinalStarted",
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None
          ) =>
        AuctionEvent.FinalStarted
      case StoredAuctionEventBody(
            "FinalLotActivated",
            None,
            None,
            None,
            None,
            None,
            None,
            Some(activated),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None
          ) =>
        AuctionEvent.FinalLotActivated(LotId(activated.lotId))
      case StoredAuctionEventBody(
            "FinalLotCompleted",
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            Some(completed),
            None,
            None,
            None,
            None,
            None,
            None,
            None
          ) =>
        AuctionEvent.FinalLotCompleted(LotId(completed.lotId))
      case StoredAuctionEventBody(
            "AuctionFinished",
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None
          ) =>
        AuctionEvent.AuctionFinished
      // Окно запуска прошло проверку команды против конфигурации; без неё журнал сверяет то, что выводится из окна.
      case StoredAuctionEventBody(
            "StepWindowLaunched",
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            Some(window),
            None,
            None,
            None,
            None,
            None,
            None
          ) if window.from.isBefore(window.until) && window.lots.nonEmpty =>
        AuctionEvent.StepWindowLaunched(restoreWindow(window))
      // Ориентировочное время финала: момент, названный администратором (ADR-040, дополнение 2026-10-19).
      case StoredAuctionEventBody(
            "FinalTimeSet",
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            Some(time),
            None,
            None,
            None,
            None,
            None
          ) =>
        AuctionEvent.FinalTimeSet(time.at)
      // Снятие времени: payload у него пуст, как у `AuctionPublished`.
      case StoredAuctionEventBody(
            "FinalTimeCleared",
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None
          ) =>
        AuctionEvent.FinalTimeCleared
      // Текст оплаты (PER-322): строка администратора, как он её записал.
      case StoredAuctionEventBody(
            "PaymentInstructionsSet",
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            Some(instructions),
            None
          ) =>
        AuctionEvent.PaymentInstructionsSet(PaymentInstructions.of(instructions.text))
      // Снятие текста: payload у него пуст, как у `FinalTimeCleared`.
      case StoredAuctionEventBody(
            "PaymentInstructionsCleared",
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None
          ) =>
        AuctionEvent.PaymentInstructionsCleared
      case StoredAuctionEventBody(
            "LotSetDefined",
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            Some(set),
            None,
            None,
            None,
            None
          ) if set.lots.distinct.size == set.lots.size =>
        AuctionEvent.LotSetDefined(LotSetId(set.lotSetId), restoreName(set.lotSetId, set.name), set.lots.map(LotId(_)))
      case StoredAuctionEventBody(
            "LotSetDeleted",
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            Some(set),
            None,
            None,
            None
          ) =>
        AuctionEvent.LotSetDeleted(LotSetId(set.lotSetId))
      case StoredAuctionEventBody(
            "LotSetSettled",
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            Some(set),
            None,
            None
          ) =>
        val settlement =
          set.collector.fold(LotSetSettlement.NotCollected)(by => LotSetSettlement.Collected(ParticipantId(by)))
        AuctionEvent.LotSetSettled(LotSetId(set.lotSetId), settlement)
      // Порядок и разделы ленты (PER-719): раскладка целиком; лот в двух местах и повтор раздела — испорченная строка.
      case StoredAuctionEventBody(
            "LotLayoutSet",
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            Some(layout)
          ) =>
        AuctionEvent.LotLayoutSet(restoreLayout(layout))
      case other => corrupted(s"auction event of kind ${other.kind} with sections that do not match it")
    }

  private def storeConfig(config: AuctionConfig): StoredAuctionConfig =
    StoredAuctionConfig(
      onlinePhase = config.onlinePhase.map(phase =>
        StoredOnlinePhase(phase.opensAt, phase.closesAt, phase.closesLots, phase.raffleClosesAt, phase.rafflePrize)
      ),
      finalBlocks = config.finalBlocks,
      closingPolicy = config.closingPolicy match {
        case ClosingPolicy.ByAuctioneer => StoredClosingPolicy("ByAuctioneer", None)
        case ClosingPolicy.ByDeadline => StoredClosingPolicy("ByDeadline", None)
        case ClosingPolicy.Mixed(onlineByDeadline) =>
          StoredClosingPolicy("Mixed", Some(StoredMixedClosing(onlineByDeadline)))
      },
      lotDefaults = config.lotDefaults.map(LotJournal.storeConfig),
      stepWindows = Option.when(config.stepWindows.nonEmpty)(config.stepWindows.map(storeWindow)),
      paymentTerm = Some(config.paymentTerm)
    )

  private def storeWindow(window: StepWindowConfig): StoredAuctionStepWindow =
    StoredAuctionStepWindow(
      window.from,
      window.until,
      LotJournal.storeMoney(window.step),
      window.lots.toList.map(_.value).sorted
    )

  private def restoreWindow(stored: StoredAuctionStepWindow): StepWindowConfig =
    StepWindowConfig(stored.from, stored.until, LotJournal.restoreMoney(stored.step), stored.lots.map(LotId(_)).toSet)

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
        stored.onlinePhase.map(phase =>
          OnlinePhase(phase.opensAt, phase.closesAt, phase.closesLots, phase.raffleClosesAt, phase.rafflePrize)
        ),
        stored.finalBlocks,
        policy,
        stored.lotDefaults.map(LotJournal.restoreConfig),
        stored.stepWindows.getOrElse(Nil).map(restoreWindow),
        stored.paymentTerm.getOrElse(AuctionConfig.PlatformPaymentTerm)
      )
      .fold(invalid => corrupted(s"auction config violates $invalid"), config => config)
  }

  private def corrupted(message: String): Nothing = throw new JournalCorrupted(message)
}
