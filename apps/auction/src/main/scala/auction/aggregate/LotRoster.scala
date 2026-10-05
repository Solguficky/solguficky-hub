package auction.aggregate

import auction.catalog.LotId
import auction.lot.LotState
import auction.lot.OpenLot
import auction.lot.OpenLotRejected

/**
 * Что аукцион знает о лоте реестра в онлайн-торгах. `Asked` и `Opening` — вопрос или команда ушли, ответа ещё нет.
 * `Active` — лот подтвердил открытие; только такой лот аукцион считает активным (И-14). `Declined` — лот отклонил
 * `OpenLot`. `Unanswered` — ответ не пришёл. `Held` и `Closed` названы ради полноты по [[LotState]]: поведение для
 * удержанного и закрытого лота приносит PER-334.
 */
enum LotStanding {
  case Asked
  case Opening
  case Active
  case Declined(reason: OpenLotRejected)
  case Unanswered
  case Held
  case Closed
}

/** Что аукцион должен сделать с лотом: спросить его состояние или открыть. Исполняет инструкцию entity. */
enum LotInstruction {
  case Ask(lot: LotId)
  case Open(lot: LotId, command: OpenLot)
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
 */
final case class LotRoster(lots: Map[LotId, LotStanding]) {

  /** Лоты, подтвердившие открытие. */
  def active: Set[LotId] = lots.collect { case (lot, LotStanding.Active) => lot }.toSet
}

object LotRoster {

  val empty: LotRoster = LotRoster(Map.empty)

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
   */
  def observed(auction: Auction, roster: LotRoster, lot: LotId, state: LotState): (LotRoster, List[LotInstruction]) =
    (auction.state, roster.lots.get(lot)) match {
      case (AuctionState.Prebidding(config, startedBy), Some(LotStanding.Asked)) =>
        state match {
          case LotState.Trading(_) => (roster.mark(lot, LotStanding.Active), Nil)
          case LotState.Held(_) => (roster.mark(lot, LotStanding.Held), Nil)
          case LotState.Sold(_) => (roster.mark(lot, LotStanding.Closed), Nil)
          case LotState.Initial | LotState.Draft | LotState.Scheduled(_) =>
            val open = LotInstruction.Open(lot, OpenLot(config.lotDeadline, startedBy))
            (roster.mark(lot, LotStanding.Opening), List(open))
        }
      case _ => (roster, Nil)
    }

  /** Лот ответил на `OpenLot`: подтверждение делает его активным, отказ — нет, и аукцион никого не ждёт. */
  def opened(roster: LotRoster, lot: LotId, answer: Either[OpenLotRejected, Unit]): LotRoster =
    roster.lots.get(lot) match {
      case Some(LotStanding.Opening) =>
        roster.mark(lot, answer.fold(LotStanding.Declined(_), _ => LotStanding.Active))
      case _ => roster
    }

  /** Ответа на вопрос или команду нет. Лот при этом мог открыться: истину даст следующий опрос, а не догадка. */
  def unanswered(roster: LotRoster, lot: LotId): LotRoster =
    roster.lots.get(lot) match {
      case Some(LotStanding.Asked | LotStanding.Opening) => roster.mark(lot, LotStanding.Unanswered)
      case _ => roster
    }

  private def ask(roster: LotRoster, lots: List[LotId]): (LotRoster, List[LotInstruction]) =
    (lots.foldLeft(roster)(_.mark(_, LotStanding.Asked)), lots.map(LotInstruction.Ask(_)))

  extension (roster: LotRoster) {
    private def mark(lot: LotId, standing: LotStanding): LotRoster = LotRoster(roster.lots.updated(lot, standing))
  }
}
