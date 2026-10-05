package auction.entity

import auction.aggregate.*
import auction.catalog.LotId
import auction.lot.LotState
import auction.lot.OpId
import auction.lot.OpenLotRejected
import net.logstash.logback.argument.StructuredArguments
import org.apache.pekko.actor.typed.ActorRef
import org.apache.pekko.actor.typed.Behavior
import org.apache.pekko.actor.typed.scaladsl.Behaviors
import org.apache.pekko.cluster.sharding.typed.scaladsl.EntityTypeKey
import org.apache.pekko.persistence.Persistence
import org.apache.pekko.persistence.typed.PersistenceId
import org.apache.pekko.persistence.typed.RecoveryCompleted
import org.apache.pekko.persistence.typed.scaladsl.Effect
import org.apache.pekko.persistence.typed.scaladsl.EventSourcedBehavior
import org.apache.pekko.persistence.typed.scaladsl.RetentionCriteria

import java.time.Clock
import java.util.UUID
import scala.util.Failure
import scala.util.Success
import scala.util.Try

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
 *
 * Протокол с лотами (И-14) entity только исполняет: что спросить и кого открыть, решает [[LotRoster]]. Знание о лотах в
 * журнал и snapshot не попадает и живёт в этой инкарнации entity; после recovery оно строится тем же опросом, что и
 * после команды открытия (ADR-045, «Восстановление лотов и аукциона»). Ответа лотов entity не ждёт: команда открытия
 * отвечает сразу после записи события, а ответы лотов приходят ей сообщениями.
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

  /** Планирование; `Schedule` — имя сообщения, как `LotEntity.Plan` у лота. */
  final case class Schedule(
      command: ScheduleAuction,
      initiator: Initiator,
      replyTo: ActorRef[Either[ScheduleAuctionRejected, AuctionAnswer]]
  ) extends Command

  /** Открытие онлайн-торгов. Повтор того же `op_id` события не пишет, но доспрашивает лоты, не ответившие раньше. */
  final case class Start(
      command: StartPrebidding,
      initiator: Initiator,
      replyTo: ActorRef[Either[StartPrebiddingRejected, AuctionAnswer]]
  ) extends Command

  final case class Get(replyTo: ActorRef[Auction]) extends Command

  /** Что аукцион сейчас знает о лотах реестра. Ничего не пишет и лотов не спрашивает. */
  final case class Roster(replyTo: ActorRef[LotRoster]) extends Command

  /** Ответ лота на вопрос о состоянии; неудача — ответа нет. */
  private[entity] final case class LotObserved(lot: LotId, state: Try[LotState]) extends Command

  /** Ответ лота на `OpenLot`; неудача — ответа нет. */
  private[entity] final case class LotAnswered(lot: LotId, answer: Try[Either[OpenLotRejected, Unit]]) extends Command

  /**
   * @param auctionId
   *   идентификатор аукциона: persistence id — `auction|<auctionId>`
   * @param lots
   *   лоты реестра: вопрос о состоянии и `OpenLot`
   */
  def apply(
      auctionId: String,
      clock: Clock,
      newId: () => UUID,
      lots: AuctionLots,
      snapshotEvery: Int = DefaultSnapshotEvery
  ): Behavior[Command] =
    Behaviors.setup { context =>
      val persistenceId = PersistenceId(TypeKey.name, auctionId)
      val tag = Set(AuctionTags.of(Persistence(context.system.classicSystem).sliceForPersistenceId(persistenceId.id)))

      // Знание о лотах несохраняемо по решению (RFC-011): рестарт пересоздаёт замыкание пустым, и устаревшее знание
      // recovery пережить не может. Меняют его только сообщения этой entity, по одному.
      var roster = LotRoster.empty

      def follow(step: (LotRoster, List[LotInstruction])): Unit = {
        val (known, instructions) = step
        roster = known
        instructions.foreach {
          case LotInstruction.Ask(lot) => context.pipeToSelf(lots.stateOf(lot))(LotObserved(lot, _))
          case LotInstruction.Open(lot, command) => context.pipeToSelf(lots.open(lot, command))(LotAnswered(lot, _))
        }
      }

      // Ожидаемый отказ зависимости: лот не ответил в срок. Сообщение исключения в запись не идёт — только его класс.
      def unanswered(lot: LotId, failure: Throwable): Unit = {
        context.log.warn(
          "lot did not answer the auction",
          StructuredArguments.keyValue("auction_id", auctionId),
          StructuredArguments.keyValue("lot_id", lot.value.toString),
          StructuredArguments.keyValue("error_category", "dependency_unavailable"),
          StructuredArguments.keyValue("error", failure.getClass.getName)
        )
        roster = LotRoster.unanswered(roster, lot)
      }

      def onCommand(state: State, command: Command): Effect[StoredAuctionEvent, State] =
        command match {
          case Start(start, initiator, replyTo) =>
            Auction.decide(state.auction, start) match {
              case Left(rejected) => Effect.reply(replyTo)(Left(rejected))
              case Right(decision) =>
                record(state.auction, decision, start.opId, initiator, clock, newId) { (auction, answer) =>
                  replyTo ! Right(answer)
                  follow(LotRoster.started(auction, roster, decision))
                }
            }
          case Roster(replyTo) => Effect.reply(replyTo)(roster)
          case LotObserved(lot, Success(lotState)) =>
            Effect.none.thenRun(after => follow(LotRoster.observed(after.auction, roster, lot, lotState)))
          case LotObserved(lot, Failure(failure)) => Effect.none.thenRun(_ => unanswered(lot, failure))
          case LotAnswered(lot, Success(answer)) =>
            Effect.none.thenRun(_ => roster = LotRoster.opened(roster, lot, answer))
          case LotAnswered(lot, Failure(failure)) => Effect.none.thenRun(_ => unanswered(lot, failure))
          case Inspect(opId, replyTo) => Effect.reply(replyTo)(Auction.inspect(state.auction, opId))
          case Draft(draft, initiator, replyTo) =>
            val decision = Auction.decide(state.auction, draft)
            record(state.auction, decision, draft.opId, initiator, clock, newId)((_, answer) => replyTo ! answer)
          case Add(add, initiator, replyTo) =>
            answered(state.auction, Auction.decide(state.auction, add), add.opId, initiator, replyTo, clock, newId)
          case Remove(remove, initiator, replyTo) =>
            val decision = Auction.decide(state.auction, remove)
            answered(state.auction, decision, remove.opId, initiator, replyTo, clock, newId)
          case Schedule(schedule, initiator, replyTo) =>
            val decision = Auction.decide(state.auction, schedule)
            answered(state.auction, decision, schedule.opId, initiator, replyTo, clock, newId)
          case Get(replyTo) => Effect.reply(replyTo)(state.auction)
        }

      EventSourcedBehavior[Command, StoredAuctionEvent, State](
        persistenceId = persistenceId,
        emptyState = State(Auction.initial, 0),
        commandHandler = onCommand,
        eventHandler = (state, stored) => {
          val sequence = state.sequence + 1
          State(Auction.apply(state.auction, AuctionJournal.envelope(sequence, stored)), sequence)
        }
      ).snapshotAdapter(AuctionJournal.snapshotAdapter)
        .withRetention(RetentionCriteria.snapshotEvery(snapshotEvery, keepNSnapshots = 2))
        .withTagger(_ => tag)
        .receiveSignal { case (state, RecoveryCompleted) => follow(LotRoster.survey(state.auction)) }
    }

  /**
   * Событие команды пишется одним `persist` с конвертом ADR-047; отказ и «без события» ничего не пишут. Ответ получает
   * аукцион после команды: у записанного события — уже с ним.
   */
  private def record(
      auction: Auction,
      decision: AuctionDecision,
      opId: OpId,
      initiator: Initiator,
      clock: Clock,
      newId: () => UUID
  )(reply: (Auction, AuctionAnswer) => Unit): Effect[StoredAuctionEvent, State] =
    decision match {
      case AuctionDecision.Repeated(original) =>
        Effect.none.thenRun(_ => reply(auction, AuctionAnswer.Written(original)))
      case AuctionDecision.Unchanged => Effect.none.thenRun(_ => reply(auction, AuctionAnswer.Unchanged))
      case AuctionDecision.Accepted(event) =>
        val stored = AuctionJournal.store(newId(), newId(), opId, clock.instant(), initiator)(event)
        Effect
          .persist(stored)
          .thenRun(written => reply(written.auction, AuctionAnswer.Written(firstOf(written.auction, opId))))
    }

  /** Команда с именованным отказом: отказ уходит ответом без записи, принятое решение — в [[record]]. */
  private def answered[R](
      auction: Auction,
      decision: Either[R, AuctionDecision],
      opId: OpId,
      initiator: Initiator,
      replyTo: ActorRef[Either[R, AuctionAnswer]],
      clock: Clock,
      newId: () => UUID
  ): Effect[StoredAuctionEvent, State] =
    decision match {
      case Left(rejected) => Effect.reply(replyTo)(Left(rejected))
      case Right(accepted) =>
        record(auction, accepted, opId, initiator, clock, newId)((_, answer) => replyTo ! Right(answer))
    }

  private def firstOf(auction: Auction, opId: OpId): AuctionEnvelope =
    auction.seen.get(opId) match {
      case Some(envelope) => envelope
      case None => throw new IllegalStateException(s"auction applied its own event without op_id ${opId.value}")
    }
}
