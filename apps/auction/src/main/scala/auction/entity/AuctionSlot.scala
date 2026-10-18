package auction.entity

import auction.lot.AuctionId
import auction.slot.TradingSlotEntity
import org.apache.pekko.Done
import org.apache.pekko.cluster.sharding.typed.scaladsl.ClusterSharding
import org.apache.pekko.util.Timeout

import java.util.UUID
import scala.concurrent.Future
import scala.concurrent.duration.FiniteDuration

/**
 * Порт аукциона к слоту торгов сообщества (ADR-047, дополнение 2026-10-12): занятие до записи `PrebiddingStarted` и
 * освобождение на переходе в конечное состояние. Неудачное `Future` — слот не ответил в срок.
 */
trait AuctionSlot {
  def claim(auctionId: String): Future[TradingSlotEntity.Claimed]
  def release(auctionId: String): Future[Done]
}

object AuctionSlot {

  /** Слот, который отдаётся всегда: тесты аукциона, которым правило одного аукциона не нужно. */
  val none: AuctionSlot = new AuctionSlot {
    def claim(auctionId: String): Future[TradingSlotEntity.Claimed] =
      Future.successful(TradingSlotEntity.Claimed.Granted)
    def release(auctionId: String): Future[Done] = Future.successful(Done)
  }

  /**
   * @param askTimeout
   *   срок ответа слота; длиннее срока, в который слот ждёт держателя, и короче срока команды открытия у шлюза
   */
  def sharded(sharding: ClusterSharding, askTimeout: FiniteDuration): AuctionSlot =
    new AuctionSlot {
      private given Timeout = Timeout(askTimeout)

      private def slot = sharding.entityRefFor(TradingSlotEntity.TypeKey, TradingSlotEntity.CommunityId)

      def claim(auctionId: String): Future[TradingSlotEntity.Claimed] =
        slot.ask[TradingSlotEntity.Claimed](TradingSlotEntity.Claim(AuctionId(UUID.fromString(auctionId)), _))

      def release(auctionId: String): Future[Done] =
        slot.ask[Done](TradingSlotEntity.Release(AuctionId(UUID.fromString(auctionId)), _))
    }
}
