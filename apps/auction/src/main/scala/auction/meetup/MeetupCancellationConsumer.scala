package auction.meetup

import auction.entity.AuctionAnswer
import io.nats.client.Connection
import io.nats.client.ConsumerContext
import io.nats.client.FetchConsumeOptions
import io.nats.client.JetStreamApiException
import io.nats.client.Message
import io.nats.client.Nats
import io.nats.client.Options
import net.logstash.logback.argument.StructuredArguments
import org.slf4j.LoggerFactory

import java.time.Duration
import scala.concurrent.Await
import scala.concurrent.Future
import scala.jdk.CollectionConverters.*
import scala.jdk.DurationConverters.*
import scala.util.Using
import scala.util.control.NonFatal

/**
 * Durable-потребитель отмен сходок (ADR-047, дополнение 2026-10-12): первая входящая зависимость Auction из шины. Факт
 * становится одной командой аукциону сходки, и сообщение подтверждается только после ответа entity; аукцион не ответил
 * — явный `nak` с задержкой, и сервер выдаст сообщение снова. Сообщение, которое не разобрать, повтор не исправит: оно
 * снимается `term` с записью в лог. Повторная выдача упирается в окно `seen` аукциона: `op_id` выведен из `event_id`.
 *
 * Durable принадлежит Auction, но создаёт его топология AppHost (ADR-050): потребитель к нему только привязывается и
 * сам его не заводит, иначе отмены, пришедшие до первого старта, пропали бы. Durable или стрима нет — дефект
 * развёртывания: потребитель зовёт `missing`, и узел останавливается, а не работает молча без наследования отмен.
 * Недоступная шина — не дефект: потребитель подключается заново через паузу.
 *
 * Свой поток и своё соединение, как у слушателя изменений: выборка из durable блокирует, а сообщения обрабатываются по
 * одному, поэтому две команды аукциону от потребителя не перекрываются.
 *
 * @param inherit
 *   команда аукциону сходки; неудачное `Future` — ответа нет
 * @param missing
 *   durable или стрима нет: узел обязан остановиться
 */
final class MeetupCancellationConsumer(
    url: String,
    settings: MeetupFactsSettings,
    inherit: Inheritance => Future[AuctionAnswer],
    missing: String => Unit
) extends AutoCloseable {

  @volatile private var running = true
  @volatile private var consumer: Option[ConsumerContext] = None

  private val thread = Thread
    .ofPlatform()
    .daemon(true)
    .name("auction-meetup-facts")
    .unstarted(() => loop())

  def start(): MeetupCancellationConsumer = {
    thread.start()
    this
  }

  /**
   * Отставание durable на сервере; `None` — потребитель сейчас не привязан. Читается на сборе метрики запросом к
   * серверу.
   */
  def backlog(): Option[DurableBacklog] =
    consumer.map { context =>
      val info = context.getConsumerInfo
      DurableBacklog(pending = info.getNumPending, unacknowledged = info.getNumAckPending)
    }

  override def close(): Unit = {
    running = false
    thread.interrupt()
    thread.join(settings.fetchWait.toMillis + settings.reconnectAfter.toMillis)
    consumer = None
  }

  private def loop(): Unit =
    while (running)
      try Using.resource(connect())(consume)
      catch {
        case absent: JetStreamApiException if MeetupCancellationConsumer.isMissing(absent) =>
          running = false
          consumer = None
          missing(
            s"durable ${MeetupCancellationConsumer.Durable} of stream ${MeetupCancellationConsumer.Stream} is not declared"
          )
        // Текст отказа клиента может нести адрес шины, поэтому в запись уходит только класс исключения.
        case NonFatal(cause) if running =>
          consumer = None
          MeetupCancellationConsumer.logger.warn(
            "auction meetup facts consumer disconnected",
            StructuredArguments.entries(
              Map[String, Any](
                "operation" -> MeetupCancellationConsumer.Operation,
                "result" -> "error",
                "error_category" -> "dependency_unavailable",
                "error" -> cause.getClass.getName
              ).asJava
            )
          )
          // `close` прерывает паузу: `InterruptedException` не `NonFatal`, и `Try` его бы не поймал.
          try Thread.sleep(settings.reconnectAfter.toMillis)
          catch { case _: InterruptedException => () }
        case NonFatal(_) => ()
        case _: InterruptedException => ()
      }

  private def connect(): Connection =
    Nats.connect(
      new Options.Builder()
        .server(url)
        .connectionTimeout(Duration.ofSeconds(2))
        // Переподключение ведёт сам цикл: оборванное соединение уходит на новый круг с привязкой к durable.
        .maxReconnects(0)
        .build()
    )

  private def consume(connection: Connection): Unit = {
    val context = connection
      .getStreamContext(MeetupCancellationConsumer.Stream)
      .getConsumerContext(MeetupCancellationConsumer.Durable)
    consumer = Some(context)
    // По одному сообщению за выборку: AckWait durable идёт с выдачи, и сообщение, ждущее в буфере клиента, пока
    // аукцион не отвечает на предыдущее, сервер выдал бы снова раньше, чем потребитель до него дойдёт.
    val options = FetchConsumeOptions.builder().maxMessages(1).expiresIn(settings.fetchWait.toMillis).build()
    while (running) {
      if (connection.getStatus != Connection.Status.CONNECTED)
        throw new IllegalStateException("auction meetup facts connection is not connected")
      // Пустая выборка клиент отдаёт как `null`.
      Option(context.fetch(options).nextMessage()).foreach(handle)
    }
  }

  // Одна запись на сообщение (logging.md): `operation` — subject, `use_case` нет — сообщение шины начинал не человек.
  private def handle(message: Message): Unit = {
    val started = System.nanoTime()
    def record(fields: (String, Any)*): Map[String, Any] =
      Map[String, Any](
        "operation" -> message.getSubject,
        "duration_us" -> (System.nanoTime() - started) / 1000
      ) ++ fields
    MeetupCancellations.inheritance(message.getData) match {
      case Left(reason) =>
        message.term()
        MeetupCancellationConsumer.logger.warn(
          "auction meetup fact dropped",
          StructuredArguments.entries(
            record("result" -> "error", "error_category" -> "invariant", "error" -> reason).asJava
          )
        )
      case Right(inheritance) =>
        val traced = inheritance.requestId.map("request_id" -> _).toList
        val auction = "auction_id" -> inheritance.auctionId.value.toString
        try {
          Await.result(inherit(inheritance), settings.answerTimeout)
          message.ack()
          MeetupCancellationConsumer.logger.info(
            "auction meetup cancellation applied",
            StructuredArguments.entries(record(("result" -> "ok") :: auction :: traced*).asJava)
          )
        } catch {
          case NonFatal(cause) =>
            message.nakWithDelay(settings.redeliveryDelay.toJava)
            val category = cause match {
              case _: java.util.concurrent.TimeoutException => "timeout"
              case _ => "dependency_unavailable"
            }
            MeetupCancellationConsumer.logger.warn(
              "auction did not answer a meetup cancellation",
              StructuredArguments.entries(
                record(
                  ("result" -> "error") :: ("error_category" -> category) :: ("error" -> cause.getClass.getName) ::
                    auction :: traced*
                ).asJava
              )
            )
        }
    }
  }
}

/** Сообщения durable, которые сервер ещё не выдал, и выданные без подтверждения. */
final case class DurableBacklog(pending: Long, unacknowledged: Long)

object MeetupCancellationConsumer {
  val Operation = "auction.meetup_facts"

  val Stream: String = "MEETUPS_EVENTS"

  /** Имя по правилу топологии `<потребитель>-<стрим в нижнем регистре через дефис>` (integration.md, «JetStream»). */
  val Durable: String = "auction-meetups-events"

  val Subject: String = "events.meetups.meetup_cancelled"

  // Коды ошибок JetStream API: 10014 — durable не найден, 10059 — стрим не найден.
  private def isMissing(failure: JetStreamApiException): Boolean =
    failure.getApiErrorCode == 10014 || failure.getApiErrorCode == 10059

  private val logger = LoggerFactory.getLogger(classOf[MeetupCancellationConsumer])
}
