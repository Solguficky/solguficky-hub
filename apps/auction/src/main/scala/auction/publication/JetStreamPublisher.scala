package auction.publication

import io.nats.client.Connection
import io.nats.client.JetStream
import io.nats.client.JetStreamOptions
import io.nats.client.Nats
import io.nats.client.Options
import io.nats.client.PublishOptions

import java.time.Duration
import scala.concurrent.duration.FiniteDuration
import scala.jdk.DurationConverters.*

/**
 * Публикация факта в JetStream (integration.md, «Дедупликация»): `Nats-Msg-Id` равен `event_id`, а ожидаемый стрим —
 * `AUCTION_EVENTS`, поэтому публикация мимо стрима становится отказом сервера, а не тихо принятым сообщением. Стрим
 * сервис не заводит: его объявляет топология AppHost (ADR-050), и без стрима публикация получает отказ, а строка ждёт
 * следующего тика.
 *
 * Соединение открывается при первой публикации, а не на старте: недоступная шина не мешает узлу подняться и принимать
 * ставки. Открытое соединение переподключается само, а неудавшееся открытие повторяет следующий тик.
 *
 * Публикацию зовёт только релей, и его тики не перекрываются, но `close` приходит из остановки узла, пока тик ещё может
 * идти. Поэтому оба метода держат один монитор: остановка ждёт текущую публикацию, а публикация после остановки
 * отказывает, а не открывает соединение, которое уже некому закрыть.
 */
final class JetStreamPublisher(url: String, ackTimeout: FiniteDuration) extends FactPublisher with AutoCloseable {

  private var connection: Option[Connection] = None
  private var closed: Boolean = false

  private val jetStreamOptions = JetStreamOptions.builder().requestTimeout(ackTimeout.toJava).build()

  override def publish(fact: LotFact): Boolean = synchronized {
    jetStream()
      .publish(
        fact.subject,
        fact.payload,
        PublishOptions.builder().messageId(fact.eventId.toString).expectedStream(JetStreamPublisher.Stream).build()
      )
      .isDuplicate
  }

  override def close(): Unit = synchronized {
    closed = true
    connection.foreach(_.close())
    connection = None
  }

  private def jetStream(): JetStream =
    connection.filter(_.getStatus != Connection.Status.CLOSED) match {
      case Some(open) => open.jetStream(jetStreamOptions)
      case None if closed => throw new IllegalStateException("fact publisher is closed")
      case None =>
        val opened = Nats.connect(
          new Options.Builder()
            .server(url)
            .connectionTimeout(Duration.ofSeconds(2))
            .maxReconnects(-1)
            .build()
        )
        connection = Some(opened)
        opened.jetStream(jetStreamOptions)
    }
}

object JetStreamPublisher {
  val Stream: String = "AUCTION_EVENTS"
}
