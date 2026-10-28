package auction.settlement

import auction.entity.JournalCorrupted
import auction.entity.JournalSerializable
import auction.entity.LotJournal
import auction.entity.StoredMoney
import auction.invoice.InvoiceId
import auction.invoice.InvoiceTerms
import auction.invoice.StoredInvoiceIssued
import auction.lot.*

import java.time.Duration
import java.time.Instant
import java.util.UUID

final case class StoredSettlementCandidate(bidId: UUID, participantId: UUID, amount: StoredMoney)
final case class StoredSettlementOpened(
    invoiceId: UUID,
    terms: StoredInvoiceIssued,
    paymentTerm: Duration,
    candidates: List[StoredSettlementCandidate]
)
final case class StoredSettlementClosure(invoiceId: UUID, opId: UUID)
final case class StoredSettlementClosed(opId: UUID, closed: Boolean)
final case class StoredSettlementResponse(
    offerId: UUID,
    participantId: UUID,
    opId: UUID,
    invoiceId: Option[UUID],
    terms: Option[StoredInvoiceIssued]
)

/** Модель хранения отдельна от домена; ровно одна секция соответствует kind (ADR-058). */
final case class StoredSettlementEvent(
    eventId: UUID,
    occurredAt: Instant,
    kind: String,
    opened: Option[StoredSettlementOpened] = None,
    closure: Option[StoredSettlementClosure] = None,
    closed: Option[StoredSettlementClosed] = None,
    response: Option[StoredSettlementResponse] = None,
    confirmed: Option[UUID] = None
) extends JournalSerializable

object SettlementJournal {

  private def terms(value: InvoiceTerms): StoredInvoiceIssued =
    StoredInvoiceIssued(
      value.auction.value,
      value.lot.value,
      value.winner.value,
      LotJournal.storeMoney(value.amount),
      value.paymentDueAt
    )

  private def restore(value: StoredInvoiceIssued): InvoiceTerms =
    InvoiceTerms(
      AuctionId(value.auctionId),
      auction.catalog.LotId(value.lotId),
      ParticipantId(value.winnerId),
      LotJournal.restoreMoney(value.amount),
      value.paymentDueAt
    )

  def store(id: UUID, at: Instant)(event: SettlementEvent): StoredSettlementEvent = {
    val empty = StoredSettlementEvent(id, at, "")
    event match {
      case SettlementEvent.Opened(sale, candidates) =>
        empty.copy(
          kind = "Opened",
          opened = Some(
            StoredSettlementOpened(
              sale.invoice.value,
              terms(sale.terms),
              sale.paymentTerm,
              candidates.map(candidate =>
                StoredSettlementCandidate(
                  candidate.bid.value,
                  candidate.participant.value,
                  LotJournal.storeMoney(candidate.amount)
                )
              )
            )
          )
        )
      case SettlementEvent.ClosureRequested(invoice, op) =>
        empty.copy(kind = "ClosureRequested", closure = Some(StoredSettlementClosure(invoice.value, op.value)))
      case SettlementEvent.ClosureCompleted(op, closed) =>
        empty.copy(kind = "ClosureCompleted", closed = Some(StoredSettlementClosed(op.value, closed)))
      case SettlementEvent.OfferDeclined(offer, participant, op) =>
        empty.copy(
          kind = "OfferDeclined",
          response = Some(StoredSettlementResponse(offer.value, participant.value, op.value, None, None))
        )
      case SettlementEvent.OfferAccepted(offer, participant, invoice, op) =>
        empty.copy(
          kind = "OfferAccepted",
          response = Some(
            StoredSettlementResponse(
              offer.value,
              participant.value,
              op.value,
              Some(invoice.id.value),
              Some(terms(invoice.terms))
            )
          )
        )
      case SettlementEvent.InvoiceConfirmed(invoice) =>
        empty.copy(kind = "InvoiceConfirmed", confirmed = Some(invoice.value))
    }
  }

  def restore(event: StoredSettlementEvent): SettlementEvent =
    event match {
      case StoredSettlementEvent(_, _, "Opened", Some(value), None, None, None, None) =>
        SettlementEvent.Opened(
          SettlementSale(InvoiceId(value.invoiceId), restore(value.terms), value.paymentTerm),
          value.candidates.map(candidate =>
            SettlementCandidate(
              BidId(candidate.bidId),
              ParticipantId(candidate.participantId),
              LotJournal.restoreMoney(candidate.amount)
            )
          )
        )
      case StoredSettlementEvent(_, _, "ClosureRequested", None, Some(value), None, None, None) =>
        SettlementEvent.ClosureRequested(InvoiceId(value.invoiceId), OpId(value.opId))
      case StoredSettlementEvent(_, _, "ClosureCompleted", None, None, Some(value), None, None) =>
        SettlementEvent.ClosureCompleted(OpId(value.opId), value.closed)
      case StoredSettlementEvent(
            _,
            _,
            "OfferDeclined",
            None,
            None,
            None,
            Some(StoredSettlementResponse(offer, participant, op, None, None)),
            None
          ) =>
        SettlementEvent.OfferDeclined(BidId(offer), ParticipantId(participant), OpId(op))
      case StoredSettlementEvent(
            _,
            _,
            "OfferAccepted",
            None,
            None,
            None,
            Some(StoredSettlementResponse(offer, participant, op, Some(invoice), Some(value))),
            None
          ) =>
        SettlementEvent.OfferAccepted(
          BidId(offer),
          ParticipantId(participant),
          SettlementInvoice(InvoiceId(invoice), restore(value)),
          OpId(op)
        )
      case StoredSettlementEvent(_, _, "InvoiceConfirmed", None, None, None, None, Some(invoice)) =>
        SettlementEvent.InvoiceConfirmed(InvoiceId(invoice))
      case _ => throw new JournalCorrupted("settlement event kind and sections do not match")
    }
}
