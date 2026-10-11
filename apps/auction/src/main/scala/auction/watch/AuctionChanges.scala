package auction.watch

import org.apache.pekko.NotUsed
import org.apache.pekko.stream.BoundedSourceQueue
import org.apache.pekko.stream.scaladsl.Source

import java.sql.Connection
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import scala.util.Using

/**
 * Источник изменений аукциона для потоков чтения (PER-335): gRPC `WatchAuction`, а дальше SSE экрана зала (PER-484).
 * Изменение не несёт данных — только повод перечитать read model: каждое сообщение потока — состояние целиком, и
 * читается оно из проекции, а не из сигнала.
 */
trait AuctionChanges {

  /**
   * Поводы перечитать аукцион. Первый повод приходит сразу при подписке, следующие — после каждого коммита проекции,
   * который тронул аукцион или лот в нём. Подписка регистрируется при материализации, до первого повода, поэтому
   * изменение, закоммиченное после начала первого чтения, даёт ещё один повод: окна потери между снимком и подпиской
   * нет. Повод, пришедший, пока предыдущий ещё не забран, с ним склеивается: чтение после забора всё равно увидит оба
   * изменения, а медленный подписчик не копит очередь.
   */
  def subscribe(auctionId: UUID): Source[Unit, NotUsed]
}

object AuctionChanges {

  /** Канал `LISTEN`/`NOTIFY`, в который проекции пишут аукцион, и payload — его `auction_id` строкой. */
  val Channel = "auction_changed"

  /**
   * Сигнал из транзакции проекции. PostgreSQL доставляет `NOTIFY` только после коммита и не доставляет на откате,
   * поэтому повод не обгоняет строку read model, которую он объявляет. Одинаковые сигналы одной транзакции база
   * склеивает сама.
   */
  def announce(connection: Connection, auctionId: UUID): Unit =
    Using.resource(connection.prepareStatement("SELECT pg_notify(?, ?)")) { statement =>
      statement.setString(1, Channel)
      statement.setString(2, auctionId.toString)
      statement.execute()
    }
}

/**
 * Подписчики по аукционам. Поводы раздаёт слушатель базы: `changed` — коммит, тронувший аукцион, `everything` —
 * слушатель мог пропустить сигналы (подключился или переподключился), и перечитать должен каждый.
 *
 * У подписчика очередь на один повод: занятая очередь значит, что повод уже ждёт чтения, и второй ничего не добавляет.
 */
final class ChangeRegistry extends AuctionChanges {

  private val subscribers =
    ConcurrentHashMap[UUID, ConcurrentHashMap.KeySetView[BoundedSourceQueue[Unit], java.lang.Boolean]]()

  def subscribe(auctionId: UUID): Source[Unit, NotUsed] =
    Source
      .queue[Unit](1)
      .mapMaterializedValue { queue =>
        subscribers.computeIfAbsent(auctionId, _ => ConcurrentHashMap.newKeySet()).add(queue)
        queue.offer(())
        queue
      }
      .watchTermination() { (queue, done) =>
        done.onComplete(_ => remove(auctionId, queue))(using scala.concurrent.ExecutionContext.parasitic)
        NotUsed
      }

  def changed(auctionId: UUID): Unit =
    Option(subscribers.get(auctionId)).foreach(_.forEach(_.offer(())))

  def everything(): Unit =
    subscribers.forEach((_, queues) => queues.forEach(_.offer(())))

  /** Число подписок аукциона — для тестов: отписка обязана убирать очередь. */
  def subscriptions(auctionId: UUID): Int = Option(subscribers.get(auctionId)).fold(0)(_.size)

  private def remove(auctionId: UUID, queue: BoundedSourceQueue[Unit]): Unit =
    subscribers.computeIfPresent(
      auctionId,
      (_, queues) => {
        queues.remove(queue)
        if (queues.isEmpty) null else queues
      }
    )
}
