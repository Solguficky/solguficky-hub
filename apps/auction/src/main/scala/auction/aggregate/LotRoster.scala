package auction.aggregate

import auction.catalog.LotId
import auction.lot.AddStepWindow
import auction.lot.CloseLot
import auction.lot.CloseLotRejected
import auction.lot.CloseReason
import auction.lot.LotState
import auction.lot.OpId
import auction.lot.OpenLot
import auction.lot.OpenLotRejected
import auction.lot.ResumeLot
import auction.lot.StepWindow
import auction.lot.WithdrawLot
import auction.lot.WithdrawLotRejected
import auction.lot.WithdrawnReason

import java.time.Instant
import java.util.UUID

/**
 * Что аукцион знает о лоте реестра в онлайн-торгах. `Asked`, `Opening` и `Closing` — вопрос или команда ушли, ответа
 * ещё нет. `Active` — лот подтвердил открытие; только такой лот аукцион считает активным (И-14) и только его закрывает
 * по дедлайну. `Declined` — лот отклонил `OpenLot`. `NotOpened` — лот так и не открыт, а открывать поздно: общий
 * дедлайн прошёл. `Unanswered` — ответ не пришёл. `Held` — лот удержан для финала (П-09). `Closed` — лот продан или
 * закрыт без продажи. В отменённом аукционе (ADR-047, дополнение 2026-10-12): `Withdrawing` — `WithdrawLot` ушёл,
 * ответа нет; `Withdrawn` — лот снят; `Closed` — лот ответил, что уже завершён, и остался как был.
 */
enum LotStanding {
  case Asked
  case Opening
  case Active
  case Closing
  case Declined(reason: OpenLotRejected)
  case NotOpened
  case Unanswered
  case Held
  case Closed
  case Withdrawing
  case Withdrawn

  /**
   * Лот больше не держит конец онлайн-торгов (RFC-011, `awaiting`): закрыт, удержан или так и не открывался. Лот без
   * ответа держит: он мог быть ещё в торгах.
   */
  def settled: Boolean =
    this match {
      case Closed | Held | Declined(_) | NotOpened | Withdrawn => true
      case Asked | Opening | Active | Closing | Unanswered | Withdrawing => false
    }
}

/**
 * Что аукцион знает о доставке запущенного окна лоту (ADR-047, дополнение 2026-10-12). `Sending` — `AddStepWindow`
 * ушёл, ответа нет; `Delivered` — лот ответил: принял окно или отказал, потому что уже не в торгах, — и ждать от него
 * нечего; `Unanswered` — ответ не пришёл.
 */
enum WindowDelivery {
  case Sending
  case Delivered
  case Unanswered
}

/** Чем лот ответил на закрытие по дедлайну: продан или закрыт без продажи — либо удержан для финала (П-09). */
enum Closure {
  case Closed
  case Held
}

/**
 * Что аукцион должен сделать с лотом: спросить его состояние, открыть, взвести таймер дедлайна или закрыть. Исполняет
 * инструкцию entity; таймер — единственная инструкция, которой нужны часы, и её `deadline` entity сравнивает со своими.
 */
enum LotInstruction {
  case Ask(lot: LotId)
  case Open(lot: LotId, command: OpenLot)
  case Arm(lot: LotId, deadline: Instant)
  case Close(lot: LotId, command: CloseLot)

  /**
   * Каждый лот, ждавший конца онлайн-торгов, закрыт или удержан: аукциону пора записать `PrebiddingEnded`. `held` —
   * удержанные лоты по ответам; журнал их не хранит (RFC-011, «Чего сессия в журнал не пишет»).
   */
  case Settle(held: Set[LotId])

  /** Снять лот с торгов: аукцион отменён (ADR-047, дополнение 2026-10-12). */
  case Withdraw(lot: LotId, command: WithdrawLot)

  /** Активный лот финала завершился, а аукцион этого ещё не записал: пора записать `FinalLotCompleted` (PER-607). */
  case Complete(lot: LotId)

  /** Доставить лоту окно, запущенное под `launch` (ADR-047, дополнение 2026-10-12). */
  case AddWindow(lot: LotId, launch: OpId, command: AddStepWindow)

  /**
   * Аукцион кончился, а записи о том нет: в финале завершён каждый лот состава, в перерыве не осталось удержанных —
   * пора записать `AuctionFinished`.
   */
  case Finish
}

/**
 * Протокол подтверждения И-14 между аукционом и лотами — чистыми функциями: каждая отдаёт знание после шага и
 * инструкции, которые шаг вызвал.
 *
 * Знание в журнал аукциона не пишется (RFC-011, «Чего сессия в журнал не пишет»): оно живёт, пока жива entity, и
 * восстанавливается тем же опросом, которым строится после команды открытия (ADR-045). Поэтому командный путь и
 * recovery начинаются с одного [[LotRoster.survey]].
 *
 * Аукцион сначала спрашивает состояние лота и только потом открывает его: лот, открытый до падения аукциона, второго
 * `OpenLot` не получает (Т-27). Не открытый лот получает `OpenLot` с `op_id` команды открытия — тем же после любого
 * рестарта, — и что с ним делать, решает сам лот: лот без условий торгов ответит `LotNotScheduled` (Т-21).
 *
 * Таймер закрытия живёт в аукционе (ADR-045, ось D RFC-011) и взводится по дедлайну, который назвал сам лот: ответом на
 * вопрос о состоянии или подтверждением открытия. Поэтому таймер после рестарта взводится тем же опросом, а лот с
 * дедлайном, истёкшим за время простоя, закрывается сразу. Наступил ли дедлайн, решает лот (П-05): на отказ закрытия
 * аукцион спрашивает его состояние заново и взводит таймер по тому, что лот ответил.
 *
 * Окна, запущенные по ходу торгов, доставляются лотам той же парой «команда — подтверждение» (ADR-047, дополнение
 * 2026-10-12): `deliveries` — знание о доставке по `op_id` запуска и лоту, несохраняемое, как и знание о лотах.
 * Recovery начинает с пустого и шлёт каждое запущенное окно каждому его лоту заново: `op_id` доставки тот же, и лот,
 * уже записавший окно, второго события не пишет.
 */
/**
 * `removals` — сколько снятий участника ушло лоту и ещё не получило ответа (PER-658). Пока хоть одно в пути, цена
 * удержанного лота может измениться, и состав финала не известен; знание о самом лоте снятие не трогает.
 */
final case class LotRoster(
    lots: Map[LotId, LotStanding],
    deliveries: Map[(OpId, LotId), WindowDelivery] = Map.empty,
    removals: Map[LotId, Int] = Map.empty
) {

  /** Лоты, подтвердившие открытие. */
  def active: Set[LotId] = lots.collect { case (lot, LotStanding.Active) => lot }.toSet

  /** Лоты, удержанные для финала по ответам. */
  def held: Set[LotId] = lots.collect { case (lot, LotStanding.Held) => lot }.toSet
}

object LotRoster {

  val empty: LotRoster = LotRoster(Map.empty)

  /** Пространство имён `op_id` закрытия по дедлайну (UUIDv5). */
  val CloseNamespace: UUID = UUID.fromString("5b7e4d0c-3f1a-4f5e-9a59-2f8f0f4c6e21")

  /**
   * `op_id` закрытия лота по дедлайну — UUIDv5 от `op_id` команды открытия и лота. Одинаков после любого рестарта:
   * повтор закрытия, ответ на которое потерялся, получает у лота исходный ответ, а не второе событие (П-06).
   */
  def closeOpId(startedBy: OpId, lot: LotId): OpId =
    OpId(Auction.nameBased(CloseNamespace, s"${startedBy.value}/${lot.value}"))

  /** Пространство имён `op_id` возврата лота в финал (UUIDv5). */
  val ResumeNamespace: UUID = UUID.fromString("0d6f3a8e-7c21-4b9e-8f45-3e2a9b1c7d60")

  /**
   * `ResumeLot` лоту финала. `op_id` — UUIDv5 от `op_id` открытия и лота, как у закрытия: лот, вернувшийся в торги до
   * рестарта аукциона, на повтор отвечает исходным `LotResumed`, а не `LotNotHeld`, и аукцион дописывает активацию.
   */
  def resumeOf(startedBy: OpId, lot: LotId): ResumeLot =
    ResumeLot(OpId(Auction.nameBased(ResumeNamespace, s"${startedBy.value}/${lot.value}")))

  /** Пространство имён `op_id` шагов, которые аукцион делает сам: общего дедлайна и конца ожидания лотов (UUIDv5). */
  val StepNamespace: UUID = UUID.fromString("c4b1e9d2-5a37-4f08-9e6b-71d2a8f30c95")

  /**
   * `op_id` шага аукциона без человека — UUIDv5 от `op_id` открытия и имени шага. Одинаков после любого рестарта:
   * таймер, сработавший второй раз, упирается в окно `seen`, а не пишет второе событие.
   */
  def stepOpId(startedBy: OpId, step: String): OpId =
    OpId(Auction.nameBased(StepNamespace, s"${startedBy.value}/$step"))

  /**
   * `op_id` завершения лота финала — шаг аукциона без человека от `op_id` открытия и лота. Один и тот же у ответа на
   * закрытие ведущим и у восстановления после рестарта: кто бы ни пришёл вторым, он упирается в окно `seen`.
   */
  def completionOf(startedBy: OpId, lot: LotId): OpId = stepOpId(startedBy, s"final-lot-completed/${lot.value}")

  /** `op_id` конца аукциона после финала — шаг без человека, как конец ожидания лотов. */
  def finishOf(startedBy: OpId): OpId = stepOpId(startedBy, "auction-finished")

  /** Пространство имён `op_id` доставки запущенного окна лоту (UUIDv5). */
  val WindowNamespace: UUID = UUID.fromString("6f1d8b2e-4a93-4c57-b0e8-3d9a72c514fb")

  /**
   * `AddStepWindow` лоту окна, запущенного под `launch`. `op_id` — UUIDv5 от `op_id` запуска и лота (ADR-047,
   * дополнение 2026-10-12): одинаков после любого рестарта, и лот на повтор отвечает исходным `StepWindowAdded`.
   */
  def windowOf(launch: LaunchedWindow, lot: LotId): AddStepWindow =
    AddStepWindow(
      StepWindow(launch.window.from, launch.window.until, launch.window.step),
      OpId(Auction.nameBased(WindowNamespace, s"${launch.opId.value}/${lot.value}"))
    )

  /** Пространство имён `op_id` снятия лота отменённым аукционом (UUIDv5). */
  val WithdrawNamespace: UUID = UUID.fromString("9e3c5a71-2b8d-4f06-a1e4-6d0b7c93f852")

  /**
   * `WithdrawLot` лоту отменённого аукциона. `op_id` — UUIDv5 от `op_id` отмены и лота (ADR-047, дополнение
   * 2026-10-12): одинаков после любого рестарта, и снятый лот на повтор отвечает исходным `LotWithdrawn`.
   */
  def withdrawalOf(cancelledBy: OpId, lot: LotId): WithdrawLot =
    WithdrawLot(
      WithdrawnReason.AuctionCancelled,
      OpId(Auction.nameBased(WithdrawNamespace, s"${cancelledBy.value}/${lot.value}"))
    )

  /**
   * Опрос всего реестра. Спрашивает аукцион в онлайн-торгах, в ожидании их конца и в перерыве; до старта лоты не
   * открыты, а с заморозки состава аукцион знает финалистов из своего журнала. Отменённый аукцион не спрашивает, а
   * снимает каждый лот реестра: что ответить, решает лот, и проданный остаётся проданным. Других команд лотам
   * отменённый аукцион больше не шлёт — ни открытия, ни закрытия.
   *
   * В финале спрашивается только активный лот (PER-607): ведущий мог закрыть его, а аукцион упасть до записи
   * `FinalLotCompleted`. Это восстановление знания, которое дал бы ответ на закрытие, а не второй путь к концу лота:
   * без закрытия ведущим ответ лота ничего не меняет. Финал с завершённым составом сразу получает `Finish`.
   */
  def survey(auction: Auction): (LotRoster, List[LotInstruction]) =
    auction.state match {
      case AuctionState.Cancelled(_, _, cancelledBy) => withdraw(empty, auction.lots.toList, cancelledBy)
      case current if asking(current) =>
        val (asked, questions) = settling(auction, ask(empty, auction.lots.toList))
        val (delivering, windows) = deliver(auction, asked, auction.launched)
        (delivering, questions ++ windows)
      case AuctionState.Final(_, _, _, _, _) if Auction.lineupCompleted(auction) => (empty, List(LotInstruction.Finish))
      case current @ AuctionState.Final(_, _, _, _, _) => ask(empty, current.activeLot.toList)
      case _ => (empty, Nil)
    }

  /**
   * Доспрос на повторе команды открытия: лоты, чей ответ не пришёл, и лоты реестра, о которых знания нет. Лот с
   * полученным ответом — подтверждением или отказом — повтор не трогает.
   */
  def resume(auction: Auction, roster: LotRoster): (LotRoster, List[LotInstruction]) =
    auction.state match {
      case AuctionState.Prebidding(_, _) =>
        val pending = auction.lots.toList.filter { lot =>
          roster.lots.get(lot) match {
            case None | Some(LotStanding.Unanswered) => true
            case Some(_) => false
          }
        }
        ask(roster, pending)
      case _ => (roster, Nil)
    }

  /**
   * Переспрос неответивших лотов по таймеру аукциона. Entity аукциона помнится шардингом и по простою не засыпает
   * (ADR-045, дополнение 2026-10-05), поэтому следующего пробуждения, которое переспросило бы их, может не быть: без
   * переспроса лот, не ответивший на закрытие, остался бы в торгах после дедлайна.
   */
  def recheck(auction: Auction, roster: LotRoster): (LotRoster, List[LotInstruction]) = {
    val silent = roster.lots.collect { case (lot, LotStanding.Unanswered) => lot }.toList
    auction.state match {
      case AuctionState.Cancelled(_, _, cancelledBy) => withdraw(roster, silent, cancelledBy)
      case current if asking(current) =>
        val (asked, questions) = ask(roster, silent)
        val (delivering, windows) = deliver(auction, asked, auction.launched)
        (delivering, questions ++ windows)
      case AuctionState.Final(_, _, _, _, _) => ask(roster, silent)
      case _ => (roster, Nil)
    }
  }

  /**
   * Шаг протокола после команды открытия: записанное событие начинает опрос заново, повтор самой команды открытия
   * доспрашивает неответившие лоты. `op_id`, под которым записано другое событие, лотов не трогает: окно `seen` вид
   * события не различает, и чужой `op_id` иначе стал бы способом открыть лоты.
   */
  def started(auction: Auction, roster: LotRoster, decision: AuctionDecision): (LotRoster, List[LotInstruction]) =
    decision match {
      case AuctionDecision.Accepted(_) => survey(auction)
      case AuctionDecision.Repeated(AuctionEnvelope(_, _, AuctionEvent.PrebiddingStarted)) => resume(auction, roster)
      case AuctionDecision.Repeated(_) | AuctionDecision.Unchanged => (roster, Nil)
    }

  /**
   * Шаг протокола после команды отмены — та же форма, что [[started]]: записанное событие снимает весь реестр заново,
   * повтор самой отмены доснимает лоты без ответа, а `op_id` под другим событием и отмена уже отменённого аукциона
   * лотов не трогают — неответившие лоты переспросит таймер.
   */
  def cancelled(auction: Auction, roster: LotRoster, decision: AuctionDecision): (LotRoster, List[LotInstruction]) =
    (auction.state, decision) match {
      case (_, AuctionDecision.Accepted(_)) => survey(auction)
      case (
            AuctionState.Cancelled(_, _, cancelledBy),
            AuctionDecision.Repeated(AuctionEnvelope(_, _, AuctionEvent.AuctionCancelled))
          ) =>
        val pending = auction.lots.toList.filter { lot =>
          roster.lots.get(lot) match {
            case None | Some(LotStanding.Unanswered) => true
            case Some(_) => false
          }
        }
        withdraw(roster, pending, cancelledBy)
      case _ => (roster, Nil)
    }

  /**
   * Шаг доставки после команды запуска: записанное окно и повтор того же `op_id` шлют окно лотам, которым оно ещё не
   * доставлено и не в пути. `op_id` под другим событием окон не трогает.
   */
  def launched(auction: Auction, roster: LotRoster, opId: OpId): (LotRoster, List[LotInstruction]) =
    deliver(auction, roster, auction.launched.filter(_.opId == opId))

  /**
   * Лот ответил на `AddStepWindow`: и принятое окно, и отказ лота, который уже не в торгах, доставку завершают —
   * аукцион такого лота не ждёт. Ответ, которого аукцион не ждёт, знания не меняет.
   */
  def windowAnswered(roster: LotRoster, launch: OpId, lot: LotId): LotRoster =
    roster.deliveries.get(launch -> lot) match {
      case Some(WindowDelivery.Sending) =>
        roster.copy(deliveries = roster.deliveries.updated(launch -> lot, WindowDelivery.Delivered))
      case _ => roster
    }

  /** Ответа на `AddStepWindow` нет: лот мог записать окно, и истину даст повтор с тем же `op_id`. */
  def windowUnanswered(roster: LotRoster, launch: OpId, lot: LotId): LotRoster =
    roster.deliveries.get(launch -> lot) match {
      case Some(WindowDelivery.Sending) =>
        roster.copy(deliveries = roster.deliveries.updated(launch -> lot, WindowDelivery.Unanswered))
      case _ => roster
    }

  /**
   * Окна шлются только в онлайн-торгах: окно кончается не позже `closesAt`, и после общего дедлайна доставлять нечего,
   * а отменённый аукцион лотам ничего, кроме снятия, не шлёт. Шлётся окно лоту, о доставке которому знания нет или
   * ответ не пришёл.
   */
  private def deliver(
      auction: Auction,
      roster: LotRoster,
      launches: List[LaunchedWindow]
  ): (LotRoster, List[LotInstruction]) =
    auction.state match {
      case AuctionState.Prebidding(_, _) =>
        val due = for {
          launch <- launches
          lot <- launch.window.lots.toList.sortBy(_.value)
          if roster.deliveries.get(launch.opId -> lot).forall(_ == WindowDelivery.Unanswered)
        } yield (launch, lot)
        (
          roster.copy(deliveries = due.foldLeft(roster.deliveries) { case (known, (launch, lot)) =>
            known.updated(launch.opId -> lot, WindowDelivery.Sending)
          }),
          due.map((launch, lot) => LotInstruction.AddWindow(lot, launch.opId, windowOf(launch, lot)))
        )
      case _ => (roster, Nil)
    }

  /**
   * Лот ответил на `WithdrawLot`: снят — `Withdrawn`; отказ — лот уже завершён или его нет, и снимать нечего. Ответ,
   * которого аукцион не ждёт, знания не меняет.
   */
  def withdrawn(roster: LotRoster, lot: LotId, answer: Either[WithdrawLotRejected, Unit]): LotRoster =
    roster.lots.get(lot) match {
      case Some(LotStanding.Withdrawing) =>
        roster.mark(lot, answer.fold(_ => LotStanding.Closed, _ => LotStanding.Withdrawn))
      case _ => roster
    }

  /**
   * Лот ответил на вопрос о состоянии. Ответ, которого аукцион не ждёт, — опоздавший или повторный — знания не меняет.
   * Лот в торгах с дедлайном получает таймер; лот, которого ведёт человек, — нет. Не открытый лот аукцион открывает
   * только в онлайн-торгах: после общего дедлайна открывать поздно, и такой лот конца торгов не держит.
   */
  def observed(auction: Auction, roster: LotRoster, lot: LotId, state: LotState): (LotRoster, List[LotInstruction]) =
    (auction.state, roster.lots.get(lot)) match {
      case (current, Some(LotStanding.Asked)) if asking(current) =>
        val step = state match {
          case LotState.Trading(trading) => (roster.mark(lot, LotStanding.Active), armed(lot, trading.deadline))
          case LotState.Held(_) => (roster.mark(lot, LotStanding.Held), Nil)
          case LotState.Sold(_) | LotState.Unsold(_) | LotState.Withdrawn(_) =>
            (roster.mark(lot, LotStanding.Closed), Nil)
          case LotState.Initial | LotState.Draft | LotState.Scheduled(_) =>
            current match {
              case AuctionState.Prebidding(config, startedBy) =>
                val open = LotInstruction.Open(lot, OpenLot(config.lotDeadline, startedBy, config.windowsOf(lot)))
                (roster.mark(lot, LotStanding.Opening), List(open))
              case _ => (roster.mark(lot, LotStanding.NotOpened), Nil)
            }
        }
        breakOver(auction, settling(auction, step))
      // В финале аукцион спрашивает лот только затем, чтобы узнать, не кончился ли он без записи о том.
      case (AuctionState.Final(_, _, _, _, _), Some(LotStanding.Asked)) =>
        state match {
          case LotState.Sold(_) | LotState.Unsold(_) | LotState.Withdrawn(_) =>
            (roster.mark(lot, LotStanding.Closed), List(LotInstruction.Complete(lot)))
          case LotState.Initial | LotState.Draft | LotState.Scheduled(_) | LotState.Trading(_) | LotState.Held(_) =>
            (roster.mark(lot, LotStanding.Active), Nil)
        }
      case _ => (roster, Nil)
    }

  /**
   * Закрытие ведущим ушло лоту (PER-607). В перерыве лот до ответа — `Closing`: такой лот держит знание о составе, и
   * заморозка, пришедшая до ответа, отвечает «состав пока не известен», а не берёт в состав лот, который вот-вот будет
   * продан. В финале знание ведётся только об активном лоте: потерянный ответ на его закрытие доводит переспрос. В
   * остальных фазах и для остальных лотов финала шаг знания не трогает.
   */
  def closingByAuctioneer(auction: Auction, roster: LotRoster, lot: LotId): LotRoster =
    auction.state match {
      case AuctionState.Break(_, _) => roster.mark(lot, LotStanding.Closing)
      case current @ AuctionState.Final(_, _, _, _, _) if current.activeLot.contains(lot) =>
        roster.mark(lot, LotStanding.Closing)
      case _ => roster
    }

  /**
   * Снятие участника ушло лоту (ADR-072, «Открыто»; PER-658). Пока оно в пути — в какой бы фазе ни ушло, — состав
   * финала не известен: заморозка, пришедшая до ответа, отвечает «состав пока не известен», а не берёт в состав цену,
   * которую снятие вот-вот изменит. Снятия считаются, а не отмечаются: ответ на одно не открывает заморозку, пока в
   * пути другое. Знание о самом лоте шаг не трогает.
   */
  def removingParticipant(roster: LotRoster, lot: LotId): LotRoster =
    roster.copy(removals = roster.removals.updated(lot, roster.removals.getOrElse(lot, 0) + 1))

  /**
   * Лот ответил на снятие участника или ответа не дождались. Снятие больше не в пути; удержанный по знанию лот аукцион
   * спрашивает заново: снятие могло изменить его цену, а за время в пути его мог продать ведущий. Вопрос встаёт в
   * очередь лота после самого снятия, и до ответа на него состав по-прежнему не известен. Лот, о котором аукцион знает
   * другое, — открываемый, закрываемый, — шаг не трогает.
   */
  def participantRemovalAnswered(roster: LotRoster, lot: LotId): (LotRoster, List[LotInstruction]) = {
    val left = roster.removals.getOrElse(lot, 0) - 1
    val settled = roster.copy(removals = if (left > 0) roster.removals.updated(lot, left) else roster.removals - lot)
    settled.lots.get(lot) match {
      case Some(LotStanding.Held) => ask(settled, List(lot))
      case _ => (settled, Nil)
    }
  }

  /**
   * Лот ответил на закрытие ведущим. Принятое — лот закрыт, и перерыв, в котором не осталось удержанных, кончается.
   * Отказ значит, что аукцион знает о лоте не то, что лот, и истину даёт вопрос о состоянии — по ответу на него финал
   * запишет конец лота, если лот уже кончился.
   */
  def endedByAuctioneer(
      auction: Auction,
      roster: LotRoster,
      lot: LotId,
      accepted: Boolean
  ): (LotRoster, List[LotInstruction]) =
    roster.lots.get(lot) match {
      case Some(LotStanding.Closing) =>
        if (accepted) breakOver(auction, (roster.mark(lot, LotStanding.Closed), Nil)) else ask(roster, List(lot))
      case _ => (roster, Nil)
    }

  /**
   * Шаг в перерыве: когда о каждом лоте реестра есть ответ и удержанных среди них не осталось — ведущий продал всех, —
   * к шагу добавляется `Finish` (PER-607). В перерыв аукцион входит только с удержанными, поэтому пустым он становится
   * лишь закрытием ведущим; после рестарта тот же вывод даёт опрос. Вне перерыва шаг не меняется.
   */
  def breakOver(auction: Auction, step: (LotRoster, List[LotInstruction])): (LotRoster, List[LotInstruction]) = {
    val (roster, instructions) = step
    lineup(auction, roster) match {
      case Some(held) if held.isEmpty => (roster, instructions :+ LotInstruction.Finish)
      case _ => step
    }
  }

  /**
   * Лот ответил на `OpenLot`: подтверждение делает его активным и взводит таймер по дедлайну из его `LotOpened`, отказ
   * — нет, и аукцион никого не ждёт.
   */
  def opened(
      auction: Auction,
      roster: LotRoster,
      lot: LotId,
      answer: Either[OpenLotRejected, Option[Instant]]
  ): (LotRoster, List[LotInstruction]) =
    roster.lots.get(lot) match {
      case Some(LotStanding.Opening) =>
        answer match {
          case Left(rejected) => settling(auction, (roster.mark(lot, LotStanding.Declined(rejected)), Nil))
          case Right(deadline) => (roster.mark(lot, LotStanding.Active), armed(lot, deadline))
        }
      case _ => (roster, Nil)
    }

  /**
   * Сработал таймер дедлайна лота. Закрывается только активный лот и только пока онлайн-торги идут или их конец ещё
   * ждёт лотов; таймер, переживший смену знания, — лот уже закрыт, удержан или ждёт ответа, — ничего не делает.
   */
  def due(auction: Auction, roster: LotRoster, lot: LotId): (LotRoster, List[LotInstruction]) =
    (auction.state, roster.lots.get(lot)) match {
      case (AuctionState.Prebidding(_, startedBy), Some(LotStanding.Active)) => closing(roster, lot, startedBy)
      case (AuctionState.Settling(_, startedBy), Some(LotStanding.Active)) => closing(roster, lot, startedBy)
      case _ => (roster, Nil)
    }

  /**
   * Лот ответил на закрытие. Принятое закрытие делает его закрытым или удержанным. Отказ значит, что аукцион знает о
   * лоте не то, что лот: дедлайн не наступил или лот уже не в торгах, — и истину даёт вопрос о состоянии, по ответу на
   * который таймер взводится заново.
   */
  def closed(
      auction: Auction,
      roster: LotRoster,
      lot: LotId,
      answer: Either[CloseLotRejected, Closure]
  ): (LotRoster, List[LotInstruction]) =
    roster.lots.get(lot) match {
      case Some(LotStanding.Closing) =>
        answer match {
          case Right(Closure.Closed) => settling(auction, (roster.mark(lot, LotStanding.Closed), Nil))
          case Right(Closure.Held) => settling(auction, (roster.mark(lot, LotStanding.Held), Nil))
          case Left(_) => ask(roster, List(lot))
        }
      case _ => (roster, Nil)
    }

  /**
   * Шаг ожидания конца онлайн-торгов: в `Settling`, когда каждый лот реестра больше не держит конец торгов, к шагу
   * добавляется инструкция `Settle`. Вне `Settling` шаг не меняется. Лот, о котором знания нет, держит: аукцион его ещё
   * не спросил.
   */
  def settling(auction: Auction, step: (LotRoster, List[LotInstruction])): (LotRoster, List[LotInstruction]) = {
    val (roster, instructions) = step
    auction.state match {
      case AuctionState.Settling(_, _) if complete(auction, roster) =>
        (roster, instructions :+ LotInstruction.Settle(roster.held))
      case _ => step
    }
  }

  /**
   * Удержанные лоты для заморозки состава: только в перерыве и только когда о каждом лоте реестра есть ответ. Перерыв
   * после рестарта переспрашивает лоты, и до последнего ответа состав не известен — `None`.
   */
  def lineup(auction: Auction, roster: LotRoster): Option[Set[LotId]] =
    auction.state match {
      case AuctionState.Break(_, _) if complete(auction, roster) && roster.removals.isEmpty => Some(roster.held)
      case _ => None
    }

  private def complete(auction: Auction, roster: LotRoster): Boolean =
    auction.lots.forall(lot => roster.lots.get(lot).exists(_.settled))

  /**
   * Держит ли аукцион торги по своему журналу — фазы от `Prebidding` до `Final`. Такой аукцион держит слот торгов
   * сообщества и подтверждает его после рестарта (ADR-047, дополнение 2026-10-12).
   */
  def holding(state: AuctionState): Boolean =
    state match {
      case AuctionState.Prebidding(_, _) | AuctionState.Settling(_, _) | AuctionState.Break(_, _) |
          AuctionState.LineupFrozen(_, _, _) | AuctionState.Final(_, _, _, _, _) =>
        true
      case AuctionState.Initial | AuctionState.Draft | AuctionState.Scheduled(_) | AuctionState.Finished(_, _) |
          AuctionState.Cancelled(_, _, _) =>
        false
    }

  /**
   * Идут ли у аукциона торги — ответ держателя слоту торгов сообщества (ADR-047, дополнение 2026-10-12), без открытия в
   * полёте: его знает entity. Фазы от `Prebidding` до `Final` — да ([[holding]]). Отменённый — пока хоть один лот
   * реестра не ответил на `WithdrawLot`: ставку лот принимает сам, мимо аукциона, и до ответа ещё торгуется. После
   * рестарта опрос снимает весь реестр заново, поэтому пустое знание читается как «торгуется». Остальное — нет.
   */
  def trading(auction: Auction, roster: LotRoster): Boolean =
    auction.state match {
      case AuctionState.Cancelled(_, _, _) =>
        !auction.lots.forall { lot =>
          roster.lots.get(lot) match {
            case Some(LotStanding.Withdrawn | LotStanding.Closed) => true
            case Some(_) | None => false
          }
        }
      case other => holding(other)
    }

  /** Лоты спрашивает аукцион в онлайн-торгах, в ожидании их конца и в перерыве, пока состав не заморожен. */
  private def asking(state: AuctionState): Boolean =
    state match {
      case AuctionState.Prebidding(_, _) | AuctionState.Settling(_, _) | AuctionState.Break(_, _) => true
      case AuctionState.Initial | AuctionState.Draft | AuctionState.Scheduled(_) | AuctionState.LineupFrozen(_, _, _) |
          AuctionState.Final(_, _, _, _, _) | AuctionState.Finished(_, _) | AuctionState.Cancelled(_, _, _) =>
        false
    }

  private def closing(roster: LotRoster, lot: LotId, startedBy: OpId): (LotRoster, List[LotInstruction]) =
    (
      roster.mark(lot, LotStanding.Closing),
      List(LotInstruction.Close(lot, CloseLot(CloseReason.DeadlineReached, closeOpId(startedBy, lot))))
    )

  /**
   * Ответа на вопрос или команду нет. Лот при этом мог открыться или закрыться: истину даст переспрос, а не догадка.
   */
  def unanswered(roster: LotRoster, lot: LotId): LotRoster =
    roster.lots.get(lot) match {
      case Some(LotStanding.Asked | LotStanding.Opening | LotStanding.Closing | LotStanding.Withdrawing) =>
        roster.mark(lot, LotStanding.Unanswered)
      case _ => roster
    }

  private def armed(lot: LotId, deadline: Option[Instant]): List[LotInstruction] =
    deadline.map(LotInstruction.Arm(lot, _)).toList

  private def ask(roster: LotRoster, lots: List[LotId]): (LotRoster, List[LotInstruction]) =
    (lots.foldLeft(roster)(_.mark(_, LotStanding.Asked)), lots.map(LotInstruction.Ask(_)))

  private def withdraw(roster: LotRoster, lots: List[LotId], cancelledBy: OpId): (LotRoster, List[LotInstruction]) =
    (
      lots.foldLeft(roster)(_.mark(_, LotStanding.Withdrawing)),
      lots.map(lot => LotInstruction.Withdraw(lot, withdrawalOf(cancelledBy, lot)))
    )

  extension (roster: LotRoster) {
    private def mark(lot: LotId, standing: LotStanding): LotRoster =
      roster.copy(lots = roster.lots.updated(lot, standing))
  }
}
