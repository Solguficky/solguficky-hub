package auction.entity

import auction.lot.Envelope
import auction.lot.PlaceBid
import auction.lot.PlaceBidRejected
import org.apache.pekko.cluster.sharding.typed.scaladsl.ClusterSharding
import org.apache.pekko.util.Timeout

import java.util.UUID
import scala.concurrent.Future
import scala.concurrent.duration.FiniteDuration

/**
 * Команды лота для тех, кто стоит снаружи entity: транспорт отдаёт команду сюда и не знает ни о шардинге, ни об
 * `ActorRef`. Следующая команда лота добавляется методом здесь, а её транспорт — вызовом этого метода.
 */
trait LotGateway {

  /**
   * Ставка лоту. Неудачное `Future` — ответа нет: ask истёк (например, entity остановилась на отказе записи в журнал)
   * или шардинг не доставил команду. Команда при этом могла быть принята, и повтор с тем же `op_id` вернёт исходный
   * ответ.
   */
  def placeBid(lotId: UUID, command: PlaceBid, initiator: Initiator): Future[Either[PlaceBidRejected, Envelope]]
}

object LotGateway {

  /** Шлюз через Cluster Sharding: идентификатор entity — идентификатор лота, как в `AuctionNode.registerLots`. */
  def sharded(sharding: ClusterSharding, askTimeout: FiniteDuration): LotGateway =
    new LotGateway {
      private given Timeout = Timeout(askTimeout)

      def placeBid(lotId: UUID, command: PlaceBid, initiator: Initiator): Future[Either[PlaceBidRejected, Envelope]] =
        sharding
          .entityRefFor(LotEntity.TypeKey, lotId.toString)
          .ask(replyTo => LotEntity.Bid(command, initiator, replyTo))
    }
}
