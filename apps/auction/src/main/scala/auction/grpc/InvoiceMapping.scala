package auction.grpc

import auction.aggregate.Denial
import auction.aggregate.PaymentInstructions
import auction.contract.InvoiceValues
import auction.invoice.FulfillmentMethod
import auction.invoice.InvoiceId
import auction.invoice.InvoiceRefusal
import auction.invoice.InvoiceView
import auction.lot.AuctionId
import auction.lot.OpId
import auction.v1.auction as model
import auction.v1.auction_service as wire
import io.grpc.Status

/** Отметка оплаты или выдачи, отображённая в домен: счёт, `op_id` и смотрящий — администратор сходки аукциона. */
final case class InvoiceMark(invoice: InvoiceId, opId: OpId, acting: Acting)

/** Выбор способа получения победителем. */
final case class FulfillmentChoice(invoice: InvoiceId, method: FulfillmentMethod, opId: OpId, acting: Acting)

/** Чтение счетов смотрящего в аукционе. */
final case class MyInvoicesQuery(auctionId: AuctionId, acting: Acting)

/**
 * Счета в типах контракта (PER-338, integration.md, «Счета»). Форма — канонические идентификаторы и способ получения:
 * `UNSPECIFIED` и значение новее схемы во входе — `INVALID_ARGUMENT`, выбор нельзя вернуть к «не выбран». Значениями
 * ответа идут отказы права и состояния счёта, статусами — счёт, которого нет или который адресован не смотрящему
 * (`NOT_FOUND`, как у `GetLot`), занятый `op_id` (`ALREADY_EXISTS`) и молчание Meetups (`UNAVAILABLE`).
 */
object InvoiceMapping {

  def markPaid(request: wire.MarkInvoicePaidRequest): Either[FormError, InvoiceMark] =
    mark(request.viewer, request.invoiceId, request.opId)

  def markHandedOver(request: wire.MarkInvoiceHandedOverRequest): Either[FormError, InvoiceMark] =
    mark(request.viewer, request.invoiceId, request.opId)

  def chooseFulfillment(request: wire.ChooseFulfillmentRequest): Either[FormError, FulfillmentChoice] =
    for {
      acting <- RequestMapping.acting(request.viewer)
      invoice <- invoiceId(request.invoiceId)
      method <- method(request.method)
      opId <- opId(request.opId)
    } yield FulfillmentChoice(invoice, method, opId, acting)

  /** Счета смотрящего: аукцион сходки (UUIDv5) или тестовый из настройки бота (UUIDv7), как у лотов аукциона. */
  def mine(request: wire.ListMyInvoicesRequest): Either[FormError, MyInvoicesQuery] =
    for {
      acting <- RequestMapping.acting(request.viewer)
      auction <- RequestMapping
        .canonicalUuidV5(request.auctionId)
        .orElse(RequestMapping.canonicalUuidV7(request.auctionId))
        .toRight(FormError("auction_id"))
    } yield MyInvoicesQuery(AuctionId(auction), acting)

  /**
   * Сводка организатора: аукцион сходки и смотрящий, которого Meetups проверит на право, — та же форма, что у пульта.
   */
  def ofAuction(request: wire.ListAuctionInvoicesRequest): Either[FormError, ConsoleQuery] =
    for {
      acting <- RequestMapping.acting(request.viewer)
      auction <- RequestMapping.canonicalUuidV5(request.auctionId).toRight(FormError("auction_id"))
    } yield ConsoleQuery(AuctionId(auction), acting)

  private def mark(viewer: Option[wire.Viewer], invoice: String, op: String): Either[FormError, InvoiceMark] =
    for {
      acting <- RequestMapping.acting(viewer)
      invoice <- invoiceId(invoice)
      opId <- opId(op)
    } yield InvoiceMark(invoice, opId, acting)

  private def invoiceId(value: String): Either[FormError, InvoiceId] =
    RequestMapping.canonicalUuidV5(value).map(InvoiceId(_)).toRight(FormError("invoice_id"))

  private def opId(value: String): Either[FormError, OpId] =
    RequestMapping.canonicalUuidV7(value).map(OpId(_)).toRight(FormError("op_id"))

  private def method(value: model.FulfillmentMethod): Either[FormError, FulfillmentMethod] =
    value match {
      case model.FulfillmentMethod.FULFILLMENT_METHOD_PICKUP => Right(FulfillmentMethod.Pickup)
      case model.FulfillmentMethod.FULFILLMENT_METHOD_DELIVERY => Right(FulfillmentMethod.Delivery)
      case model.FulfillmentMethod.FULFILLMENT_METHOD_DIGITAL => Right(FulfillmentMethod.Digital)
      case model.FulfillmentMethod.FULFILLMENT_METHOD_UNSPECIFIED | model.FulfillmentMethod.Unrecognized(_) =>
        Left(FormError("method"))
    }

  val paymentAccepted: wire.MarkInvoicePaidResponse =
    wire.MarkInvoicePaidResponse().withAccepted(wire.InvoicePaymentAccepted())

  val handoverAccepted: wire.MarkInvoiceHandedOverResponse =
    wire.MarkInvoiceHandedOverResponse().withAccepted(wire.InvoiceHandoverAccepted())

  val fulfillmentAccepted: wire.ChooseFulfillmentResponse =
    wire.ChooseFulfillmentResponse().withAccepted(wire.FulfillmentAccepted())

  def paid(answer: Either[InvoiceRefusal, Unit]): Either[Status, wire.MarkInvoicePaidResponse] =
    answer match {
      case Right(()) => Right(paymentAccepted)
      case Left(InvoiceRefusal.InvoiceNotFound) => Left(invoiceNotFound)
      case Left(InvoiceRefusal.OpIdTaken) => Left(opIdTaken)
      case Left(refused @ (InvoiceRefusal.InvoiceNotPaid | InvoiceRefusal.FulfillmentFrozen)) =>
        throw new IllegalStateException(s"payment mark answered $refused")
    }

  def handedOver(answer: Either[InvoiceRefusal, Unit]): Either[Status, wire.MarkInvoiceHandedOverResponse] = {
    import wire.MarkInvoiceHandedOverRefusal.Reason
    answer match {
      case Right(()) => Right(handoverAccepted)
      case Left(InvoiceRefusal.InvoiceNotPaid) =>
        Right(
          wire
            .MarkInvoiceHandedOverResponse()
            .withRefused(wire.MarkInvoiceHandedOverRefusal(Reason.InvoiceNotPaid(wire.InvoiceNotPaid())))
        )
      case Left(InvoiceRefusal.InvoiceNotFound) => Left(invoiceNotFound)
      case Left(InvoiceRefusal.OpIdTaken) => Left(opIdTaken)
      case Left(InvoiceRefusal.FulfillmentFrozen) =>
        throw new IllegalStateException("handover mark answered FulfillmentFrozen")
    }
  }

  def fulfillment(answer: Either[InvoiceRefusal, Unit]): Either[Status, wire.ChooseFulfillmentResponse] = {
    import wire.ChooseFulfillmentRefusal.Reason
    answer match {
      case Right(()) => Right(fulfillmentAccepted)
      case Left(InvoiceRefusal.FulfillmentFrozen) =>
        Right(
          wire
            .ChooseFulfillmentResponse()
            .withRefused(wire.ChooseFulfillmentRefusal(Reason.FulfillmentFrozen(wire.FulfillmentFrozen())))
        )
      case Left(InvoiceRefusal.InvoiceNotFound) => Left(invoiceNotFound)
      case Left(InvoiceRefusal.OpIdTaken) => Left(opIdTaken)
      case Left(InvoiceRefusal.InvoiceNotPaid) =>
        throw new IllegalStateException("fulfillment choice answered InvoiceNotPaid")
    }
  }

  /**
   * Отказ права на отметку оплаты: ворота сходки у отметок не стоят — проданный лот остаётся проданным и после отмены.
   */
  def paidDenied(denial: Denial): Either[Status, wire.MarkInvoicePaidResponse] = {
    import wire.MarkInvoicePaidRefusal.Reason
    authority(denial, "payment mark")
      .map {
        case Authority.NotAdministrator => Reason.NotMeetupAdministrator(wire.NotMeetupAdministrator())
        case Authority.MeetupNotFound => Reason.MeetupNotFound(wire.MeetupNotFound())
      }
      .map(reason => wire.MarkInvoicePaidResponse().withRefused(wire.MarkInvoicePaidRefusal(reason)))
  }

  def handedOverDenied(denial: Denial): Either[Status, wire.MarkInvoiceHandedOverResponse] = {
    import wire.MarkInvoiceHandedOverRefusal.Reason
    authority(denial, "handover mark")
      .map {
        case Authority.NotAdministrator => Reason.NotMeetupAdministrator(wire.NotMeetupAdministrator())
        case Authority.MeetupNotFound => Reason.MeetupNotFound(wire.MeetupNotFound())
      }
      .map(reason => wire.MarkInvoiceHandedOverResponse().withRefused(wire.MarkInvoiceHandedOverRefusal(reason)))
  }

  def auctionInvoicesDenied(denial: Denial): Either[Status, wire.ListAuctionInvoicesResponse] = {
    import wire.ListAuctionInvoicesRefusal.Reason
    authority(denial, "auction invoices")
      .map {
        case Authority.NotAdministrator => Reason.NotMeetupAdministrator(wire.NotMeetupAdministrator())
        case Authority.MeetupNotFound => Reason.MeetupNotFound(wire.MeetupNotFound())
      }
      .map(reason => wire.ListAuctionInvoicesResponse().withRefused(wire.ListAuctionInvoicesRefusal(reason)))
  }

  /** Счета и текст оплаты аукциона: текст читается в момент вызова, поэтому правка доходит и до прежних счетов. */
  def mine(invoices: List[InvoiceView], instructions: Option[PaymentInstructions]): wire.ListMyInvoicesResponse =
    wire.ListMyInvoicesResponse(invoices.map(InvoiceValues.snapshot), instructions.map(_.value))

  def ofAuction(
      invoices: List[InvoiceView],
      instructions: Option[PaymentInstructions]
  ): wire.ListAuctionInvoicesResponse =
    wire
      .ListAuctionInvoicesResponse()
      .withInvoices(wire.AuctionInvoices(invoices.map(InvoiceValues.snapshot), instructions.map(_.value)))

  /** Два отказа права, общие у трёх методов: остальное — статусы или дефект ворот. */
  private enum Authority {
    case NotAdministrator
    case MeetupNotFound
  }

  private def authority(denial: Denial, what: String): Either[Status, Authority] =
    denial match {
      case Denial.NotAdministrator => Right(Authority.NotAdministrator)
      case Denial.MeetupNotFound => Right(Authority.MeetupNotFound)
      case Denial.Unavailable => Left(Status.UNAVAILABLE.withDescription("meetups did not answer"))
      case Denial.AuctionNotFound => Left(Status.NOT_FOUND.withDescription("auction not found"))
      case Denial.MeetupCancelled | Denial.MeetupHidden | Denial.LotsFrozen | Denial.LotOfAnotherAuction =>
        throw new IllegalStateException(s"$what authority answered $denial")
    }

  val invoiceNotFound: Status = Status.NOT_FOUND.withDescription("invoice not found")

  private val opIdTaken: Status = Status.ALREADY_EXISTS.withDescription("op_id belongs to another command")
}
