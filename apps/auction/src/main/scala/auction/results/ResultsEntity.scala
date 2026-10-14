package auction.results

import auction.lot.AuctionId
import auction.lot.ParticipantId
import net.logstash.logback.argument.StructuredArguments
import org.apache.pekko.Done
import org.apache.pekko.actor.typed.ActorRef
import org.apache.pekko.actor.typed.Behavior
import org.apache.pekko.actor.typed.scaladsl.Behaviors
import org.apache.pekko.cluster.sharding.typed.scaladsl.EntityTypeKey
import org.apache.pekko.persistence.Persistence
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
 * Итоги прогнозов аукциона как персистентный агрегат под Cluster Sharding — отдельная entity со своим журналом рядом с
 * прогнозами и розыгрышем (ADR-067, п. 8): persistence id `results|<auction_id>`. Решение в [[Results]],
 * `onPersistFailure` не задан (ADR-045).
 *
 * Торгов entity не знает по построению: снимок исходов лотов она получает портом [[ResultsOutcomes]], а прогнозы —
 * [[ResultsForecasts]] (п. 1). Подсчёт ведёт аукцион: он зовёт `Settle`, когда переходит в `Finished`, и повторяет,
 * пока не получит ответ. Итог считается один раз: посчитанное или подведённое вручную повтор не меняет и второго
 * события не пишет. Отменённый аукцион `Settle` не зовёт — отмена итогов не даёт (п. 4).
 *
 * Таймеров у entity нет, поэтому шардинг её не помнит. Строки итогов и имена пишет только эта entity; пока запрос в
 * полёте, остальные команды ждут в stash. Хранилище не ответило — ответа нет: повтор снова доведёт подсчёт.
 */
object ResultsEntity {

  val TypeKey: EntityTypeKey[Command] = EntityTypeKey[Command]("results")

  sealed trait Command

  final case class Settle(replyTo: ActorRef[Either[SettleRefused, Done]]) extends Command

  /** Ручная отметка итогов: автоподсчёт пропускается (п. 8). Повтор принят без второго события. */
  final case class RecordManually(replyTo: ActorRef[Done]) extends Command

  /** Удаление вместе с аукционом: сначала строки, затем событие. Ответ — после события. */
  final case class Discard(replyTo: ActorRef[Done]) extends Command

  final case class Get(replyTo: ActorRef[Results]) extends Command

  private[results] final case class Computed(
      replyTo: ActorRef[Either[SettleRefused, Done]],
      answer: Try[Either[SettleRefused, Settlement]]
  ) extends Command

  private[results] final case class Named(
      replyTo: ActorRef[Either[SettleRefused, Done]],
      answer: Try[(Settlement, Map[ParticipantId, String])]
  ) extends Command

  private[results] final case class Recorded(
      replyTo: ActorRef[Either[SettleRefused, Done]],
      outcomes: List[NominationOutcome],
      answer: Try[Unit]
  ) extends Command

  private[results] final case class Wiped(replyTo: ActorRef[Done], answer: Try[Unit]) extends Command

  def apply(
      auctionId: String,
      clock: Clock,
      newId: () => UUID,
      outcomes: ResultsOutcomes,
      forecasts: ResultsForecasts,
      names: ResultNames,
      store: ResultsStore
  ): Behavior[Command] =
    Behaviors.setup { context =>
      import context.executionContext
      val auction = AuctionId(UUID.fromString(auctionId))

      // Запрос в полёте. Рестарт начинает с `false`: ответ прошлой инкарнации до новой не дойдёт.
      var busy = false

      def warn(message: String, failure: Throwable): Unit =
        context.log.warn(
          message,
          StructuredArguments.keyValue("auction_id", auctionId),
          StructuredArguments.keyValue("error_category", "dependency_unavailable"),
          StructuredArguments.keyValue("error", failure.getClass.getName)
        )

      def step(event: Option[ResultsEvent], replyTo: ActorRef[Done]): EffectBuilder[StoredResultsEvent, Results] =
        event match {
          case Some(written) =>
            Effect
              .persist(ResultsJournal.store(newId(), clock.instant())(written))
              .thenRun((_: Results) => replyTo ! Done)
          case None => Effect.none.thenRun((_: Results) => replyTo ! Done)
        }

      /** Подсчёт: снимок исходов лотов, снимок прогнозов и чистое ядро. `None`-снимок и пустой — не считаются. */
      def compute(): Future[Either[SettleRefused, Settlement]] =
        attempt {
          for {
            snapshot <- outcomes.outcomes(auction)
            all <- forecasts.forecasts(auction)
          } yield snapshot match {
            case Some(lots) if lots.nonEmpty => Right(Results.count(lots, all))
            case _ => Left(SettleRefused.NotComplete)
          }
        }

      /** Синхронный отказ порта приходит неудачей, а не роняет entity в обработке сообщения. */
      def attempt[A](asked: => Future[A]): Future[A] =
        Try(asked) match {
          case Success(answer) => answer
          case Failure(failure) => Future.failed(failure)
        }

      def rows(settlement: Settlement, names: Map[ParticipantId, String]): List[ResultRow] =
        settlement.participants.flatMap { participant =>
          val name = names.getOrElse(participant.participant, "")
          participant.perNomination.map {
            case (nomination, Participation.Guessed) =>
              ResultRow(participant.participant, nomination, guessed = true, None, name)
            case (nomination, Participation.Missed(deviation)) =>
              ResultRow(participant.participant, nomination, guessed = false, deviation, name)
          }
        }

      def onCommand(state: Results, command: Command): Effect[StoredResultsEvent, Results] =
        command match {
          // Ответы своих запросов идут раньше сторожа `busy`: они и есть то, чего он ждёт.
          case Computed(replyTo, Success(Right(settlement))) =>
            val participants = settlement.participants.map(_.participant).toSet
            val named = attempt(names.names(auction, participants)).map(known => (settlement, known))
            Effect.none.thenRun((_: Results) => context.pipeToSelf(named)(Named(replyTo, _)))
          case Computed(replyTo, Success(Left(refused))) =>
            busy = false
            Effect.none.thenRun((_: Results) => replyTo ! Left(refused)).thenUnstashAll()
          case Computed(replyTo, Failure(failure)) =>
            busy = false
            Effect.none
              .thenRun { (_: Results) =>
                warn("results outcomes did not answer", failure)
                replyTo ! Left(SettleRefused.NotComplete)
              }
              .thenUnstashAll()
          case Named(replyTo, Success((settlement, known))) =>
            val written = rows(settlement, known)
            Effect.none.thenRun { (_: Results) =>
              context.pipeToSelf(store.record(auction, written))(Recorded(replyTo, settlement.outcomes, _))
            }
          case Named(replyTo, Failure(failure)) =>
            busy = false
            Effect.none
              .thenRun { (_: Results) =>
                warn("results names did not answer", failure)
                replyTo ! Left(SettleRefused.NotComplete)
              }
              .thenUnstashAll()
          case Recorded(replyTo, outcomes, Success(_)) =>
            busy = false
            Effect
              .persist(ResultsJournal.store(newId(), clock.instant())(ResultsEvent.ResultsSettled(outcomes)))
              .thenRun((_: Results) => replyTo ! Right(Done))
              .thenUnstashAll()
          case Recorded(replyTo, _, Failure(failure)) =>
            busy = false
            Effect.none
              .thenRun { (_: Results) =>
                warn("results rows did not record", failure)
                replyTo ! Left(SettleRefused.NotComplete)
              }
              .thenUnstashAll()
          case Wiped(replyTo, Success(_)) =>
            busy = false
            step(Results.discard(state), replyTo).thenUnstashAll()
          case Wiped(_, Failure(failure)) =>
            busy = false
            Effect.none.thenRun((_: Results) => warn("results rows did not discard", failure)).thenUnstashAll()
          case _ if busy => Effect.stash()
          case Settle(replyTo) =>
            state match {
              case Results.Unsettled =>
                busy = true
                Effect.none.thenRun((_: Results) => context.pipeToSelf(compute())(Computed(replyTo, _)))
              case Results.Counted(_) | Results.ByHand => Effect.reply(replyTo)(Right(Done))
            }
          case RecordManually(replyTo) => step(Results.recordByHand(state), replyTo)
          case Discard(replyTo) =>
            busy = true
            Effect.none.thenRun((_: Results) => context.pipeToSelf(store.discard(auction))(Wiped(replyTo, _)))
          case Get(replyTo) => Effect.reply(replyTo)(state)
        }

      val persistenceId = PersistenceId(TypeKey.name, auctionId)
      // Тег один на итоги: срез зависит только от persistence id (ResultsTags); по тегу их читает публикация факта.
      val tag = Set(ResultsTags.of(Persistence(context.system.classicSystem).sliceForPersistenceId(persistenceId.id)))
      EventSourcedBehavior[Command, StoredResultsEvent, Results](
        persistenceId = persistenceId,
        emptyState = Results.initial,
        commandHandler = onCommand,
        eventHandler = (state, stored) => Results.apply(state, ResultsJournal.restoreEvent(stored.event))
      ).withTagger(_ => tag)
    }
}
