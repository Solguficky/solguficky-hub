package auction.telemetry

import auction.meetup.DurableBacklog
import io.opentelemetry.api.common.AttributeKey
import io.opentelemetry.api.common.Attributes
import io.opentelemetry.api.metrics.Meter
import net.logstash.logback.argument.StructuredArguments
import org.slf4j.LoggerFactory

import scala.util.control.NonFatal

/**
 * Отставание потребителя фактов Meetups (ADR-047, дополнение 2026-10-12, «Цена») по счётчикам его durable на сервере:
 *
 *   - `auction.meetup_facts.pending` — сообщения, которые durable ещё не выдал. Растёт, когда потребитель стоит или
 *     отключён, и видно это на сборе, а не после обработки;
 *   - `auction.meetup_facts.unacknowledged` — выданные, но не подтверждённые: аукцион не отвечает, и сообщения ходят по
 *     кругу явного `nak`.
 *
 * Атрибут `durable` — имя durable. Потребитель не привязан — наблюдения нет, а не ноль: ноль значил бы «отставания
 * нет».
 */
final class MeetupFactsMetrics(meter: Meter) {

  private val logger = LoggerFactory.getLogger(getClass)

  private val DurableKey = AttributeKey.stringKey("durable")

  /**
   * Регистрирует обе метрики. Чтение идёт на сборе запросом к серверу; отказ пропускает одно наблюдение и пишется в
   * лог, а не роняет экспорт остальных метрик.
   *
   * @param read
   *   отставание durable; `None` — потребитель не привязан
   */
  def watchPending(durable: String, read: () => Option[DurableBacklog]): AutoCloseable = {
    val attributes = Attributes.of(DurableKey, durable)
    val pending = meter
      .gaugeBuilder("auction.meetup_facts.pending")
      .ofLongs()
      .setUnit("{message}")
      .setDescription("Messages of the meetup facts durable not yet delivered to the auction")
      .buildObserver()
    val unacknowledged = meter
      .gaugeBuilder("auction.meetup_facts.unacknowledged")
      .ofLongs()
      .setUnit("{message}")
      .setDescription("Messages of the meetup facts durable delivered to the auction and not yet acknowledged")
      .buildObserver()
    val observe: Runnable = () =>
      try
        read().foreach { backlog =>
          pending.record(backlog.pending, attributes)
          unacknowledged.record(backlog.unacknowledged, attributes)
        }
      catch {
        // Текст отказа клиента шины может нести её адрес, поэтому в запись уходит только класс исключения.
        case NonFatal(cause) =>
          logger.warn(
            "auction meetup facts backlog not measured",
            StructuredArguments.keyValue("error", cause.getClass.getName)
          )
      }
    meter.batchCallback(observe, pending, unacknowledged)
  }
}
