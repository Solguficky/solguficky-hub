package auction.publication

import auction.contract.LotValues
import auction.entity.LotJournal
import auction.lot.BidOrigin
import auction.lot.LotEvent
import auction.lot.LotState
import auction.projection.AppliedEvent
import auction.projection.LotViewRow
import auction.v1.auction as model
import auction.v1.auction_events as bus

import java.util.UUID

/** Факт к публикации: ключ дедупликации, subject и тело `auction.v1.LotEvent`. */
final case class LotFact(eventId: UUID, subject: String, payload: Array[Byte])

/**
 * Отображение строки журнала лота в публичный факт на шине (integration.md, «Auction NATS»).
 *
 * Конверт шины — не строка журнала: наружу выходят `event_id`, лот, номер события и время решения, а операция,
 * транзакция и актор остаются в сервисе. Тело — снимок состояния после события, а не дельта, поэтому факт строится из
 * строки лота, которую свёртка получила сразу после этого события.
 *
 * Приватные события — прокси-лимиты — фактом не становятся, но номер в журнале занимают: пропуск `version` на шине не
 * означает потерю.
 */
object LotFacts {

  val SubjectPrefix: String = "events.auction."

  def fact(applied: AppliedEvent): Option[LotFact] =
    occasion(LotJournal.envelope(applied.sequence, applied.stored).event).map { (name, occasion) =>
      val message = bus.LotEvent(
        eventId = applied.stored.eventId.toString,
        lotId = applied.row.lotId.toString,
        version = applied.sequence,
        occurredAt = LotValues.instant(applied.stored.occurredAt),
        state = Some(state(applied.row)),
        occasion = occasion
      )
      LotFact(applied.stored.eventId, SubjectPrefix + name, message.toByteArray)
    }

  /**
   * Повод события и имя его subject'а: `events.auction.` плюс имя ветки `oneof occasion`. Match без ветки по умолчанию
   * намеренно: новое событие домена — закрытие лота, снятие — не скомпилируется, пока ему не назначат повод или не
   * признают приватным.
   */
  def occasion(event: LotEvent): Option[(String, bus.LotEvent.Occasion)] =
    event match {
      case LotEvent.LotDrafted(_) => Some("lot_drafted" -> bus.LotEvent.Occasion.LotDrafted(bus.LotDrafted()))
      case LotEvent.LotScheduled(_) => Some("lot_scheduled" -> bus.LotEvent.Occasion.LotScheduled(bus.LotScheduled()))
      case LotEvent.LotOpened(_, _, _) => Some("lot_opened" -> bus.LotEvent.Occasion.LotOpened(bus.LotOpened()))
      case LotEvent.BidPlaced(_, _, _, previousLeader, origin) =>
        val placed = bus.BidPlaced(
          previousLeaderId = previousLeader.map(_.value.toString),
          origin = origin match {
            case BidOrigin.Manual(source) => bus.BidPlaced.Origin.Manual(bus.ManualBid(LotValues.bidSource(source)))
            case BidOrigin.Proxy => bus.BidPlaced.Origin.Proxy(bus.ProxyBid())
          }
        )
        Some("bid_placed" -> bus.LotEvent.Occasion.BidPlaced(placed))
      case LotEvent.ProxyLimitSet(_, _) | LotEvent.ProxyLimitWithdrawn(_) => None
    }

  /** Публичное состояние лота: без прокси-лимитов и без того, что снимок ответа считает для одного смотрящего. */
  def state(row: LotViewRow): bus.LotState = {
    val base = bus.LotState(id = row.lotId.toString, auctionId = row.auctionId.toString)
    LotJournal.restoreLot(row.stored).state match {
      case LotState.Initial =>
        throw new IllegalStateException(s"lot ${row.lotId} published before it was drafted")
      case LotState.Draft => base.withDraft(model.LotDraft())
      case LotState.Scheduled(schedule) =>
        base
          .withConfig(LotValues.config(schedule.config))
          .withScheduled(model.LotSchedule(Some(LotValues.money(schedule.startingPrice))))
      case LotState.Trading(trading) =>
        base.withConfig(LotValues.config(trading.config)).withTrading(LotValues.trading(trading))
      case LotState.Held(held) => base.withConfig(LotValues.config(held.config)).withHeld(LotValues.held(held))
      case LotState.Sold(sale) => base.withSold(LotValues.sale(sale))
    }
  }
}
