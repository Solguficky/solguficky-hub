package auction.telemetry

import io.opentelemetry.api.metrics.Meter
import org.slf4j.LoggerFactory

import scala.util.control.NonFatal

/** Очередь фактов, которые проекция записала, а шина ещё не подтвердила. */
final case class OutboxBacklog(pending: Long, oldestSeconds: Double)

/**
 * Отставание публикации от проекции — то, чего `auction.projection.events_behind` проекции публикации не видит: факт
 * уже лежит в outbox, а шина недоступна.
 *
 *   - `auction.publication.pending` — сколько фактов ждёт шину;
 *   - `auction.publication.oldest_age` — сколько секунд ждёт старейший из них. Ноль при пустой очереди.
 *
 * Обе читаются одним запросом к базе на сборе метрики, поэтому видны и при остановленном релее.
 */
final class PublicationMetrics(meter: Meter) {

  private val logger = LoggerFactory.getLogger(getClass)

  /**
   * Регистрирует обе метрики. Отказ базы пропускает одно наблюдение и пишется в лог, а не роняет экспорт остальных.
   */
  def watchOutbox(read: () => OutboxBacklog): AutoCloseable = {
    val pending = meter
      .gaugeBuilder("auction.publication.pending")
      .ofLongs()
      .setUnit("{event}")
      .setDescription("Facts written to the outbox and not yet acknowledged by the bus")
      .buildObserver()
    val oldest = meter
      .gaugeBuilder("auction.publication.oldest_age")
      .setUnit("s")
      .setDescription("Age of the oldest fact waiting in the outbox")
      .buildObserver()
    val observe: Runnable = () =>
      try {
        val backlog = read()
        pending.record(backlog.pending)
        oldest.record(backlog.oldestSeconds)
      } catch {
        case NonFatal(cause) => logger.warn("auction publication backlog not measured", cause)
      }
    meter.batchCallback(observe, pending, oldest)
  }
}
