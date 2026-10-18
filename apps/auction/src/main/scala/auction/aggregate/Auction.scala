package auction.aggregate

import auction.catalog.LotId
import auction.lot.AdvanceAsk
import auction.lot.AdvanceAskRejected
import auction.lot.AntiSnipe
import auction.lot.AuctionId
import auction.lot.CurrencyCode
import auction.lot.LotConfig
import auction.lot.LotConfigInput
import auction.lot.MarkForFinal
import auction.lot.Money
import auction.lot.CloseLot
import auction.lot.CloseReason
import auction.lot.OpId
import auction.lot.Sale
import auction.lot.ScheduleLot
import auction.lot.ScheduleLotRejected
import auction.lot.StepPolicyInput
import auction.lot.UnmarkForFinal
import auction.lot.UnsoldReason

import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.time.Duration
import java.time.Instant
import java.util.UUID

/** Сходка, у которой родился аукцион. Её идентификатор принадлежит Meetups; Auction хранит его и не меняет (И-21). */
final case class MeetupId(value: UUID)

/**
 * Где аукцион (ADR-047). `Initial` — аукцион без журнала или удалённый до торгов: под шардингом entity поднимается на
 * любой `auction_id`, и из `Initial` выводит только `AuctionDrafted`. `Draft` — после рождения. `Scheduled` несёт
 * проверенную конфигурацию, которую повторное планирование заменяет целиком. `Prebidding` — онлайн-торги: конфигурация
 * и реестр заморожены, а `startedBy` — `op_id` команды открытия, с которым аукцион шлёт лотам `OpenLot`.
 *
 * Дальше по машине RFC-011 (PER-334) конфигурация и `startedBy` переходят во все состояния: от `startedBy` выводятся
 * `op_id` закрытия лота, возврата лота в финал и производных шагов аукциона. `Settling` — общий дедлайн прошёл, и
 * аукцион ждёт, пока каждый открытый лот закроется или удержится. `Break` — все закрыты или удержаны, состав не
 * заморожен; финалистов он не несёт: их знают лоты (ADR-047, дополнение 2026-10-06). `LineupFrozen` несёт порядок
 * выхода. `Final` — финал идёт, `activated` — лоты состава, которые аукцион вернул в торги, в порядке возврата,
 * `completed` — завершённые лоты состава в порядке завершения (PER-607). Активный лот — последний возвращённый, пока он
 * не завершён. `Finished` — аукцион закончился: без финалистов — вместе с онлайн-торгами, с финалом — когда завершён
 * каждый лот состава, а в перерыве — когда ведущий продал каждый удержанный лот (PER-607). `Cancelled` — аукцион
 * отменён после старта торгов (ADR-047, дополнение 2026-10-12); `cancelledBy` — `op_id` отмены, от которого выводятся
 * `op_id` снятия лотов и отмены розыгрыша.
 */
enum AuctionState {
  case Initial
  case Draft
  case Scheduled(config: AuctionConfig)
  case Prebidding(config: AuctionConfig, startedBy: OpId)
  case Settling(config: AuctionConfig, startedBy: OpId)
  case Break(config: AuctionConfig, startedBy: OpId)
  case LineupFrozen(config: AuctionConfig, startedBy: OpId, order: List[LotId])
  case Final(
      config: AuctionConfig,
      startedBy: OpId,
      order: List[LotId],
      activated: List[LotId],
      completed: List[LotId]
  )
  case Finished(config: AuctionConfig, startedBy: OpId)
  case Cancelled(config: AuctionConfig, startedBy: OpId, cancelledBy: OpId)

  /** Конфигурация и `op_id` открытия у аукциона, который открыл торги; до старта — `None`. */
  def started: Option[(AuctionConfig, OpId)] =
    this match {
      case Initial | Draft | Scheduled(_) => None
      case Prebidding(config, startedBy) => Some((config, startedBy))
      case Settling(config, startedBy) => Some((config, startedBy))
      case Break(config, startedBy) => Some((config, startedBy))
      case LineupFrozen(config, startedBy, _) => Some((config, startedBy))
      case Final(config, startedBy, _, _, _) => Some((config, startedBy))
      case Finished(config, startedBy) => Some((config, startedBy))
      case Cancelled(config, startedBy, _) => Some((config, startedBy))
    }

  /** Активный лот финала: возвращён в торги и ещё не завершён. Вне финала — `None`. */
  def activeLot: Option[LotId] =
    this match {
      case Final(_, _, _, activated, completed) => activated.lastOption.filterNot(completed.contains)
      case _ => None
    }
}

/** Команды аукциона. Каждая несёт `op_id`; инициатор едет в конверте, а не в команде. */
final case class DraftAuction(meetup: MeetupId, opId: OpId)

final case class AddLot(lot: LotId, opId: OpId)

final case class RemoveLot(lot: LotId, opId: OpId)

/** Планирование: конфигурация приходит непроверенной и повторяется до старта торгов, каждый раз целиком. */
final case class ScheduleAuction(config: AuctionConfigInput, opId: OpId)

/** Открытие онлайн-торгов. Лоты открывает не сама команда, а протокол подтверждения после неё ([[LotRoster]]). */
final case class StartPrebidding(opId: OpId)

/**
 * Удаление аукциона до торгов (ADR-047, дополнение 2026-10-09): аукцион в `Draft` или `Scheduled` возвращается в
 * `Initial`, и `DraftAuction` рождает его у той же сходки заново под тем же `auction_id`.
 */
final case class DiscardAuction(opId: OpId)

/**
 * Отмена аукциона после старта торгов (ADR-047, дополнение 2026-10-12): что завершилось, остаётся, что идёт,
 * обрывается. Лоты и розыгрыш снимает не сама команда, а протокол после неё ([[LotRoster]]).
 */
final case class CancelAuction(opId: OpId)

/**
 * Отмена сходки из шины (ADR-047, дополнение 2026-10-12): команда без человека, без входа сверх `op_id` и без отказов.
 * Удалить аукцион, отменить его или ничего не делать, решает агрегат по своему состоянию, а не потребитель: состояние,
 * прочитанное заранее, успевает устареть. `op_id` — UUIDv5 от `event_id` факта ([[Auction.meetupCancellationOf]]).
 */
final case class ApplyMeetupCancelled(opId: OpId)

/**
 * `ScheduleLot` словаря ADR-047, каким он приходит аукциону: администратор задаёт стартовую цену и шаг, остальные
 * условия подставляет аукцион ([[LotTerms]]). Лоту после решения уходит его собственная команда [[ScheduleLot]] с тем
 * же `op_id`. События аукцион на неё не пишет: условия торгов живут только в журнале лота.
 */
final case class ScheduleAuctionLot(lot: LotId, startingPrice: Money, stepPolicy: StepPolicyInput, opId: OpId)

/**
 * Выбор организатора о финалисте (ADR-047, дополнение 2026-10-06): отметить лот реестра для финала или снять отметку.
 * Как и у [[ScheduleAuctionLot]], решение аукциона — команда лоту с тем же `op_id`, а событие пишет только лот: отметка
 * живёт в его журнале, и второго источника о финалисте у аукциона нет.
 */
final case class SelectForFinal(lot: LotId, opId: OpId)

final case class DeselectForFinal(lot: LotId, opId: OpId)

/**
 * Ask ведущего лоту реестра (RFC-011, П-08). Аукцион — прокси к команде лота: он проверяет только, что лот в его
 * реестре, и отдаёт лоту `AdvanceAsk` с тем же `op_id`; фазу и цену судит лот, и событие пишет только он.
 */
final case class AdvanceLotAsk(lot: LotId, newAsk: Money, opId: OpId)

/**
 * Общий дедлайн онлайн-торгов (RFC-011, `EndPrebidding`). Отдаёт её не человек, а таймер entity на `closesAt`, поэтому
 * в контракте такой команды нет; `now` — часы entity в момент срабатывания.
 */
final case class EndPrebidding(opId: OpId, now: Instant)

/**
 * Все лоты, ждавшие закрытия, закрыты или удержаны (RFC-011, производный `PrebiddingEnded`). Отдаёт её entity по
 * ответам лотов, и `held` — удержанные лоты из этих ответов: в журнал аукциона они не попадают, а решают, перерыв это
 * или конец аукциона.
 */
final case class EndSettling(held: Set[LotId], opId: OpId)

/** Заморозка состава финала: `order` — удержанные лоты в порядке выхода, каждый ровно один раз. */
final case class FreezeFinalLineup(order: List[LotId], opId: OpId)

final case class StartFinal(opId: OpId)

/** Следующий лот очереди финала: аукцион возвращает его в торги командой `ResumeLot` и только потом пишет событие. */
final case class StartNextLot(opId: OpId)

/**
 * Закрытие лота ведущим (RFC-011, `CloseLot(ByAuctioneer)`, PER-607). Аукцион — прокси к команде лота, как у ask: он
 * решает по фазе, можно ли сейчас закрывать, и отдаёт лоту `CloseLot` с тем же `op_id`; продаёт или закрывает без
 * продажи лот. О конце активного лота финала аукцион узнаёт из ответа лота (ADR-047, дополнение 2026-10-11) и пишет его
 * своим шагом [[CompleteFinalLot]], а не под `op_id` ведущего.
 */
final case class CloseAuctionLot(lot: LotId, opId: OpId)

/**
 * Активный лот финала завершён (RFC-011, производный `FinalLotCompleted`). Отдаёт её entity — по ответу лота на
 * закрытие ведущим или по его состоянию после рестарта; `op_id` выводится от `op_id` открытия и лота
 * ([[LotRoster.completionOf]]), поэтому оба пути упираются в одно окно `seen`.
 */
final case class CompleteFinalLot(lot: LotId, opId: OpId)

/**
 * Конец аукциона (RFC-011, производный конец сессии): в финале завершены все лоты состава, а в перерыве не осталось ни
 * одного удержанного лота — ведущий продал всех (PER-607). `op_id` — шаг аукциона без человека, один у обоих путей.
 */
final case class FinishAuction(opId: OpId)

/**
 * Условия торгов, которые лоту задаёт не администратор, а аукцион: валюта, анти-снайп и признак прокси (ADR-047,
 * `LotDefaults`). Шага здесь нет: его всегда называет команда.
 */
final case class LotTerms(currency: CurrencyCode, antiSnipe: AntiSnipe, proxyEnabled: Boolean)

object LotTerms {

  /**
   * Умолчания платформы для аукциона в `Draft` (ADR-047, дополнение 2026-10-05): конфигурации у него ещё нет, а
   * `ScheduleAuction` приходит позже или не приходит вовсе. Лот, запланированный с ними, сохраняет их и после
   * планирования аукциона — до следующего `ScheduleLot`.
   */
  val platform: LotTerms =
    LotTerms(CurrencyCode("RUB"), AntiSnipe(Duration.ofMinutes(2), Duration.ofMinutes(2), 3), proxyEnabled = true)

  def of(defaults: LotConfig): LotTerms = LotTerms(defaults.currency, defaults.antiSnipe, defaults.proxyEnabled)
}

/**
 * События аукциона: payload рождения — `meetup_id`, реестра — `lot_id`, планирования — конфигурация целиком, у старта
 * торгов и отмены payload нет (ADR-047). `PrebiddingEnded` несёт `finished`: уходит ли аукцион в перерыв или
 * заканчивается без финалистов, решают ответы лотов, которых журнал не хранит, а свёртке нужно знать это из самого
 * события. Состав финала — порядок выхода в `FinalLineupFrozen`, возвращённый в торги лот — в `FinalLotActivated`,
 * завершённый — в `FinalLotCompleted`. `AuctionFinished` — конец аукциона с финалом; у аукциона без финала его не
 * бывает, тот кончается `PrebiddingEnded(finished = true)`.
 */
enum AuctionEvent {
  case AuctionDrafted(meetup: MeetupId)
  case LotAdded(lot: LotId)
  case LotRemoved(lot: LotId)
  case AuctionScheduled(config: AuctionConfig)
  case PrebiddingStarted
  case AuctionDiscarded
  case AuctionCancelled
  case PrebiddingDeadlineReached
  case PrebiddingEnded(finished: Boolean)
  case FinalLineupFrozen(order: List[LotId])
  case FinalStarted
  case FinalLotActivated(lot: LotId)
  case FinalLotCompleted(lot: LotId)
  case AuctionFinished
}

/** Строка журнала аукциона в той части конверта, которую читает ядро; `sequence` назначает тот, кто пишет журнал. */
final case class AuctionEnvelope(sequence: Long, opId: OpId, event: AuctionEvent)

/** Отказы `AddLot`: аукциона нет или реестр заморожен стартом торгов (И-20). */
enum AddLotRejected {
  case AuctionNotFound
  case LotsFrozen
}

/** Отказы `RemoveLot`: аукциона нет, реестр заморожен или лота нет в реестре. */
enum RemoveLotRejected {
  case AuctionNotFound
  case LotsFrozen
  case LotNotInAuction
}

/** Отказы `ScheduleAuction`: аукциона нет, конфигурация противоречива (Т-19, Т-44) или торги уже идут. */
enum ScheduleAuctionRejected {
  case AuctionNotFound
  case ConfigInvalid(reason: auction.aggregate.ConfigInvalid)
  case AuctionAlreadyStarted
}

/** Отказы `DiscardAuction`: аукциона нет или торги уже открыты — ставки могли быть, и удалять поздно. */
enum DiscardAuctionRejected {
  case AuctionNotFound
  case AuctionAlreadyStarted
}

/**
 * Отказы `CancelAuction`: аукциона нет, торги не открыты — там действует `DiscardAuction`, — или аукцион уже
 * закончился. Отменённый аукцион не отказывает: повтор отмены события не пишет.
 */
enum CancelAuctionRejected {
  case AuctionNotFound
  case AuctionNotStarted
  case AuctionAlreadyFinished
}

/** Отказы `StartPrebidding`: аукциона нет либо он не в `Scheduled` — не запланирован или уже открыт. */
enum StartPrebiddingRejected {
  case AuctionNotFound
  case AuctionNotScheduled
}

/** Отказы общего дедлайна: аукцион не в онлайн-торгах или часы entity ещё не дошли до `closesAt`. */
enum EndPrebiddingRejected {
  case NotInPrebidding
  case DeadlineNotReached
}

/** Отказ конца ожидания: аукцион уже не ждёт лотов — шаг сделан раньше. */
enum EndSettlingRejected {
  case NotSettling
}

/**
 * Отказы заморозки состава (RFC-011). `LineupUnknown` — аукцион ещё не знает, какие лоты удержаны: после рестарта он
 * переспрашивает их, и ответили не все. Это не отказ человеку, а «повтори позже». `LineupMismatch` несёт удержанные
 * лоты на момент решения.
 */
enum FreezeFinalLineupRejected {
  case AuctionNotFound
  case NotInBreak
  case LineupUnknown
  case LineupEmpty
  case LineupMismatch(held: Set[LotId])
}

/** Отказы старта финала: у контракта один — состав не заморожен, в том числе когда финал уже идёт. */
enum StartFinalRejected {
  case AuctionNotFound
  case LineupNotFrozen
}

/**
 * Отказы следующего лота финала. Активным считается последний возвращённый в торги лот, пока он не завершён: завершение
 * лота финала приходит с закрытием лота ведущим, и до него аукцион следующего лота не открывает. `OpIdTaken` — под этим
 * `op_id` записана другая команда аукциона: повтор отвечает лотом исходной активации, а лота у чужой команды нет.
 */
enum StartNextLotRejected {
  case AuctionNotFound
  case NotInFinal
  case AnotherLotActive(lot: LotId)
  case LineupExhausted
  case OpIdTaken
}

/**
 * Отказы закрытия ведущим. `DeadlineNotReached` — онлайн-торги или ожидание их конца: лот там закрывает дедлайн, а не
 * человек. `LotNotOpen` — закрывать нечего или нельзя: лот не открыт, уже закрыт или стоит в составе финала, но ещё не
 * вышел — удержанный лот состава закрывается только активным. `OpIdTaken` — под этим `op_id` лот записал другую
 * команду.
 */
enum CloseAuctionLotRejected {
  case AuctionNotFound
  case LotNotInAuction
  case DeadlineNotReached
  case LotNotOpen
  case OpIdTaken
}

/** Чем лот кончился по закрытию ведущим: продан или закрыт без продажи. */
enum LotEnding {
  case Sold(sale: Sale)
  case Unsold(reason: UnsoldReason)
}

/** Отказ шага завершения лота финала: лот не активный — уже завершён шагом раньше или аукцион не в финале. */
enum CompleteFinalLotRejected {
  case NotActive
}

/**
 * Отказ конца аукциона: не в перерыве и не в финале либо ещё есть что разыгрывать — незавершённый лот состава или
 * удержанный лот в перерыве, в том числе пока о лотах перерыва знание не полное.
 */
enum FinishAuctionRejected {
  case NotInBreakOrFinal
  case LineupNotCompleted
}

/**
 * Решение о следующем лоте финала, пока событие не записано: повтор `op_id` уже записанной активации или лот, который
 * пора вернуть в торги командой `ResumeLot`.
 */
enum NextLot {
  case Repeated(original: AuctionEnvelope)
  case Resume(lot: LotId)
}

/**
 * Отказы `ScheduleLot`, идущего через аукцион: аукциона нет, условия заморожены стартом торгов, лота нет в реестре —
 * это решает аукцион, — либо отказал сам лот.
 */
enum ScheduleAuctionLotRejected {
  case AuctionNotFound
  case LotsFrozen
  case LotNotInAuction
  case ByLot(rejected: ScheduleLotRejected)
}

/** Отказы ask ведущего, идущего через аукцион: аукциона нет или лота нет в реестре — это решает аукцион, — либо лот. */
enum AdvanceLotAskRejected {
  case AuctionNotFound
  case LotNotInAuction
  case ByLot(rejected: AdvanceAskRejected)
}

/**
 * Отказы выбора финалиста: аукциона нет, онлайн-торги не идут, лота нет в реестре, отбирать некуда — это решает
 * аукцион, — либо отказал сам лот (`R` — отказы его команды). `SelectionNotApplicable` — у конфигурации нет финала или
 * лоты не получают дедлайна: отмеченный лот удержался бы навсегда или не удержался бы вовсе (RFC-011, Т-45). Снятию
 * отметки он не отвечает: снять её можно всегда, пока не наступил дедлайн. Наступил ли дедлайн лота, судит лот; после
 * общего дедлайна аукцион уходит из `Prebidding`, и ответ — `NotInPrebidding` (ADR-047, дополнение 2026-10-06).
 */
enum FinalChoiceRejected[+R] {
  case AuctionNotFound extends FinalChoiceRejected[Nothing]
  case NotInPrebidding extends FinalChoiceRejected[Nothing]
  case LotNotInAuction extends FinalChoiceRejected[Nothing]
  case SelectionNotApplicable extends FinalChoiceRejected[Nothing]
  case ByLot(rejected: R)
}

/**
 * Исход принятой команды.
 *
 * `Unchanged` — команда принята, но событие не нужно: аукцион у сходки уже есть. Такой ответ в окно `seen` не попадает,
 * потому что ничего не записано, и повтор того же `op_id` приходит к тому же решению заново. После удаления аукциона
 * (`AuctionDiscarded`) такой запоздавший повтор родит аукцион снова — это то же, что новое нажатие «Включить».
 */
enum AuctionDecision {
  case Accepted(event: AuctionEvent)
  case Repeated(original: AuctionEnvelope)
  case Unchanged
}

/**
 * Что знает аукцион до проверки права (ADR-047, «Порядок»): повтор уже принятого `op_id`, аукциона нет или аукцион
 * сходки `meetup`. Первые два ответа отдаются без обращения к Meetups. `registryOpen` — открыт ли реестр (И-20): по
 * нему `AddLot` отказывает раньше, чем лот родится.
 */
enum Inspection {
  case Repeated(original: AuctionEnvelope)
  case Absent
  case Present(meetup: MeetupId, registryOpen: Boolean)
}

/**
 * Агрегат аукциона: состояние, сходка, реестр лотов и окно дедупликации, свёрнутые из журнала.
 *
 * `meetup` пуста ровно в `Initial` и после рождения не меняется. Реестр `lots` меняется только в `Draft` и `Scheduled`
 * (И-20). `seen` — то же окно, что у лота: `seen(op_id) ⟺ в журнале есть событие с этим op_id`, и пишет его только
 * [[Auction.apply]].
 */
final case class Auction(
    state: AuctionState,
    meetup: Option[MeetupId],
    lots: Set[LotId],
    seen: Map[OpId, AuctionEnvelope]
)

object Auction {

  val initial: Auction = Auction(AuctionState.Initial, None, Set.empty, Map.empty)

  /**
   * Пространство имён UUIDv5 аукциона сходки (integration.md, «Аукцион у сходки»). Не меняется никогда: другое
   * пространство дало бы той же сходке другой аукцион.
   */
  val MeetupNamespace: UUID = UUID.fromString("83a6d0b2-84ed-4444-a77b-dd0338dc84a4")

  /**
   * Аукцион сходки — UUIDv5 (RFC 9562) от канонической строки `meetup_id` в UTF-8. Две команды рождения одной сходки
   * поэтому приходят в одну entity, и вторая упирается в первую в журнале (ADR-047, И-21).
   */
  def idOf(meetup: MeetupId): AuctionId = AuctionId(nameBased(MeetupNamespace, meetup.value.toString))

  /**
   * Пространство имён UUIDv5 `op_id` отмены сходки из шины. Не меняется никогда, как и пространство аукциона сходки.
   */
  val MeetupCancellationNamespace: UUID = UUID.fromString("1cb0b497-fae3-4a59-bb5a-22f40418ba01")

  /**
   * `op_id` команды [[ApplyMeetupCancelled]] — UUIDv5 от канонической строки `event_id` факта отмены: повторная
   * доставка того же факта упирается в окно `seen` и второго события не пишет.
   */
  def meetupCancellationOf(eventId: UUID): OpId = OpId(nameBased(MeetupCancellationNamespace, eventId.toString))

  /** UUIDv5 (RFC 9562): SHA-1 от пространства имён и имени в UTF-8, с битами версии и варианта. */
  private[aggregate] def nameBased(namespace: UUID, name: String): UUID = {
    val digest = MessageDigest.getInstance("SHA-1")
    digest.update(bytes(namespace))
    digest.update(name.getBytes(StandardCharsets.UTF_8))
    val hash = digest.digest()
    hash(6) = ((hash(6) & 0x0f) | 0x50).toByte
    hash(8) = ((hash(8) & 0x3f) | 0x80).toByte
    new UUID(long(hash, 0), long(hash, 8))
  }

  def inspect(auction: Auction, opId: OpId): Inspection =
    auction.seen.get(opId) match {
      case Some(original) => Inspection.Repeated(original)
      case None => auction.meetup.fold(Inspection.Absent)(Inspection.Present(_, registryOpen(auction.state)))
    }

  /** Реестр открыт в `Draft` и `Scheduled` и заморожен стартом торгов (И-20). */
  private def registryOpen(state: AuctionState): Boolean =
    state match {
      case AuctionState.Draft | AuctionState.Scheduled(_) => true
      case AuctionState.Initial | AuctionState.Prebidding(_, _) | AuctionState.Settling(_, _) |
          AuctionState.Break(_, _) | AuctionState.LineupFrozen(_, _, _) | AuctionState.Final(_, _, _, _, _) |
          AuctionState.Finished(_, _) | AuctionState.Cancelled(_, _, _) =>
        false
    }

  /** Рождение у сходки. Аукцион, который уже есть, не отказывает и события не пишет: включение идемпотентно. */
  def decide(auction: Auction, command: DraftAuction): AuctionDecision =
    auction.seen.get(command.opId) match {
      case Some(original) => AuctionDecision.Repeated(original)
      case None =>
        auction.state match {
          case AuctionState.Initial => AuctionDecision.Accepted(AuctionEvent.AuctionDrafted(command.meetup))
          case AuctionState.Draft | AuctionState.Scheduled(_) | AuctionState.Prebidding(_, _) |
              AuctionState.Settling(_, _) | AuctionState.Break(_, _) | AuctionState.LineupFrozen(_, _, _) |
              AuctionState.Final(_, _, _, _, _) | AuctionState.Finished(_, _) | AuctionState.Cancelled(_, _, _) =>
            AuctionDecision.Unchanged
        }
    }

  /**
   * Лот в реестр (И-20: только до старта торгов). Лот, который уже в реестре, тоже пишет `LotAdded`: реестр —
   * множество, а `op_id` попадает в окно `seen`. Ответ без события повтором не защищён, и запоздавший повтор после
   * `RemoveLot` вернул бы снятый лот. У включения аукциона ответ без события возможен, и его запоздавший повтор после
   * удаления рождает аукцион снова — это не возврат прежнего, а новое включение пустого аукциона.
   */
  def decide(auction: Auction, command: AddLot): Either[AddLotRejected, AuctionDecision] =
    auction.seen.get(command.opId) match {
      case Some(original) => Right(AuctionDecision.Repeated(original))
      case None =>
        auction.state match {
          case AuctionState.Initial => Left(AddLotRejected.AuctionNotFound)
          case AuctionState.Draft | AuctionState.Scheduled(_) =>
            Right(AuctionDecision.Accepted(AuctionEvent.LotAdded(command.lot)))
          case AuctionState.Prebidding(_, _) | AuctionState.Settling(_, _) | AuctionState.Break(_, _) |
              AuctionState.LineupFrozen(_, _, _) | AuctionState.Final(_, _, _, _, _) | AuctionState.Finished(_, _) |
              AuctionState.Cancelled(_, _, _) =>
            Left(AddLotRejected.LotsFrozen)
        }
    }

  /** Лот из реестра. Лота нет в реестре — `LotNotInAuction`. */
  def decide(auction: Auction, command: RemoveLot): Either[RemoveLotRejected, AuctionDecision] =
    auction.seen.get(command.opId) match {
      case Some(original) => Right(AuctionDecision.Repeated(original))
      case None =>
        auction.state match {
          case AuctionState.Initial => Left(RemoveLotRejected.AuctionNotFound)
          case AuctionState.Draft | AuctionState.Scheduled(_) =>
            if (auction.lots.contains(command.lot))
              Right(AuctionDecision.Accepted(AuctionEvent.LotRemoved(command.lot)))
            else Left(RemoveLotRejected.LotNotInAuction)
          case AuctionState.Prebidding(_, _) | AuctionState.Settling(_, _) | AuctionState.Break(_, _) |
              AuctionState.LineupFrozen(_, _, _) | AuctionState.Final(_, _, _, _, _) | AuctionState.Finished(_, _) |
              AuctionState.Cancelled(_, _, _) =>
            Left(RemoveLotRejected.LotsFrozen)
        }
    }

  /**
   * Планирование. Состояние проверяется раньше конфигурации: после старта торгов ответ — `AuctionAlreadyStarted`, какой
   * бы ни была конфигурация. В `Scheduled` команда пишет событие всегда и заменяет конфигурацию целиком (RFC-011).
   */
  def decide(auction: Auction, command: ScheduleAuction): Either[ScheduleAuctionRejected, AuctionDecision] =
    auction.seen.get(command.opId) match {
      case Some(original) => Right(AuctionDecision.Repeated(original))
      case None =>
        auction.state match {
          case AuctionState.Initial => Left(ScheduleAuctionRejected.AuctionNotFound)
          case AuctionState.Prebidding(_, _) | AuctionState.Settling(_, _) | AuctionState.Break(_, _) |
              AuctionState.LineupFrozen(_, _, _) | AuctionState.Final(_, _, _, _, _) | AuctionState.Finished(_, _) |
              AuctionState.Cancelled(_, _, _) =>
            Left(ScheduleAuctionRejected.AuctionAlreadyStarted)
          case AuctionState.Draft | AuctionState.Scheduled(_) =>
            AuctionConfig
              .parse(command.config)
              .left
              .map(ScheduleAuctionRejected.ConfigInvalid(_))
              .map(config => AuctionDecision.Accepted(AuctionEvent.AuctionScheduled(config)))
        }
    }

  /**
   * Открытие онлайн-торгов — только из `Scheduled`. Повтор того же `op_id` получает исходный ответ и второй раз аукцион
   * не открывает; новый `op_id` на уже открытом — `AuctionNotScheduled`.
   */
  def decide(auction: Auction, command: StartPrebidding): Either[StartPrebiddingRejected, AuctionDecision] =
    auction.seen.get(command.opId) match {
      case Some(original) => Right(AuctionDecision.Repeated(original))
      case None =>
        auction.state match {
          case AuctionState.Initial => Left(StartPrebiddingRejected.AuctionNotFound)
          case AuctionState.Scheduled(_) => Right(AuctionDecision.Accepted(AuctionEvent.PrebiddingStarted))
          case AuctionState.Draft | AuctionState.Prebidding(_, _) | AuctionState.Settling(_, _) |
              AuctionState.Break(_, _) | AuctionState.LineupFrozen(_, _, _) | AuctionState.Final(_, _, _, _, _) |
              AuctionState.Finished(_, _) | AuctionState.Cancelled(_, _, _) =>
            Left(StartPrebiddingRejected.AuctionNotScheduled)
        }
    }

  /**
   * Удаление до торгов: из `Draft` и `Scheduled`. После старта торгов — `AuctionAlreadyStarted`: у лотов могли быть
   * ставки. Повтор того же `op_id` получает исходный ответ из окна `seen`, которое удаление не очищает.
   */
  def decide(auction: Auction, command: DiscardAuction): Either[DiscardAuctionRejected, AuctionDecision] =
    auction.seen.get(command.opId) match {
      case Some(original) => Right(AuctionDecision.Repeated(original))
      case None =>
        auction.state match {
          case AuctionState.Initial => Left(DiscardAuctionRejected.AuctionNotFound)
          case AuctionState.Draft | AuctionState.Scheduled(_) =>
            Right(AuctionDecision.Accepted(AuctionEvent.AuctionDiscarded))
          case AuctionState.Prebidding(_, _) | AuctionState.Settling(_, _) | AuctionState.Break(_, _) |
              AuctionState.LineupFrozen(_, _, _) | AuctionState.Final(_, _, _, _, _) | AuctionState.Finished(_, _) |
              AuctionState.Cancelled(_, _, _) =>
            Left(DiscardAuctionRejected.AuctionAlreadyStarted)
        }
    }

  /**
   * Отмена после старта торгов: из любой фазы от `Prebidding` до `Final`. До торгов — `AuctionNotStarted`, на
   * законченном — `AuctionAlreadyFinished`. Отменённый аукцион на новую отмену отвечает без события: отменить его
   * второй раз нечем, а повтор прежнего `op_id` получает исходный ответ из окна `seen`. `held` — удержанные лоты
   * перерыва по знанию entity, как у заморозки: перерыв без удержанных уже кончился.
   */
  def decide(
      auction: Auction,
      command: CancelAuction,
      held: Option[Set[LotId]] = None
  ): Either[CancelAuctionRejected, AuctionDecision] =
    auction.seen.get(command.opId) match {
      case Some(original) => Right(AuctionDecision.Repeated(original))
      case None =>
        auction.state match {
          case AuctionState.Initial => Left(CancelAuctionRejected.AuctionNotFound)
          case AuctionState.Draft | AuctionState.Scheduled(_) => Left(CancelAuctionRejected.AuctionNotStarted)
          // Финал с завершённым составом и перерыв без удержанных уже кончились: конец аукциона entity пишет
          // сообщением себе, и отмена, пришедшая между ними, его не обгоняет (PER-607).
          case AuctionState.Final(_, _, _, _, _) if lineupCompleted(auction) =>
            Left(CancelAuctionRejected.AuctionAlreadyFinished)
          case AuctionState.Break(_, _) if held.contains(Set.empty) =>
            Left(CancelAuctionRejected.AuctionAlreadyFinished)
          case AuctionState.Prebidding(_, _) | AuctionState.Settling(_, _) | AuctionState.Break(_, _) |
              AuctionState.LineupFrozen(_, _, _) | AuctionState.Final(_, _, _, _, _) =>
            Right(AuctionDecision.Accepted(AuctionEvent.AuctionCancelled))
          case AuctionState.Finished(_, _) => Left(CancelAuctionRejected.AuctionAlreadyFinished)
          case AuctionState.Cancelled(_, _, _) => Right(AuctionDecision.Unchanged)
        }
    }

  /**
   * Отмена сходки (ADR-047, дополнение 2026-10-12): `Initial` — ничего, до торгов — `AuctionDiscarded`, как удаление
   * администратором, торги открыты — `AuctionCancelled` по правилам [[CancelAuction]], конечное состояние — ничего.
   * Финал с завершённым составом и перерыв без удержанных уже кончились, как и для отмены администратором. Отказов нет:
   * факт отмены необратим, и ответить ему «нельзя» некому. `held` — удержанные лоты перерыва по знанию entity.
   */
  def decide(auction: Auction, command: ApplyMeetupCancelled, held: Option[Set[LotId]]): AuctionDecision =
    auction.seen.get(command.opId) match {
      case Some(original) => AuctionDecision.Repeated(original)
      case None =>
        auction.state match {
          case AuctionState.Initial => AuctionDecision.Unchanged
          case AuctionState.Draft | AuctionState.Scheduled(_) => AuctionDecision.Accepted(AuctionEvent.AuctionDiscarded)
          case AuctionState.Prebidding(_, _) | AuctionState.Settling(_, _) | AuctionState.Break(_, _) |
              AuctionState.LineupFrozen(_, _, _) | AuctionState.Final(_, _, _, _, _) | AuctionState.Finished(_, _) |
              AuctionState.Cancelled(_, _, _) =>
            decide(auction, CancelAuction(command.opId), held) match {
              case Right(decision) => decision
              case Left(
                    CancelAuctionRejected.AuctionAlreadyFinished | CancelAuctionRejected.AuctionNotStarted |
                    CancelAuctionRejected.AuctionNotFound
                  ) =>
                AuctionDecision.Unchanged
            }
        }
    }

  /**
   * Условия торгов лоту реестра. Решение — команда лоту, а не событие аукциона, поэтому окна `seen` здесь нет: повтор
   * `op_id` узнаёт лот. Состояние проверяется раньше реестра, как у `RemoveLot`: после старта торгов ответ —
   * `LotsFrozen` на любой лот, и условия лота, которому аукцион уже шлёт `OpenLot`, не меняются. Незаданные условия —
   * из `lotDefaults` запланированного аукциона, а в `Draft` и без `lotDefaults` — умолчания платформы.
   */
  def decide(auction: Auction, command: ScheduleAuctionLot): Either[ScheduleAuctionLotRejected, ScheduleLot] =
    auction.state match {
      case AuctionState.Initial => Left(ScheduleAuctionLotRejected.AuctionNotFound)
      case AuctionState.Prebidding(_, _) | AuctionState.Settling(_, _) | AuctionState.Break(_, _) |
          AuctionState.LineupFrozen(_, _, _) | AuctionState.Final(_, _, _, _, _) | AuctionState.Finished(_, _) |
          AuctionState.Cancelled(_, _, _) =>
        Left(ScheduleAuctionLotRejected.LotsFrozen)
      case AuctionState.Draft => planned(auction, command, LotTerms.platform)
      case AuctionState.Scheduled(config) =>
        planned(auction, command, config.lotDefaults.fold(LotTerms.platform)(LotTerms.of))
    }

  /**
   * Отметка лота реестра для финала. Окна `seen` нет, как у `ScheduleAuctionLot`: повтор `op_id` узнаёт лот. Состояние
   * проверяется раньше реестра: до старта торгов отмечать нечего, и ответ — `NotInPrebidding` на любой лот. Лот реестра
   * аукциона без финала или без дедлайна лотов — `SelectionNotApplicable`.
   */
  def decide(auction: Auction, command: SelectForFinal): Either[FinalChoiceRejected[Nothing], MarkForFinal] =
    choice(auction, command.lot)(MarkForFinal(command.opId)).flatMap { mark =>
      auction.state match {
        case AuctionState.Prebidding(config, _) if config.finalBlocks == 0 || config.lotDeadline.isEmpty =>
          Left(FinalChoiceRejected.SelectionNotApplicable)
        case _ => Right(mark)
      }
    }

  /** Снятие отметки — по тем же правилам аукциона, что и отметка; остальное решает лот. */
  def decide(auction: Auction, command: DeselectForFinal): Either[FinalChoiceRejected[Nothing], UnmarkForFinal] =
    choice(auction, command.lot)(UnmarkForFinal(command.opId))

  /**
   * Ask ведущего лоту реестра. Окна `seen` нет, как у `ScheduleAuctionLot`: повтор `op_id` узнаёт лот. Фазу аукциона
   * ask не проверяет: объявить цену можно любому лоту в торгах (П-08), а лот вне торгов отвечает сам.
   */
  def decide(auction: Auction, command: AdvanceLotAsk): Either[AdvanceLotAskRejected, AdvanceAsk] =
    auction.state match {
      case AuctionState.Initial => Left(AdvanceLotAskRejected.AuctionNotFound)
      case _ if !auction.lots.contains(command.lot) => Left(AdvanceLotAskRejected.LotNotInAuction)
      case _ => Right(AdvanceAsk(command.newAsk, command.opId))
    }

  private def choice[C](auction: Auction, lot: LotId)(command: C): Either[FinalChoiceRejected[Nothing], C] =
    auction.state match {
      case AuctionState.Initial => Left(FinalChoiceRejected.AuctionNotFound)
      case AuctionState.Draft | AuctionState.Scheduled(_) | AuctionState.Settling(_, _) | AuctionState.Break(_, _) |
          AuctionState.LineupFrozen(_, _, _) | AuctionState.Final(_, _, _, _, _) | AuctionState.Finished(_, _) |
          AuctionState.Cancelled(_, _, _) =>
        Left(FinalChoiceRejected.NotInPrebidding)
      case AuctionState.Prebidding(_, _) =>
        if (auction.lots.contains(lot)) Right(command) else Left(FinalChoiceRejected.LotNotInAuction)
    }

  /**
   * Общий дедлайн: из `Prebidding` в `Settling`, когда часы entity дошли до `closesAt`. Это тот же момент, который лоты
   * получают дедлайном (`lotDeadline`): аукцион, чьи лоты дедлайна не получают, общего дедлайна не знает — их закрывает
   * человек, и ожидание закрытия по часам застряло бы навсегда. В `Settling` такой аукцион не уходит.
   */
  def decide(auction: Auction, command: EndPrebidding): Either[EndPrebiddingRejected, AuctionDecision] =
    auction.seen.get(command.opId) match {
      case Some(original) => Right(AuctionDecision.Repeated(original))
      case None =>
        auction.state match {
          case AuctionState.Prebidding(config, _) =>
            prebiddingDeadline(config) match {
              case Some(closesAt) if !command.now.isBefore(closesAt) =>
                Right(AuctionDecision.Accepted(AuctionEvent.PrebiddingDeadlineReached))
              case _ => Left(EndPrebiddingRejected.DeadlineNotReached)
            }
          case _ => Left(EndPrebiddingRejected.NotInPrebidding)
        }
    }

  /** Конец ожидания лотов: перерыв, если есть удержанные, иначе аукцион закончен без финала (RFC-011). */
  def decide(auction: Auction, command: EndSettling): Either[EndSettlingRejected, AuctionDecision] =
    auction.seen.get(command.opId) match {
      case Some(original) => Right(AuctionDecision.Repeated(original))
      case None =>
        auction.state match {
          case AuctionState.Settling(_, _) =>
            Right(AuctionDecision.Accepted(AuctionEvent.PrebiddingEnded(finished = command.held.isEmpty)))
          case _ => Left(EndSettlingRejected.NotSettling)
        }
    }

  /**
   * Заморозка состава. `held` — удержанные лоты, как их знает entity по ответам лотов; `None` — опрос не закончен.
   * Порядок проверок: фаза, знание о лотах, пустой состав, совпадение `order` с удержанными (Т-47).
   */
  def decide(
      auction: Auction,
      command: FreezeFinalLineup,
      held: Option[Set[LotId]]
  ): Either[FreezeFinalLineupRejected, AuctionDecision] =
    auction.seen.get(command.opId) match {
      case Some(original) => Right(AuctionDecision.Repeated(original))
      case None =>
        auction.state match {
          case AuctionState.Initial => Left(FreezeFinalLineupRejected.AuctionNotFound)
          case AuctionState.Break(_, _) =>
            held match {
              case None => Left(FreezeFinalLineupRejected.LineupUnknown)
              case Some(lots) if lots.isEmpty => Left(FreezeFinalLineupRejected.LineupEmpty)
              case Some(lots) =>
                if (command.order.distinct.size == command.order.size && command.order.toSet == lots)
                  Right(AuctionDecision.Accepted(AuctionEvent.FinalLineupFrozen(command.order)))
                else Left(FreezeFinalLineupRejected.LineupMismatch(lots))
            }
          case _ => Left(FreezeFinalLineupRejected.NotInBreak)
        }
    }

  /** Старт финала — только из `LineupFrozen` (И-19, Т-46). */
  def decide(auction: Auction, command: StartFinal): Either[StartFinalRejected, AuctionDecision] =
    auction.seen.get(command.opId) match {
      case Some(original) => Right(AuctionDecision.Repeated(original))
      case None =>
        auction.state match {
          case AuctionState.Initial => Left(StartFinalRejected.AuctionNotFound)
          case AuctionState.LineupFrozen(_, _, _) => Right(AuctionDecision.Accepted(AuctionEvent.FinalStarted))
          case _ => Left(StartFinalRejected.LineupNotFrozen)
        }
    }

  /**
   * Какой лот финала вернуть в торги. Событие здесь не решается: его пишет [[activate]] после ответа лота на
   * `ResumeLot` (И-14). Лот, уже возвращённый в торги, остаётся активным, пока не завершится (`FinalLotCompleted`).
   */
  def decide(auction: Auction, command: StartNextLot): Either[StartNextLotRejected, NextLot] =
    auction.seen.get(command.opId) match {
      case Some(original) => Right(NextLot.Repeated(original))
      case None =>
        auction.state match {
          case AuctionState.Initial => Left(StartNextLotRejected.AuctionNotFound)
          case final_ @ AuctionState.Final(_, _, order, activated, completed) =>
            final_.activeLot match {
              case Some(active) => Left(StartNextLotRejected.AnotherLotActive(active))
              case None =>
                order.find(lot => !activated.contains(lot) && !completed.contains(lot)) match {
                  case Some(next) => Right(NextLot.Resume(next))
                  case None => Left(StartNextLotRejected.LineupExhausted)
                }
            }
          case _ => Left(StartNextLotRejected.NotInFinal)
        }
    }

  /**
   * Закрытие лота ведущим. Окна `seen` нет, как у ask: повтор `op_id` узнаёт лот, и ответом на него будет исходная
   * продажа. Аукцион отказывает только там, где закрытие человеком что-то сломало бы: в онлайн-торгах и ожидании их
   * конца лот закрывает дедлайн, а удержанный лот состава, ещё не вышедший в финал, — только его очередь. Остальное
   * судит лот: удержанный в перерыве продаётся по цене, с которой пережил дедлайн, и выпадает из финалистов (RFC-011),
   * активный лот финала продаётся лидеру, закрытый отвечает `LotNotOpen` или — на повтор — исходным закрытием.
   * Отменённый аукцион лотам команд не шлёт (ADR-047, дополнение 2026-10-12): лот, которому снятие ещё не дошло, после
   * отмены не продаётся.
   */
  def decide(auction: Auction, command: CloseAuctionLot): Either[CloseAuctionLotRejected, CloseLot] = {
    val close = CloseLot(CloseReason.ByAuctioneer, command.opId)
    auction.state match {
      case AuctionState.Initial => Left(CloseAuctionLotRejected.AuctionNotFound)
      case _ if !auction.lots.contains(command.lot) => Left(CloseAuctionLotRejected.LotNotInAuction)
      case AuctionState.Prebidding(_, _) | AuctionState.Settling(_, _) =>
        Left(CloseAuctionLotRejected.DeadlineNotReached)
      case AuctionState.LineupFrozen(_, _, order) if order.contains(command.lot) =>
        Left(CloseAuctionLotRejected.LotNotOpen)
      case AuctionState.Final(_, _, order, activated, _)
          if order.contains(command.lot) && !activated.contains(command.lot) =>
        Left(CloseAuctionLotRejected.LotNotOpen)
      case AuctionState.Cancelled(_, _, _) => Left(CloseAuctionLotRejected.LotNotOpen)
      case AuctionState.Draft | AuctionState.Scheduled(_) | AuctionState.Break(_, _) |
          AuctionState.LineupFrozen(_, _, _) | AuctionState.Final(_, _, _, _, _) | AuctionState.Finished(_, _) =>
        Right(close)
    }
  }

  /** Завершение лота финала: событие — только для активного лота; уже завершённый шаг упирается в окно `seen`. */
  def decide(auction: Auction, command: CompleteFinalLot): Either[CompleteFinalLotRejected, AuctionDecision] =
    auction.seen.get(command.opId) match {
      case Some(original) => Right(AuctionDecision.Repeated(original))
      case None =>
        if (auction.state.activeLot.contains(command.lot))
          Right(AuctionDecision.Accepted(AuctionEvent.FinalLotCompleted(command.lot)))
        else Left(CompleteFinalLotRejected.NotActive)
    }

  /**
   * Конец аукциона: в финале — когда завершён каждый лот состава (RFC-011), в перерыве — когда по знанию entity не
   * осталось удержанных лотов (`held`, как у заморозки; `None` — лоты ещё не все ответили).
   */
  def decide(
      auction: Auction,
      command: FinishAuction,
      held: Option[Set[LotId]]
  ): Either[FinishAuctionRejected, AuctionDecision] =
    auction.seen.get(command.opId) match {
      case Some(original) => Right(AuctionDecision.Repeated(original))
      case None =>
        auction.state match {
          case AuctionState.Final(_, _, _, _, _) =>
            if (lineupCompleted(auction)) Right(AuctionDecision.Accepted(AuctionEvent.AuctionFinished))
            else Left(FinishAuctionRejected.LineupNotCompleted)
          case AuctionState.Break(_, _) =>
            if (held.contains(Set.empty)) Right(AuctionDecision.Accepted(AuctionEvent.AuctionFinished))
            else Left(FinishAuctionRejected.LineupNotCompleted)
          case _ => Left(FinishAuctionRejected.NotInBreakOrFinal)
        }
    }

  /** Финал, в котором завершён каждый лот состава: аукциону пора записать `AuctionFinished`. */
  def lineupCompleted(auction: Auction): Boolean =
    auction.state match {
      case AuctionState.Final(_, _, order, _, completed) => order.forall(completed.contains)
      case _ => false
    }

  /**
   * Лот ответил на `ResumeLot`: решение о следующем лоте принимается заново, и событие пишется, только если следующим
   * всё ещё остаётся этот лот. Две команды, решившие один лот до записи, так получают одну активацию и
   * `AnotherLotActive`.
   */
  def activate(auction: Auction, command: StartNextLot, lot: LotId): Either[StartNextLotRejected, AuctionDecision] =
    decide(auction, command).flatMap {
      case NextLot.Repeated(original) => Right(AuctionDecision.Repeated(original))
      case NextLot.Resume(next) if next == lot => Right(AuctionDecision.Accepted(AuctionEvent.FinalLotActivated(lot)))
      case NextLot.Resume(_) => Left(StartNextLotRejected.AnotherLotActive(lot))
    }

  /** Общий дедлайн онлайн-торгов — дедлайн, который получают лоты; в `Prebidding` его ждёт таймер entity. */
  def prebiddingDeadline(auction: Auction): Option[Instant] =
    auction.state match {
      case AuctionState.Prebidding(config, _) => prebiddingDeadline(config)
      case _ => None
    }

  private def prebiddingDeadline(config: AuctionConfig): Option[Instant] = config.lotDeadline

  private def planned(
      auction: Auction,
      command: ScheduleAuctionLot,
      terms: LotTerms
  ): Either[ScheduleAuctionLotRejected, ScheduleLot] =
    if (!auction.lots.contains(command.lot)) Left(ScheduleAuctionLotRejected.LotNotInAuction)
    else {
      val config = LotConfigInput(terms.currency, command.stepPolicy, terms.antiSnipe, terms.proxyEnabled)
      Right(ScheduleLot(command.startingPrice, config, command.opId))
    }

  /**
   * Применение события: меняет состояние и не отказывает. Событие, которое к состоянию не относится, состояние не
   * трогает — такой пары `decide` не порождает.
   */
  def apply(auction: Auction, envelope: AuctionEnvelope): Auction = {
    val next = (auction.state, envelope.event) match {
      case (AuctionState.Initial, AuctionEvent.AuctionDrafted(meetup)) =>
        auction.copy(state = AuctionState.Draft, meetup = Some(meetup))
      case (AuctionState.Draft | AuctionState.Scheduled(_), AuctionEvent.LotAdded(lot)) =>
        auction.copy(lots = auction.lots + lot)
      case (AuctionState.Draft | AuctionState.Scheduled(_), AuctionEvent.LotRemoved(lot)) =>
        auction.copy(lots = auction.lots - lot)
      case (AuctionState.Draft | AuctionState.Scheduled(_), AuctionEvent.AuctionScheduled(config)) =>
        auction.copy(state = AuctionState.Scheduled(config))
      case (AuctionState.Scheduled(config), AuctionEvent.PrebiddingStarted) =>
        auction.copy(state = AuctionState.Prebidding(config, envelope.opId))
      // Сходка, реестр и конфигурация уходят, окно `seen` остаётся: повтор любой прежней команды узнаёт свой ответ.
      case (AuctionState.Draft | AuctionState.Scheduled(_), AuctionEvent.AuctionDiscarded) =>
        Auction.initial.copy(seen = auction.seen)
      case (AuctionState.Prebidding(config, startedBy), AuctionEvent.PrebiddingDeadlineReached) =>
        auction.copy(state = AuctionState.Settling(config, startedBy))
      case (AuctionState.Settling(config, startedBy), AuctionEvent.PrebiddingEnded(finished)) =>
        auction.copy(state =
          if (finished) AuctionState.Finished(config, startedBy) else AuctionState.Break(config, startedBy)
        )
      case (AuctionState.Break(config, startedBy), AuctionEvent.FinalLineupFrozen(order)) =>
        auction.copy(state = AuctionState.LineupFrozen(config, startedBy, order))
      case (AuctionState.LineupFrozen(config, startedBy, order), AuctionEvent.FinalStarted) =>
        auction.copy(state = AuctionState.Final(config, startedBy, order, Nil, Nil))
      case (final_ @ AuctionState.Final(_, _, _, activated, _), AuctionEvent.FinalLotActivated(lot)) =>
        auction.copy(state = final_.copy(activated = activated :+ lot))
      case (final_ @ AuctionState.Final(_, _, _, _, completed), AuctionEvent.FinalLotCompleted(lot)) =>
        auction.copy(state = final_.copy(completed = completed :+ lot))
      case (AuctionState.Final(config, startedBy, _, _, _), AuctionEvent.AuctionFinished) =>
        auction.copy(state = AuctionState.Finished(config, startedBy))
      case (AuctionState.Break(config, startedBy), AuctionEvent.AuctionFinished) =>
        auction.copy(state = AuctionState.Finished(config, startedBy))
      case (current, AuctionEvent.AuctionCancelled) =>
        current match {
          case AuctionState.Prebidding(_, _) | AuctionState.Settling(_, _) | AuctionState.Break(_, _) |
              AuctionState.LineupFrozen(_, _, _) | AuctionState.Final(_, _, _, _, _) =>
            current.started.fold(auction) { (config, startedBy) =>
              auction.copy(state = AuctionState.Cancelled(config, startedBy, envelope.opId))
            }
          case _ => auction
        }
      case _ => auction
    }
    val seen = if (auction.seen.contains(envelope.opId)) auction.seen else auction.seen.updated(envelope.opId, envelope)
    next.copy(seen = seen)
  }

  /** Свёртка журнала в порядке `sequence`. */
  def replay(from: Auction, journal: Seq[AuctionEnvelope]): Auction =
    journal.sortBy(_.sequence).foldLeft(from)(apply)

  private def bytes(uuid: UUID): Array[Byte] = {
    val buffer = java.nio.ByteBuffer.allocate(16)
    buffer.putLong(uuid.getMostSignificantBits)
    buffer.putLong(uuid.getLeastSignificantBits)
    buffer.array()
  }

  private def long(bytes: Array[Byte], from: Int): Long =
    (from until from + 8).foldLeft(0L)((acc, i) => (acc << 8) | (bytes(i) & 0xffL))
}
