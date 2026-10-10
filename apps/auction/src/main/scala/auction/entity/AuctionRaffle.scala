package auction.entity

import auction.raffle.OpenRaffle
import auction.raffle.RaffleEntity
import org.apache.pekko.Done
import org.apache.pekko.cluster.sharding.typed.scaladsl.ClusterSharding
import org.apache.pekko.util.Timeout

import java.time.Instant
import scala.concurrent.Future
import scala.concurrent.duration.FiniteDuration

/**
 * Розыгрыш, каким его видит entity аукциона: только открытие регистрации (ADR-066, п. 5). Открывает аукцион, потому что
 * розыгрыш рождается вместе с его планированием, а окно регистрации начинается фактическим открытием онлайн-торгов.
 * Неудачное `Future` — ответа нет, и аукцион спросит ещё раз на тике переспроса: открытие идемпотентно.
 */
trait AuctionRaffle {
  def open(auctionId: String, closesAt: Instant): Future[Done]
}

object AuctionRaffle {

  /** Аукцион без розыгрыша в узле: тесты аукциона, которым розыгрыш не нужен. */
  val none: AuctionRaffle = (_, _) => Future.successful(Done)

  def sharded(sharding: ClusterSharding, askTimeout: FiniteDuration): AuctionRaffle =
    new AuctionRaffle {
      private given Timeout = Timeout(askTimeout)

      def open(auctionId: String, closesAt: Instant): Future[Done] =
        sharding
          .entityRefFor(RaffleEntity.TypeKey, auctionId)
          .ask[Done](RaffleEntity.Open(OpenRaffle(closesAt), _))
    }
}
