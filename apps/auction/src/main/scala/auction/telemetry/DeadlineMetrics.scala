package auction.telemetry

import io.opentelemetry.api.metrics.Meter
import org.slf4j.LoggerFactory

import scala.util.control.NonFatal

/**
 * Лоты, просроченные, но не закрытые (PER-292): `auction.lots.overdue` — сколько лотов read model держит в торгах с
 * дедлайном, прошедшим больше допуска назад.
 *
 * Метрика считается на сборе запросом к базе, а не пишется планировщиком: планировщик, который молчит, — упавший
 * таймер, не поднятый аукцион, лот без ответа — ничего бы и не написал. Здесь его тишина видна как ненулевое число, а
 * не как отсутствие сигнала. Отказ базы пропускает одно наблюдение, как у `events_behind`.
 */
final class DeadlineMetrics(meter: Meter) {

  private val logger = LoggerFactory.getLogger(getClass)

  /** @param read число просроченных незакрытых лотов */
  def watchOverdue(read: () => Long): AutoCloseable =
    meter
      .gaugeBuilder("auction.lots.overdue")
      .ofLongs()
      .setUnit("{lot}")
      .setDescription("Lots still trading past their deadline by more than the grace period")
      .buildWithCallback { measurement =>
        try measurement.record(read())
        catch {
          case NonFatal(cause) =>
            logger.warn("auction overdue lots not measured", cause)
        }
      }
}
