package auction.raffle

import auction.lot.AuctionId
import com.typesafe.config.Config
import org.apache.pekko.cluster.sharding.typed.scaladsl.ClusterSharding
import org.apache.pekko.util.Timeout

import scala.concurrent.Future
import scala.concurrent.duration.FiniteDuration
import scala.jdk.DurationConverters.*

/**
 * Команды и чтение розыгрыша для транспорта — как `LotGateway` у лота. Неудачное `Future` — ответа нет: ask истёк или
 * шардинг не доставил команду; команда могла быть принята, и повтор с тем же `op_id` вернёт исходный ответ.
 */
trait RaffleGateway {
  def register(auction: AuctionId, command: Register): Future[Either[RegistrationRejected, Raffle]]

  def cancel(auction: AuctionId, command: CancelRegistration): Future[Either[RegistrationRejected, Raffle]]

  def get(auction: AuctionId): Future[Raffle]
}

object RaffleGateway {

  def sharded(sharding: ClusterSharding, askTimeout: FiniteDuration): RaffleGateway =
    new RaffleGateway {
      private given Timeout = Timeout(askTimeout)

      private def entity(auction: AuctionId) = sharding.entityRefFor(RaffleEntity.TypeKey, auction.value.toString)

      def register(auction: AuctionId, command: Register): Future[Either[RegistrationRejected, Raffle]] =
        entity(auction).ask(RaffleEntity.Enter(command, _))

      def cancel(auction: AuctionId, command: CancelRegistration): Future[Either[RegistrationRejected, Raffle]] =
        entity(auction).ask(RaffleEntity.Leave(command, _))

      def get(auction: AuctionId): Future[Raffle] = entity(auction).ask(RaffleEntity.Get(_))
    }
}

object RaffleSettings {

  /** Окно проверки права обязано кончиться до раунда маяка: иначе решение о пуле могло бы прийти после его выхода. */
  def fromConfig(config: Config): Either[String, RaffleEntity.Settings] = {
    val section = "auction.raffle"
    val settings = RaffleEntity.Settings(
      screeningWindow = config.getDuration(s"$section.screening-window").toScala,
      retryEvery = config.getDuration(s"$section.retry-every").toScala,
      nameRetention = config.getDuration(s"$section.name-retention")
    )
    if (settings.screeningWindow.toNanos >= Quicknet.Margin.toNanos)
      Left("auction raffle screening window must end before the beacon round: auction.raffle.screening-window")
    else Right(settings)
  }
}
