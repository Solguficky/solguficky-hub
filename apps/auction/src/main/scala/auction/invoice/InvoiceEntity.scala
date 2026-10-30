package auction.invoice

import auction.lot.AuctionId
import auction.lot.OpId
import auction.lot.ParticipantId
import org.apache.pekko.Done
import org.apache.pekko.actor.typed.ActorRef
import org.apache.pekko.actor.typed.Behavior
import org.apache.pekko.actor.typed.scaladsl.Behaviors
import org.apache.pekko.cluster.sharding.typed.scaladsl.ClusterSharding
import org.apache.pekko.cluster.sharding.typed.scaladsl.Entity
import org.apache.pekko.cluster.sharding.typed.scaladsl.EntityTypeKey
import org.apache.pekko.persistence.Persistence
import org.apache.pekko.persistence.typed.PersistenceId
import org.apache.pekko.persistence.typed.scaladsl.Effect
import org.apache.pekko.persistence.typed.scaladsl.EventSourcedBehavior
import org.apache.pekko.util.Timeout

import java.time.Instant
import java.time.Clock
import java.util.UUID
import scala.concurrent.Future
import scala.concurrent.duration.FiniteDuration

/**
 * Счёт проданного лота как персистентный агрегат под Cluster Sharding (PER-338): persistence id `invoice|<invoice_id>`,
 * решение в [[Invoice]], `onPersistFailure` не задан (ADR-045). Таймеров у entity нет, поэтому шардинг её не помнит, и
 * простаивающий счёт засыпает.
 *
 * Выставляет счёт проекция журнала лотов `lot-invoicing` командой `Issue` на каждый `LotSold`; доставка at-least-once,
 * и идемпотентность держит сам счёт: его id выведен из `bid_id` продажи, а выставленный счёт второго события не пишет.
 */
object InvoiceEntity {

  val TypeKey: EntityTypeKey[Command] = EntityTypeKey[Command]("invoice")

  sealed trait Command

  final case class Issue(terms: InvoiceTerms, replyTo: ActorRef[Done]) extends Command

  final case class ChangeDue(expected: Option[Instant], dueAt: Option[Instant], replyTo: ActorRef[Done]) extends Command

  final case class MarkPaid(opId: OpId, replyTo: ActorRef[Either[InvoiceRefusal, Done]]) extends Command

  final case class MarkHandedOver(opId: OpId, replyTo: ActorRef[Either[InvoiceRefusal, Done]]) extends Command

  final case class ChooseFulfillment(
      viewer: ParticipantId,
      method: FulfillmentMethod,
      opId: OpId,
      replyTo: ActorRef[Either[InvoiceRefusal, Done]]
  ) extends Command

  /** Счёт, как его знает entity; ничего не пишет. */
  final case class Get(replyTo: ActorRef[Invoice]) extends Command

  def apply(invoiceId: String, clock: Clock, newId: () => UUID): Behavior[Command] =
    Behaviors.setup { context =>
      def answer(
          decided: Either[InvoiceRefusal, Option[InvoiceEvent]],
          replyTo: ActorRef[Either[InvoiceRefusal, Done]]
      ): Effect[StoredInvoiceEvent, Invoice] =
        decided match {
          case Left(refused) => Effect.reply(replyTo)(Left(refused))
          case Right(None) => Effect.reply(replyTo)(Right(Done))
          case Right(Some(event)) =>
            Effect.persist(InvoiceJournal.store(newId(), clock.instant())(event)).thenReply(replyTo)(_ => Right(Done))
        }

      def onCommand(state: Invoice, command: Command): Effect[StoredInvoiceEvent, Invoice] =
        command match {
          case Issue(terms, replyTo) =>
            Invoice.issue(state, terms) match {
              case Some(event) =>
                Effect.persist(InvoiceJournal.store(newId(), clock.instant())(event)).thenReply(replyTo)(_ => Done)
              case None => Effect.reply(replyTo)(Done)
            }
          case ChangeDue(expected, dueAt, replyTo) =>
            Invoice.changeDue(state, expected, dueAt) match {
              case Some(event) =>
                Effect.persist(InvoiceJournal.store(newId(), clock.instant())(event)).thenReply(replyTo)(_ => Done)
              case None => Effect.reply(replyTo)(Done)
            }
          case MarkPaid(opId, replyTo) => answer(Invoice.markPaid(state, opId), replyTo)
          case MarkHandedOver(opId, replyTo) => answer(Invoice.markHandedOver(state, opId), replyTo)
          case ChooseFulfillment(viewer, method, opId, replyTo) =>
            answer(Invoice.chooseFulfillment(state, viewer, method, opId), replyTo)
          case Get(replyTo) => Effect.reply(replyTo)(state)
        }

      val persistenceId = PersistenceId(TypeKey.name, invoiceId)
      // Тег один на счёт: срез зависит только от persistence id (InvoiceTags); по тегу журнал читают проекции счетов.
      val tag = Set(InvoiceTags.of(Persistence(context.system.classicSystem).sliceForPersistenceId(persistenceId.id)))
      EventSourcedBehavior[Command, StoredInvoiceEvent, Invoice](
        persistenceId = persistenceId,
        emptyState = Invoice.initial,
        commandHandler = onCommand,
        eventHandler = (state, stored) => Invoice.apply(state, InvoiceJournal.restoreEvent(stored.event))
      ).withTagger(_ => tag)
    }
}

/**
 * Команды и чтение счёта для тех, кто стоит снаружи entity, — как `ResultsGateway`. Неудачное `Future` — ответа нет:
 * ask истёк или шардинг не доставил команду; команда могла быть принята, и повтор с тем же `op_id` вернёт исходный
 * ответ.
 */
trait InvoiceGateway {
  def issue(invoice: InvoiceId, terms: InvoiceTerms): Future[Done]

  def changeDue(invoice: InvoiceId, expected: Option[Instant], dueAt: Option[Instant]): Future[Done] =
    Future.failed(new IllegalStateException("payment clock is not wired"))

  def get(invoice: InvoiceId): Future[Invoice]

  def markPaid(invoice: InvoiceId, opId: OpId): Future[Either[InvoiceRefusal, Done]]

  def markHandedOver(invoice: InvoiceId, opId: OpId): Future[Either[InvoiceRefusal, Done]]

  def chooseFulfillment(
      invoice: InvoiceId,
      viewer: ParticipantId,
      method: FulfillmentMethod,
      opId: OpId
  ): Future[Either[InvoiceRefusal, Done]]
}

/** Чтения счетов из read model: согласованы с entity в конечном счёте. */
trait InvoiceViews {

  /** Счета победителя в аукционе. */
  def mine(auction: AuctionId, winner: ParticipantId): Future[List[InvoiceView]]

  /** Все счета аукциона — сводка организатора. */
  def ofAuction(auction: AuctionId): Future[List[InvoiceView]]
}

object InvoiceViews {

  /** Узел без счетов: тесты границы, которым они не нужны. */
  val none: InvoiceViews = new InvoiceViews {
    def mine(auction: AuctionId, winner: ParticipantId) = Future.successful(Nil)
    def ofAuction(auction: AuctionId) = Future.successful(Nil)
  }
}

object InvoiceGateway {

  /** Узел без счетов: тесты границы, которым они не нужны. Любой вызов — ответа нет. */
  val none: InvoiceGateway = new InvoiceGateway {
    private def missing[T]: Future[T] = Future.failed(new IllegalStateException("invoices are not wired in this node"))
    def issue(invoice: InvoiceId, terms: InvoiceTerms) = missing
    def get(invoice: InvoiceId) = missing
    def markPaid(invoice: InvoiceId, opId: OpId) = missing
    def markHandedOver(invoice: InvoiceId, opId: OpId) = missing
    def chooseFulfillment(invoice: InvoiceId, viewer: ParticipantId, method: FulfillmentMethod, opId: OpId) = missing
  }

  /** Регистрирует entity счёта в шардинге и отдаёт шлюз к ней; `askTimeout` — срок ответа entity. */
  def sharded(
      sharding: ClusterSharding,
      clock: Clock,
      newId: () => UUID,
      askTimeout: FiniteDuration
  ): InvoiceGateway = {
    sharding.init(Entity(InvoiceEntity.TypeKey)(context => InvoiceEntity(context.entityId, clock, newId)))
    new InvoiceGateway {
      private given Timeout = Timeout(askTimeout)

      private def entity(invoice: InvoiceId) = sharding.entityRefFor(InvoiceEntity.TypeKey, invoice.value.toString)

      def issue(invoice: InvoiceId, terms: InvoiceTerms): Future[Done] =
        entity(invoice).ask(InvoiceEntity.Issue(terms, _))

      override def changeDue(invoice: InvoiceId, expected: Option[Instant], dueAt: Option[Instant]): Future[Done] =
        entity(invoice).ask(InvoiceEntity.ChangeDue(expected, dueAt, _))

      def get(invoice: InvoiceId): Future[Invoice] = entity(invoice).ask(InvoiceEntity.Get(_))

      def markPaid(invoice: InvoiceId, opId: OpId): Future[Either[InvoiceRefusal, Done]] =
        entity(invoice).ask(InvoiceEntity.MarkPaid(opId, _))

      def markHandedOver(invoice: InvoiceId, opId: OpId): Future[Either[InvoiceRefusal, Done]] =
        entity(invoice).ask(InvoiceEntity.MarkHandedOver(opId, _))

      def chooseFulfillment(
          invoice: InvoiceId,
          viewer: ParticipantId,
          method: FulfillmentMethod,
          opId: OpId
      ): Future[Either[InvoiceRefusal, Done]] =
        entity(invoice).ask(InvoiceEntity.ChooseFulfillment(viewer, method, opId, _))
    }
  }
}
