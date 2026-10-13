package auction.prediction

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
 * Прогнозы аукциона как персистентный агрегат под Cluster Sharding — отдельная entity со своим журналом рядом с
 * аукционом, как розыгрыш (ADR-067, п. 1): persistence id `predictions|<auction_id>`. Решение в [[Predictions]],
 * `onPersistFailure` не задан (ADR-045).
 *
 * Ход раундов ведёт аукцион командами `Open`, `Close`, `Cancel` и `Discard` и повторяет их, пока не получит ответ: все
 * четыре идемпотентны. Таймеров у entity нет, поэтому шардинг её не помнит.
 *
 * Прогнозы — строки [[PredictionStore]], и пишет их только эта entity. Пока запрос к хранилищу в полёте, остальные
 * команды ждут в stash: закрытие раунда не обгоняет принятую запись, а запись, пришедшая после закрытия, получает
 * отказ. Строки на момент закрытия поэтому и есть прогноз, зафиксированный раундом. Хранилище не ответило — ответа нет:
 * команда могла записаться, и повтор с тем же `op_id` вернёт исходный ответ.
 */
object PredictionEntity {

  val TypeKey: EntityTypeKey[Command] = EntityTypeKey[Command]("predictions")

  sealed trait Command

  final case class Open(round: PredictionRound, replyTo: ActorRef[Done]) extends Command

  final case class Close(round: PredictionRound, replyTo: ActorRef[Done]) extends Command

  final case class Cancel(replyTo: ActorRef[Done]) extends Command

  /** Удаление вместе с аукционом: сначала строки, затем событие. Ответ — после события. */
  final case class Discard(replyTo: ActorRef[Done]) extends Command

  final case class Submit(command: SubmitForecast, replyTo: ActorRef[Either[SubmitRejected, Forecast]]) extends Command

  final case class Get(replyTo: ActorRef[Predictions]) extends Command

  private[prediction] final case class Submitted(
      replyTo: ActorRef[Either[SubmitRejected, Forecast]],
      answer: Try[Either[SubmitRejected, Forecast]]
  ) extends Command

  private[prediction] final case class Wiped(replyTo: ActorRef[Done], answer: Try[Unit]) extends Command

  def apply(auctionId: String, clock: Clock, newId: () => UUID, store: PredictionStore): Behavior[Command] =
    Behaviors.setup { context =>
      import context.executionContext
      val auction = AuctionId(UUID.fromString(auctionId))

      // Запрос к хранилищу в полёте. Рестарт начинает с `false`: ответ прошлой инкарнации до новой не дойдёт.
      var busy = false

      def warn(message: String, failure: Throwable): Unit =
        context.log.warn(
          message,
          StructuredArguments.keyValue("auction_id", auctionId),
          StructuredArguments.keyValue("error_category", "dependency_unavailable"),
          StructuredArguments.keyValue("error", failure.getClass.getName)
        )

      def step(
          event: Option[PredictionEvent],
          replyTo: ActorRef[Done]
      ): EffectBuilder[StoredPredictionEvent, Predictions] =
        event match {
          case Some(written) =>
            Effect.persist(PredictionJournal.store(newId(), clock.instant())(written)).thenRun(_ => replyTo ! Done)
          case None => Effect.none.thenRun(_ => replyTo ! Done)
        }

      /** Повтор отправки в раунд, который её уже не примет: исходный ответ своему повтору, иначе отказ раунда. */
      def recall(
          command: SubmitForecast,
          rejected: SubmitRejected
      ): Future[Either[SubmitRejected, Forecast]] =
        store.recall(auction, command.participant, command.round, command.opId).map {
          case Some(answer) => answer
          case None => Left(rejected)
        }

      def onCommand(state: Predictions, command: Command): Effect[StoredPredictionEvent, Predictions] =
        command match {
          case Submitted(replyTo, answer) =>
            busy = false
            answer match {
              case Success(outcome) => Effect.none.thenRun((_: Predictions) => replyTo ! outcome).thenUnstashAll()
              case Failure(failure) =>
                Effect.none
                  .thenRun((_: Predictions) => warn("prediction store did not answer", failure))
                  .thenUnstashAll()
            }
          case Wiped(replyTo, Success(())) =>
            busy = false
            step(Predictions.discard(state), replyTo).thenUnstashAll()
          case Wiped(_, Failure(failure)) =>
            busy = false
            Effect.none.thenRun((_: Predictions) => warn("prediction store did not discard", failure)).thenUnstashAll()
          case _ if busy => Effect.stash()
          case Open(round, replyTo) => step(Predictions.open(state, round), replyTo)
          case Close(round, replyTo) => step(Predictions.close(state, round), replyTo)
          case Cancel(replyTo) => step(Predictions.cancel(state), replyTo)
          case Discard(replyTo) =>
            busy = true
            Effect.none.thenRun(_ => context.pipeToSelf(store.discard(auction))(Wiped(replyTo, _)))
          case Submit(submit, replyTo) =>
            busy = true
            val answer = Predictions.admits(state, submit.round) match {
              case Right(()) => store.submit(auction, submit)
              case Left(rejected) => recall(submit, rejected)
            }
            Effect.none.thenRun(_ => context.pipeToSelf(answer)(Submitted(replyTo, _)))
          case Get(replyTo) => Effect.reply(replyTo)(state)
        }

      EventSourcedBehavior[Command, StoredPredictionEvent, Predictions](
        persistenceId = PersistenceId(TypeKey.name, auctionId),
        emptyState = Predictions.initial,
        commandHandler = onCommand,
        eventHandler = (state, stored) => Predictions.apply(state, PredictionJournal.restoreEvent(stored.event))
      )
    }
}
