package auction

import com.typesafe.config.Config

/**
 * Адрес HTTP-границы сервиса.
 *
 * Значения приходят из `application.conf`, а переменные окружения переопределяют их там же: код не знает, что
 * переопределение вообще есть, и Aspire задаёт адрес привязкой, а не правкой исходников.
 */
final case class AuctionConfig(host: String, port: Int)

object AuctionConfig {

  def fromConfig(config: Config): AuctionConfig =
    AuctionConfig(
      host = config.getString("auction.http.host"),
      port = config.getInt("auction.http.port")
    )
}
