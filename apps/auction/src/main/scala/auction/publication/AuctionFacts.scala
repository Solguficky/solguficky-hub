package auction.publication

import auction.aggregate.AuctionEvent
import auction.aggregate.AuctionState
import auction.contract.AuctionValues
import auction.contract.LotValues
import auction.entity.AuctionJournal
import auction.entity.StoredAuctionEvent
import auction.projection.AuctionViewRow
import auction.v1.auction_events as bus

/**
 * Отображение строки журнала аукциона в публичный факт на шине (integration.md, «Аукцион на шине»), та же форма, что
 * [[LotFacts]]: конверт — `event_id`, аукцион, номер события и время решения, тело — снимок аукциона сразу после
 * события. Финалистов снимок не называет до заморозки состава: статусы `prebidding`, `settling` и `on_break` пустые.
 */
object AuctionFacts {

  def fact(sequence: Long, stored: StoredAuctionEvent, row: AuctionViewRow): Option[Fact] =
    occasion(AuctionJournal.restoreEvent(stored.event)).map { (name, occasion) =>
      val message = bus.AuctionEvent(
        eventId = stored.eventId.toString,
        auctionId = row.auctionId.toString,
        version = sequence,
        occurredAt = LotValues.instant(stored.occurredAt),
        state = Some(state(row)),
        occasion = occasion
      )
      Fact(stored.eventId, LotFacts.SubjectPrefix + name, message.toByteArray)
    }

  /**
   * Повод события и имя его subject'а, как у [[LotFacts.occasion]]: match без ветки по умолчанию, и новое событие
   * аукциона не скомпилируется, пока ему не назначат повод. Удаление до торгов поводом не стало: в контракте ветки нет,
   * а подписчика у аукциона без торгов не заявлено.
   */
  def occasion(event: AuctionEvent): Option[(String, bus.AuctionEvent.Occasion)] =
    event match {
      case AuctionEvent.AuctionDrafted(_) =>
        Some("auction_drafted" -> bus.AuctionEvent.Occasion.AuctionDrafted(bus.AuctionDrafted()))
      case AuctionEvent.AuctionScheduled(_) =>
        Some("auction_scheduled" -> bus.AuctionEvent.Occasion.AuctionScheduled(bus.AuctionScheduled()))
      case AuctionEvent.LotAdded(lot) =>
        Some("lot_added" -> bus.AuctionEvent.Occasion.LotAdded(bus.LotAdded(lot.value.toString)))
      case AuctionEvent.LotRemoved(lot) =>
        Some("lot_removed" -> bus.AuctionEvent.Occasion.LotRemoved(bus.LotRemoved(lot.value.toString)))
      case AuctionEvent.PrebiddingStarted =>
        Some("prebidding_started" -> bus.AuctionEvent.Occasion.PrebiddingStarted(bus.PrebiddingStarted()))
      case AuctionEvent.PrebiddingDeadlineReached =>
        Some(
          "prebidding_deadline_reached" ->
            bus.AuctionEvent.Occasion.PrebiddingDeadlineReached(bus.PrebiddingDeadlineReached())
        )
      case AuctionEvent.PrebiddingEnded(_) =>
        Some("prebidding_ended" -> bus.AuctionEvent.Occasion.PrebiddingEnded(bus.PrebiddingEnded()))
      case AuctionEvent.FinalLineupFrozen(_) =>
        Some("final_lineup_frozen" -> bus.AuctionEvent.Occasion.FinalLineupFrozen(bus.FinalLineupFrozen()))
      case AuctionEvent.FinalStarted =>
        Some("final_started" -> bus.AuctionEvent.Occasion.FinalStarted(bus.FinalStarted()))
      case AuctionEvent.FinalLotActivated(_) =>
        Some("final_lot_activated" -> bus.AuctionEvent.Occasion.FinalLotActivated(bus.FinalLotActivated()))
      case AuctionEvent.AuctionDiscarded => None
    }

  /** Публичное состояние аукциона: сходка, конфигурация, реестр по возрастанию `lot_id` и статус. */
  def state(row: AuctionViewRow): bus.AuctionState = {
    val auction = AuctionJournal.restoreAuction(row.stored)
    // Конфигурация есть с планирования: у `Scheduled` — своя, с открытия торгов — замороженная.
    val config = auction.state match {
      case AuctionState.Scheduled(config) => Some(config)
      case other => other.started.map((config, _) => config)
    }
    val base = bus.AuctionState(
      id = row.auctionId.toString,
      config = config.map(AuctionValues.config),
      lotIds = auction.lots.toList.map(_.value).sorted.map(_.toString),
      meetupId = row.meetupId.toString
    )
    auction.state match {
      case AuctionState.Initial =>
        throw new IllegalStateException(s"auction ${row.auctionId} published without being drafted")
      case AuctionState.Draft => base.withDraft(bus.AuctionState.Draft())
      case AuctionState.Scheduled(_) => base.withScheduled(bus.AuctionState.Scheduled())
      case AuctionState.Prebidding(_, _) => base.withPrebidding(bus.AuctionState.Prebidding())
      case AuctionState.Settling(_, _) => base.withSettling(bus.AuctionState.Settling())
      case AuctionState.Break(_, _) => base.withOnBreak(bus.AuctionState.Break())
      case AuctionState.LineupFrozen(_, _, order) => base.withLineupFrozen(AuctionValues.lineupFrozen(order))
      case AuctionState.Final(_, _, order, activated) => base.withInFinal(AuctionValues.inFinal(order, activated))
      case AuctionState.Finished(_, _) => base.withFinished(bus.AuctionState.Finished())
    }
  }
}
