package auction.publication

import auction.contract.LotValues
import auction.entity.Initiator
import auction.entity.LotJournal
import auction.lot.BidOrigin
import auction.lot.LotEvent
import auction.lot.LotState
import auction.lot.ParticipantId
import auction.lot.Phase
import auction.lot.StepWindow
import auction.projection.AppliedEvent
import auction.projection.LotViewRow
import auction.v1.auction as model
import auction.v1.auction_events as bus

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

  /** Факты свёртки по порядку: строка до каждого события — строка после предыдущего, а до первого — `before`. */
  def facts(before: Option[LotViewRow], applied: List[AppliedEvent]): List[Fact] =
    applied.zip(before :: applied.map(step => Some(step.row))).flatMap((step, previous) => fact(step, previous))

  /** Факт одного события; `before` — строка лота до него, из неё повод снятия берёт прежнего лидера. */
  def fact(applied: AppliedEvent, before: Option[LotViewRow]): Option[Fact] =
    occasion(
      LotJournal.envelope(applied.sequence, applied.stored).event,
      LotJournal.restoreInitiator(applied.stored.actor),
      before.flatMap(leaderOf)
    ).map { (name, occasion) =>
      val message = bus.LotEvent(
        eventId = applied.stored.eventId.toString,
        lotId = applied.row.lotId.toString,
        version = applied.sequence,
        occurredAt = LotValues.instant(applied.stored.occurredAt),
        state = Some(state(applied.row)),
        occasion = occasion
      )
      Fact(applied.stored.eventId, SubjectPrefix + name, message.toByteArray)
    }

  /**
   * Повод события и имя его subject'а: `events.auction.` плюс имя ветки `oneof occasion`. Match без ветки по умолчанию
   * намеренно: новое событие домена — закрытие лота, снятие — не скомпилируется, пока ему не назначат повод или не
   * признают приватным.
   *
   * `initiator` — тот, чья команда записала событие: производная ставка, поставленная не командой самого участника,
   * отвечает другому (`answers_other_bidder`, PER-473). Флаг выводится из конверта, а не хранится в событии:
   * производную ставку пишут только ставка и прокси-лимит, а их инициатор — всегда участник.
   *
   * `previousLeader` — лидер лота до события. Его берёт только снятие участника (ADR-072, п. 5): ставка несёт прежнего
   * лидера в самом событии, а снятие — нет, его итог — уже новый лидер.
   */
  def occasion(
      event: LotEvent,
      initiator: Initiator,
      previousLeader: => Option[ParticipantId]
  ): Option[(String, bus.LotEvent.Occasion)] =
    event match {
      case LotEvent.LotDrafted(_) => Some("lot_drafted" -> bus.LotEvent.Occasion.LotDrafted(bus.LotDrafted()))
      case LotEvent.LotScheduled(_) => Some("lot_scheduled" -> bus.LotEvent.Occasion.LotScheduled(bus.LotScheduled()))
      case _: LotEvent.LotOpened => Some("lot_opened" -> bus.LotEvent.Occasion.LotOpened(bus.LotOpened()))
      case LotEvent.BidPlaced(_, participant, _, previousLeader, origin, overtakenByProxy) =>
        val placed = bus.BidPlaced(
          previousLeaderId = previousLeader.map(_.value.toString),
          origin = origin match {
            case BidOrigin.Manual(source) => bus.BidPlaced.Origin.Manual(bus.ManualBid(LotValues.bidSource(source)))
            case BidOrigin.Proxy => bus.BidPlaced.Origin.Proxy(bus.ProxyBid())
          },
          overtakenByProxy = overtakenByProxy,
          answersOtherBidder = origin == BidOrigin.Proxy && initiator != Initiator.Participant(participant)
        )
        Some("bid_placed" -> bus.LotEvent.Occasion.BidPlaced(placed))
      case LotEvent.DeadlineExtended(_, _) =>
        Some("deadline_extended" -> bus.LotEvent.Occasion.DeadlineExtended(bus.DeadlineExtended()))
      case LotEvent.LotSold(_, _, _, _) => Some("lot_sold" -> bus.LotEvent.Occasion.LotSold(bus.LotSold()))
      case LotEvent.LotUnsold(_) => Some("lot_unsold" -> bus.LotEvent.Occasion.LotUnsold(bus.LotUnsold()))
      case LotEvent.LotHeldForFinal(_) =>
        Some("lot_held_for_final" -> bus.LotEvent.Occasion.LotHeldForFinal(bus.LotHeldForFinal()))
      case LotEvent.LotResumed => Some("lot_resumed" -> bus.LotEvent.Occasion.LotResumed(bus.LotResumed()))
      case LotEvent.AskAdvanced(_) => Some("ask_advanced" -> bus.LotEvent.Occasion.AskAdvanced(bus.AskAdvanced()))
      case LotEvent.LotWithdrawn(_) =>
        Some("lot_withdrawn" -> bus.LotEvent.Occasion.LotWithdrawn(bus.LotWithdrawn()))
      case LotEvent.StepWindowAdded(_) =>
        Some("step_window_added" -> bus.LotEvent.Occasion.StepWindowAdded(bus.StepWindowAdded()))
      // Замена и снятие окна периода — один повод: итог несёт снимок, а что было до него, факт не говорит (PER-786).
      case LotEvent.PeriodWindowSet(_) | LotEvent.PeriodWindowCleared(_) =>
        Some("step_window_changed" -> bus.LotEvent.Occasion.StepWindowChanged(bus.StepWindowChanged()))
      // Отметка — рабочий выбор организатора до заморозки состава: публичным факт становится только удержание.
      case LotEvent.ProxyLimitSet(_, _) | LotEvent.ProxyLimitWithdrawn(_) | LotEvent.LotMarkedForFinal |
          LotEvent.LotUnmarkedForFinal =>
        None
      // Кого сняли, кто и почему, факт не несёт: снимок называет нового лидера, повод — прежнего (ADR-072, п. 5).
      case LotEvent.ParticipantRemoved(_, _, _, _) =>
        val removed = bus.ParticipantRemoved(previousLeaderId = previousLeader.map(_.value.toString))
        Some("participant_removed" -> bus.LotEvent.Occasion.ParticipantRemoved(removed))
    }

  private def leaderOf(row: LotViewRow): Option[ParticipantId] =
    LotJournal.restoreLot(row.stored).state match {
      case LotState.Trading(trading) => trading.leader
      case LotState.Held(held) => held.leader
      case _ => None
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
        base
          .withConfig(LotValues.config(trading.config))
          .withTrading(LotValues.trading(trading))
          // Окна действуют только в онлайн-фазе: живой финал их не несёт (ADR-047, П-03), и публикатор
          // держит это обещание схемы, а не полагается на форму состояния.
          .withStepWindows(if (trading.phase == Phase.Online) trading.stepWindows.map(stepWindow) else Nil)
      case LotState.Held(held) => base.withConfig(LotValues.config(held.config)).withHeld(LotValues.held(held))
      case LotState.Sold(sale) => base.withSold(LotValues.sale(sale))
      case LotState.Unsold(reason) => base.withUnsold(LotValues.unsold(reason))
      case LotState.Withdrawn(reason) => base.withWithdrawn(LotValues.withdrawn(reason))
    }
  }

  /**
   * Окно лота как данные факта: записанный полуинтервал `[from, until)`, его шаг и стартовая цена, если заданы, и
   * период «Счастливых часов», если окно — условия лота в нём.
   */
  private def stepWindow(window: StepWindow): bus.StepWindow =
    bus.StepWindow(
      from = LotValues.instant(window.from),
      until = LotValues.instant(window.until),
      step = window.step.map(LotValues.money),
      start = window.start.map(LotValues.money),
      happyHourPeriodId = window.period.fold("")(_.value.toString)
    )
}
