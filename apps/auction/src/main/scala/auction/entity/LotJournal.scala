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

final case class StoredBidPlaced(
    bidId: UUID,
    participant: UUID,
    amount: StoredMoney,
    previousLeader: Option[UUID],
    origin: String,
    source: String
)

/**
 * `LotDrafted` записан одним `kind` без секции: payload у него пуст (ADR-047), а сессия лежит в конверте строки. Секции
 * добавлялись в конец: строка, записанная до них, читает недостающую как пустую.
 */
final case class StoredEvent(
    kind: String,
    lotOpened: Option[StoredLotOpened],
    bidPlaced: Option[StoredBidPlaced],
    lotScheduled: Option[StoredSchedule]
)

/** Поле `actor` конверта ADR-047; в коде его значение — [[Initiator]], чтобы не спорить с актором Pekko. */
final case class StoredActor(kind: String, id: Option[UUID])

/**
 * Строка журнала лота: конверт ADR-047 и событие. `aggregate_type` и `aggregate_id` — это `persistence_id` строки,
 * `sequence` — её `sequence_number`, `schema_version` — версия в manifest (`JacksonMigration`); в payload они не
 * дублируются. `sessionId` необязателен по форме (ADR-058): строка, записанная до `LotDrafted`, его не несёт, и такая
 * строка читается, но лота уже не рождает. Новая строка несёт его всегда, а `LotDrafted` без него — испорченный журнал.
 */
final case class StoredLotEvent(
    eventId: UUID,
    transactionId: UUID,
    opId: UUID,
    sessionId: Option[UUID],
    occurredAt: Instant,
    actor: StoredActor,
    event: StoredEvent
) extends JournalSerializable

final case class StoredTrading(
    config: StoredConfig,
    currentPrice: StoredMoney,
    ask: Option[StoredMoney],
    leader: Option[UUID],
    leadingBidId: Option[UUID],
    phase: String,
    deadline: Option[Instant]
)

final case class StoredHeld(
    config: StoredConfig,
    currentPrice: StoredMoney,
    leader: Option[UUID],
    leadingBidId: Option[UUID]
)

final case class StoredSale(winner: UUID, price: StoredMoney, bidId: UUID, at: Instant)

final case class StoredLotState(
    kind: String,
    trading: Option[StoredTrading],
    held: Option[StoredHeld],
    sold: Option[StoredSale],
    scheduled: Option[StoredSchedule]
)

/** Конверт окна дедупликации несёт сессию строки: без неё `LotDrafted` из snapshot не восстановить. */
final case class StoredSeen(sequence: Long, opId: UUID, sessionId: Option[UUID], event: StoredEvent)

/**
 * Snapshot лота целиком, вместе с окном дедупликации: без него повтор `op_id` до snapshot дописал бы журнал (П-06).
 * `sequence` — номер последнего события, с которого entity продолжает счёт после snapshot (`LotEntity.State`).
 */
final case class StoredLot(sequence: Long, state: StoredLotState, session: Option[UUID], seen: List[StoredSeen])
    extends JournalSerializable

/** Кто инициировал команду (RFC-011, конверт): участник, оператор или планировщик. */
enum Initiator {
  case Participant(id: ParticipantId)
  case Operator(id: ParticipantId)
  case Scheduler
}

/**
 * Общая часть конверта всех событий одной команды: один `op_id`, одна транзакция, одна сессия и одно время решения
 * (ADR-047).
 */
final case class Transaction(id: UUID, opId: OpId, session: SessionId, occurredAt: Instant, initiator: Initiator)

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
      sessionId = Some(transaction.session.value),
      occurredAt = transaction.occurredAt,
      actor = storeInitiator(transaction.initiator),
      event = storeEvent(event)
    )

  /** Строка журнала в той части конверта, которую читает ядро; `sequence` — номер строки в журнале Pekko. */
  def envelope(sequence: Long, stored: StoredLotEvent): Envelope =
    Envelope(sequence, OpId(stored.opId), restoreEvent(stored.event, stored.sessionId))

  def storeLot(lot: Lot, sequence: Long): StoredLot =
    StoredLot(
      sequence = sequence,
      state = storeState(lot.state),
      session = lot.session.map(_.value),
      seen = lot.seen.values.toList
        .sortBy(_.sequence)
        .map { envelope =>
          StoredSeen(envelope.sequence, envelope.opId.value, sessionOfEvent(envelope.event), storeEvent(envelope.event))
        }
    )

  /**
   * Snapshot восстанавливается с инвариантом `Lot.session`: сессия пуста ровно в `Initial`. Replay такого лота не дал
   * бы, поэтому snapshot без сессии в непустом состоянии — испорченный, и entity падает на recovery, а не на первой
   * команде после него.
   */
  def restoreLot(stored: StoredLot): Lot = {
    val state = restoreState(stored.state)
    val session = stored.session.map(SessionId(_))
    if ((state == LotState.Initial) != session.isEmpty)
      corrupted(s"lot snapshot of kind ${stored.state.kind} with session ${stored.session}")
    Lot(
      state = state,
      session = session,
      seen = stored.seen.map { seen =>
        val envelope = Envelope(seen.sequence, OpId(seen.opId), restoreEvent(seen.event, seen.sessionId))
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
   * Сессия, которую событие несёт в домене. Конверт окна `seen` пишет её только для `LotDrafted`: остальным событиям
   * она при восстановлении не нужна, а лот хранит свою сессию отдельным полем snapshot.
   */
  private def sessionOfEvent(event: LotEvent): Option[UUID] =
    event match {
      case LotEvent.LotDrafted(session) => Some(session.value)
      case _ => None
    }

  private def storeEvent(event: LotEvent): StoredEvent =
    event match {
      case LotEvent.LotDrafted(_) =>
        StoredEvent("LotDrafted", lotOpened = None, bidPlaced = None, lotScheduled = None)
      case LotEvent.LotScheduled(schedule) =>
        StoredEvent("LotScheduled", lotOpened = None, bidPlaced = None, lotScheduled = Some(storeSchedule(schedule)))
      case LotEvent.LotOpened(startingPrice, config, deadline) =>
        StoredEvent(
          "LotOpened",
          lotOpened = Some(StoredLotOpened(storeMoney(startingPrice), storeConfig(config), deadline)),
          bidPlaced = None,
          lotScheduled = None
        )
      case LotEvent.BidPlaced(bidId, participant, amount, previousLeader, origin, source) =>
        StoredEvent(
          "BidPlaced",
          lotOpened = None,
          bidPlaced = Some(
            StoredBidPlaced(
              bidId = bidId.value,
              participant = participant.value,
              amount = storeMoney(amount),
              previousLeader = previousLeader.map(_.value),
              origin = origin.toString,
              source = source.toString
            )
          ),
          lotScheduled = None
        )
    }

  private def restoreEvent(stored: StoredEvent, session: Option[UUID]): LotEvent =
    (stored.kind, stored.lotOpened, stored.bidPlaced, stored.lotScheduled) match {
      case ("LotDrafted", None, None, None) =>
        session match {
          case Some(id) => LotEvent.LotDrafted(SessionId(id))
          case None => corrupted("lot drafted without a session")
        }
      case ("LotScheduled", None, None, Some(schedule)) => LotEvent.LotScheduled(restoreSchedule(schedule))
      case ("LotOpened", Some(opened), None, None) =>
        LotEvent.LotOpened(restoreMoney(opened.startingPrice), restoreConfig(opened.config), opened.deadline)
      case ("BidPlaced", None, Some(placed), None) =>
        LotEvent.BidPlaced(
          bidId = BidId(placed.bidId),
          participant = ParticipantId(placed.participant),
          amount = restoreMoney(placed.amount),
          previousLeader = placed.previousLeader.map(ParticipantId(_)),
          origin = restoreEnum("bid origin", placed.origin)(BidOrigin.valueOf),
          source = restoreEnum("bid source", placed.source)(BidSource.valueOf)
        )
      case _ => corrupted(s"lot event of kind ${stored.kind} with sections that do not match it")
    }

  private def storeState(state: LotState): StoredLotState =
    state match {
      case LotState.Initial => StoredLotState("Initial", None, None, None, None)
      case LotState.Draft => StoredLotState("Draft", None, None, None, None)
      case LotState.Scheduled(schedule) =>
        StoredLotState("Scheduled", None, None, None, scheduled = Some(storeSchedule(schedule)))
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
              deadline = trading.deadline
            )
          ),
          held = None,
          sold = None,
          scheduled = None
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
              leadingBidId = held.leadingBidId.map(_.value)
            )
          ),
          sold = None,
          scheduled = None
        )
      case LotState.Sold(sale) =>
        StoredLotState(
          "Sold",
          trading = None,
          held = None,
          sold = Some(StoredSale(sale.winner.value, storeMoney(sale.price), sale.bidId.value, sale.at)),
          scheduled = None
        )
    }

  private def restoreState(stored: StoredLotState): LotState =
    (stored.kind, stored.trading, stored.held, stored.sold, stored.scheduled) match {
      case ("Initial", None, None, None, None) => LotState.Initial
      case ("Draft", None, None, None, None) => LotState.Draft
      case ("Scheduled", None, None, None, Some(schedule)) => LotState.Scheduled(restoreSchedule(schedule))
      case ("Trading", Some(trading), None, None, None) =>
        LotState.Trading(
          TradingState(
            config = restoreConfig(trading.config),
            currentPrice = restoreMoney(trading.currentPrice),
            ask = trading.ask.map(restoreMoney),
            leader = trading.leader.map(ParticipantId(_)),
            leadingBidId = trading.leadingBidId.map(BidId(_)),
            phase = restoreEnum("phase", trading.phase)(Phase.valueOf),
            deadline = trading.deadline
          )
        )
      case ("Held", None, Some(held), None, None) =>
        LotState.Held(
          HeldState(
            config = restoreConfig(held.config),
            currentPrice = restoreMoney(held.currentPrice),
            leader = held.leader.map(ParticipantId(_)),
            leadingBidId = held.leadingBidId.map(BidId(_))
          )
        )
      case ("Sold", None, None, Some(sale), None) =>
        LotState.Sold(Sale(ParticipantId(sale.winner), restoreMoney(sale.price), BidId(sale.bidId), sale.at))
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

  private def storeConfig(config: LotConfig): StoredConfig =
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
  private def restoreConfig(stored: StoredConfig): LotConfig = {
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
