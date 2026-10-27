package auction.invoice

import auction.aggregate.Auction
import auction.catalog.LotId
import auction.lot.AuctionId
import auction.lot.BidId
import auction.lot.Money
import auction.lot.OpId
import auction.lot.ParticipantId

import java.time.Duration
import java.time.Instant
import java.time.temporal.ChronoUnit
import java.util.UUID

/*
 * Ядро счёта проданного лота (PER-338, контракт PER-308, integration.md, «Счета»): решения и `apply` чистыми
 * функциями, без актора, журнала и часов. Счёт — свой агрегат со своим журналом, а не статус в журнале лота: проданный
 * лот терминален, а передача невыкупленного лота второй ставке даст тому же лоту второй счёт. Деньги через платформу не
 * проходят: оплату и выдачу отмечает организатор вручную.
 */

/**
 * Идентификатор счёта — UUIDv5 от `bid_id` выигравшей ставки: повторная доставка продажи приходит в тот же счёт, а
 * продажа другой ставке — в другой.
 */
final case class InvoiceId(value: UUID)

object InvoiceId {

  /** Пространство имён UUIDv5 счёта. Не меняется никогда: другое пространство дало бы той же продаже второй счёт. */
  val Namespace: UUID = UUID.fromString("5d2c4f0e-6b1a-4c7e-9f38-2a7d61e0b4c9")

  def of(bid: BidId): InvoiceId = InvoiceId(Auction.nameBased(Namespace, bid.value.toString))
}

/** Как победитель получает лот (P-54). Отсутствие выбора — `None` у счёта, а не вариант. */
enum FulfillmentMethod {
  case Pickup
  case Delivery
  case Digital
}

/**
 * Неизменные условия счёта: аукцион и лот продажи, победитель, сумма — цена продажи — и момент, до которого счёт ждёт
 * оплаты. Всё задаётся при выставлении и дальше не меняется.
 */
final case class InvoiceTerms(
    auction: AuctionId,
    lot: LotId,
    winner: ParticipantId,
    amount: Money,
    paymentDueAt: Instant
)

object InvoiceTerms {

  /**
   * Условия счёта по продаже: срок оплаты отсчитывается от момента продажи `LotSold.at` и обрезается до микросекунд —
   * точности `timestamptz` read model, — чтобы чтение счёта и факт шины несли один и тот же момент.
   */
  def ofSale(
      auction: AuctionId,
      lot: LotId,
      winner: ParticipantId,
      price: Money,
      soldAt: Instant,
      paymentTerm: Duration
  ): InvoiceTerms =
    InvoiceTerms(auction, lot, winner, price, soldAt.plus(paymentTerm).truncatedTo(ChronoUnit.MICROS))
}

/** Счёт, каким его отдают чтения и факт: id, условия, статус и выбранный способ получения. */
final case class InvoiceView(
    id: InvoiceId,
    terms: InvoiceTerms,
    status: InvoiceStatus,
    fulfillment: Option[FulfillmentMethod]
)

/** Где счёт. Путь один и в одну сторону: к оплате, затем оплачено, затем выдано. Просрочка — не статус. */
enum InvoiceStatus {
  case AwaitingPayment
  case Paid
  case HandedOver
}

/** Команда, принятая под `op_id`: окно `seen` отличает повтор своей команды от чужого `op_id`. */
enum InvoiceAction {
  case MarkPaid
  case MarkHandedOver
  case ChooseFulfillment
}

enum InvoiceEvent {
  case InvoiceIssued(terms: InvoiceTerms)
  case InvoicePaid(opId: OpId)
  case InvoiceHandedOver(opId: OpId)

  /** Приватный факт: на шину он не идёт (integration.md, «Счёт на шине»), но занимает номер в журнале счёта. */
  case FulfillmentChosen(method: FulfillmentMethod, opId: OpId)
}

/**
 * Почему команда счёта не записана. `InvoiceNotFound` — счёта нет или он адресован не смотрящему: чужой счёт неотличим
 * от несуществующего. `OpIdTaken` — `op_id` уже принят под командой другого вида.
 */
enum InvoiceRefusal {
  case InvoiceNotFound
  case OpIdTaken
  case InvoiceNotPaid
  case FulfillmentFrozen
}

/**
 * Состояние счёта. `Initial` — счёта нет: под шардингом entity поднимается на любой id, и из `Initial` выводится только
 * выставление. `seen` — окно `op_id` принятых команд; его пишет только `apply`, поэтому оно восстанавливается реплеем.
 */
enum Invoice {
  case Initial
  case Issued(
      terms: InvoiceTerms,
      status: InvoiceStatus,
      fulfillment: Option[FulfillmentMethod],
      seen: Map[OpId, InvoiceAction]
  )
}

object Invoice {

  val initial: Invoice = Invoice.Initial

  /** Выставление идемпотентно: счёт, который уже есть, второго события не пишет, и условия не пересчитываются. */
  def issue(state: Invoice, terms: InvoiceTerms): Option[InvoiceEvent] =
    state match {
      case Initial => Some(InvoiceEvent.InvoiceIssued(terms))
      case Issued(_, _, _, _) => None
    }

  /**
   * Отметка оплаты. Оплаченный или выданный счёт принимает её без второго перехода, поэтому отказа «уже оплачен» нет.
   * Повтор принятого `op_id` — исходный ответ.
   */
  def markPaid(state: Invoice, opId: OpId): Either[InvoiceRefusal, Option[InvoiceEvent]] =
    issued(state, opId, InvoiceAction.MarkPaid) { invoice =>
      invoice.status match {
        case InvoiceStatus.AwaitingPayment => Right(Some(InvoiceEvent.InvoicePaid(opId)))
        case InvoiceStatus.Paid | InvoiceStatus.HandedOver => Right(None)
      }
    }

  /** Отметка выдачи: только после оплаты. Выданный счёт принимает её без второго перехода. */
  def markHandedOver(state: Invoice, opId: OpId): Either[InvoiceRefusal, Option[InvoiceEvent]] =
    issued(state, opId, InvoiceAction.MarkHandedOver) { invoice =>
      invoice.status match {
        case InvoiceStatus.AwaitingPayment => Left(InvoiceRefusal.InvoiceNotPaid)
        case InvoiceStatus.Paid => Right(Some(InvoiceEvent.InvoiceHandedOver(opId)))
        case InvoiceStatus.HandedOver => Right(None)
      }
    }

  /**
   * Выбор способа получения победителем: заменяет прежний до выдачи, после неё счёт отвечает `FulfillmentFrozen`.
   * Событие пишется и на тот же способ: иначе `op_id` такой команды не попал бы в окно, и её запоздавший повтор после
   * другого выбора вернул бы прежний способ.
   */
  def chooseFulfillment(
      state: Invoice,
      viewer: ParticipantId,
      method: FulfillmentMethod,
      opId: OpId
  ): Either[InvoiceRefusal, Option[InvoiceEvent]] =
    state match {
      case Issued(terms, _, _, _) if terms.winner != viewer => Left(InvoiceRefusal.InvoiceNotFound)
      case _ =>
        issued(state, opId, InvoiceAction.ChooseFulfillment) { invoice =>
          invoice.status match {
            case InvoiceStatus.HandedOver => Left(InvoiceRefusal.FulfillmentFrozen)
            case InvoiceStatus.AwaitingPayment | InvoiceStatus.Paid =>
              Right(Some(InvoiceEvent.FulfillmentChosen(method, opId)))
          }
        }
    }

  /** Общий порядок команд: счёта нет — отказ, повтор своей команды — исходный ответ, чужой `op_id` — отказ. */
  private def issued(state: Invoice, opId: OpId, action: InvoiceAction)(
      decide: Issued => Either[InvoiceRefusal, Option[InvoiceEvent]]
  ): Either[InvoiceRefusal, Option[InvoiceEvent]] =
    state match {
      case Initial => Left(InvoiceRefusal.InvoiceNotFound)
      case invoice: Issued =>
        invoice.seen.get(opId) match {
          case Some(`action`) => Right(None)
          case Some(_) => Left(InvoiceRefusal.OpIdTaken)
          case None => decide(invoice)
        }
    }

  def apply(state: Invoice, event: InvoiceEvent): Invoice =
    (state, event) match {
      case (Initial, InvoiceEvent.InvoiceIssued(terms)) =>
        Issued(terms, InvoiceStatus.AwaitingPayment, None, Map.empty)
      case (invoice: Issued, InvoiceEvent.InvoicePaid(opId)) =>
        invoice.copy(status = InvoiceStatus.Paid, seen = invoice.seen + (opId -> InvoiceAction.MarkPaid))
      case (invoice: Issued, InvoiceEvent.InvoiceHandedOver(opId)) =>
        invoice.copy(status = InvoiceStatus.HandedOver, seen = invoice.seen + (opId -> InvoiceAction.MarkHandedOver))
      case (invoice: Issued, InvoiceEvent.FulfillmentChosen(method, opId)) =>
        invoice.copy(fulfillment = Some(method), seen = invoice.seen + (opId -> InvoiceAction.ChooseFulfillment))
      case (other, written) =>
        throw new IllegalStateException(s"invoice event $written does not apply to $other")
    }
}
