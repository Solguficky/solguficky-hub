package auction.entity

import auction.lot.*
import org.apache.pekko.persistence.typed.SnapshotAdapter

import java.time.Duration
import java.time.Instant
import java.time.format.DateTimeParseException
import java.util.UUID

/**
 * Типы, которые Pekko пишет в строку журнала и в snapshot. Привязка к `jackson-json` — одна строка
 * `serialization-bindings` в `application.conf` на этот маркер.
 */
trait JournalSerializable

/*
 * Модель хранения лота (ADR формата журнала).
 *
 * Доменные типы в базу не пишутся: закрытые конструкторы `LotConfig` и `StepPolicy` держат И-15, и рефлексия Jackson
 * обошла бы их, а переименование в домене молча ломало бы журнал. Поэтому в строке лежат только эти классы, а в их
 * полях — только `Long`, `Int`, `Boolean`, `String`, `UUID` и `Instant`: числа с плавающей точкой непредставимы по типу
 * поля (ПП-5). Длительности пишутся строкой ISO-8601, а не числом: Jackson записал бы их дробью секунд.
 *
 * Имя класса — manifest строки журнала, а имена полей — ключи JSON. И то и другое — формат хранения: переименование
 * без `JacksonMigration` делает записанный журнал нечитаемым, и golden-файлы в тестах держат это обязательство.
 * Взаимоисключающие варианты записаны полем `kind` и одной заполненной секцией — та же форма, что `oneof`, без
 * полиморфных аннотаций Jackson.
 */

final case class StoredMoney(minorUnits: Long, currency: String)

final case class StoredTier(bound: StoredMoney, step: StoredMoney)

/** `fixed` либо непустые `tiers`; первый порог `Tiered` записан явно с границей ноль, как его принимает И-15. */
final case class StoredStepPolicy(fixed: Option[StoredMoney], tiers: List[StoredTier])

final case class StoredAntiSnipe(window: String, extension: String, maxExtensions: Int)

final case class StoredConfig(
    currency: String,
    stepPolicy: StoredStepPolicy,
    antiSnipe: StoredAntiSnipe,
    proxyEnabled: Boolean
)

/** Секция `LotScheduled` и состояния `Scheduled`: `Schedule` снимком. */
final case class StoredSchedule(startingPrice: StoredMoney, config: StoredConfig)

/**
 * Окно «Счастливых часов» лота: полуинтервал `[from, until)`, сумма шага и стартовая цена для лота без ставок (ADR-047,
 * дополнения 2026-10-08 и 2026-10-27), хотя бы одно из двух. `start` добавлен в конец, а `step` стал необязательным:
 * строка, записанная до них, — окно с одним шагом. Строку без шага образ до дополнения 2026-10-27 не читает.
 */
final case class StoredStepWindow(
    from: Instant,
    until: Instant,
    step: Option[StoredMoney],
    start: Option[StoredMoney] = None
)

/**
 * `stepWindows` пишется только непустым (ADR-047, дополнение 2026-10-08): строка без него — торги без окна, и так
 * читается всё, что записано до этого поля.
 */
final case class StoredLotOpened(
    startingPrice: StoredMoney,
    config: StoredConfig,
    deadline: Option[Instant],
    stepWindows: Option[List[StoredStepWindow]] = None
)

/**
 * `source` есть только у ручной ставки: производную ставку прокси поставила система, а не канал. Строка, записанная до
 * прокси, несёт его всегда и читается так же. `overtakenByProxy` пишется только со значением `true` (PER-473): строка
 * без него — ставка, которую команда не перебила, и так читается всё, что записано до этого поля.
 */
final case class StoredBidPlaced(
    bidId: UUID,
    participant: UUID,
    amount: StoredMoney,
    previousLeader: Option[UUID],
    origin: String,
    source: Option[String],
    overtakenByProxy: Option[Boolean] = None
)

/** `setSeq` в payload не входит: это `sequence_number` той же строки (ADR-047). */
final case class StoredProxyLimitSet(participant: UUID, max: StoredMoney)

final case class StoredProxyLimitWithdrawn(participant: UUID)

/** Секция `DeadlineExtended`: итог продления — новый дедлайн и счётчик, а не приращение (ADR-047). */
final case class StoredDeadlineExtended(newDeadline: Instant, extensionsUsed: Int)

/** Секция `LotUnsold`: причина именем варианта `UnsoldReason`. */
final case class StoredLotUnsold(reason: String)

/** Секция `LotHeldForFinal`: время удержания, остальное лот свернул из журнала до него (ADR-047). */
final case class StoredLotHeldForFinal(at: Instant)

/** Секция `AskAdvanced`: объявленная сумма; ведущий — инициатор конверта, в секцию он не входит. */
final case class StoredAskAdvanced(ask: StoredMoney)

/** Секция `LotWithdrawn`: причина именем варианта `WithdrawnReason`; снявший — инициатор конверта. */
final case class StoredLotWithdrawn(reason: String)

/**
 * Секция `ParticipantRemoved` (ADR-072): снятый и итог переигрывания — цена, лидер и его позиция. Лидер и позиция пусты
 * вместе; снявший — инициатор конверта.
 */
final case class StoredParticipantRemoved(
    participant: UUID,
    price: StoredMoney,
    leader: Option[UUID],
    leadingBidId: Option[UUID]
)

/**
 * `LotDrafted` записан одним `kind` без секции: payload у него пуст (ADR-047), а аукцион лежит в конверте строки. Так
 * же без секции `LotMarkedForFinal` и `LotResumed`. Секции добавлялись в конец: строка, записанная до них, читает
 * недостающую как пустую. `stepWindowAdded` — окно, запущенное по ходу торгов (ADR-047, дополнение 2026-10-12).
 */
final case class StoredEvent(
    kind: String,
    lotOpened: Option[StoredLotOpened],
    bidPlaced: Option[StoredBidPlaced],
    lotScheduled: Option[StoredSchedule],
    proxyLimitSet: Option[StoredProxyLimitSet],
    proxyLimitWithdrawn: Option[StoredProxyLimitWithdrawn],
    lotSold: Option[StoredSale],
    lotUnsold: Option[StoredLotUnsold],
    deadlineExtended: Option[StoredDeadlineExtended],
    lotHeldForFinal: Option[StoredLotHeldForFinal],
    askAdvanced: Option[StoredAskAdvanced] = None,
    lotWithdrawn: Option[StoredLotWithdrawn] = None,
    stepWindowAdded: Option[StoredStepWindow] = None,
    participantRemoved: Option[StoredParticipantRemoved] = None
)

object StoredEvent {

  /** Событие данного вида без единой секции; заполненную секцию добавляет `copy`. */
  def of(kind: String): StoredEvent = StoredEvent(kind, None, None, None, None, None, None, None, None, None)
}

/** Поле `actor` конверта ADR-047; в коде его значение — [[Initiator]], чтобы не спорить с актором Pekko. */
final case class StoredActor(kind: String, id: Option[UUID])

/**
 * Строка журнала лота: конверт ADR-047 и событие. `aggregate_type` и `aggregate_id` — это `persistence_id` строки,
 * `sequence` — её `sequence_number`, `schema_version` — версия в manifest (`JacksonMigration`); в payload они не
 * дублируются. `auctionId` необязателен по форме (ADR-058): строка, записанная до `LotDrafted`, его не несёт, и такая
 * строка читается, но лота уже не рождает. Новая строка несёт его всегда, а `LotDrafted` без него — испорченный журнал.
 */
final case class StoredLotEvent(
    eventId: UUID,
    transactionId: UUID,
    opId: UUID,
    auctionId: Option[UUID],
    occurredAt: Instant,
    actor: StoredActor,
    event: StoredEvent
) extends JournalSerializable

/** Лимит в snapshot несёт `setSeq`: строки `ProxyLimitSet` до snapshot replay уже не прочитает. */
final case class StoredProxyLimit(participant: UUID, max: StoredMoney, setSeq: Long)

/**
 * Вход истории торгов: `kind` — `Bid`, `LimitSet` или `LimitWithdrawn`, `amount` — сумма ставки или лимита, у снятия
 * лимита её нет. `at` и `sequence` — момент и номер строки журнала, из которой вход записан.
 */
final case class StoredEntry(participant: UUID, kind: String, amount: Option[StoredMoney], at: Instant, sequence: Long)

/** Окно `StepWindowAdded` в истории торгов и номер строки журнала, с которой лот его знает. */
final case class StoredAddedWindow(window: StoredStepWindow, sequence: Long)

/**
 * История торгов лота (ADR-072, п. 2). `stepWindows` — окна `LotOpened` и `addedWindows` — запущенные по ходу торгов
 * пишутся только непустыми, как в `StoredLotOpened`; `removed` — снятые участники.
 */
final case class StoredCourse(
    startingPrice: StoredMoney,
    stepWindows: Option[List[StoredStepWindow]],
    online: List[StoredEntry],
    held: List[StoredEntry],
    removed: List[UUID],
    addedWindows: Option[List[StoredAddedWindow]] = None
)

/**
 * `proxyLimits` необязателен по форме: snapshot, записанный до прокси-лимитов, его не несёт и читается как торги без
 * лимитов. Новый snapshot пишет его всегда, в порядке `setSeq`. `extensionsUsed` так же: snapshot, записанный до
 * анти-снайпа, читается как торги без продлений — других тогда и не было. `markedForFinal` так же: до отметки финала
 * отмеченных лотов не было. `stepWindows` так же и пишется только непустым, как в `StoredLotOpened`. `course` — история
 * торгов (PER-657): новый snapshot пишет её всегда, а прежний её не несёт и читается торгами с неизвестной историей.
 */
final case class StoredTrading(
    config: StoredConfig,
    currentPrice: StoredMoney,
    ask: Option[StoredMoney],
    leader: Option[UUID],
    leadingBidId: Option[UUID],
    phase: String,
    deadline: Option[Instant],
    proxyLimits: Option[List[StoredProxyLimit]],
    extensionsUsed: Option[Int],
    markedForFinal: Option[Boolean],
    stepWindows: Option[List[StoredStepWindow]] = None,
    course: Option[StoredCourse] = None
)

/**
 * `extensionsUsed` необязателен по форме: удержанный лот до PER-310 не встречался, и snapshot без него читается нулём.
 * `course` — как в `StoredTrading`.
 */
final case class StoredHeld(
    config: StoredConfig,
    currentPrice: StoredMoney,
    leader: Option[UUID],
    leadingBidId: Option[UUID],
    proxyLimits: Option[List[StoredProxyLimit]],
    extensionsUsed: Option[Int],
    course: Option[StoredCourse] = None
)

/** Продажа: секция события `LotSold` и состояния `Sold` — одни и те же поля (ADR-047). */
final case class StoredSale(winner: UUID, price: StoredMoney, bidId: UUID, at: Instant)

/**
 * `unsold` — причина закрытия без продажи, `withdrawn` — причина снятия; обе добавлены в конец, и snapshot, записанный
 * до них, читает их пустыми.
 */
final case class StoredLotState(
    kind: String,
    trading: Option[StoredTrading],
    held: Option[StoredHeld],
    sold: Option[StoredSale],
    scheduled: Option[StoredSchedule],
    unsold: Option[String],
    withdrawn: Option[String] = None
)

/** Конверт окна дедупликации несёт аукцион строки: без неё `LotDrafted` из snapshot не восстановить. */
final case class StoredSeen(sequence: Long, opId: UUID, auctionId: Option[UUID], event: StoredEvent)

/**
 * Snapshot лота целиком, вместе с окном дедупликации: без него повтор `op_id` до snapshot дописал бы журнал (П-06).
 * `sequence` — номер последнего события, с которого entity продолжает счёт после snapshot (`LotEntity.State`).
 */
final case class StoredLot(sequence: Long, state: StoredLotState, auction: Option[UUID], seen: List[StoredSeen])
    extends JournalSerializable

/** Кто инициировал команду (RFC-011, конверт): участник, оператор или планировщик. */
enum Initiator {
  case Participant(id: ParticipantId)
  case Operator(id: ParticipantId)
  case Scheduler
}

/**
 * Общая часть конверта всех событий одной команды: один `op_id`, одна транзакция, один аукцион и одно время решения
 * (ADR-047).
 */
final case class Transaction(id: UUID, opId: OpId, auction: AuctionId, occurredAt: Instant, initiator: Initiator)

/**
 * Строка журнала или snapshot, которую нельзя превратить обратно в доменное значение. Это не ожидаемый отказ, а
 * испорченный журнал: entity падает, а не продолжает с состоянием, которого журнал не держит.
 */
final class JournalCorrupted(message: String) extends RuntimeException(message)

object LotJournal {

  def store(eventId: UUID, transaction: Transaction, event: LotEvent): StoredLotEvent =
    StoredLotEvent(
      eventId = eventId,
      transactionId = transaction.id,
      opId = transaction.opId.value,
      auctionId = Some(transaction.auction.value),
      occurredAt = transaction.occurredAt,
      actor = storeInitiator(transaction.initiator),
      event = storeEvent(event)
    )

  /** Строка журнала в той части конверта, которую читает ядро; `sequence` — номер строки в журнале Pekko. */
  def envelope(sequence: Long, stored: StoredLotEvent): Envelope =
    Envelope(sequence, OpId(stored.opId), restoreEvent(stored.event, stored.auctionId))

  def storeLot(lot: Lot, sequence: Long): StoredLot =
    StoredLot(
      sequence = sequence,
      state = storeState(lot.state),
      auction = lot.auction.map(_.value),
      seen = lot.seen.values.toList
        .sortBy(_.sequence)
        .map { envelope =>
          StoredSeen(envelope.sequence, envelope.opId.value, auctionOfEvent(envelope.event), storeEvent(envelope.event))
        }
    )

  /**
   * Snapshot восстанавливается с инвариантом `Lot.auction`: аукцион пуст ровно в `Initial`. Replay такого лота не дал
   * бы, поэтому snapshot без аукциона в непустом состоянии — испорченный, и entity падает на recovery, а не на первой
   * команде после него.
   */
  def restoreLot(stored: StoredLot): Lot = {
    val state = restoreState(stored.state)
    val auction = stored.auction.map(AuctionId(_))
    if ((state == LotState.Initial) != auction.isEmpty)
      corrupted(s"lot snapshot of kind ${stored.state.kind} with auction ${stored.auction}")
    Lot(
      state = state,
      auction = auction,
      seen = stored.seen.map { seen =>
        val envelope = Envelope(seen.sequence, OpId(seen.opId), restoreEvent(seen.event, seen.auctionId))
        envelope.opId -> envelope
      }.toMap
    )
  }

  val snapshotAdapter: SnapshotAdapter[LotEntity.State] = new SnapshotAdapter[LotEntity.State] {
    override def toJournal(state: LotEntity.State): Any = storeLot(state.lot, state.sequence)

    override def fromJournal(from: Any): LotEntity.State =
      from match {
        case stored: StoredLot => LotEntity.State(restoreLot(stored), stored.sequence)
        case other => corrupted(s"lot snapshot of unexpected type ${other.getClass.getName}")
      }
  }

  def storeInitiator(initiator: Initiator): StoredActor =
    initiator match {
      case Initiator.Participant(id) => StoredActor("Participant", Some(id.value))
      case Initiator.Operator(id) => StoredActor("Operator", Some(id.value))
      case Initiator.Scheduler => StoredActor("Scheduler", None)
    }

  def restoreInitiator(stored: StoredActor): Initiator =
    (stored.kind, stored.id) match {
      case ("Participant", Some(id)) => Initiator.Participant(ParticipantId(id))
      case ("Operator", Some(id)) => Initiator.Operator(ParticipantId(id))
      case ("Scheduler", None) => Initiator.Scheduler
      case _ => corrupted(s"initiator $stored")
    }

  /**
   * Аукцион, который событие несёт в домене. Конверт окна `seen` пишет его только для `LotDrafted`: остальным событиям
   * он при восстановлении не нужен, а лот хранит свой аукцион отдельным полем snapshot.
   */
  private def auctionOfEvent(event: LotEvent): Option[UUID] =
    event match {
      case LotEvent.LotDrafted(auction) => Some(auction.value)
      case _ => None
    }

  private def storeEvent(event: LotEvent): StoredEvent =
    event match {
      case LotEvent.LotDrafted(_) => StoredEvent.of("LotDrafted")
      case LotEvent.LotScheduled(schedule) =>
        StoredEvent.of("LotScheduled").copy(lotScheduled = Some(storeSchedule(schedule)))
      case LotEvent.LotOpened(startingPrice, config, deadline, windows) =>
        StoredEvent
          .of("LotOpened")
          .copy(lotOpened =
            Some(StoredLotOpened(storeMoney(startingPrice), storeConfig(config), deadline, storeWindows(windows)))
          )
      case LotEvent.BidPlaced(bidId, participant, amount, previousLeader, origin, overtakenByProxy) =>
        val (originKind, source) = origin match {
          case BidOrigin.Manual(channel) => ("Manual", Some(channel.toString))
          case BidOrigin.Proxy => ("Proxy", None)
        }
        StoredEvent
          .of("BidPlaced")
          .copy(bidPlaced =
            Some(
              StoredBidPlaced(
                bidId = bidId.value,
                participant = participant.value,
                amount = storeMoney(amount),
                previousLeader = previousLeader.map(_.value),
                origin = originKind,
                source = source,
                overtakenByProxy = Option.when(overtakenByProxy)(true)
              )
            )
          )
      case LotEvent.ProxyLimitSet(participant, max) =>
        StoredEvent
          .of("ProxyLimitSet")
          .copy(proxyLimitSet = Some(StoredProxyLimitSet(participant.value, storeMoney(max))))
      case LotEvent.ProxyLimitWithdrawn(participant) =>
        StoredEvent
          .of("ProxyLimitWithdrawn")
          .copy(proxyLimitWithdrawn = Some(StoredProxyLimitWithdrawn(participant.value)))
      case LotEvent.LotSold(winner, price, bidId, at) =>
        StoredEvent.of("LotSold").copy(lotSold = Some(StoredSale(winner.value, storeMoney(price), bidId.value, at)))
      case LotEvent.LotUnsold(reason) =>
        StoredEvent.of("LotUnsold").copy(lotUnsold = Some(StoredLotUnsold(reason.toString)))
      case LotEvent.DeadlineExtended(newDeadline, extensionsUsed) =>
        StoredEvent
          .of("DeadlineExtended")
          .copy(deadlineExtended = Some(StoredDeadlineExtended(newDeadline, extensionsUsed)))
      case LotEvent.LotMarkedForFinal => StoredEvent.of("LotMarkedForFinal")
      case LotEvent.LotHeldForFinal(at) =>
        StoredEvent.of("LotHeldForFinal").copy(lotHeldForFinal = Some(StoredLotHeldForFinal(at)))
      case LotEvent.LotResumed => StoredEvent.of("LotResumed")
      case LotEvent.LotUnmarkedForFinal => StoredEvent.of("LotUnmarkedForFinal")
      case LotEvent.AskAdvanced(ask) =>
        StoredEvent.of("AskAdvanced").copy(askAdvanced = Some(StoredAskAdvanced(storeMoney(ask))))
      case LotEvent.LotWithdrawn(reason) =>
        StoredEvent.of("LotWithdrawn").copy(lotWithdrawn = Some(StoredLotWithdrawn(reason.toString)))
      case LotEvent.StepWindowAdded(window) =>
        StoredEvent.of("StepWindowAdded").copy(stepWindowAdded = Some(storeWindow(window)))
      case LotEvent.ParticipantRemoved(participant, price, leader, leadingBidId) =>
        StoredEvent
          .of("ParticipantRemoved")
          .copy(participantRemoved =
            Some(
              StoredParticipantRemoved(
                participant.value,
                storeMoney(price),
                leader.map(_.value),
                leadingBidId.map(_.value)
              )
            )
          )
    }

  /**
   * Ровно одна секция, и та, что названа `kind`; у `LotDrafted`, `LotMarkedForFinal`, `LotUnmarkedForFinal` и
   * `LotResumed` — ни одной. Иначе строка испорчена.
   */
  private def restoreEvent(stored: StoredEvent, auction: Option[UUID]): LotEvent = {
    val sections = List(
      stored.lotOpened,
      stored.bidPlaced,
      stored.lotScheduled,
      stored.proxyLimitSet,
      stored.proxyLimitWithdrawn,
      stored.lotSold,
      stored.lotUnsold,
      stored.deadlineExtended,
      stored.lotHeldForFinal,
      stored.askAdvanced,
      stored.lotWithdrawn,
      stored.stepWindowAdded,
      stored.participantRemoved
    ).count(_.isDefined)
    def mismatch: Nothing = corrupted(s"lot event of kind ${stored.kind} with sections that do not match it")
    (stored.kind, sections) match {
      case ("LotDrafted", 0) =>
        auction match {
          case Some(id) => LotEvent.LotDrafted(AuctionId(id))
          case None => corrupted("lot drafted without an auction")
        }
      case ("LotScheduled", 1) =>
        stored.lotScheduled.fold(mismatch)(schedule => LotEvent.LotScheduled(restoreSchedule(schedule)))
      case ("LotOpened", 1) =>
        stored.lotOpened.fold(mismatch) { opened =>
          val config = restoreConfig(opened.config)
          LotEvent.LotOpened(
            restoreMoney(opened.startingPrice),
            config,
            opened.deadline,
            restoreWindows(opened.stepWindows, config)
          )
        }
      case ("BidPlaced", 1) =>
        stored.bidPlaced.fold(mismatch) { placed =>
          LotEvent.BidPlaced(
            bidId = BidId(placed.bidId),
            participant = ParticipantId(placed.participant),
            amount = restoreMoney(placed.amount),
            previousLeader = placed.previousLeader.map(ParticipantId(_)),
            origin = restoreOrigin(placed.origin, placed.source),
            overtakenByProxy = placed.overtakenByProxy.contains(true)
          )
        }
      case ("ProxyLimitSet", 1) =>
        stored.proxyLimitSet.fold(mismatch) { set =>
          LotEvent.ProxyLimitSet(ParticipantId(set.participant), restoreMoney(set.max))
        }
      case ("ProxyLimitWithdrawn", 1) =>
        stored.proxyLimitWithdrawn.fold(mismatch) { withdrawn =>
          LotEvent.ProxyLimitWithdrawn(ParticipantId(withdrawn.participant))
        }
      case ("LotSold", 1) =>
        stored.lotSold.fold(mismatch) { sold =>
          LotEvent.LotSold(ParticipantId(sold.winner), restoreMoney(sold.price), BidId(sold.bidId), sold.at)
        }
      case ("LotUnsold", 1) =>
        stored.lotUnsold.fold(mismatch) { unsold =>
          LotEvent.LotUnsold(restoreEnum("unsold reason", unsold.reason)(UnsoldReason.valueOf))
        }
      case ("DeadlineExtended", 1) =>
        stored.deadlineExtended.fold(mismatch) { extended =>
          LotEvent.DeadlineExtended(extended.newDeadline, extended.extensionsUsed)
        }
      case ("LotMarkedForFinal", 0) => LotEvent.LotMarkedForFinal
      case ("LotHeldForFinal", 1) => stored.lotHeldForFinal.fold(mismatch)(held => LotEvent.LotHeldForFinal(held.at))
      case ("LotResumed", 0) => LotEvent.LotResumed
      case ("LotUnmarkedForFinal", 0) => LotEvent.LotUnmarkedForFinal
      case ("AskAdvanced", 1) =>
        stored.askAdvanced.fold(mismatch)(advanced => LotEvent.AskAdvanced(restoreMoney(advanced.ask)))
      case ("LotWithdrawn", 1) =>
        stored.lotWithdrawn.fold(mismatch) { withdrawn =>
          LotEvent.LotWithdrawn(restoreEnum("withdrawn reason", withdrawn.reason)(WithdrawnReason.valueOf))
        }
      // Валюту и пересечения окна сверяет свёртка состояния: у события нет конфигурации лота.
      case ("StepWindowAdded", 1) =>
        stored.stepWindowAdded.fold(mismatch) { added =>
          val window = restoreWindow(added)
          if (!window.from.isBefore(window.until)) corrupted("step window that ends before it starts")
          LotEvent.StepWindowAdded(window)
        }
      case ("ParticipantRemoved", 1) =>
        stored.participantRemoved.fold(mismatch) { removed =>
          if (removed.leader.isDefined != removed.leadingBidId.isDefined)
            corrupted("participant removal with a leader but no position, or a position but no leader")
          LotEvent.ParticipantRemoved(
            participant = ParticipantId(removed.participant),
            price = restoreMoney(removed.price),
            leader = removed.leader.map(ParticipantId(_)),
            leadingBidId = removed.leadingBidId.map(BidId(_))
          )
        }
      case _ => mismatch
    }
  }

  /** Ручная ставка несёт канал, производная — нет; иное сочетание `decide` не пишет. */
  private def restoreOrigin(origin: String, source: Option[String]): BidOrigin =
    (origin, source) match {
      case ("Manual", Some(channel)) => BidOrigin.Manual(restoreEnum("bid source", channel)(BidSource.valueOf))
      case ("Proxy", None) => BidOrigin.Proxy
      case _ => corrupted(s"bid origin $origin with source $source")
    }

  private def storeLimits(limits: Map[ParticipantId, ProxyLimit]): Option[List[StoredProxyLimit]] =
    Some(
      limits.toList
        .sortBy((_, limit) => limit.setSeq)
        .map((participant, limit) => StoredProxyLimit(participant.value, storeMoney(limit.max), limit.setSeq))
    )

  /** Второй лимит участника или лимит в чужой валюте — испорченный snapshot: `decide` таких не пишет (И-03, И-04). */
  private def restoreLimits(
      stored: Option[List[StoredProxyLimit]],
      config: LotConfig
  ): Map[ParticipantId, ProxyLimit] = {
    val limits = stored.getOrElse(Nil)
    if (limits.map(_.participant).distinct.size != limits.size) corrupted("two proxy limits of one participant")
    limits.map { limit =>
      val max = restoreMoney(limit.max)
      if (max.currency != config.currency) corrupted(s"proxy limit in ${max.currency.value}")
      ParticipantId(limit.participant) -> ProxyLimit(max, limit.setSeq)
    }.toMap
  }

  private def storeState(state: LotState): StoredLotState =
    state match {
      case LotState.Initial => StoredLotState("Initial", None, None, None, None, None)
      case LotState.Draft => StoredLotState("Draft", None, None, None, None, None)
      case LotState.Scheduled(schedule) =>
        StoredLotState("Scheduled", None, None, None, scheduled = Some(storeSchedule(schedule)), unsold = None)
      case LotState.Trading(trading) =>
        StoredLotState(
          "Trading",
          trading = Some(
            StoredTrading(
              config = storeConfig(trading.config),
              currentPrice = storeMoney(trading.currentPrice),
              ask = trading.ask.map(storeMoney),
              leader = trading.leader.map(_.value),
              leadingBidId = trading.leadingBidId.map(_.value),
              phase = trading.phase.toString,
              deadline = trading.deadline,
              proxyLimits = storeLimits(trading.proxyLimits),
              extensionsUsed = Some(trading.extensionsUsed),
              markedForFinal = Some(trading.markedForFinal),
              stepWindows = storeWindows(trading.stepWindows),
              course = trading.course.map(storeCourse)
            )
          ),
          held = None,
          sold = None,
          scheduled = None,
          unsold = None
        )
      case LotState.Held(held) =>
        StoredLotState(
          "Held",
          trading = None,
          held = Some(
            StoredHeld(
              config = storeConfig(held.config),
              currentPrice = storeMoney(held.currentPrice),
              leader = held.leader.map(_.value),
              leadingBidId = held.leadingBidId.map(_.value),
              proxyLimits = storeLimits(held.proxyLimits),
              extensionsUsed = Some(held.extensionsUsed),
              course = held.course.map(storeCourse)
            )
          ),
          sold = None,
          scheduled = None,
          unsold = None
        )
      case LotState.Sold(sale) =>
        StoredLotState(
          "Sold",
          trading = None,
          held = None,
          sold = Some(StoredSale(sale.winner.value, storeMoney(sale.price), sale.bidId.value, sale.at)),
          scheduled = None,
          unsold = None
        )
      case LotState.Unsold(reason) =>
        StoredLotState("Unsold", None, None, None, None, unsold = Some(reason.toString))
      case LotState.Withdrawn(reason) =>
        StoredLotState("Withdrawn", None, None, None, None, None, withdrawn = Some(reason.toString))
    }

  private def restoreState(stored: StoredLotState): LotState =
    (stored.kind, stored.trading, stored.held, stored.sold, stored.scheduled, stored.unsold, stored.withdrawn) match {
      case ("Initial", None, None, None, None, None, None) => LotState.Initial
      case ("Draft", None, None, None, None, None, None) => LotState.Draft
      case ("Scheduled", None, None, None, Some(schedule), None, None) => LotState.Scheduled(restoreSchedule(schedule))
      case ("Trading", Some(trading), None, None, None, None, None) =>
        val config = restoreConfig(trading.config)
        LotState.Trading(
          TradingState(
            config = config,
            currentPrice = restoreMoney(trading.currentPrice),
            ask = trading.ask.map(restoreMoney),
            leader = trading.leader.map(ParticipantId(_)),
            leadingBidId = trading.leadingBidId.map(BidId(_)),
            phase = restoreEnum("phase", trading.phase)(Phase.valueOf),
            deadline = trading.deadline,
            extensionsUsed = trading.extensionsUsed.getOrElse(0),
            proxyLimits = restoreLimits(trading.proxyLimits, config),
            markedForFinal = trading.markedForFinal.getOrElse(false),
            course = trading.course.map(restoreCourse(_, config)),
            stepWindows = restoreWindows(trading.stepWindows, config)
          )
        )
      case ("Held", None, Some(held), None, None, None, None) =>
        val config = restoreConfig(held.config)
        LotState.Held(
          HeldState(
            config = config,
            currentPrice = restoreMoney(held.currentPrice),
            leader = held.leader.map(ParticipantId(_)),
            leadingBidId = held.leadingBidId.map(BidId(_)),
            proxyLimits = restoreLimits(held.proxyLimits, config),
            extensionsUsed = held.extensionsUsed.getOrElse(0),
            course = held.course.map(restoreCourse(_, config))
          )
        )
      case ("Sold", None, None, Some(sale), None, None, None) =>
        LotState.Sold(Sale(ParticipantId(sale.winner), restoreMoney(sale.price), BidId(sale.bidId), sale.at))
      case ("Unsold", None, None, None, None, Some(reason), None) =>
        LotState.Unsold(restoreEnum("unsold reason", reason)(UnsoldReason.valueOf))
      case ("Withdrawn", None, None, None, None, None, Some(reason)) =>
        LotState.Withdrawn(restoreEnum("withdrawn reason", reason)(WithdrawnReason.valueOf))
      case _ => corrupted(s"lot state of kind ${stored.kind} with sections that do not match it")
    }

  private def storeCourse(course: Course): StoredCourse =
    StoredCourse(
      startingPrice = storeMoney(course.startingPrice),
      stepWindows = storeWindows(course.stepWindows),
      online = course.online.toList.map(storeEntry),
      held = course.held.toList.map(storeEntry),
      removed = course.removed.toList.map(_.value).sorted,
      addedWindows = Option.when(course.addedWindows.nonEmpty)(
        course.addedWindows.toList.map(added => StoredAddedWindow(storeWindow(added.window), added.sequence))
      )
    )

  private def storeEntry(entry: Entry): StoredEntry = {
    val (kind, amount) = entry.move match {
      case Move.Bid(amount) => ("Bid", Some(storeMoney(amount)))
      case Move.LimitSet(max) => ("LimitSet", Some(storeMoney(max)))
      case Move.LimitWithdrawn => ("LimitWithdrawn", None)
    }
    StoredEntry(entry.participant.value, kind, amount, entry.at, entry.sequence)
  }

  /**
   * История проходит те же проверки, что лимиты и окна: суммы в валюте лота (И-04), входы в порядке журнала. Иное —
   * испорченный snapshot: `apply` такой истории не копит.
   */
  private def restoreCourse(stored: StoredCourse, config: LotConfig): Course = {
    val startingPrice = restoreMoney(stored.startingPrice)
    if (startingPrice.currency != config.currency) corrupted("trading history starting price in another currency")
    val online = stored.online.map(restoreEntry(_, config)).toVector
    val held = stored.held.map(restoreEntry(_, config)).toVector
    val sequences = (online ++ held).map(_.sequence)
    if (sequences != sequences.sorted || sequences.distinct.size != sequences.size)
      corrupted("trading history entries out of journal order")
    val stepWindows = restoreWindows(stored.stepWindows, config)
    val added = stored.addedWindows.getOrElse(Nil)
    // Все окна истории вместе проходят проверки окон торгов: валюта, границы и пересечения.
    restoreWindows(Some(stored.stepWindows.getOrElse(Nil) ++ added.map(_.window)), config)
    if (added.map(_.sequence) != added.map(_.sequence).sorted)
      corrupted("trading history step windows out of journal order")
    // Снимают только участника лота (ADR-072, п. 1): снятый без входа — не та история, которую копит `apply`.
    val entered = (online ++ held).collect { case Entry(who, Move.Bid(_) | Move.LimitSet(_), _, _) => who.value }.toSet
    if (!stored.removed.forall(entered.contains)) corrupted("trading history removes someone who never entered it")
    Course(
      startingPrice = startingPrice,
      stepWindows = stepWindows,
      online = online,
      held = held,
      removed = stored.removed.map(ParticipantId(_)).toSet,
      addedWindows = added.map(each => AddedWindow(restoreWindow(each.window), each.sequence)).toVector
    )
  }

  private def restoreEntry(stored: StoredEntry, config: LotConfig): Entry = {
    val amount = stored.amount.map(restoreMoney)
    if (amount.exists(_.currency != config.currency)) corrupted(s"trading history entry in another currency")
    val move = (stored.kind, amount) match {
      case ("Bid", Some(sum)) => Move.Bid(sum)
      case ("LimitSet", Some(max)) => Move.LimitSet(max)
      case ("LimitWithdrawn", None) => Move.LimitWithdrawn
      case _ => corrupted(s"trading history entry of kind ${stored.kind} with amount $amount")
    }
    Entry(ParticipantId(stored.participant), move, stored.at, stored.sequence)
  }

  private def storeWindows(windows: List[StepWindow]): Option[List[StoredStepWindow]] =
    Option.when(windows.nonEmpty)(windows.map(storeWindow))

  private def storeWindow(window: StepWindow): StoredStepWindow =
    StoredStepWindow(window.from, window.until, window.step.map(storeMoney), window.start.map(storeMoney))

  private def restoreWindow(stored: StoredStepWindow): StepWindow =
    if (stored.step.isEmpty && stored.start.isEmpty) corrupted("step window with neither a step nor a starting price")
    else StepWindow(stored.from, stored.until, stored.step.map(restoreMoney), stored.start.map(restoreMoney))

  /**
   * Окна И-21: в валюте лота, `from` раньше `until`, без пересечений. Иное — испорченный журнал, а не торги без окна.
   * Порядок состояния — по возрастанию начала: так их пишет `Lot.decide(OpenLot)`, и так их читает шина.
   */
  private def restoreWindows(stored: Option[List[StoredStepWindow]], config: LotConfig): List[StepWindow] = {
    val windows = stored.getOrElse(Nil).map(restoreWindow)
    if (windows.exists(!_.in(config.currency))) corrupted("step window in another currency than the lot")
    if (windows.exists(window => !window.from.isBefore(window.until)))
      corrupted("step window that ends before it starts")
    val ordered = windows.sortBy(_.from)
    if (ordered.zip(ordered.drop(1)).exists((earlier, later) => later.from.isBefore(earlier.until)))
      corrupted("overlapping step windows of one lot")
    ordered
  }

  private[auction] def storeMoney(money: Money): StoredMoney = StoredMoney(money.minorUnits, money.currency.value)

  private[auction] def restoreMoney(stored: StoredMoney): Money =
    Money(stored.minorUnits, CurrencyCode(stored.currency))

  private def storeSchedule(schedule: Schedule): StoredSchedule =
    StoredSchedule(storeMoney(schedule.startingPrice), storeConfig(schedule.config))

  /** Снимок условий восстанавливается через те же проверки, что и при планировании: журнал И-15 и валюту не обходит. */
  private def restoreSchedule(stored: StoredSchedule): Schedule =
    Schedule
      .of(restoreMoney(stored.startingPrice), restoreConfig(stored.config))
      .fold(rejected => corrupted(s"schedule violates $rejected"), schedule => schedule)

  private[entity] def storeConfig(config: LotConfig): StoredConfig =
    StoredConfig(
      currency = config.currency.value,
      stepPolicy = config.stepPolicy match {
        case StepPolicy.Fixed(step) => StoredStepPolicy(Some(storeMoney(step)), Nil)
        case StepPolicy.Tiered(base, tiers) =>
          val first = StoredTier(storeMoney(Money(0, base.currency)), storeMoney(base))
          StoredStepPolicy(None, first :: tiers.map(tier => StoredTier(storeMoney(tier.bound), storeMoney(tier.step))))
      },
      antiSnipe = StoredAntiSnipe(
        window = config.antiSnipe.window.toString,
        extension = config.antiSnipe.extension.toString,
        maxExtensions = config.antiSnipe.maxExtensions
      ),
      proxyEnabled = config.proxyEnabled
    )

  /** Конфигурация восстанавливается через те же проверки, что и при планировании: журнал И-15 не обходит. */
  private[entity] def restoreConfig(stored: StoredConfig): LotConfig = {
    val policy = (stored.stepPolicy.fixed, stored.stepPolicy.tiers) match {
      case (Some(step), Nil) => StepPolicy.fixed(restoreMoney(step))
      case (None, tiers @ (_ :: _)) =>
        StepPolicy.tiered(tiers.map(tier => StepPolicy.Tier(restoreMoney(tier.bound), restoreMoney(tier.step))))
      case _ => corrupted("step policy with both or neither of fixed and tiers")
    }
    val antiSnipe = AntiSnipe(
      window = restoreDuration(stored.antiSnipe.window),
      extension = restoreDuration(stored.antiSnipe.extension),
      maxExtensions = stored.antiSnipe.maxExtensions
    )
    policy
      .flatMap(LotConfig.of(CurrencyCode(stored.currency), _, antiSnipe, stored.proxyEnabled))
      .fold(invalid => corrupted(s"lot config violates $invalid"), config => config)
  }

  private def restoreDuration(stored: String): Duration =
    try Duration.parse(stored)
    catch { case _: DateTimeParseException => corrupted(s"duration $stored") }

  private def restoreEnum[A](what: String, stored: String)(valueOf: String => A): A =
    try valueOf(stored)
    catch { case _: IllegalArgumentException => corrupted(s"$what $stored") }

  private def corrupted(message: String): Nothing = throw new JournalCorrupted(message)
}
