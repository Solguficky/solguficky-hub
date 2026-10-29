package auction.settlement

import auction.catalog.LotId
import auction.invoice.*
import auction.lot.*
import org.apache.pekko.Done
import org.apache.pekko.actor.typed.*
import org.apache.pekko.actor.typed.scaladsl.Behaviors
import org.apache.pekko.cluster.sharding.typed.ClusterShardingSettings
import org.apache.pekko.cluster.sharding.typed.scaladsl.*
import org.apache.pekko.persistence.typed.PersistenceId
import org.apache.pekko.persistence.typed.RecoveryCompleted
import org.apache.pekko.persistence.typed.scaladsl.*
import org.apache.pekko.util.Timeout

import java.time.Clock
import java.util.UUID
import scala.concurrent.Future
import scala.concurrent.duration.*
import scala.util.*

/**
 * Расчёты лота: сохраняет намерение до эффекта, повторяет его после recovery и до подтверждения. Таймер повторяет
 * только уже принятое решение; наступление срока оплаты не создаёт невыкуп.
 */
object SettlementEntity {
  val TypeKey: EntityTypeKey[Command] = EntityTypeKey[Command]("settlement")

  sealed trait Command
  final case class Open(sale: SettlementSale, candidates: List[SettlementCandidate], replyTo: ActorRef[Done])
      extends Command
  final case class RequestUnredeemed(invoice: InvoiceId, opId: OpId, replyTo: ActorRef[Either[SettlementRefusal, Done]])
      extends Command
  final case class Accept(
      offer: BidId,
      participant: ParticipantId,
      opId: OpId,
      replyTo: ActorRef[Either[SettlementRefusal, Done]]
  ) extends Command
  final case class Decline(
      offer: BidId,
      participant: ParticipantId,
      opId: OpId,
      replyTo: ActorRef[Either[SettlementRefusal, Done]]
  ) extends Command
  final case class Get(replyTo: ActorRef[Settlement]) extends Command
  private case object Retry extends Command
  private final case class Closed(opId: OpId, result: Try[Either[InvoiceRefusal, Done]]) extends Command
  private final case class Issued(invoice: InvoiceId, result: Try[Done]) extends Command

  def apply(
      lotId: String,
      invoices: InvoiceGateway,
      clock: Clock,
      newId: () => UUID,
      retryEvery: FiniteDuration,
      failed: Throwable => Unit
  ): Behavior[Command] =
    Behaviors.withTimers { timers =>
      Behaviors.setup { context =>
        def drive(state: Settlement): Unit =
          state match {
            case active: Settlement.Open =>
              active.stage match {
                case SettlementStage.Closing(op) =>
                  timers.startSingleTimer(Retry, Retry, retryEvery)
                  context.pipeToSelf(invoices.markUnredeemed(active.current.id, op))(Closed(op, _))
                case SettlementStage.Issuing =>
                  timers.startSingleTimer(Retry, Retry, retryEvery)
                  context.pipeToSelf(invoices.issue(active.current.id, active.current.terms))(
                    Issued(active.current.id, _)
                  )
                case _ => timers.cancel(Retry)
              }
            case Settlement.Initial => timers.cancel(Retry)
          }

        def persist(event: Option[SettlementEvent]): Effect[StoredSettlementEvent, Settlement] =
          event match {
            case Some(value) =>
              Effect.persist(SettlementJournal.store(newId(), clock.instant())(value)).thenRun(drive)
            case None => Effect.none
          }

        def answer(
            result: Either[SettlementRefusal, Option[SettlementEvent]],
            replyTo: ActorRef[Either[SettlementRefusal, Done]]
        ): Effect[StoredSettlementEvent, Settlement] =
          result match {
            case Left(refusal) => Effect.reply(replyTo)(Left(refusal))
            case Right(None) => Effect.reply(replyTo)(Right(Done))
            case Right(Some(event)) =>
              Effect
                .persist(SettlementJournal.store(newId(), clock.instant())(event))
                .thenRun(drive)
                .thenReply(replyTo)(_ => Right(Done))
          }

        def onCommand(state: Settlement, command: Command): Effect[StoredSettlementEvent, Settlement] =
          command match {
            case Open(sale, candidates, replyTo) =>
              Settlement.open(state, sale, candidates) match {
                case Some(event) =>
                  Effect.persist(SettlementJournal.store(newId(), clock.instant())(event)).thenReply(replyTo)(_ => Done)
                case None => Effect.reply(replyTo)(Done)
              }
            case RequestUnredeemed(invoice, op, replyTo) =>
              answer(Settlement.requestUnredeemed(state, invoice, op), replyTo)
            case Accept(offer, participant, op, replyTo) =>
              answer(Settlement.accept(state, offer, participant, op, clock.instant()), replyTo)
            case Decline(offer, participant, op, replyTo) =>
              answer(Settlement.decline(state, offer, participant, op), replyTo)
            case Closed(op, Success(Right(_))) => persist(Settlement.closureCompleted(state, op, ClosureOutcome.Closed))
            case Closed(op, Success(Left(InvoiceRefusal.InvoiceAlreadyPaid))) =>
              persist(Settlement.closureCompleted(state, op, ClosureOutcome.AlreadyPaid))
            case Closed(op, Success(Left(InvoiceRefusal.OpIdTaken))) =>
              persist(Settlement.closureCompleted(state, op, ClosureOutcome.OpIdTaken))
            case Closed(_, Success(Left(refusal))) =>
              throw new IllegalStateException(s"settlement invoice closure answered $refusal")
            case Issued(invoice, Success(_)) => persist(Settlement.invoiceConfirmed(state, invoice))
            // Таймер уже вооружён; сбой ask не отменяет сохранённое намерение.
            case Closed(_, Failure(error)) => failed(error); Effect.none
            case Issued(_, Failure(error)) => failed(error); Effect.none
            case Retry => drive(state); Effect.none
            case Get(replyTo) => Effect.reply(replyTo)(state)
          }

        EventSourcedBehavior[Command, StoredSettlementEvent, Settlement](
          PersistenceId(TypeKey.name, lotId),
          Settlement.Initial,
          onCommand,
          (state, stored) => Settlement(state, SettlementJournal.restore(stored))
        ).receiveSignal { case (state, RecoveryCompleted) => drive(state) }
      }
    }
}

/** Внутренний порт: результат requestUnredeemed — квитанция; исход закрытия хранится в Settlement.Open.closures. */
trait SettlementGateway {
  def open(lot: LotId, sale: SettlementSale, candidates: List[SettlementCandidate]): Future[Done]
  def get(lot: LotId): Future[Settlement]
  def requestUnredeemed(lot: LotId, invoice: InvoiceId, op: OpId): Future[Either[SettlementRefusal, Done]]
  def accept(lot: LotId, offer: BidId, participant: ParticipantId, op: OpId): Future[Either[SettlementRefusal, Done]]
  def decline(lot: LotId, offer: BidId, participant: ParticipantId, op: OpId): Future[Either[SettlementRefusal, Done]]
}

object SettlementGateway {
  def sharded(
      system: ActorSystem[?],
      sharding: ClusterSharding,
      invoices: InvoiceGateway,
      clock: Clock,
      newId: () => UUID,
      askTimeout: FiniteDuration,
      failed: (String, Throwable) => Unit,
      retryEvery: FiniteDuration = 1.second
  ): SettlementGateway = {
    val settings = ClusterShardingSettings(system)
      .withRememberEntities(true)
      .withRememberEntitiesStoreMode(ClusterShardingSettings.RememberEntitiesStoreModeEventSourced)
    sharding.init(
      Entity(SettlementEntity.TypeKey)(context =>
        SettlementEntity(context.entityId, invoices, clock, newId, retryEvery, error => failed(context.entityId, error))
      ).withSettings(settings)
    )
    new SettlementGateway {
      private given Timeout = Timeout(askTimeout)
      private def entity(lot: LotId) = sharding.entityRefFor(SettlementEntity.TypeKey, lot.value.toString)
      def open(lot: LotId, sale: SettlementSale, candidates: List[SettlementCandidate]) =
        entity(lot).ask(SettlementEntity.Open(sale, candidates, _))
      def get(lot: LotId) = entity(lot).ask(SettlementEntity.Get(_))
      def requestUnredeemed(lot: LotId, invoice: InvoiceId, op: OpId) =
        entity(lot).ask(SettlementEntity.RequestUnredeemed(invoice, op, _))
      def accept(lot: LotId, offer: BidId, participant: ParticipantId, op: OpId) =
        entity(lot).ask(SettlementEntity.Accept(offer, participant, op, _))
      def decline(lot: LotId, offer: BidId, participant: ParticipantId, op: OpId) =
        entity(lot).ask(SettlementEntity.Decline(offer, participant, op, _))
    }
  }
}
