package auction

import com.typesafe.config.Config

/**
 * Адрес одной из границ сервиса: HTTP с health или gRPC.
 *
 * Значения приходят из `application.conf`, а переменные окружения переопределяют их там же: код не знает, что
 * переопределение вообще есть, и Aspire задаёт адрес привязкой, а не правкой исходников.
 */
final case class AuctionConfig(host: String, port: Int)

object AuctionConfig {

  def fromConfig(config: Config): AuctionConfig = at(config, "auction.http")

  def grpcFromConfig(config: Config): AuctionConfig = at(config, "auction.grpc")

  private def at(config: Config, path: String): AuctionConfig =
    AuctionConfig(host = config.getString(s"$path.host"), port = config.getInt(s"$path.port"))
}
