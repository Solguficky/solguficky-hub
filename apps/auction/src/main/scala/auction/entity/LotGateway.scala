package auction.entity

import auction.lot.AuctionId
import auction.lot.DraftLot
import auction.lot.DraftLotRejected
import auction.lot.Envelope
import auction.lot.Lot
import auction.lot.PlaceBid
import auction.lot.PlaceBidRejected
import auction.lot.SetProxyLimit
import auction.lot.SetProxyLimitRejected
import auction.lot.WithdrawProxyLimit
import auction.lot.WithdrawProxyLimitRejected
import org.apache.pekko.cluster.sharding.typed.scaladsl.ClusterSharding
import org.apache.pekko.util.Timeout

import java.util.UUID
import scala.concurrent.ExecutionContext
import scala.concurrent.Future
import scala.concurrent.duration.FiniteDuration

/**
 * Команды лота для тех, кто стоит снаружи entity: транспорт отдаёт команду сюда и не знает ни о шардинге, ни об
 * `ActorRef`. Следующая команда лота добавляется методом здесь, а её транспорт — вызовом этого метода.
 */
trait LotGateway {

  /** Рождение лота в аукционе; неудачное `Future` значит то же, что у ставки. */
  def draftLot(lotId: UUID, command: DraftLot, initiator: Initiator): Future[Either[DraftLotRejected, Envelope]]

  /** Аукцион, в котором лот родился; `None` — лот не родился. Читает entity, а не read model. */
  def auctionOf(lotId: UUID): Future[Option[AuctionId]]

  /**
   * Ставка лоту. Неудачное `Future` — ответа нет: ask истёк (например, entity остановилась на отказе записи в журнал)
   * или шардинг не доставил команду. Команда при этом могла быть принята, и повтор с тем же `op_id` вернёт исходный
   * ответ. Принятая ставка приходит с версией лота, с которой её видно в чтении (`LotEntity.Recorded`).
   */
  def placeBid(
      lotId: UUID,
      command: PlaceBid,
      initiator: Initiator
  ): Future[Either[PlaceBidRejected, LotEntity.Recorded]]

  /** Прокси-лимит лоту; неудачное `Future` и версия в ответе значат то же, что у ставки. */
  def setProxyLimit(
      lotId: UUID,
      command: SetProxyLimit,
      initiator: Initiator
  ): Future[Either[SetProxyLimitRejected, LotEntity.Recorded]]

  /** Снятие прокси-лимита; неудачное `Future` значит то же, что у ставки. */
  def withdrawProxyLimit(
      lotId: UUID,
      command: WithdrawProxyLimit,
      initiator: Initiator
  ): Future[Either[WithdrawProxyLimitRejected, Envelope]]
}

object LotGateway {

  /** Шлюз через Cluster Sharding: идентификатор entity — идентификатор лота, как в `AuctionNode.registerLots`. */
  def sharded(sharding: ClusterSharding, askTimeout: FiniteDuration): LotGateway =
    new LotGateway {
      private given Timeout = Timeout(askTimeout)

      def draftLot(lotId: UUID, command: DraftLot, initiator: Initiator): Future[Either[DraftLotRejected, Envelope]] =
        sharding
          .entityRefFor(LotEntity.TypeKey, lotId.toString)
          .ask(replyTo => LotEntity.Draft(command, initiator, replyTo))

      def auctionOf(lotId: UUID): Future[Option[AuctionId]] =
        sharding
          .entityRefFor(LotEntity.TypeKey, lotId.toString)
          .ask[Lot](LotEntity.Get(_))
          .map(_.auction)(using ExecutionContext.parasitic)

      def placeBid(
          lotId: UUID,
          command: PlaceBid,
          initiator: Initiator
      ): Future[Either[PlaceBidRejected, LotEntity.Recorded]] =
        sharding
          .entityRefFor(LotEntity.TypeKey, lotId.toString)
          .ask(replyTo => LotEntity.Bid(command, initiator, replyTo))

      def setProxyLimit(
          lotId: UUID,
          command: SetProxyLimit,
          initiator: Initiator
      ): Future[Either[SetProxyLimitRejected, LotEntity.Recorded]] =
        sharding
          .entityRefFor(LotEntity.TypeKey, lotId.toString)
          .ask(replyTo => LotEntity.SetLimit(command, initiator, replyTo))

      def withdrawProxyLimit(
          lotId: UUID,
          command: WithdrawProxyLimit,
          initiator: Initiator
      ): Future[Either[WithdrawProxyLimitRejected, Envelope]] =
        sharding
          .entityRefFor(LotEntity.TypeKey, lotId.toString)
          .ask(replyTo => LotEntity.WithdrawLimit(command, initiator, replyTo))
    }
}
