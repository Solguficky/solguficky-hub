package auction.publication

import auction.aggregate.Auction
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
 *
 * Удалённый до торгов аукцион свёрнут в `Initial`, и снимок после события его не опишет. Поэтому снимок
 * `auction_discarded` — строка до события со статусом `discarded`: сходка, конфигурация и реестр, какими они были.
 */
object AuctionFacts {

  /** `before` — строка до события; нужна только удалению, остальным снимок даёт строка после него. */
  def fact(
      sequence: Long,
      stored: StoredAuctionEvent,
      before: Option[AuctionViewRow],
      after: AuctionViewRow
  ): Option[Fact] = {
    val event = AuctionJournal.restoreEvent(stored.event)
    occasion(event).map { (name, occasion) =>
      val snapshot = event match {
        case AuctionEvent.AuctionDiscarded =>
          before.fold(throw new IllegalStateException(s"auction ${after.auctionId} discarded without a row"))(discarded)
        case _ => state(after)
      }
      val message = bus.AuctionEvent(
        eventId = stored.eventId.toString,
        auctionId = after.auctionId.toString,
        version = sequence,
        occurredAt = LotValues.instant(stored.occurredAt),
        state = Some(snapshot),
        occasion = occasion
      )
      Fact(stored.eventId, LotFacts.SubjectPrefix + name, message.toByteArray)
    }
  }

  /**
   * Повод события и имя его subject'а, как у [[LotFacts.occasion]]: match без ветки по умолчанию, и новое событие
   * аукциона не скомпилируется, пока ему не назначат повод.
   */
  def occasion(event: AuctionEvent): Option[(String, bus.AuctionEvent.Occasion)] =
    event match {
      case AuctionEvent.AuctionDrafted(_, _) =>
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
      case AuctionEvent.FinalLotCompleted(lot) =>
        Some(
          "final_lot_completed" ->
            bus.AuctionEvent.Occasion.FinalLotCompleted(bus.FinalLotCompleted(lot.value.toString))
        )
      case AuctionEvent.AuctionFinished =>
        Some("auction_finished" -> bus.AuctionEvent.Occasion.AuctionFinished(bus.AuctionFinished()))
      case AuctionEvent.AuctionDiscarded =>
        Some("auction_discarded" -> bus.AuctionEvent.Occasion.AuctionDiscarded(bus.AuctionDiscarded()))
      case AuctionEvent.AuctionCancelled =>
        Some("auction_cancelled" -> bus.AuctionEvent.Occasion.AuctionCancelled(bus.AuctionCancelled()))
      // Запущенное окно публикуют его лоты фактом `step_window_added`: окна — данные лота, а не аукциона (ADR-047,
      // дополнение 2026-10-12).
      case AuctionEvent.StepWindowLaunched(_) => None
      // Видимость — факт аукциона: по нему Notifications сообщает о новом аукционе и снимает неотправленную весть
      // (ADR-047, дополнение 2026-10-20; PER-646).
      case AuctionEvent.AuctionPublished =>
        Some("auction_published" -> bus.AuctionEvent.Occasion.AuctionPublished(bus.AuctionPublished()))
      case AuctionEvent.AuctionHidden =>
        Some("auction_hidden" -> bus.AuctionEvent.Occasion.AuctionHidden(bus.AuctionHidden()))
      // Ориентировочное время финала — подпись для экрана зала и бота хаба, а не повод для шины (ADR-040, дополнение
      // 2026-10-19).
      case AuctionEvent.FinalTimeSet(_) | AuctionEvent.FinalTimeCleared => None
    }

  /** Публичное состояние аукциона: сходка, конфигурация, реестр по возрастанию `lot_id` и статус. */
  def state(row: AuctionViewRow): bus.AuctionState = {
    val auction = AuctionJournal.restoreAuction(row.stored)
    val base = described(row, auction)
    auction.state match {
      case AuctionState.Initial =>
        throw new IllegalStateException(s"auction ${row.auctionId} published without being drafted")
      case AuctionState.Draft => base.withDraft(bus.AuctionState.Draft())
      case AuctionState.Scheduled(_) => base.withScheduled(bus.AuctionState.Scheduled())
      case AuctionState.Prebidding(_, _) => base.withPrebidding(bus.AuctionState.Prebidding())
      case AuctionState.Settling(_, _) => base.withSettling(bus.AuctionState.Settling())
      case AuctionState.Break(_, _) => base.withOnBreak(bus.AuctionState.Break())
      case AuctionState.LineupFrozen(_, _, order) => base.withLineupFrozen(AuctionValues.lineupFrozen(order))
      case final_ @ AuctionState.Final(_, _, order, _, _) =>
        base.withInFinal(AuctionValues.inFinal(order, final_.activeLot))
      case AuctionState.Finished(_, _) => base.withFinished(bus.AuctionState.Finished())
      case AuctionState.Cancelled(_, _, _) => base.withCancelled(bus.AuctionState.Cancelled())
    }
  }

  /** Снимок удалённого аукциона: строка до удаления со статусом `discarded`. */
  private def discarded(before: AuctionViewRow): bus.AuctionState =
    described(before, AuctionJournal.restoreAuction(before.stored)).withDiscarded(bus.AuctionState.Discarded())

  private def described(row: AuctionViewRow, auction: Auction): bus.AuctionState = {
    // Конфигурация есть с планирования: у `Scheduled` — своя, с открытия торгов — замороженная.
    val config = auction.state match {
      case AuctionState.Scheduled(config) => Some(config)
      case other => other.started.map((config, _) => config)
    }
    bus.AuctionState(
      id = row.auctionId.toString,
      config = config.map(AuctionValues.config),
      lotIds = auction.lots.toList.map(_.value).sorted.map(_.toString),
      meetupId = row.meetupId.toString,
      // Признак скрытия шина несёт полем, а не поводом: без него снимок показывал бы видимость до следующего факта
      // аукциона (ADR-047, дополнение 2026-10-20).
      hidden = auction.hidden
    )
  }
}
