package auction.entity

import auction.prediction.PredictionEntity
import auction.prediction.PredictionRound
import org.apache.pekko.Done
import org.apache.pekko.cluster.sharding.typed.scaladsl.ClusterSharding
import org.apache.pekko.util.Timeout

import scala.concurrent.Future
import scala.concurrent.duration.FiniteDuration

/**
 * Прогнозы, какими их видит entity аукциона (ADR-067, п. 4): раунды открываются и закрываются по фактам аукциона, игра
 * отменяется вместе с ним и удаляется до его удаления. Неудачное `Future` — ответа нет; все четыре команды
 * идемпотентны, и аукцион повторяет их, пока не получит ответ.
 */
trait AuctionPredictions {
  def open(auctionId: String, round: PredictionRound): Future[Done]

  def close(auctionId: String, round: PredictionRound): Future[Done]

  def cancel(auctionId: String): Future[Done]

  def discard(auctionId: String): Future[Done]
}

object AuctionPredictions {

  /** Аукцион без прогнозов в узле: тесты аукциона, которым игра не нужна. */
  val none: AuctionPredictions = new AuctionPredictions {
    def open(auctionId: String, round: PredictionRound): Future[Done] = Future.successful(Done)

    def close(auctionId: String, round: PredictionRound): Future[Done] = Future.successful(Done)

    def cancel(auctionId: String): Future[Done] = Future.successful(Done)

    def discard(auctionId: String): Future[Done] = Future.successful(Done)
  }

  def sharded(sharding: ClusterSharding, askTimeout: FiniteDuration): AuctionPredictions =
    new AuctionPredictions {
      private given Timeout = Timeout(askTimeout)

      private def entity(auctionId: String) = sharding.entityRefFor(PredictionEntity.TypeKey, auctionId)

      def open(auctionId: String, round: PredictionRound): Future[Done] =
        entity(auctionId).ask[Done](PredictionEntity.Open(round, _))

      def close(auctionId: String, round: PredictionRound): Future[Done] =
        entity(auctionId).ask[Done](PredictionEntity.Close(round, _))

      def cancel(auctionId: String): Future[Done] = entity(auctionId).ask[Done](PredictionEntity.Cancel(_))

      def discard(auctionId: String): Future[Done] = entity(auctionId).ask[Done](PredictionEntity.Discard(_))
    }
}
