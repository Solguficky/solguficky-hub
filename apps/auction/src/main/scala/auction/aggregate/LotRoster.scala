package auction.aggregate

import auction.catalog.LotId
import auction.lot.CloseLot
import auction.lot.CloseLotRejected
import auction.lot.CloseReason
import auction.lot.LotState
import auction.lot.OpId
import auction.lot.OpenLot
import auction.lot.OpenLotRejected

import java.time.Instant
import java.util.UUID

/**
 * Что аукцион знает о лоте реестра в онлайн-торгах. `Asked`, `Opening` и `Closing` — вопрос или команда ушли, ответа
 * ещё нет. `Active` — лот подтвердил открытие; только такой лот аукцион считает активным (И-14) и только его закрывает
 * по дедлайну. `Declined` — лот отклонил `OpenLot`. `Unanswered` — ответ не пришёл. `Closed` — лот продан или закрыт
 * без продажи. `Held` назван ради полноты по [[LotState]]: поведение для удержанного лота приносит PER-334.
 */
enum LotStanding {
  case Asked
  case Opening
  case Active
  case Closing
  case Declined(reason: OpenLotRejected)
  case Unanswered
  case Held
  case Closed
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
 */
final case class LotRoster(lots: Map[LotId, LotStanding]) {

  /** Лоты, подтвердившие открытие. */
  def active: Set[LotId] = lots.collect { case (lot, LotStanding.Active) => lot }.toSet
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

  /** Опрос всего реестра. Вне онлайн-торгов спрашивать некого: знание пусто, инструкций нет. */
  def survey(auction: Auction): (LotRoster, List[LotInstruction]) =
    auction.state match {
      case AuctionState.Prebidding(_, _) => ask(empty, auction.lots.toList)
      case AuctionState.Initial | AuctionState.Draft | AuctionState.Scheduled(_) => (empty, Nil)
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
      case AuctionState.Initial | AuctionState.Draft | AuctionState.Scheduled(_) => (roster, Nil)
    }

  /**
   * Переспрос неответивших лотов по таймеру аукциона. Entity аукциона помнится шардингом и по простою не засыпает
   * (ADR-045, дополнение 2026-10-05), поэтому следующего пробуждения, которое переспросило бы их, может не быть: без
   * переспроса лот, не ответивший на закрытие, остался бы в торгах после дедлайна.
   */
  def recheck(auction: Auction, roster: LotRoster): (LotRoster, List[LotInstruction]) =
    auction.state match {
      case AuctionState.Prebidding(_, _) =>
        ask(roster, roster.lots.collect { case (lot, LotStanding.Unanswered) => lot }.toList)
      case AuctionState.Initial | AuctionState.Draft | AuctionState.Scheduled(_) => (roster, Nil)
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
   * Лот ответил на вопрос о состоянии. Ответ, которого аукцион не ждёт, — опоздавший или повторный — знания не меняет.
   * Лот в торгах с дедлайном получает таймер; лот, которого ведёт человек, — нет.
   */
  def observed(auction: Auction, roster: LotRoster, lot: LotId, state: LotState): (LotRoster, List[LotInstruction]) =
    (auction.state, roster.lots.get(lot)) match {
      case (AuctionState.Prebidding(config, startedBy), Some(LotStanding.Asked)) =>
        state match {
          case LotState.Trading(trading) => (roster.mark(lot, LotStanding.Active), armed(lot, trading.deadline))
          case LotState.Held(_) => (roster.mark(lot, LotStanding.Held), Nil)
          case LotState.Sold(_) | LotState.Unsold(_) => (roster.mark(lot, LotStanding.Closed), Nil)
          case LotState.Initial | LotState.Draft | LotState.Scheduled(_) =>
            val open = LotInstruction.Open(lot, OpenLot(config.lotDeadline, startedBy, config.windowsOf(lot)))
            (roster.mark(lot, LotStanding.Opening), List(open))
        }
      case _ => (roster, Nil)
    }

  /**
   * Лот ответил на `OpenLot`: подтверждение делает его активным и взводит таймер по дедлайну из его `LotOpened`, отказ
   * — нет, и аукцион никого не ждёт.
   */
  def opened(
      roster: LotRoster,
      lot: LotId,
      answer: Either[OpenLotRejected, Option[Instant]]
  ): (LotRoster, List[LotInstruction]) =
    roster.lots.get(lot) match {
      case Some(LotStanding.Opening) =>
        answer match {
          case Left(rejected) => (roster.mark(lot, LotStanding.Declined(rejected)), Nil)
          case Right(deadline) => (roster.mark(lot, LotStanding.Active), armed(lot, deadline))
        }
      case _ => (roster, Nil)
    }

  /**
   * Сработал таймер дедлайна лота. Закрывается только активный лот; таймер, переживший смену знания, — лот уже закрыт,
   * удержан или ждёт ответа, — ничего не делает.
   */
  def due(auction: Auction, roster: LotRoster, lot: LotId): (LotRoster, List[LotInstruction]) =
    (auction.state, roster.lots.get(lot)) match {
      case (AuctionState.Prebidding(_, startedBy), Some(LotStanding.Active)) =>
        val close = LotInstruction.Close(lot, CloseLot(CloseReason.DeadlineReached, closeOpId(startedBy, lot)))
        (roster.mark(lot, LotStanding.Closing), List(close))
      case _ => (roster, Nil)
    }

  /**
   * Лот ответил на закрытие. Принятое закрытие делает его закрытым. Отказ значит, что аукцион знает о лоте не то, что
   * лот: дедлайн не наступил или лот уже не в торгах, — и истину даёт вопрос о состоянии, по ответу на который таймер
   * взводится заново.
   */
  def closed(
      roster: LotRoster,
      lot: LotId,
      answer: Either[CloseLotRejected, Unit]
  ): (LotRoster, List[LotInstruction]) =
    roster.lots.get(lot) match {
      case Some(LotStanding.Closing) =>
        answer match {
          case Right(()) => (roster.mark(lot, LotStanding.Closed), Nil)
          case Left(_) => ask(roster, List(lot))
        }
      case _ => (roster, Nil)
    }

  /**
   * Ответа на вопрос или команду нет. Лот при этом мог открыться или закрыться: истину даст переспрос, а не догадка.
   */
  def unanswered(roster: LotRoster, lot: LotId): LotRoster =
    roster.lots.get(lot) match {
      case Some(LotStanding.Asked | LotStanding.Opening | LotStanding.Closing) =>
        roster.mark(lot, LotStanding.Unanswered)
      case _ => roster
    }

  private def armed(lot: LotId, deadline: Option[Instant]): List[LotInstruction] =
    deadline.map(LotInstruction.Arm(lot, _)).toList

  private def ask(roster: LotRoster, lots: List[LotId]): (LotRoster, List[LotInstruction]) =
    (lots.foldLeft(roster)(_.mark(_, LotStanding.Asked)), lots.map(LotInstruction.Ask(_)))

  extension (roster: LotRoster) {
    private def mark(lot: LotId, standing: LotStanding): LotRoster = LotRoster(roster.lots.updated(lot, standing))
  }
}
