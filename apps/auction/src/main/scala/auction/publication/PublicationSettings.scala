package auction.publication

import com.typesafe.config.Config

import scala.concurrent.duration.FiniteDuration
import scala.jdk.DurationConverters.*

/**
 * Настройки релея фактов.
 *
 * Адрес шины необязателен, как у Meetups и Identity: профиль без узла `nats` поднимает сервис без него. Тогда проекция
 * публикации продолжает писать outbox, факты ждут в нём, и релей вынесет их, когда адрес появится.
 */
final case class PublicationSettings(
    natsUrl: Option[String],
    interval: FiniteDuration,
    batch: Int,
    ackTimeout: FiniteDuration
) {

  // Адрес от AppHost несёт пользователя и пароль шины, а настройки попадают в отладочный вывод.
  override def toString: String =
    s"PublicationSettings(${natsUrl.fold("<none>")(_ => "***")}, $interval, $batch, $ackTimeout)"
}

object PublicationSettings {

  private val section = "auction.publication"

  def fromConfig(config: Config): PublicationSettings =
    PublicationSettings(
      natsUrl = Option
        .when(config.hasPath(s"$section.nats-url"))(config.getString(s"$section.nats-url"))
        .filter(_.trim.nonEmpty),
      interval = config.getDuration(s"$section.interval").toScala,
      batch = config.getInt(s"$section.batch"),
      ackTimeout = config.getDuration(s"$section.ack-timeout").toScala
    )
}
