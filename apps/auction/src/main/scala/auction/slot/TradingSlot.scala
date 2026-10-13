package auction.slot

import auction.lot.AuctionId

/**
 * Слот торгов сообщества (ADR-047, дополнение 2026-10-12): в сообществе торги открыты не больше чем у одного аукциона.
 * `Free` — слот никем не занят; `Held` — его занял аукцион, решивший открыть торги.
 */
enum SlotState {
  case Free
  case Held(auction: AuctionId)
}

enum SlotEvent {
  case SlotTaken(auction: AuctionId)
  case SlotReleased(auction: AuctionId)
}

/**
 * Шаг занятия. `Granted` — слот отдан просящему; `events` пусты, если он уже держит слот («занят тобой»). `AskHolder` —
 * слот держит другой аукцион, и слот спрашивает его, идут ли у него торги: своей записи слот слепо не верит.
 */
enum ClaimStep {
  case Granted(events: List[SlotEvent])
  case AskHolder(holder: AuctionId)
}

/**
 * Чистое ядро слота: решение и применение без актора, журнала и часов. Окна `op_id` у слота нет — занятие и
 * освобождение идемпотентны по `auction_id`, как требует дополнение ADR-047.
 */
final case class TradingSlot(state: SlotState)

object TradingSlot {

  val initial: TradingSlot = TradingSlot(SlotState.Free)

  def claim(slot: TradingSlot, auction: AuctionId): ClaimStep =
    slot.state match {
      case SlotState.Free => ClaimStep.Granted(List(SlotEvent.SlotTaken(auction)))
      case SlotState.Held(holder) if holder == auction => ClaimStep.Granted(Nil)
      case SlotState.Held(holder) => ClaimStep.AskHolder(holder)
    }

  /**
   * Держатель ответил, идут ли у него торги. Занят — отказ с держателем; свободен — открытие не записалось, аукцион
   * закончился или освобождение потерялось, и слот переходит к просящему одной записью. Если слот успел смениться,
   * решение принимается заново по текущему состоянию, и ответ прежнего держателя ничего не значит.
   */
  def answered(
      slot: TradingSlot,
      auction: AuctionId,
      holder: AuctionId,
      busy: Boolean
  ): Either[AuctionId, List[SlotEvent]] =
    claim(slot, auction) match {
      case ClaimStep.Granted(events) => Right(events)
      case ClaimStep.AskHolder(current) if current == holder =>
        if (busy) Left(holder) else Right(List(SlotEvent.SlotReleased(holder), SlotEvent.SlotTaken(auction)))
      case ClaimStep.AskHolder(current) => Left(current)
    }

  /** Освобождает только держатель; освобождение чужим или свободного слота ничего не пишет. */
  def release(slot: TradingSlot, auction: AuctionId): List[SlotEvent] =
    slot.state match {
      case SlotState.Held(holder) if holder == auction => List(SlotEvent.SlotReleased(auction))
      case SlotState.Held(_) | SlotState.Free => Nil
    }

  def apply(slot: TradingSlot, event: SlotEvent): TradingSlot =
    event match {
      case SlotEvent.SlotTaken(auction) => TradingSlot(SlotState.Held(auction))
      case SlotEvent.SlotReleased(auction) if slot.state == SlotState.Held(auction) => TradingSlot(SlotState.Free)
      case SlotEvent.SlotReleased(_) => slot
    }
}
