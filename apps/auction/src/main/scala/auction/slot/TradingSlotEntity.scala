package auction.slot

import auction.lot.AuctionId
import net.logstash.logback.argument.StructuredArguments
import org.apache.pekko.Done
import org.apache.pekko.actor.typed.ActorRef
import org.apache.pekko.actor.typed.Behavior
import org.apache.pekko.actor.typed.scaladsl.Behaviors
import org.apache.pekko.cluster.sharding.typed.scaladsl.EntityTypeKey
import org.apache.pekko.persistence.typed.PersistenceId
import org.apache.pekko.persistence.typed.scaladsl.Effect
import org.apache.pekko.persistence.typed.scaladsl.EffectBuilder
import org.apache.pekko.persistence.typed.scaladsl.EventSourcedBehavior

import java.time.Clock
import java.util.UUID
import scala.concurrent.Future
import scala.util.Failure
import scala.util.Success
import scala.util.Try

/**
 * Вопрос слота держателю: идут ли у аукциона торги. Ответ — `true`, если торги идут или открытие в полёте; неудачное
 * `Future` — держатель не ответил в срок, и срок несёт сама реализация.
 */
trait SlotHolders {
  def busy(auction: AuctionId): Future[Boolean]
}

/**
 * Слот торгов сообщества как персистентный агрегат под Cluster Sharding (ADR-047, дополнение 2026-10-12): один на
 * сообщество, с постоянным идентификатором — persistence id `trading-slot|community`. Решение в [[TradingSlot]],
 * `onPersistFailure` не задан (ADR-045).
 *
 * Торгов пакет не знает по построению, как розыгрыш: состояние держателя он получает только ответом порта
 * [[SlotHolders]]. Пока слот ждёт этого ответа, занятие и освобождение откладываются в stash: вопрос и решение по нему
 * не перекрываются с другим занятием, и два аукциона не получают слот одновременно. Держатель не ответил в срок — слот
 * остаётся за ним, а просящий получает `Unavailable`: отданный на молчании слот мог бы дать два аукциона со ставками.
 *
 * Таймеров у слота нет, и шардинг его не помнит: будят его вопросы аукционов.
 */
object TradingSlotEntity {

  val TypeKey: EntityTypeKey[Command] = EntityTypeKey[Command]("trading-slot")

  /** Единственный идентификатор слота: торги одного аукциона на всё сообщество. */
  val CommunityId: String = "community"

  /** Ответ на занятие: слот твой, слот у другого аукциона или держатель не ответил. */
  enum Claimed {
    case Granted
    case Taken(holder: AuctionId)
    case Unavailable
  }

  sealed trait Command

  /** Занятие аукционом, решившим открыть торги; повтор того же аукциона — «занят тобой». */
  final case class Claim(auction: AuctionId, replyTo: ActorRef[Claimed]) extends Command

  /** Освобождение аукционом, пришедшим в конечное состояние. Ответ — после записи или сразу, если слот не его. */
  final case class Release(auction: AuctionId, replyTo: ActorRef[Done]) extends Command

  final case class Get(replyTo: ActorRef[TradingSlot]) extends Command

  /** Ответ держателя на вопрос слота; неудача — ответа нет. */
  private[slot] final case class HolderAnswered(
      auction: AuctionId,
      holder: AuctionId,
      replyTo: ActorRef[Claimed],
      answer: Try[Boolean]
  ) extends Command

  def apply(clock: Clock, newId: () => UUID, holders: SlotHolders): Behavior[Command] =
    Behaviors.setup { context =>
      // Вопрос держателю в полёте; несохраняем: рестарт сбрасывает его вместе с ответом, которого уже не будет, а
      // просящий получает истёкший ask и повторяет занятие.
      var inquiring = false

      def write(events: List[SlotEvent])(reply: => Unit): EffectBuilder[StoredSlotEvent, TradingSlot] =
        if (events.isEmpty) Effect.none.thenRun(_ => reply)
        else {
          val now = clock.instant()
          // Идентификатор строки — свой у каждого события, в том числе у пары «освобождение — занятие».
          Effect.persist(events.map(event => TradingSlotJournal.store(newId(), now)(event))).thenRun(_ => reply)
        }

      def onCommand(slot: TradingSlot, command: Command): Effect[StoredSlotEvent, TradingSlot] =
        command match {
          case Get(replyTo) => Effect.reply(replyTo)(slot)
          case _: Claim | _: Release if inquiring => Effect.stash()
          case Claim(auction, replyTo) =>
            TradingSlot.claim(slot, auction) match {
              case ClaimStep.Granted(events) => write(events)(replyTo ! Claimed.Granted)
              case ClaimStep.AskHolder(holder) =>
                inquiring = true
                Effect.none.thenRun { _ =>
                  context.pipeToSelf(holders.busy(holder))(HolderAnswered(auction, holder, replyTo, _))
                }
            }
          case Release(auction, replyTo) => write(TradingSlot.release(slot, auction))(replyTo ! Done)
          case HolderAnswered(auction, holder, replyTo, answer) =>
            inquiring = false
            val decided = answer match {
              case Success(busy) =>
                TradingSlot.answered(slot, auction, holder, busy) match {
                  case Left(current) => Effect.none.thenRun((_: TradingSlot) => replyTo ! Claimed.Taken(current))
                  case Right(events) => write(events)(replyTo ! Claimed.Granted)
                }
              // Ожидаемый отказ зависимости: держатель не ответил в срок. Сообщение исключения в запись не идёт.
              case Failure(failure) =>
                Effect.none.thenRun { (_: TradingSlot) =>
                  context.log.warn(
                    "trading slot holder did not answer",
                    StructuredArguments.keyValue("auction_id", auction.value.toString),
                    StructuredArguments.keyValue("holder_id", holder.value.toString),
                    StructuredArguments.keyValue("error_category", "dependency_unavailable"),
                    StructuredArguments.keyValue("error", failure.getClass.getName)
                  )
                  replyTo ! Claimed.Unavailable
                }
            }
            decided.thenUnstashAll()
        }

      EventSourcedBehavior[Command, StoredSlotEvent, TradingSlot](
        persistenceId = PersistenceId(TypeKey.name, CommunityId),
        emptyState = TradingSlot.initial,
        commandHandler = onCommand,
        eventHandler = (slot, stored) => TradingSlot.apply(slot, TradingSlotJournal.restore(stored))
      )
    }
}
