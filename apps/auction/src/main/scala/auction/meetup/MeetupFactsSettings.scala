package auction.meetup

import com.typesafe.config.Config

import scala.concurrent.duration.FiniteDuration
import scala.jdk.DurationConverters.*

/**
 * Настройки потребителя фактов Meetups. Адрес шины — тот же, что у релея фактов, и так же необязателен: профиль без
 * узла `nats` поднимает сервис без потребителя, и отмены сходок в нём не наследуются.
 *
 * @param fetchWait
 *   сколько выборка ждёт сообщений; столько же длится остановка в худшем случае
 * @param answerTimeout
 *   сколько потребитель ждёт ответа аукциона на одну команду
 * @param redeliveryDelay
 *   через сколько сервер выдаст снова сообщение, на которое аукцион не ответил
 * @param reconnectAfter
 *   пауза перед повторным подключением после отказа шины
 */
final case class MeetupFactsSettings(
    natsUrl: Option[String],
    fetchWait: FiniteDuration,
    answerTimeout: FiniteDuration,
    redeliveryDelay: FiniteDuration,
    reconnectAfter: FiniteDuration
) {

  // Адрес от AppHost несёт пользователя и пароль шины, а настройки попадают в отладочный вывод.
  override def toString: String =
    s"MeetupFactsSettings(${natsUrl.fold("<none>")(_ => "***")}, $fetchWait, $answerTimeout, " +
      s"$redeliveryDelay, $reconnectAfter)"
}

object MeetupFactsSettings {

  private val section = "auction.meetup-facts"

  def fromConfig(config: Config): MeetupFactsSettings =
    MeetupFactsSettings(
      natsUrl = Option
        .when(config.hasPath("auction.publication.nats-url"))(config.getString("auction.publication.nats-url"))
        .filter(_.trim.nonEmpty),
      fetchWait = config.getDuration(s"$section.fetch-wait").toScala,
      answerTimeout = config.getDuration(s"$section.answer-timeout").toScala,
      redeliveryDelay = config.getDuration(s"$section.redelivery-delay").toScala,
      reconnectAfter = config.getDuration(s"$section.reconnect-after").toScala
    )
}
