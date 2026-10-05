package auction.entity

import auction.aggregate.*
import auction.lot.AuctionId
import auction.lot.OpId
import org.apache.pekko.cluster.sharding.typed.scaladsl.ClusterSharding
import org.apache.pekko.util.Timeout

import scala.concurrent.Future
import scala.concurrent.duration.FiniteDuration

/**
 * Команды аукциона для тех, кто стоит снаружи entity, — как [[LotGateway]]. Неудачное `Future` — ответа нет: ask истёк
 * или шардинг не доставил команду; команда могла быть принята, и повтор с тем же `op_id` вернёт исходный ответ.
 */
trait AuctionGateway {
  def inspect(auctionId: AuctionId, opId: OpId): Future[Inspection]

  def draft(auctionId: AuctionId, command: DraftAuction, initiator: Initiator): Future[AuctionAnswer]

  def addLot(auctionId: AuctionId, command: AddLot, initiator: Initiator): Future[Either[AddLotRejected, AuctionAnswer]]

  def removeLot(
      auctionId: AuctionId,
      command: RemoveLot,
      initiator: Initiator
  ): Future[Either[RemoveLotRejected, AuctionAnswer]]

  def schedule(
      auctionId: AuctionId,
      command: ScheduleAuction,
      initiator: Initiator
  ): Future[Either[ScheduleAuctionRejected, AuctionAnswer]]

  /** Открытие онлайн-торгов. Ответ приходит после записи события и подтверждений лотов не ждёт. */
  def startPrebidding(
      auctionId: AuctionId,
      command: StartPrebidding,
      initiator: Initiator
  ): Future[Either[StartPrebiddingRejected, AuctionAnswer]]

  /** Условия торгов лоту реестра. Ответ приходит после ответа лота: событие пишет он, а не аукцион. */
  def scheduleLot(
      auctionId: AuctionId,
      command: ScheduleAuctionLot,
      initiator: Initiator
  ): Future[Either[ScheduleAuctionLotRejected, Unit]]
}

object AuctionGateway {

  /**
   * Шлюз через Cluster Sharding: идентификатор entity — идентификатор аукциона, как в `AuctionNode.registerAuctions`.
   */
  def sharded(sharding: ClusterSharding, askTimeout: FiniteDuration): AuctionGateway =
    new AuctionGateway {
      private given Timeout = Timeout(askTimeout)

      private def entity(auctionId: AuctionId) =
        sharding.entityRefFor(AuctionEntity.TypeKey, auctionId.value.toString)

      def inspect(auctionId: AuctionId, opId: OpId): Future[Inspection] =
        entity(auctionId).ask(AuctionEntity.Inspect(opId, _))

      def draft(auctionId: AuctionId, command: DraftAuction, initiator: Initiator): Future[AuctionAnswer] =
        entity(auctionId).ask(AuctionEntity.Draft(command, initiator, _))

      def addLot(
          auctionId: AuctionId,
          command: AddLot,
          initiator: Initiator
      ): Future[Either[AddLotRejected, AuctionAnswer]] =
        entity(auctionId).ask(AuctionEntity.Add(command, initiator, _))

      def removeLot(
          auctionId: AuctionId,
          command: RemoveLot,
          initiator: Initiator
      ): Future[Either[RemoveLotRejected, AuctionAnswer]] =
        entity(auctionId).ask(AuctionEntity.Remove(command, initiator, _))

      def schedule(
          auctionId: AuctionId,
          command: ScheduleAuction,
          initiator: Initiator
      ): Future[Either[ScheduleAuctionRejected, AuctionAnswer]] =
        entity(auctionId).ask(AuctionEntity.Schedule(command, initiator, _))

      def startPrebidding(
          auctionId: AuctionId,
          command: StartPrebidding,
          initiator: Initiator
      ): Future[Either[StartPrebiddingRejected, AuctionAnswer]] =
        entity(auctionId).ask(AuctionEntity.Start(command, initiator, _))

      def scheduleLot(
          auctionId: AuctionId,
          command: ScheduleAuctionLot,
          initiator: Initiator
      ): Future[Either[ScheduleAuctionLotRejected, Unit]] =
        entity(auctionId).ask(AuctionEntity.PlanLot(command, initiator, _))
    }
}
