package auction.publication

import auction.telemetry.OutboxBacklog
import net.logstash.logback.argument.StructuredArguments
import org.apache.pekko.actor.Cancellable
import org.apache.pekko.actor.typed.ActorSystem
import org.apache.pekko.actor.typed.DispatcherSelector
import org.slf4j.LoggerFactory

import java.io.PrintWriter
import java.io.StringWriter
import java.util.UUID
import scala.annotation.tailrec
import scala.concurrent.duration.FiniteDuration
import scala.jdk.CollectionConverters.*
import scala.util.Failure
import scala.util.Success
import scala.util.Try
import scala.util.control.NonFatal

/**
 * Публикует один факт и ждёт ack шины. `true` — стрим признал его повтором по `Nats-Msg-Id`: это тоже подтверждение.
 * Исключение означает, что ack не получен, и строка остаётся в outbox.
 */
trait FactPublisher {
  def publish(fact: LotFact): Boolean
}

/** Отказ публикации одного факта; тик на нём остановился, чтобы следующие не обогнали его. */
final case class Declined(eventId: UUID, cause: Throwable)

/** Итог одного тика релея. */
final case class RelayReport(backlog: OutboxBacklog, published: Int, repeats: Int, declined: Option[Declined])

/**
 * Релей outbox (integration.md, «Дедупликация»): выносит факты в шину в порядке записи и удаляет строку после ack.
 *
 * Доставка at-least-once. Падение между ack и удалением строки публикует факт повторно с тем же `Nats-Msg-Id`, и стрим
 * отбрасывает повтор в своём окне; после окна повтор гасит потребитель по `event_id`.
 */
final class OutboxRelay(outbox: LotOutbox, publisher: FactPublisher, batch: Int) {

  def pass(): RelayReport = {
    val backlog = outbox.backlog()

    @tailrec
    def publish(facts: List[PendingFact], published: Int, repeats: Int): RelayReport =
      facts match {
        case Nil => RelayReport(backlog, published, repeats, None)
        case next :: rest =>
          Try(publisher.publish(next.fact)) match {
            case Success(duplicate) =>
              outbox.remove(next.fact.eventId)
              publish(rest, published + 1, if (duplicate) repeats + 1 else repeats)
            case Failure(cause) =>
              RelayReport(backlog, published, repeats, Some(Declined(next.fact.eventId, cause)))
          }
      }

    publish(outbox.pending(batch).toList, 0, 0)
  }
}

object OutboxRelay {

  /** Имя фоновой операции в логе. Сценария у неё нет: публикацию начинает таймер, а не человек. */
  val Operation: String = "auction.outbox.dispatch"

  private val logger = LoggerFactory.getLogger(classOf[OutboxRelay])

  /**
   * Запускает тики релея с паузой `interval` между концом одного и началом следующего: тики не перекрываются, и
   * одновременно работающих релеев на узле нет. Тик идёт на диспетчере блокирующего ввода-вывода, а не на общем.
   */
  def start(system: ActorSystem[?], relay: OutboxRelay, interval: FiniteDuration): Cancellable =
    system.scheduler.scheduleWithFixedDelay(interval, interval)(() => tick(relay))(using
      system.dispatchers.lookup(DispatcherSelector.blocking())
    )

  private def tick(relay: OutboxRelay): Unit = {
    val started = System.nanoTime()
    def fields(extra: (String, Any)*): java.util.Map[String, Any] =
      (Map[String, Any](
        "operation" -> Operation,
        "duration_us" -> (System.nanoTime() - started) / 1000
      ) ++ extra).asJava

    try {
      val report = relay.pass()
      val backlog = backlogFields(report)
      report.declined match {
        case Some(declined) =>
          // Недоступная шина — ожидаемый исход, а не сбой сервиса: Warning.
          logger.warn(
            "outbox dispatch declined",
            StructuredArguments.entries(
              fields(
                backlog ++ Seq(
                  "result" -> "error",
                  "error_category" -> "dependency_unavailable",
                  "error" -> withoutCredentials(String.valueOf(declined.cause.getMessage)),
                  "event_id" -> declined.eventId.toString
                )*
              )
            )
          )
        case None if report.repeats > 0 =>
          // Повтор по Nats-Msg-Id — факт, опубликованный до падения между ack и удалением строки.
          logger.warn("outbox dispatch repeated", StructuredArguments.entries(fields(backlog :+ ("result" -> "ok")*)))
        case None if report.published > 0 =>
          logger.info("outbox dispatched", StructuredArguments.entries(fields(backlog :+ ("result" -> "ok")*)))
        case None =>
          logger.debug("outbox dispatch idle", StructuredArguments.entries(fields(backlog :+ ("result" -> "ok")*)))
      }
    } catch {
      case NonFatal(cause) =>
        logger.error(
          "outbox dispatch failed",
          StructuredArguments.entries(
            fields(
              "result" -> "error",
              "error_category" -> "unexpected",
              "error" -> cause.getClass.getName,
              "stack" -> withoutCredentials(stackOf(cause))
            )
          )
        )
    }
  }

  /**
   * Повторы пишутся только когда были: поле с нулём в каждой записи превращает вопрос «были ли» в запрос по значению.
   */
  private def backlogFields(report: RelayReport): Seq[(String, Any)] =
    Seq("pending" -> report.backlog.pending, "published" -> report.published) ++
      Option.when(report.repeats > 0)("repeats" -> report.repeats) ++
      Option.when(report.backlog.pending > 0)(
        "oldest_pending_age_us" -> (report.backlog.oldestSeconds * 1_000_000).toLong
      )

  /**
   * Адрес шины от AppHost несёт пользователя и пароль (`nats://user:pass@host`), а клиент NATS кладёт адрес сервера в
   * текст отказа соединения. В лог учётные данные не уходят (logging.md), поэтому userinfo любого URL в тексте
   * заменяется до записи.
   */
  private[publication] def withoutCredentials(text: String): String =
    text.replaceAll("""([a-zA-Z][a-zA-Z0-9+.-]*://)[^@/\s]+@""", "$1***@")

  private def stackOf(cause: Throwable): String = {
    val text = new StringWriter()
    cause.printStackTrace(new PrintWriter(text))
    text.toString
  }
}
