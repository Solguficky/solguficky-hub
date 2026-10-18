package auction.entity

import auction.results.ResultsEntity
import auction.results.SettleRefused
import org.apache.pekko.Done
import org.apache.pekko.cluster.sharding.typed.scaladsl.ClusterSharding
import org.apache.pekko.util.Timeout

import scala.concurrent.Future
import scala.concurrent.duration.FiniteDuration

/**
 * Итоги прогнозов, какими их видит entity аукциона (ADR-067, п. 8): подсчёт по переходу в `Finished`, ручная отметка и
 * удаление вместе с аукционом до торгов. Торгов entity итогов не знает — она получает снимок исходов лотов портом, — и
 * сюда приходит только команда. Неудачное `Future` — ответа нет; все команды идемпотентны, и аукцион повторяет их на
 * тике переспроса и после recovery, пока не получит ответ.
 */
trait AuctionResults {
  def settle(auctionId: String): Future[Either[SettleRefused, Done]]

  def recordManually(auctionId: String): Future[Done]

  def discard(auctionId: String): Future[Done]
}

object AuctionResults {

  /** Аукцион без итогов в узле: тесты аукциона, которым подсчёт не нужен. */
  val none: AuctionResults = new AuctionResults {
    def settle(auctionId: String): Future[Either[SettleRefused, Done]] = Future.successful(Right(Done))

    def recordManually(auctionId: String): Future[Done] = Future.successful(Done)

    def discard(auctionId: String): Future[Done] = Future.successful(Done)
  }

  def sharded(sharding: ClusterSharding, askTimeout: FiniteDuration): AuctionResults =
    new AuctionResults {
      private given Timeout = Timeout(askTimeout)

      private def entity(auctionId: String) = sharding.entityRefFor(ResultsEntity.TypeKey, auctionId)

      def settle(auctionId: String): Future[Either[SettleRefused, Done]] =
        entity(auctionId).ask(ResultsEntity.Settle(_))

      def recordManually(auctionId: String): Future[Done] = entity(auctionId).ask(ResultsEntity.RecordManually(_))

      def discard(auctionId: String): Future[Done] = entity(auctionId).ask(ResultsEntity.Discard(_))
    }
}
