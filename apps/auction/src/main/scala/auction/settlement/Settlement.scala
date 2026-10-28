package auction.settlement

import auction.invoice.InvoiceId
import auction.invoice.InvoiceTerms
import auction.lot.*

import java.time.Duration
import java.time.Instant

/** Кандидат существует только при принятой ставке; скрытый лимит не является предложением цены. */
final case class SettlementCandidate(bid: BidId, participant: ParticipantId, amount: Money)

/** Неизменный исход торгов и срок, замороженный при открытии аукциона. */
final case class SettlementSale(invoice: InvoiceId, terms: InvoiceTerms, paymentTerm: Duration)

final case class SettlementInvoice(id: InvoiceId, terms: InvoiceTerms)

/** Идентификатор предложения — id принятой ставки кандидата, уникальный в истории лота. */
final case class SettlementOffer(candidate: SettlementCandidate)

enum OfferOutcome {
  case Pending, Accepted, Declined
}

final case class OfferRecord(offer: SettlementOffer, outcome: OfferOutcome)

enum SettlementStage {
  case AwaitingPayment
  case Closing(opId: OpId)
  case Offering(offer: SettlementOffer)
  case Issuing
  case Unredeemed
}

enum SettlementAction {
  case Close(invoice: InvoiceId)
  case Accept(offer: BidId, participant: ParticipantId)
  case Decline(offer: BidId, participant: ParticipantId)
}

enum SettlementRefusal {
  case SettlementNotFound, StaleInvoice, StaleOffer, OfferNotFound, Busy, OpIdTaken
}

enum ClosureOutcome {
  case Closed, AlreadyPaid, OpIdTaken
}

enum SettlementEvent {
  case Opened(sale: SettlementSale, candidates: List[SettlementCandidate])
  case ClosureRequested(invoice: InvoiceId, opId: OpId)
  case ClosureCompleted(opId: OpId, outcome: ClosureOutcome)
  case OfferDeclined(offer: BidId, participant: ParticipantId, opId: OpId)
  case OfferAccepted(offer: BidId, participant: ParticipantId, invoice: SettlementInvoice, opId: OpId)
  case InvoiceConfirmed(invoice: InvoiceId)
}

enum Settlement {
  case Initial
  case Open(
      sale: SettlementSale,
      remaining: List[SettlementCandidate],
      invoices: List[SettlementInvoice],
      current: SettlementInvoice,
      stage: SettlementStage,
      offers: List[OfferRecord],
      closures: Map[OpId, ClosureOutcome],
      seen: Map[OpId, SettlementAction]
  )
}

object Settlement {

  /**
   * Последние принятые ставки с учётом уже выполненных снятий (решение владельца PER-694: 100, не 910). При снятии цены
   * берутся из пересчитанной истории теми же правилами, что ADR-072. Сам лимит кандидата не создаёт.
   */
  def candidates(events: List[Written], winner: ParticipantId): List[SettlementCandidate] = {
    val (_, latest) = events.foldLeft((Lot.initial, List.empty[SettlementCandidate])) { case ((lot, bids), row) =>
      val after = Lot(lot, row.envelope, row.at)
      val next = row.envelope.event match {
        case LotEvent.BidPlaced(id, participant, amount, _, _, _) =>
          SettlementCandidate(id, participant, amount) :: bids.filterNot(_.participant == participant)
        case removed: LotEvent.ParticipantRemoved =>
          val (config, course) = lot.state match {
            case LotState.Trading(trading) => trading.config -> trading.course
            case LotState.Held(held) => held.config -> held.course
            case _ => throw new IllegalStateException("participant removal outside trading history")
          }
          val history = course.getOrElse(throw new IllegalStateException("participant removal without course"))
          val position = removed.leadingBidId.getOrElse(BidId(row.envelope.opId.value))
          Lot
            .replayedBids(config, history.copy(removed = history.removed + removed.participant), position)
            .flatMap { effective =>
              if (removed.leader.contains(effective.participant))
                removed.leadingBidId.map(id => SettlementCandidate(id, effective.participant, removed.price))
              else
                bids
                  .find(_.participant == effective.participant)
                  .map(previous => previous.copy(amount = effective.amount))
            }
        case _ => bids
      }
      after -> next
    }
    latest.filterNot(_.participant == winner)
  }

  def open(state: Settlement, sale: SettlementSale, candidates: List[SettlementCandidate]): Option[SettlementEvent] =
    state match {
      case Settlement.Initial => Some(SettlementEvent.Opened(sale, candidates))
      case _: Settlement.Open => None
    }

  /** Ответ означает сохранённый запрос. Результат атомарного закрытия счёта читается в closures по op_id. */
  def requestUnredeemed(
      state: Settlement,
      invoice: InvoiceId,
      opId: OpId
  ): Either[SettlementRefusal, Option[SettlementEvent]] =
    decide(state, opId, SettlementAction.Close(invoice)) { active =>
      if (active.current.id != invoice) Left(SettlementRefusal.StaleInvoice)
      else
        active.stage match {
          case SettlementStage.AwaitingPayment => Right(Some(SettlementEvent.ClosureRequested(invoice, opId)))
          case _ => Left(SettlementRefusal.Busy)
        }
    }

  def decline(
      state: Settlement,
      offer: BidId,
      participant: ParticipantId,
      opId: OpId
  ): Either[SettlementRefusal, Option[SettlementEvent]] =
    respond(state, offer, participant, opId, SettlementAction.Decline(offer, participant)) { _ =>
      SettlementEvent.OfferDeclined(offer, participant, opId)
    }

  def accept(
      state: Settlement,
      offer: BidId,
      participant: ParticipantId,
      opId: OpId,
      at: Instant
  ): Either[SettlementRefusal, Option[SettlementEvent]] =
    respond(state, offer, participant, opId, SettlementAction.Accept(offer, participant)) { active =>
      val candidate = active.offers
        .find(_.offer.candidate.bid == offer)
        .map(_.offer.candidate)
        .getOrElse(throw new IllegalStateException("current offer missing from history"))
      val terms = InvoiceTerms.ofSale(
        active.sale.terms.auction,
        active.sale.terms.lot,
        participant,
        candidate.amount,
        at,
        active.sale.paymentTerm
      )
      SettlementEvent.OfferAccepted(offer, participant, SettlementInvoice(InvoiceId.of(offer), terms), opId)
    }

  private def respond(
      state: Settlement,
      offer: BidId,
      participant: ParticipantId,
      opId: OpId,
      action: SettlementAction
  )(event: Settlement.Open => SettlementEvent): Either[SettlementRefusal, Option[SettlementEvent]] =
    state match {
      case active: Settlement.Open
          if !active.offers.exists(record =>
            record.offer.candidate.bid == offer && record.offer.candidate.participant == participant
          ) =>
        Left(SettlementRefusal.OfferNotFound)
      case _ =>
        decide(state, opId, action) { active =>
          active.stage match {
            case SettlementStage.Offering(current) if current.candidate.bid == offer =>
              Right(Some(event(active)))
            case _ => Left(SettlementRefusal.StaleOffer)
          }
        }
    }

  private def decide(state: Settlement, opId: OpId, action: SettlementAction)(
      run: Settlement.Open => Either[SettlementRefusal, Option[SettlementEvent]]
  ): Either[SettlementRefusal, Option[SettlementEvent]] =
    state match {
      case Settlement.Initial => Left(SettlementRefusal.SettlementNotFound)
      case active: Settlement.Open =>
        active.seen.get(opId) match {
          case Some(`action`) => Right(None)
          case Some(_) => Left(SettlementRefusal.OpIdTaken)
          case None => run(active)
        }
    }

  /** Подтверждения старого ask после следующего шага не могут откатить состояние. */
  def closureCompleted(state: Settlement, opId: OpId, outcome: ClosureOutcome): Option[SettlementEvent] =
    state match {
      case active: Settlement.Open if active.stage == SettlementStage.Closing(opId) =>
        Some(SettlementEvent.ClosureCompleted(opId, outcome))
      case _ => None
    }

  def invoiceConfirmed(state: Settlement, invoice: InvoiceId): Option[SettlementEvent] =
    state match {
      case active: Settlement.Open if active.stage == SettlementStage.Issuing && active.current.id == invoice =>
        Some(SettlementEvent.InvoiceConfirmed(invoice))
      case _ => None
    }

  /** Актуальный покупатель отсутствует, пока есть лишь предложение или итог «невыкуплен». */
  def buyer(state: Settlement): Option[ParticipantId] =
    state match {
      case active: Settlement.Open =>
        active.stage match {
          case SettlementStage.AwaitingPayment | SettlementStage.Closing(_) | SettlementStage.Issuing =>
            Some(active.current.terms.winner)
          case SettlementStage.Offering(_) | SettlementStage.Unredeemed => None
        }
      case Settlement.Initial => None
    }

  private def offerNext(active: Settlement.Open): Settlement.Open =
    active.remaining match {
      case next :: rest =>
        val offer = SettlementOffer(next)
        active.copy(
          remaining = rest,
          stage = SettlementStage.Offering(offer),
          offers = active.offers :+ OfferRecord(offer, OfferOutcome.Pending)
        )
      case Nil => active.copy(stage = SettlementStage.Unredeemed)
    }

  def apply(state: Settlement, event: SettlementEvent): Settlement =
    (state, event) match {
      case (Settlement.Initial, SettlementEvent.Opened(sale, candidates)) =>
        val invoice = SettlementInvoice(sale.invoice, sale.terms)
        Settlement.Open(
          sale,
          candidates,
          List(invoice),
          invoice,
          SettlementStage.AwaitingPayment,
          Nil,
          Map.empty,
          Map.empty
        )
      case (active: Settlement.Open, SettlementEvent.ClosureRequested(invoice, opId)) =>
        active.copy(
          stage = SettlementStage.Closing(opId),
          seen = active.seen + (opId -> SettlementAction.Close(invoice))
        )
      case (active: Settlement.Open, SettlementEvent.ClosureCompleted(opId, outcome)) =>
        val after = active.copy(closures = active.closures + (opId -> outcome))
        outcome match {
          case ClosureOutcome.Closed => offerNext(after)
          case ClosureOutcome.AlreadyPaid | ClosureOutcome.OpIdTaken =>
            after.copy(stage = SettlementStage.AwaitingPayment)
        }
      case (active: Settlement.Open, SettlementEvent.OfferDeclined(offer, participant, opId)) =>
        offerNext(
          active.copy(
            offers = active.offers.map(record =>
              if (record.offer.candidate.bid == offer) record.copy(outcome = OfferOutcome.Declined) else record
            ),
            seen = active.seen + (opId -> SettlementAction.Decline(offer, participant))
          )
        )
      case (active: Settlement.Open, SettlementEvent.OfferAccepted(offer, participant, invoice, opId)) =>
        active.copy(
          current = invoice,
          invoices = active.invoices :+ invoice,
          stage = SettlementStage.Issuing,
          offers = active.offers.map(record =>
            if (record.offer.candidate.bid == offer) record.copy(outcome = OfferOutcome.Accepted) else record
          ),
          seen = active.seen + (opId -> SettlementAction.Accept(offer, participant))
        )
      case (active: Settlement.Open, SettlementEvent.InvoiceConfirmed(_)) =>
        active.copy(stage = SettlementStage.AwaitingPayment)
      case _ => throw new IllegalStateException("settlement event does not apply to state")
    }
}
