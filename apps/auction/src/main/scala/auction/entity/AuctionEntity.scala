package auction.entity

import auction.aggregate.*
import auction.lot.OpId
import org.apache.pekko.actor.typed.ActorRef
import org.apache.pekko.actor.typed.Behavior
import org.apache.pekko.actor.typed.scaladsl.Behaviors
import org.apache.pekko.cluster.sharding.typed.scaladsl.EntityTypeKey
import org.apache.pekko.persistence.Persistence
import org.apache.pekko.persistence.typed.PersistenceId
import org.apache.pekko.persistence.typed.scaladsl.Effect
import org.apache.pekko.persistence.typed.scaladsl.EventSourcedBehavior
import org.apache.pekko.persistence.typed.scaladsl.RetentionCriteria

import java.time.Clock
import java.util.UUID

/**
 * Ответ entity аукциона на принятую команду: конверт записанного события (или исходный — на повтор) либо «без события».
 */
enum AuctionAnswer {
  case Written(envelope: AuctionEnvelope)
  case Unchanged
}

/**
 * Аукцион как персистентный агрегат под Cluster Sharding — та же форма, что [[LotEntity]]: решение в
 * [[Auction.decide]], состояние меняет только [[Auction.apply]], `onPersistFailure` не задан (ADR-045).
 *
 * Права entity не проверяет: проверка у Meetups асинхронна и идёт в шлюзе между `Inspect` и командой. Окно `seen`
 * команда сверяет заново — повтор, принятый между двумя шагами, получает исходный ответ, а не второе событие.
 */
object AuctionEntity {

  val TypeKey: EntityTypeKey[Command] = EntityTypeKey[Command]("auction")

  val DefaultSnapshotEvery: Int = 100

  /** Аукцион и номер последнего применённого события; номер выводится счётом, как у лота (`LotEntity.State`). */
  final case class State(auction: Auction, sequence: Long)

  sealed trait Command

  /** Что знает аукцион до проверки права: повтор, отсутствие или сходка. Ничего не пишет. */
  final case class Inspect(opId: OpId, replyTo: ActorRef[Inspection]) extends Command

  final case class Draft(command: DraftAuction, initiator: Initiator, replyTo: ActorRef[AuctionAnswer]) extends Command

  final case class Add(command: AddLot, initiator: Initiator, replyTo: ActorRef[Either[AddLotRejected, AuctionAnswer]])
      extends Command

  final case class Remove(
      command: RemoveLot,
      initiator: Initiator,
      replyTo: ActorRef[Either[RemoveLotRejected, AuctionAnswer]]
  ) extends Command

  final case class Get(replyTo: ActorRef[Auction]) extends Command

  /**
   * @param auctionId
   *   идентификатор аукциона: persistence id — `auction|<auctionId>`
   */
  def apply(
      auctionId: String,
      clock: Clock,
      newId: () => UUID,
      snapshotEvery: Int = DefaultSnapshotEvery
  ): Behavior[Command] =
    Behaviors.setup { context =>
      val persistenceId = PersistenceId(TypeKey.name, auctionId)
      val tag = Set(AuctionTags.of(Persistence(context.system.classicSystem).sliceForPersistenceId(persistenceId.id)))
      EventSourcedBehavior[Command, StoredAuctionEvent, State](
        persistenceId = persistenceId,
        emptyState = State(Auction.initial, 0),
        commandHandler = (state, command) => handle(state, command, clock, newId),
        eventHandler = (state, stored) => {
          val sequence = state.sequence + 1
          State(Auction.apply(state.auction, AuctionJournal.envelope(sequence, stored)), sequence)
        }
      ).snapshotAdapter(AuctionJournal.snapshotAdapter)
        .withRetention(RetentionCriteria.snapshotEvery(snapshotEvery, keepNSnapshots = 2))
        .withTagger(_ => tag)
    }

  private def handle(
      state: State,
      command: Command,
      clock: Clock,
      newId: () => UUID
  ): Effect[StoredAuctionEvent, State] = {
    val auction = state.auction
    command match {
      case Inspect(opId, replyTo) => Effect.reply(replyTo)(Auction.inspect(auction, opId))
      case Draft(draft, initiator, replyTo) =>
        record(Auction.decide(auction, draft), draft.opId, initiator, clock, newId)(replyTo ! _)
      case Add(add, initiator, replyTo) =>
        Auction.decide(auction, add) match {
          case Left(rejected) => Effect.reply(replyTo)(Left(rejected))
          case Right(decision) => record(decision, add.opId, initiator, clock, newId)(answer => replyTo ! Right(answer))
        }
      case Remove(remove, initiator, replyTo) =>
        Auction.decide(auction, remove) match {
          case Left(rejected) => Effect.reply(replyTo)(Left(rejected))
          case Right(decision) =>
            record(decision, remove.opId, initiator, clock, newId)(answer => replyTo ! Right(answer))
        }
      case Get(replyTo) => Effect.reply(replyTo)(auction)
    }
  }

  /** Событие команды пишется одним `persist` с конвертом ADR-047; отказ и «без события» ничего не пишут. */
  private def record(
      decision: AuctionDecision,
      opId: OpId,
      initiator: Initiator,
      clock: Clock,
      newId: () => UUID
  )(reply: AuctionAnswer => Unit): Effect[StoredAuctionEvent, State] =
    decision match {
      case AuctionDecision.Repeated(original) => Effect.none.thenRun(_ => reply(AuctionAnswer.Written(original)))
      case AuctionDecision.Unchanged => Effect.none.thenRun(_ => reply(AuctionAnswer.Unchanged))
      case AuctionDecision.Accepted(event) =>
        val stored = AuctionJournal.store(newId(), newId(), opId, clock.instant(), initiator)(event)
        Effect.persist(stored).thenRun(written => reply(AuctionAnswer.Written(firstOf(written.auction, opId))))
    }

  private def firstOf(auction: Auction, opId: OpId): AuctionEnvelope =
    auction.seen.get(opId) match {
      case Some(envelope) => envelope
      case None => throw new IllegalStateException(s"auction applied its own event without op_id ${opId.value}")
    }
}
