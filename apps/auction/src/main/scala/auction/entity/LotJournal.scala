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

final case class StoredLotOpened(startingPrice: StoredMoney, config: StoredConfig, deadline: Option[Instant])

/**
 * `source` есть только у ручной ставки: производную ставку прокси поставила система, а не канал. Строка, записанная до
 * прокси, несёт его всегда и читается так же.
 */
final case class StoredBidPlaced(
    bidId: UUID,
    participant: UUID,
    amount: StoredMoney,
    previousLeader: Option[UUID],
    origin: String,
    source: Option[String]
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

/**
 * `LotDrafted` записан одним `kind` без секции: payload у него пуст (ADR-047), а аукцион лежит в конверте строки. Так
 * же без секции `LotMarkedForFinal` и `LotResumed`. Секции добавлялись в конец: строка, записанная до них, читает
 * недостающую как пустую.
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
    lotHeldForFinal: Option[StoredLotHeldForFinal]
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
 * `proxyLimits` необязателен по форме: snapshot, записанный до прокси-лимитов, его не несёт и читается как торги без
 * лимитов. Новый snapshot пишет его всегда, в порядке `setSeq`. `extensionsUsed` так же: snapshot, записанный до
 * анти-снайпа, читается как торги без продлений — других тогда и не было. `markedForFinal` так же: до отметки финала
 * отмеченных лотов не было.
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
    markedForFinal: Option[Boolean]
)

/**
 * `extensionsUsed` необязателен по форме: удержанный лот до PER-310 не встречался, и snapshot без него читается нулём.
 */
final case class StoredHeld(
    config: StoredConfig,
    currentPrice: StoredMoney,
    leader: Option[UUID],
    leadingBidId: Option[UUID],
    proxyLimits: Option[List[StoredProxyLimit]],
    extensionsUsed: Option[Int]
)

/** Продажа: секция события `LotSold` и состояния `Sold` — одни и те же поля (ADR-047). */
final case class StoredSale(winner: UUID, price: StoredMoney, bidId: UUID, at: Instant)

/** `unsold` — причина закрытия без продажи; добавлена в конец, и snapshot, записанный до неё, читает её пустой. */
final case class StoredLotState(
    kind: String,
    trading: Option[StoredTrading],
    held: Option[StoredHeld],
    sold: Option[StoredSale],
    scheduled: Option[StoredSchedule],
    unsold: Option[String]
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
      case LotEvent.LotOpened(startingPrice, config, deadline) =>
        StoredEvent
          .of("LotOpened")
          .copy(lotOpened = Some(StoredLotOpened(storeMoney(startingPrice), storeConfig(config), deadline)))
      case LotEvent.BidPlaced(bidId, participant, amount, previousLeader, origin) =>
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
                source = source
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
      stored.lotHeldForFinal
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
          LotEvent.LotOpened(restoreMoney(opened.startingPrice), restoreConfig(opened.config), opened.deadline)
        }
      case ("BidPlaced", 1) =>
        stored.bidPlaced.fold(mismatch) { placed =>
          LotEvent.BidPlaced(
            bidId = BidId(placed.bidId),
            participant = ParticipantId(placed.participant),
            amount = restoreMoney(placed.amount),
            previousLeader = placed.previousLeader.map(ParticipantId(_)),
            origin = restoreOrigin(placed.origin, placed.source)
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
              markedForFinal = Some(trading.markedForFinal)
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
              extensionsUsed = Some(held.extensionsUsed)
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
    }

  private def restoreState(stored: StoredLotState): LotState =
    (stored.kind, stored.trading, stored.held, stored.sold, stored.scheduled, stored.unsold) match {
      case ("Initial", None, None, None, None, None) => LotState.Initial
      case ("Draft", None, None, None, None, None) => LotState.Draft
      case ("Scheduled", None, None, None, Some(schedule), None) => LotState.Scheduled(restoreSchedule(schedule))
      case ("Trading", Some(trading), None, None, None, None) =>
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
            markedForFinal = trading.markedForFinal.getOrElse(false)
          )
        )
      case ("Held", None, Some(held), None, None, None) =>
        val config = restoreConfig(held.config)
        LotState.Held(
          HeldState(
            config = config,
            currentPrice = restoreMoney(held.currentPrice),
            leader = held.leader.map(ParticipantId(_)),
            leadingBidId = held.leadingBidId.map(BidId(_)),
            proxyLimits = restoreLimits(held.proxyLimits, config),
            extensionsUsed = held.extensionsUsed.getOrElse(0)
          )
        )
      case ("Sold", None, None, Some(sale), None, None) =>
        LotState.Sold(Sale(ParticipantId(sale.winner), restoreMoney(sale.price), BidId(sale.bidId), sale.at))
      case ("Unsold", None, None, None, None, Some(reason)) =>
        LotState.Unsold(restoreEnum("unsold reason", reason)(UnsoldReason.valueOf))
      case _ => corrupted(s"lot state of kind ${stored.kind} with sections that do not match it")
    }

  private def storeMoney(money: Money): StoredMoney = StoredMoney(money.minorUnits, money.currency.value)

  private def restoreMoney(stored: StoredMoney): Money = Money(stored.minorUnits, CurrencyCode(stored.currency))

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
