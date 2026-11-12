package auction.lot

import java.time.Duration
import java.time.Instant
import java.util.UUID

/** Участник — идентификатор платформы, а не Telegram user id (RFC-011, «Идентичность»). */
final case class ParticipantId(value: UUID)

/** Ставка адресуема: на неё ссылаются лидерство, продажа и уведомление. */
final case class BidId(value: UUID)

/** Ключ идемпотентности команды; генерирует отправитель, проверяет домен (П-06). */
final case class OpId(value: UUID)

/** Аукцион, которому принадлежит лот (RFC-011, «Идентичность»; до PER-423 — «торговая сессия»). */
final case class AuctionId(value: UUID)

/**
 * Параметры анти-снайпа (П-04): ставка за `window` до дедлайна продлевает его на `extension`, не больше `maxExtensions`
 * раз. Лежат в конфигурации, потому что `LotOpened` несёт её целиком (ADR-047): правило не читает настроек снаружи.
 */
final case class AntiSnipe(window: Duration, extension: Duration, maxExtensions: Int)

/**
 * Конфигурация торгов, замороженная на входе в `Trading` (И-10) и пришедшая целиком из `LotOpened` (RFC-011, И-07).
 *
 * Анти-снайп читают ставка и прокси-лимит, признак прокси — `SetProxyLimit`. Валюта политики шага совпадает с валютой
 * лота по построению: иначе шаг складывался бы с ценой другой валюты (И-04).
 */
final case class LotConfig private[lot] (
    currency: CurrencyCode,
    stepPolicy: StepPolicy,
    antiSnipe: AntiSnipe,
    proxyEnabled: Boolean
)

object LotConfig {

  def of(
      currency: CurrencyCode,
      stepPolicy: StepPolicy,
      antiSnipe: AntiSnipe,
      proxyEnabled: Boolean
  ): Either[StepPolicyInvalid, LotConfig] =
    if (stepPolicy.currency != currency) Left(StepPolicyInvalid.MixedCurrency)
    else Right(LotConfig(currency, stepPolicy, antiSnipe, proxyEnabled))

  /** Проверка И-15 на входе `ScheduleLot`: политика строится теми же конструкторами, что закрывают её тип. */
  def parse(input: LotConfigInput): Either[StepPolicyInvalid, LotConfig] = {
    val policy = input.stepPolicy match {
      case StepPolicyInput.Fixed(step) => StepPolicy.fixed(step)
      case StepPolicyInput.Tiered(tiers) => StepPolicy.tiered(tiers)
    }
    policy.flatMap(of(input.currency, _, input.antiSnipe, input.proxyEnabled))
  }
}

/**
 * Политика шага, как её прислал организатор, до проверки И-15. Проверенная [[StepPolicy]] противоречивой быть не может,
 * поэтому отказ `StepPolicyInvalid` у `ScheduleLot` возможен, только если вход несёт непроверенную форму.
 */
enum StepPolicyInput {
  case Fixed(step: Money)
  case Tiered(tiers: List[StepPolicy.Tier])
}

/** Конфигурация торгов во входе `ScheduleLot` до проверки: [[LotConfig.parse]] превращает её в [[LotConfig]]. */
final case class LotConfigInput(
    currency: CurrencyCode,
    stepPolicy: StepPolicyInput,
    antiSnipe: AntiSnipe,
    proxyEnabled: Boolean
)

/**
 * Условия торгов, которые лот знает до открытия: та часть `LotOpened`, что без дедлайна (ADR-047, `Schedule`).
 * Стартовая цена в валюте конфигурации по построению — иначе `OpenLot` получил бы отказ, которого у него нет (RFC-011,
 * «Как лот попадает в Draft и Scheduled»).
 */
final case class Schedule private[lot] (startingPrice: Money, config: LotConfig)

object Schedule {

  def of(startingPrice: Money, config: LotConfig): Either[ScheduleLotRejected, Schedule] =
    if (startingPrice.currency != config.currency) Left(ScheduleLotRejected.CurrencyMismatch)
    else Right(Schedule(startingPrice, config))
}

/** Фаза торгов: `Online` из открытия лота, `Live` из возврата в финал; меняет правило приёма ставки (ADR-049). */
enum Phase {
  case Online
  case Live
}

/**
 * Окно «Счастливых часов» лота — полуинтервал `[from, until)` и условия в нём (RFC-011, П-03; ADR-047, дополнения
 * 2026-10-08 и 2026-10-27): сумма шага и стартовая цена для лота без ставок, хотя бы одно из двух. Лот получает только
 * окна, в которые организатор его выбрал, поэтому списка лотов здесь нет; валюта сумм — валюта лота, окна в чужой
 * валюте лот при открытии и при запуске отбрасывает (И-04). Окно прежних событий — окно с одним шагом.
 */
final case class StepWindow(
    from: Instant,
    until: Instant,
    step: Option[Money],
    start: Option[Money],
    period: Option[WindowPeriod] = None
) {
  require(step.isDefined || start.isDefined, "a step window sets a step, a starting price or both")

  /** Окно — условия лота в этом периоде «Счастливых часов». */
  def of(other: WindowPeriod): Boolean = period.contains(other)

  /** Полуинтервалы пересекаются: каждое начинается раньше, чем кончается другое. */
  def overlaps(other: StepWindow): Boolean = from.isBefore(other.until) && other.from.isBefore(until)

  /** Все суммы окна в валюте `currency`: окно в чужой валюте лот не записывает. */
  def in(currency: CurrencyCode): Boolean = (step.toList ++ start.toList).forall(_.currency == currency)
}

object StepWindow {

  /**
   * Окно сниженного шага без стартовой цены — форма объявленного и запущенного окна (дополнения 2026-10-08,
   * 2026-10-12).
   */
  def apply(from: Instant, until: Instant, step: Money): StepWindow = StepWindow(from, until, Some(step), None)
}

/**
 * Период «Счастливых часов» аукциона, условиями лота в котором служит окно (ADR-047, дополнение 2026-10-27, PER-786):
 * идентификатор периода аукциона. По нему лот заменяет и снимает окно периода до его начала. Окно объявленное и
 * запущенное периода не имеет.
 */
final case class WindowPeriod(value: UUID)

/**
 * Действующий прокси-лимит участника (RFC-011, «Состояние лота»).
 *
 * `setSeq` — `sequence` события `ProxyLimitSet`, которое его записало: в payload он не входит, а берётся из конверта
 * (ADR-047), и им П-02 решает равенство максимумов (П-07). `setAt` из RFC не хранится: ни одно правило его не читает, а
 * время конверта ядро не видит.
 */
final case class ProxyLimit(max: Money, setSeq: Long)

/** Что сделал участник входом торгов: ручная ставка, выставленный или снятый прокси-лимит (ADR-072, п. 2). */
enum Move {
  case Bid(amount: Money)
  case LimitSet(max: Money)
  case LimitWithdrawn
}

/**
 * Вход торгов лота (ADR-072, п. 2): участник, что он сделал, момент команды `at` и `sequence` события. Производные
 * ставки прокси входами не являются — их дают правила, и переигрывание выводит их заново.
 */
final case class Entry(participant: ParticipantId, move: Move, at: Instant, sequence: Long)

/**
 * Окно, запущенное по ходу торгов (`StepWindowAdded`) или заданное периодом (`PeriodWindowSet`), и номер строки
 * журнала, с которой лот его знает.
 */
final case class AddedWindow(window: StepWindow, sequence: Long)

/**
 * История торгов лота — то, по чему снятие участника переигрывает торги без него (ADR-072, п. 2). Стартовая цена и окна
 * сниженного шага лежат здесь, а не только в торгах: удержание окон не несёт, а переигрывание в `Held` идёт по ним.
 * `stepWindows` — окна `LotOpened`, `addedWindows` — запущенные потом вместе с номером строки: вход видит окно, только
 * если лот знал его к этому входу. Без номера окно, которое аукцион запустил с текущего момента, а лот записал позже,
 * дало бы при переигрывании сниженный шаг входу, принятому ещё по обычному. Окно периода «Счастливых часов» лежит здесь
 * последней формой: замена и снятие идут только до его начала (PER-786), поэтому входы до них приняты раньше окна, и
 * прежняя форма ни на один из них не действовала. `online` — входы онлайн-недели, на которые П-02 отвечал; `held` —
 * лимиты, записанные в удержании, которые ждали финала без пересчёта. Входы живого финала история не копит: снятие в
 * `Live` закрыто (п. 4), а другой фазы, где оно открыто, после финала нет. `removed` — снятые участники (И-22).
 */
final case class Course(
    startingPrice: Money,
    stepWindows: List[StepWindow],
    online: Vector[Entry],
    held: Vector[Entry],
    removed: Set[ParticipantId],
    addedWindows: Vector[AddedWindow] = Vector.empty
) {

  /** Окна, которые лот знал к строке `sequence`, по возрастанию начала — как `stepWindows` торгов в тот момент. */
  def windowsAt(sequence: Long): List[StepWindow] =
    (stepWindows ++ addedWindows.filter(_.sequence < sequence).map(_.window)).sortBy(_.from)
}

object Course {

  /** История лота, торги которого только что открылись: входов и снятых ещё нет. */
  def opened(startingPrice: Money, stepWindows: List[StepWindow]): Course =
    Course(startingPrice, stepWindows, Vector.empty, Vector.empty, Set.empty)
}

/**
 * Состояние лота в торгах (RFC-011, «Состояние лота»).
 *
 * До первой ставки `currentPrice` — стартовая цена, а `leader` пуст (И-02). `deadline` пуст, если лот ведёт человек.
 * `proxyLimits` держит И-03 по построению: ключ — участник, и новый лимит заменяет прежний. `extensionsUsed` — сколько
 * раз анти-снайп уже продлил дедлайн (П-04); он лежит рядом с дедлайном, чтобы лимит продлений восстанавливался из
 * журнала вместе с ним (ПП-2). `markedForFinal` — лот отмечен для финала (П-09): торги идут как обычно, а закрытие по
 * дедлайну удержит его вместо продажи. Это состояние, а не настройка: `false` из `LotOpened` и `LotResumed`, `true` из
 * `LotMarkedForFinal` (И-10). `stepWindows` — окна сниженного шага из `LotOpened`, `StepWindowAdded` и
 * `PeriodWindowSet` по возрастанию начала: объявленные и запущенные только дописываются, а окно периода «Счастливых
 * часов» до его начала заменяется и снимается (И-21, ADR-047, дополнения 2026-10-12 и 2026-10-27), и действуют они
 * только в фазе `Online`. В живой финал они не доходят: удержание их не переносит, и `LotResumed` строит торги без
 * окон. `course` — история торгов для снятия участника (ADR-072); пуста она только у состояния, прочитанного из строки
 * прежней формы, которая истории не несла: entity поднимает лот replay'ем журнала, и там история есть всегда.
 */
final case class TradingState(
    config: LotConfig,
    currentPrice: Money,
    ask: Option[Money],
    leader: Option[ParticipantId],
    leadingBidId: Option[BidId],
    phase: Phase,
    deadline: Option[Instant],
    extensionsUsed: Int,
    proxyLimits: Map[ParticipantId, ProxyLimit],
    markedForFinal: Boolean,
    course: Option[Course],
    stepWindows: List[StepWindow] = Nil
)

/**
 * Лот удержан для живого финала: те же цена, лидер, лимиты и счётчик продлений, что были в торгах на момент дедлайна,
 * дедлайна и ask нет (П-09). Лимит, записанный в удержании, ждёт финала: пересчёт П-02 здесь не запускается. `course` —
 * та же история торгов, что в [[TradingState]]: снятие участника открыто и в удержании (ADR-072, п. 4).
 */
final case class HeldState(
    config: LotConfig,
    currentPrice: Money,
    leader: Option[ParticipantId],
    leadingBidId: Option[BidId],
    proxyLimits: Map[ParticipantId, ProxyLimit],
    extensionsUsed: Int,
    course: Option[Course]
)

final case class Sale(winner: ParticipantId, price: Money, bidId: BidId, at: Instant)

/** Почему лот закрылся без продажи. Резервной цены в модели нет, поэтому причина одна (RFC-011, О-2). */
enum UnsoldReason {
  case NoBids
}

/**
 * Почему лот снят с торгов (ADR-047, `LotWithdrawn`). Причина пока одна — отмена аукциона (дополнение 2026-10-12):
 * снятие лота организатором, автором и как дубля придёт вместе со своими командами.
 */
enum WithdrawnReason {
  case AuctionCancelled
}

/**
 * Состояния лота (RFC-011, «Состояние лота»). Сумма запечатана: остальные терминальные добавятся случаями, а
 * исчерпывающий `match` в [[Lot.decide]] покажет, где их обработать.
 *
 * `Initial` — «в журнале лота ещё ничего нет». В RFC-011 такого состояния нет: там до `LotDrafted` лота не существует.
 * Под шардингом entity поднимается на любой `lot_id`, и лот без журнала — это `Initial`; из него выводит только
 * `LotDrafted`, а любая другая команда получает `LotNotFound`. В журнал и snapshot он не попадает.
 */
enum LotState {
  case Initial
  case Draft
  case Scheduled(schedule: Schedule)
  case Trading(state: TradingState)
  case Held(state: HeldState)
  case Sold(sale: Sale)
  case Unsold(reason: UnsoldReason)
  case Withdrawn(reason: WithdrawnReason)
}

/**
 * Кто отправил ставку: участник из бота или помощник ведущего за человека в зале. Ставка зала — запись «участник принял
 * объявленную цену»: сумма в ней та, что огласил ведущий, и в живом финале правило приёма у неё то же, что у бота.
 */
enum BidSource {
  case Bot
  case Floor
}

/**
 * Происхождение ставки: ручная команда или производная ставка прокси (П-02). Ручная несёт канал, через который её
 * поставили; у производной канала нет — её поставила система в пределах лимита (`ProxyBid` в `auction_events.proto`).
 */
enum BidOrigin {
  case Manual(source: BidSource)
  case Proxy
}

final case class PlaceBid(participant: ParticipantId, amount: Money, opId: OpId, source: BidSource)

/** Прокси-лимит участника на лот: новый заменяет прежний, каким бы он ни был (И-03). */
final case class SetProxyLimit(participant: ParticipantId, max: Money, opId: OpId)

/** Снятие прокси-лимита участником, в том числе лидером (RFC-011, О-3). */
final case class WithdrawProxyLimit(participant: ParticipantId, opId: OpId)

/**
 * Рождение лота. Отправляет аукцион после своего `LotAdded`, и лот с этой минуты принадлежит ему: аукцион — часть
 * рождения, а не отдельная привязка (RFC-011, «Команды и события»).
 */
final case class DraftLot(auction: AuctionId, opId: OpId)

/** Условия торгов целиком: каждая правка до `LotOpened` заменяет прежние, а не дополняет их. */
final case class ScheduleLot(startingPrice: Money, config: LotConfigInput, opId: OpId)

/**
 * Открытие торгов лота. Стартовая цена и конфигурация берутся из `Scheduled`, а дедлайн и окна сниженного шага приходят
 * от аукциона, которому принадлежит их источник (RFC-011, «Вход и выход команд»). `stepWindows` — окна, в которые
 * организатор выбрал этот лот; пусто, если таких нет.
 */
final case class OpenLot(deadline: Option[Instant], opId: OpId, stepWindows: List[StepWindow] = Nil)

/**
 * Почему лот закрывают: наступил дедлайн — тогда наступил ли он, решает сам лот (RFC-011, П-05), — или закрывает
 * ведущий, и дедлайн не проверяется.
 */
enum CloseReason {
  case DeadlineReached
  case ByAuctioneer
}

/** Закрытие лота. По дедлайну его шлёт аукцион, когда наступает дедлайн лота (ADR-045); время решения — серверное. */
final case class CloseLot(reason: CloseReason, opId: OpId)

/**
 * Отметка лота для финала (RFC-011, П-09). Шлёт аукцион по выбору организатора (PER-320); отметка торгов не
 * останавливает, а меняет исход закрытия по дедлайну.
 */
final case class MarkForFinal(opId: OpId)

/**
 * Снятие отметки для финала (PER-320, ADR-047, дополнение 2026-10-06). Подчиняется тому же дедлайну, что отметка:
 * снятая до него отметка возвращает лоту обычное закрытие, а удержанный лот с финала этой командой не снимается.
 */
final case class UnmarkForFinal(opId: OpId)

/**
 * Снятие лота с торгов (ADR-047, дополнение 2026-10-12). Шлёт аукцион, отменённый после старта торгов: снимается лот,
 * который ещё не продан и не закрыт, в том числе не открытый и удержанный. `Withdrawn` терминален, как продажа.
 */
final case class WithdrawLot(reason: WithdrawnReason, opId: OpId)

/**
 * Снятие участника с лота целиком (ADR-072, п. 1): все его ставки и действующий лимит. Шлёт аукцион по команде
 * администратора сходки; администратор — инициатор конверта, в команду он не входит. `expectedVersion` — номер лота, на
 * котором администратор видел предпросмотр (PER-658): снятие необратимо, и итог, которого он не видел, не пишется.
 */
final case class RemoveParticipant(participant: ParticipantId, opId: OpId, expectedVersion: Long)

/** Возврат удержанного лота в торги живого финала (П-09): без дедлайна и ask, в фазе `Live`. */
final case class ResumeLot(opId: OpId)

/**
 * Окно сниженного шага, запущенное по ходу торгов (ADR-047, дополнение 2026-10-12). Шлёт аукцион после
 * `StepWindowLaunched` каждому лоту окна и после рестарта — тем же `op_id`, пока лот не ответит.
 */
final case class AddStepWindow(window: StepWindow, opId: OpId)

/**
 * Условия лота в периоде «Счастливых часов» (ADR-047, дополнение 2026-10-27, PER-786): окно `window` с периодом
 * заменяет окно того же периода или ложится новым. Шлёт аукцион после записи условий и после рестарта — тем же `op_id`,
 * пока лот не ответит.
 */
final case class SetPeriodWindow(window: StepWindow, opId: OpId) {
  require(window.period.isDefined, "a period window names its period")
}

/** Снятие условий лота в периоде `period`: аукцион снял условия или удалил период (PER-786). */
final case class ClearPeriodWindow(period: WindowPeriod, opId: OpId)

/**
 * Следующая цена, которую ведущий объявил залу (RFC-011, П-08). Ведущего команда не несёт: он — инициатор конверта, а
 * ask — приглашение, а не ставка, поэтому ни цену, ни лидера команда не меняет.
 */
final case class AdvanceAsk(newAsk: Money, opId: OpId)

/**
 * События лота. `LotOpened` несёт всю конфигурацию торгов и окна сниженного шага, чтобы состояние восстанавливалось из
 * журнала без обращения наружу (И-07). `previousLeader` при первой ставке отсутствует, а не равен нулю (RFC-011, П-01).
 *
 * У `LotDrafted` payload нет (ADR-047): аукцион лежит в конверте строки. В доменном событии он полем, потому что
 * принадлежность лота аукциону восстанавливает `apply`, а конверт ядро не читает. `LotScheduled` несёт `Schedule`
 * снимком.
 *
 * `DeadlineExtended` собственной команды не имеет (ADR-047): его пишет ставка или прокси-лимит последним событием своей
 * транзакции. Он несёт итог — новый дедлайн и счётчик, а не приращение, поэтому свёртка не зависит от того, с какого
 * snapshot она началась.
 *
 * `LotMarkedForFinal` и `LotResumed` payload не несут, `LotHeldForFinal` — только время удержания (ADR-047, дополнение
 * 2026-09-24): цена, лидер и лимиты удержанного лота — те, что свёрнуты из журнала до него. `LotUnmarkedForFinal` тоже
 * без payload (дополнение 2026-10-06): он только снимает признак.
 *
 * `AskAdvanced` несёт только объявленную сумму: кто её объявил, лежит в конверте инициатором, как в контракте шины.
 * `LotWithdrawn` — только причину: снявший лежит там же (ADR-047, `actor`). `StepWindowAdded` — запущенное окно без
 * множества лотов, той же формы, что окно в `LotOpened` (дополнение 2026-10-12). `PeriodWindowSet` — окно периода
 * «Счастливых часов» целиком, с периодом; `PeriodWindowCleared` — только период (дополнение 2026-10-27, PER-786).
 *
 * `overtakenByProxy` у ручной ставки — её той же командой перебила производная ставка другого участника, и лидерство,
 * взятое ею, команду не пережило. Свёртка его не читает: это знание о транзакции для потребителей факта, которое
 * проекция публикации, видящая по одному событию, иначе не получила бы (PER-473). У производной ставки всегда `false`.
 *
 * `ParticipantRemoved` несёт итог переигрывания торгов без снятого (ADR-072, п. 1): цену, лидера и `leadingBidId` —
 * позицию лидера, новую ставку суммой `price`, которой в журнале может не быть. Лидер и позиция пусты вместе: у
 * оставшихся нет ни ставки, ни лимита (И-02). Итог в событии, а не вывод при `apply`, — исход замораживается в момент
 * решения и от версии правил переигрывания не зависит.
 */
enum LotEvent {
  case LotDrafted(auction: AuctionId)
  case LotScheduled(schedule: Schedule)
  case LotOpened(
      startingPrice: Money,
      config: LotConfig,
      deadline: Option[Instant],
      stepWindows: List[StepWindow] = Nil
  )
  case BidPlaced(
      bidId: BidId,
      participant: ParticipantId,
      amount: Money,
      previousLeader: Option[ParticipantId],
      origin: BidOrigin,
      overtakenByProxy: Boolean = false
  )
  case ProxyLimitSet(participant: ParticipantId, max: Money)
  case ProxyLimitWithdrawn(participant: ParticipantId)
  case DeadlineExtended(newDeadline: Instant, extensionsUsed: Int)
  case LotSold(winner: ParticipantId, price: Money, bidId: BidId, at: Instant)
  case LotUnsold(reason: UnsoldReason)
  case LotMarkedForFinal
  case LotHeldForFinal(at: Instant)
  case LotResumed
  case LotUnmarkedForFinal
  case AskAdvanced(ask: Money)
  case LotWithdrawn(reason: WithdrawnReason)
  case StepWindowAdded(window: StepWindow)
  case PeriodWindowSet(window: StepWindow)
  case PeriodWindowCleared(period: WindowPeriod)

  case ParticipantRemoved(
      participant: ParticipantId,
      price: Money,
      leader: Option[ParticipantId],
      leadingBidId: Option[BidId]
  )
}

/**
 * Строка журнала агрегата в той части конверта, которую читает ядро.
 *
 * `sequence` назначает не ядро, а тот, кто пишет журнал: на рабочем пути это номер события в Pekko Persistence. Ядро
 * только сворачивает журнал в его порядке (П-07); второго счётчика рядом с журнальным нет.
 */
final case class Envelope(sequence: Long, opId: OpId, event: LotEvent)

/**
 * Строка журнала лота, как её сворачивает [[Lot.replay]]: конверт и момент записи — `occurred_at` строки. Момент нужен
 * истории торгов: по нему переигрывание снятия знает, когда был вход (ADR-072, п. 2).
 */
final case class Written(envelope: Envelope, at: Instant)

/*
 * `LotNotFound` — ответ лоту в `Initial` на любую команду, кроме `DraftLot`: «тот же ответ, что и команде к
 * неизвестному `lot_id`» (RFC-011, «Команды и события»). Под шардингом это одно и то же.
 */

/** Отказ `DraftLot`: лот уже родился, в каком бы состоянии он ни был. */
enum DraftLotRejected {
  case LotAlreadyExists
}

/**
 * Отказы `ScheduleLot`. `SchedulingClosed` — после `LotOpened` условия заморожены (И-10). `StepPolicyInvalid` называет
 * нарушение И-15, `CurrencyMismatch` — стартовую цену в валюте, отличной от конфигурации. `OpIdTaken` — `op_id` уже
 * записан под другим событием лота; как у команд участника, на границе это статус, а не значение ответа.
 */
enum ScheduleLotRejected {
  case LotNotFound
  case OpIdTaken
  case SchedulingClosed
  case StepPolicyInvalid(reason: auction.lot.StepPolicyInvalid)
  case CurrencyMismatch
}

/**
 * Отказы `OpenLot`. `LotNotScheduled` — ответ лоту без условий торгов или уже открытому. `AnotherLotActive` проверяет
 * аукцион, а не лот: это отказ `StartNextLot` в финале (PER-334), в онлайн-торгах лоты открыты одновременно.
 */
enum OpenLotRejected {
  case LotNotFound
  case LotNotScheduled
}

/**
 * Именованные отказы `PlaceBid` (RFC-011, «Команды и события»). Отказ событий не пишет и повтором не защищён (П-06).
 *
 * `OpIdTaken` у трёх команд участника — `op_id` уже записан под другой командой: чужого участника или другого вида
 * (ADR-047, дополнение 2026-10-05). Как и `LotNotFound`, на границе это статус, а не значение ответа.
 */
enum PlaceBidRejected {
  case LotNotFound
  case OpIdTaken
  case LotNotOpen
  case LotOnHold(currentPrice: Money)
  case CurrencyMismatch
  case BidderIsLeader(currentPrice: Money)
  case BidNotAtNextPrice(expected: Money)
  case BidBelowMinimum(minRequired: Money)
  case BidAboveMaximum(maximum: Money)
  case ParticipantRemovedFromLot
}

/**
 * Отказы `SetProxyLimit` (ADR-047). `ProxyDisabledForLot` от входа не зависит и проверяется первым; валюта — до
 * сравнения с ценой, потому что суммы разных валют не сравниваются (И-04). `ProxyBelowCurrentPrice` — лимит ниже нижней
 * границы торга; лимит, равный ей, принимается: лидер вправе опустить свой лимит вплоть до текущей цены (RFC-011, О-3).
 */
enum SetProxyLimitRejected {
  case LotNotFound
  case OpIdTaken
  case LotNotOpen
  case ProxyDisabledForLot
  case CurrencyMismatch
  case ProxyBelowCurrentPrice(minLimit: Money)
  case ParticipantRemovedFromLot
}

/**
 * Отказы `CloseLot` (RFC-011, П-05). `LotNotOpen` — лот не в торгах и не удержан, в том числе уже закрытый (И-05).
 * `DeadlineNotReached` — закрытие по дедлайну, которого у лота нет или который ещё не наступил: планировщик лишь
 * присылает команду, а наступил ли момент, решает лот.
 */
enum CloseLotRejected {
  case LotNotFound
  case LotNotOpen
  case DeadlineNotReached
}

/**
 * Отказы `MarkForFinal` (RFC-011, П-09). `LotNotOpen` — лот не в торгах, в том числе удержанный или закрытый.
 * `NotInOnlinePhase` — лот уже в живом финале. `DeadlinePassed` — дедлайн наступил, даже если закрытие ещё не пришло:
 * гонку отметки и закрытия судит лот, а не планировщик. `OpIdTaken` — `op_id` уже записан под другим событием лота.
 */
enum MarkForFinalRejected {
  case LotNotFound
  case OpIdTaken
  case LotNotOpen
  case NotInOnlinePhase
  case AlreadyMarkedForFinal
  case DeadlinePassed
}

/**
 * Отказы `UnmarkForFinal` (ADR-047, дополнение 2026-10-06). `LotNotOpen` — лот ещё не в торгах или уже закрыт.
 * `DeadlinePassed` — дедлайн наступил, в том числе у удержанного лота: снять финалиста после дедлайна значило бы
 * продать лот задним числом. `NotMarkedForFinal` — отметки нет, снимать нечего.
 */
enum UnmarkForFinalRejected {
  case LotNotFound
  case OpIdTaken
  case LotNotOpen
  case NotInOnlinePhase
  case NotMarkedForFinal
  case DeadlinePassed
}

/** Отказы `ResumeLot`: вернуть в торги можно только удержанный лот; `OpIdTaken` — как у отметки. */
enum ResumeLotRejected {
  case LotNotFound
  case OpIdTaken
  case LotNotHeld
}

/**
 * Отказы `AdvanceAsk` (RFC-011, П-08). `LotNotOpen` — лот не в торгах, в том числе удержанный: ask объявляют торгам, а
 * не перерыву. `AskBelowCurrentPrice` называет сумму, которую ask обязан превысить, — нижнюю границу торга: текущую
 * цену или прежний ask, если он выше. `OpIdTaken` — `op_id` уже записан под другим событием лота.
 */
enum AdvanceAskRejected {
  case LotNotFound
  case OpIdTaken
  case LotNotOpen
  case CurrencyMismatch
  case AskBelowCurrentPrice(mustExceed: Money)
}

/**
 * Отказы `WithdrawLot`. `LotAlreadyClosed` — лот продан, закрыт без продажи или уже снят под другим `op_id`: что
 * завершилось, остаётся (ADR-047, дополнение 2026-10-12). `OpIdTaken` — `op_id` уже записан под другим событием лота.
 */
enum WithdrawLotRejected {
  case LotNotFound
  case OpIdTaken
  case LotAlreadyClosed
}

/**
 * Отказы `AddStepWindow` (ADR-047, дополнение 2026-10-12). `LotNotOpen` — лот не в торгах онлайн-этапа: закрыт, снят,
 * удержан или уже в живом финале; аукцион такого лота не ждёт. `OpIdTaken` — `op_id` уже записан под другим событием
 * лота.
 */
enum AddStepWindowRejected {
  case LotNotFound
  case OpIdTaken
  case LotNotOpen
}

/**
 * Отказы `SetPeriodWindow` и `ClearPeriodWindow` (PER-786). `LotNotOpen` — лот не в торгах онлайн-этапа, как у
 * `AddStepWindow`. `PeriodStarted` — момент команды не раньше начала окна периода: с начала период заморожен. Аукцион
 * ни одного из них не ждёт.
 */
enum PeriodWindowRejected {
  case LotNotFound
  case OpIdTaken
  case LotNotOpen
  case PeriodStarted
}

/**
 * Отказы `RemoveParticipant` (ADR-072, п. 1 и 4). `LotNotOpen` — лот не в торгах и не удержан. `NotInOnlinePhase` — лот
 * в живом финале: ставки там ведёт ведущий. `DeadlinePassed` — дедлайн наступил, даже если закрытие ещё не пришло: тот
 * же судья, что у отметки финала. `NotALotParticipant` — у человека на лоте нет ни принятой ручной ставки, ни
 * выставленного лимита, в том числе снятого потом. `ParticipantAlreadyRemoved` — его уже сняли под другим `op_id`.
 * `LotChanged` — лот ушёл от номера, на котором администратор видел предпросмотр (PER-658).
 */
enum RemoveParticipantRejected {
  case LotNotFound
  case OpIdTaken
  case LotNotOpen
  case NotInOnlinePhase
  case DeadlinePassed
  case NotALotParticipant
  case ParticipantAlreadyRemoved
  case LotChanged
}

/** Отказы `WithdrawProxyLimit`: у участника нет действующего лимита на этот лот. */
enum WithdrawProxyLimitRejected {
  case LotNotFound
  case OpIdTaken
  case NoActiveProxyLimit
}
