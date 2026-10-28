package auction.contract

import auction.invoice.FulfillmentMethod
import auction.invoice.InvoiceStatus
import auction.invoice.InvoiceView
import auction.v1.auction as model
import auction.v1.auction_events as bus
import auction.v1.auction_service as wire

/**
 * Значения счёта в типах контракта — как [[LotValues]] у лота: состояние факта шины `InvoiceState` и снимок чтения
 * `InvoiceSnapshot` повторяют друг друга поле в поле, кроме способа получения — его несёт только чтение.
 */
object InvoiceValues {

  def state(view: InvoiceView): bus.InvoiceState =
    bus.InvoiceState(
      id = view.id.value.toString,
      auctionId = view.terms.auction.value.toString,
      lotId = view.terms.lot.value.toString,
      winnerId = view.terms.winner.value.toString,
      amount = Some(LotValues.money(view.terms.amount)),
      paymentDueAt = LotValues.instant(view.terms.paymentDueAt),
      status = view.status match {
        case InvoiceStatus.AwaitingPayment =>
          bus.InvoiceState.Status.AwaitingPayment(bus.InvoiceState.AwaitingPayment())
        case InvoiceStatus.Paid => bus.InvoiceState.Status.Paid(bus.InvoiceState.Paid())
        case InvoiceStatus.HandedOver => bus.InvoiceState.Status.HandedOver(bus.InvoiceState.HandedOver())
        case InvoiceStatus.Unredeemed => bus.InvoiceState.Status.Empty
      }
    )

  def snapshot(view: InvoiceView): wire.InvoiceSnapshot =
    wire.InvoiceSnapshot(
      id = view.id.value.toString,
      auctionId = view.terms.auction.value.toString,
      lotId = view.terms.lot.value.toString,
      winnerId = view.terms.winner.value.toString,
      amount = Some(LotValues.money(view.terms.amount)),
      paymentDueAt = LotValues.instant(view.terms.paymentDueAt),
      fulfillment = view.fulfillment.fold(model.FulfillmentMethod.FULFILLMENT_METHOD_UNSPECIFIED)(method),
      status = view.status match {
        case InvoiceStatus.AwaitingPayment =>
          wire.InvoiceSnapshot.Status.AwaitingPayment(bus.InvoiceState.AwaitingPayment())
        case InvoiceStatus.Paid => wire.InvoiceSnapshot.Status.Paid(bus.InvoiceState.Paid())
        case InvoiceStatus.HandedOver => wire.InvoiceSnapshot.Status.HandedOver(bus.InvoiceState.HandedOver())
        case InvoiceStatus.Unredeemed => wire.InvoiceSnapshot.Status.Empty
      }
    )

  def method(value: FulfillmentMethod): model.FulfillmentMethod =
    value match {
      case FulfillmentMethod.Pickup => model.FulfillmentMethod.FULFILLMENT_METHOD_PICKUP
      case FulfillmentMethod.Delivery => model.FulfillmentMethod.FULFILLMENT_METHOD_DELIVERY
      case FulfillmentMethod.Digital => model.FulfillmentMethod.FULFILLMENT_METHOD_DIGITAL
    }
}
