package auction.testkit

import org.apache.pekko.actor.typed.ActorRef
import org.apache.pekko.actor.typed.Behavior
import org.apache.pekko.cluster.sharding.typed.scaladsl.EntityTypeKey
import org.apache.pekko.persistence.typed.PersistenceId
import org.apache.pekko.persistence.typed.scaladsl.Effect
import org.apache.pekko.persistence.typed.scaladsl.EventSourcedBehavior

/**
 * Минимальный персистентный агрегат для проверки журнала: каждое `Append` пишет одно событие и отвечает числом событий.
 *
 * Поведения лота и сессии в срезе журнала нет, поэтому инфраструктуру проверяет эта entity. Отказ записи она не
 * перехватывает — `onPersistFailure` не задан, как того требует ADR-045 и от агрегатов сервиса. Событие — `Long`: у
 * Pekko для него встроенный сериализатор, и тест не зависит от выбора сериализации событий аукциона.
 */
object CounterEntity {

  val TypeKey: EntityTypeKey[Command] = EntityTypeKey[Command]("counter")

  sealed trait Command
  final case class Append(replyTo: ActorRef[Long]) extends Command
  final case class Read(replyTo: ActorRef[Long]) extends Command

  def apply(id: String): Behavior[Command] =
    EventSourcedBehavior[Command, Long, Long](
      persistenceId = PersistenceId(TypeKey.name, id),
      emptyState = 0L,
      commandHandler = (count, command) =>
        command match {
          case Append(replyTo) => Effect.persist(1L).thenReply(replyTo)(count => count)
          case Read(replyTo) => Effect.reply(replyTo)(count)
        },
      eventHandler = (count, event) => count + event
    )
}
