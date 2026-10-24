package auction.telemetry

import io.nats.client.Connection
import io.nats.client.Consumer
import io.nats.client.ErrorListener
import io.nats.client.JetStreamSubscription
import io.nats.client.Message
import io.nats.client.support.Status
import net.logstash.logback.argument.StructuredArguments
import org.slf4j.LoggerFactory
import org.slf4j.event.Level

import scala.jdk.CollectionConverters.*

/**
 * События клиента jnats в лог сервиса (PER-697). Без своего слушателя клиент берёт `ErrorListenerLoggerImpl`, который
 * пишет в java.util.logging: строка уходит голым stderr мимо logback, без полей каркаса и с уровнем, который сборщик
 * логов угадывает по потоку. Слушатель пишет событие одной записью JSON через logback, имя события — полем
 * `nats_event`.
 *
 * Уровень — тот, что давал сам клиент (`SEVERE` — `error`, `WARNING` — `warn`), с двумя исключениями. Исключение
 * соединения — `warn`: отказ шины пишет и владелец соединения, цикл потребителя или релей, предупреждением с той же
 * категорией, а клиент с бесконечным переподключением звал бы его на каждой попытке. Сброшенное сообщение — `warn`, а
 * не `info`: это потерянная выдача. `flowControlProcessed` не переопределён: flow control бывает только у
 * push-подписки, а Auction тянет выборками.
 *
 * Адрес шины в запись не идёт. Исключение клиента — только классом, как в записях потребителя. Текст ошибки сервера
 * (`-ERR`) и статуса pull адреса клиента не несёт, но проходит ту же чистку учётных данных, что текст отказа у релея.
 *
 * @param operation
 *   поле `operation` записи: чьё это соединение
 */
final class NatsClientLog(operation: String) extends ErrorListener {

  override def errorOccurred(conn: Connection, error: String): Unit =
    write(Level.ERROR, "errorOccurred", "dependency_unavailable", "error" -> NatsClientLog.withoutCredentials(error))

  override def exceptionOccurred(conn: Connection, exp: Exception): Unit =
    write(Level.WARN, "exceptionOccurred", "dependency_unavailable", "error" -> exp.getClass.getName)

  override def slowConsumerDetected(conn: Connection, consumer: Consumer): Unit =
    write(Level.WARN, "slowConsumerDetected", "unexpected")

  override def messageDiscarded(conn: Connection, msg: Message): Unit =
    write(Level.WARN, "messageDiscarded", "unexpected")

  override def heartbeatAlarm(
      conn: Connection,
      sub: JetStreamSubscription,
      lastStreamSequence: Long,
      lastConsumerSequence: Long
  ): Unit =
    write(
      Level.ERROR,
      "heartbeatAlarm",
      "dependency_unavailable",
      consumer(sub) ++ Seq(
        "last_stream_sequence" -> lastStreamSequence,
        "last_consumer_sequence" -> lastConsumerSequence
      )*
    )

  override def unhandledStatus(conn: Connection, sub: JetStreamSubscription, status: Status): Unit =
    write(Level.WARN, "unhandledStatus", "dependency_unavailable", consumer(sub) ++ described(status)*)

  override def pullStatusWarning(conn: Connection, sub: JetStreamSubscription, status: Status): Unit =
    write(Level.WARN, "pullStatusWarning", "dependency_unavailable", consumer(sub) ++ described(status)*)

  override def pullStatusError(conn: Connection, sub: JetStreamSubscription, status: Status): Unit =
    write(Level.ERROR, "pullStatusError", "dependency_unavailable", consumer(sub) ++ described(status)*)

  override def socketWriteTimeout(conn: Connection): Unit =
    write(Level.ERROR, "socketWriteTimeout", "dependency_unavailable")

  private def consumer(sub: JetStreamSubscription): Seq[(String, Any)] =
    Option(sub).flatMap(subscription => Option(subscription.getConsumerName)).map("consumer" -> _).toSeq

  private def described(status: Status): Seq[(String, Any)] =
    Option(status).toSeq.flatMap { known =>
      Seq("nats_status" -> known.getCode, "error" -> NatsClientLog.withoutCredentials(known.getMessage))
    }

  private def write(level: Level, event: String, category: String, fields: (String, Any)*): Unit = {
    val record = Map[String, Any](
      "operation" -> operation,
      "result" -> "error",
      "error_category" -> category,
      "error" -> event,
      "nats_event" -> event
    ) ++ fields
    NatsClientLog.logger
      .atLevel(level)
      .addArgument(StructuredArguments.entries(record.asJava))
      .log("auction nats client event")
  }
}

object NatsClientLog {
  private val logger = LoggerFactory.getLogger(classOf[NatsClientLog])

  /** Userinfo любого URL в тексте заменяется до записи (logging.md): то же правило, что у текста отказа релея. */
  def withoutCredentials(text: String): String =
    Option(text).fold("")(_.replaceAll("""([a-zA-Z][a-zA-Z0-9+.-]*://)[^@/\s]+@""", "$1***@"))
}
