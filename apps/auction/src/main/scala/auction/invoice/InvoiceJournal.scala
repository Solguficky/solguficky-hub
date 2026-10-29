package auction.invoice

import auction.catalog.LotId
import auction.entity.JournalCorrupted
import auction.entity.JournalSerializable
import auction.entity.LotJournal
import auction.entity.StoredMoney
import auction.lot.AuctionId
import auction.lot.OpId
import auction.lot.ParticipantId
import com.fasterxml.jackson.annotation.JsonInclude

import java.time.Instant
import java.util.UUID

/*
 * Модель хранения счёта (ADR-058) — та же форма, что у итогов и розыгрыша: доменные типы в базу не пишутся, имя класса
 * — manifest строки, имена полей — ключи JSON, вариант — поле `kind` и не больше одной заполненной секции. Snapshot у
 * счёта нет: журнал из нескольких строк, и восстановление идёт только по ним.
 */

/** Payload `InvoiceIssued`: условия счёта целиком. */
final case class StoredInvoiceIssued(
    auctionId: UUID,
    lotId: UUID,
    winnerId: UUID,
    amount: StoredMoney,
    paymentDueAt: Instant
)

/** Payload отметок оплаты и выдачи: `op_id` команды организатора. */
final case class StoredInvoiceMark(opId: UUID)

/** Payload `FulfillmentChosen`: способ — `Pickup`, `Delivery` или `Digital` — и `op_id` команды победителя. */
final case class StoredFulfillmentChosen(method: String, opId: UUID)

final case class StoredInvoiceEventBody(
    kind: String,
    invoiceIssued: Option[StoredInvoiceIssued],
    invoicePaid: Option[StoredInvoiceMark],
    invoiceHandedOver: Option[StoredInvoiceMark],
    fulfillmentChosen: Option[StoredFulfillmentChosen],
    @JsonInclude(JsonInclude.Include.NON_ABSENT) invoiceUnredeemed: Option[StoredInvoiceMark] = None
)

/** Строка журнала счёта. Счёт строки — её `persistence_id`. */
final case class StoredInvoiceEvent(eventId: UUID, occurredAt: Instant, event: StoredInvoiceEventBody)
    extends JournalSerializable

object InvoiceJournal {

  private val empty = StoredInvoiceEventBody("", None, None, None, None)

  def store(eventId: UUID, occurredAt: Instant)(event: InvoiceEvent): StoredInvoiceEvent =
    StoredInvoiceEvent(eventId, occurredAt, storeEvent(event))

  def storeEvent(event: InvoiceEvent): StoredInvoiceEventBody =
    event match {
      case InvoiceEvent.InvoiceIssued(terms) =>
        empty.copy(
          kind = "InvoiceIssued",
          invoiceIssued = Some(
            StoredInvoiceIssued(
              terms.auction.value,
              terms.lot.value,
              terms.winner.value,
              LotJournal.storeMoney(terms.amount),
              terms.paymentDueAt
            )
          )
        )
      case InvoiceEvent.InvoicePaid(opId) =>
        empty.copy(kind = "InvoicePaid", invoicePaid = Some(StoredInvoiceMark(opId.value)))
      case InvoiceEvent.InvoiceHandedOver(opId) =>
        empty.copy(kind = "InvoiceHandedOver", invoiceHandedOver = Some(StoredInvoiceMark(opId.value)))
      case InvoiceEvent.InvoiceUnredeemed(opId) =>
        empty.copy(kind = "InvoiceUnredeemed", invoiceUnredeemed = Some(StoredInvoiceMark(opId.value)))
      case InvoiceEvent.FulfillmentChosen(method, opId) =>
        empty.copy(
          kind = "FulfillmentChosen",
          fulfillmentChosen = Some(StoredFulfillmentChosen(methodName(method), opId.value))
        )
    }

  /** Ровно та секция, что названа `kind`. Иначе строка испорчена. */
  def restoreEvent(stored: StoredInvoiceEventBody): InvoiceEvent =
    stored match {
      case StoredInvoiceEventBody("InvoiceIssued", Some(issued), None, None, None, None) =>
        InvoiceEvent.InvoiceIssued(
          InvoiceTerms(
            AuctionId(issued.auctionId),
            LotId(issued.lotId),
            ParticipantId(issued.winnerId),
            LotJournal.restoreMoney(issued.amount),
            issued.paymentDueAt
          )
        )
      case StoredInvoiceEventBody("InvoicePaid", None, Some(mark), None, None, None) =>
        InvoiceEvent.InvoicePaid(OpId(mark.opId))
      case StoredInvoiceEventBody("InvoiceHandedOver", None, None, Some(mark), None, None) =>
        InvoiceEvent.InvoiceHandedOver(OpId(mark.opId))
      case StoredInvoiceEventBody("FulfillmentChosen", None, None, None, Some(chosen), None) =>
        InvoiceEvent.FulfillmentChosen(restoreMethod(chosen.method), OpId(chosen.opId))
      case StoredInvoiceEventBody("InvoiceUnredeemed", None, None, None, None, Some(mark)) =>
        InvoiceEvent.InvoiceUnredeemed(OpId(mark.opId))
      case other =>
        throw new JournalCorrupted(s"invoice event of kind ${other.kind} with sections that do not match it")
    }

  /**
   * Имена способов — формат хранения журнала и строки `auction_invoice`: их переименование делает строки нечитаемыми.
   */
  def methodName(method: FulfillmentMethod): String =
    method match {
      case FulfillmentMethod.Pickup => "Pickup"
      case FulfillmentMethod.Delivery => "Delivery"
      case FulfillmentMethod.Digital => "Digital"
    }

  /** Имена статусов — формат хранения строки `auction_invoice`, как имена способов. */
  def statusName(status: InvoiceStatus): String =
    status match {
      case InvoiceStatus.AwaitingPayment => "AwaitingPayment"
      case InvoiceStatus.Paid => "Paid"
      case InvoiceStatus.HandedOver => "HandedOver"
      case InvoiceStatus.Unredeemed => "Unredeemed"
    }

  def restoreStatus(name: String): InvoiceStatus =
    name match {
      case "AwaitingPayment" => InvoiceStatus.AwaitingPayment
      case "Paid" => InvoiceStatus.Paid
      case "HandedOver" => InvoiceStatus.HandedOver
      case "Unredeemed" => InvoiceStatus.Unredeemed
      case other => throw new JournalCorrupted(s"invoice row names an unknown status $other")
    }

  def restoreMethod(name: String): FulfillmentMethod =
    name match {
      case "Pickup" => FulfillmentMethod.Pickup
      case "Delivery" => FulfillmentMethod.Delivery
      case "Digital" => FulfillmentMethod.Digital
      case other => throw new JournalCorrupted(s"invoice names an unknown fulfillment method $other")
    }
}

/**
 * Теги журнала счёта — своё семейство по той же формуле, что у лота и итогов (ADR-061): номер среза Pekko по
 * persistence id по модулю числа срезов. Формула — формат хранения: её смена переписывает `event_tag`. По тегу журнал
 * счёта читают read model и публикация факта.
 */
object InvoiceTags {

  val Count: Int = 4

  def of(slice: Int): String = s"invoice-${Math.floorMod(slice, Count)}"

  val all: Vector[String] = Vector.tabulate(Count)(of)
}
