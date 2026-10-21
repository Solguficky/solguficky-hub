package auction.publication

import auction.contract.InvoiceValues
import auction.contract.LotValues
import auction.invoice.InvoiceEvent
import auction.invoice.InvoiceJournal
import auction.invoice.InvoiceView
import auction.invoice.StoredInvoiceEvent
import auction.v1.auction_events as bus

/**
 * Отображение строки журнала счёта в публичный факт на шине (integration.md, «Счёт на шине»), та же форма, что
 * [[ResultsFacts]]: конверт — `event_id`, счёт, номер события в журнале счёта и время решения, тело — снимок счёта
 * сразу после события. Выбор способа получения — приватный факт: повода у него нет, а номер в журнале он занимает,
 * поэтому `version` на шине монотонна, но не непрерывна.
 */
object InvoiceFacts {

  /** `after` — счёт сразу после события `stored`, свёрнутый из его журнала. */
  def fact(sequence: Long, stored: StoredInvoiceEvent, after: InvoiceView): Option[Fact] =
    occasion(InvoiceJournal.restoreEvent(stored.event)).map { (name, occasion) =>
      val message = bus.InvoiceEvent(
        eventId = stored.eventId.toString,
        invoiceId = after.id.value.toString,
        version = sequence,
        occurredAt = LotValues.instant(stored.occurredAt),
        state = Some(InvoiceValues.state(after)),
        occasion = occasion
      )
      Fact(stored.eventId, LotFacts.SubjectPrefix + name, message.toByteArray)
    }

  /**
   * Повод события и имя его subject'а, как у [[ResultsFacts.occasion]]: match без ветки по умолчанию, и новое событие
   * счёта не скомпилируется, пока ему не решат повод.
   */
  def occasion(event: InvoiceEvent): Option[(String, bus.InvoiceEvent.Occasion)] =
    event match {
      case InvoiceEvent.InvoiceIssued(_) =>
        Some("invoice_issued" -> bus.InvoiceEvent.Occasion.InvoiceIssued(bus.InvoiceIssued()))
      case InvoiceEvent.InvoicePaid(_) =>
        Some("invoice_paid" -> bus.InvoiceEvent.Occasion.InvoicePaid(bus.InvoicePaid()))
      case InvoiceEvent.InvoiceHandedOver(_) =>
        Some("invoice_handed_over" -> bus.InvoiceEvent.Occasion.InvoiceHandedOver(bus.InvoiceHandedOver()))
      case InvoiceEvent.FulfillmentChosen(_, _) => None
    }
}
