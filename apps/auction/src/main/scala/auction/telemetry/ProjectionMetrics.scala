package auction.telemetry

import io.opentelemetry.api.common.AttributeKey
import io.opentelemetry.api.common.Attributes
import io.opentelemetry.api.metrics.Meter
import org.apache.pekko.projection.HandlerRecoveryStrategy
import org.apache.pekko.projection.ProjectionId
import org.apache.pekko.projection.StatusObserver
import org.slf4j.LoggerFactory

import java.time.Clock
import scala.util.control.NonFatal

/**
 * Отставание проекции двумя метриками, потому что каждая по отдельности слепа в своём случае.
 *
 *   - `auction.projection.events_behind` — сколько событий тега журнал держит сверх offset проекции. Считается на сборе
 *     метрики запросом к базе, поэтому видна и застрявшая проекция, которая ничего не обрабатывает.
 *   - `auction.projection.lag` — сколько секунд прошло от записи события до его обработки. Пишется после обработки и
 *     поэтому молчит, когда проекция стоит.
 *
 * Атрибуты — имя проекции и тег, то есть `projection_name` и `projection_key` её offset.
 */
final class ProjectionMetrics(meter: Meter, clock: Clock) {

  private val logger = LoggerFactory.getLogger(getClass)

  private val ProjectionKey = AttributeKey.stringKey("projection")
  private val TagKey = AttributeKey.stringKey("tag")

  private val lag = meter
    .histogramBuilder("auction.projection.lag")
    .setUnit("s")
    .setDescription("Time from writing an event to the journal to processing it in the projection")
    .build()

  private def attributes(projection: String, tag: String): Attributes =
    Attributes.of(ProjectionKey, projection, TagKey, tag)

  /**
   * Наблюдатель проекции, который пишет задержку каждого обработанного события.
   *
   * @param writtenAt
   *   время записи события в журнал, миллисекунды эпохи
   */
  def observer[Envelope](writtenAt: Envelope => Long): StatusObserver[Envelope] =
    new StatusObserver[Envelope] {
      override def started(projectionId: ProjectionId): Unit = ()
      override def failed(projectionId: ProjectionId, cause: Throwable): Unit = ()
      override def stopped(projectionId: ProjectionId): Unit = ()
      override def beforeProcess(projectionId: ProjectionId, envelope: Envelope): Unit = ()
      override def afterProcess(projectionId: ProjectionId, envelope: Envelope): Unit = {
        val seconds = math.max(0L, clock.millis() - writtenAt(envelope)) / 1000.0
        lag.record(seconds, attributes(projectionId.name, projectionId.key))
      }
      override def offsetProgress(projectionId: ProjectionId, envelope: Envelope): Unit = ()
      override def error(
          projectionId: ProjectionId,
          envelope: Envelope,
          cause: Throwable,
          recoveryStrategy: HandlerRecoveryStrategy
      ): Unit = ()
    }

  /**
   * Регистрирует `events_behind`. Чтение идёт на сборе метрики; отказ базы пропускает одно наблюдение и пишется в лог,
   * а не роняет экспорт остальных метрик.
   *
   * @param read
   *   отставание по тегам проекции
   */
  def watchBacklog(projection: String, read: () => Map[String, Long]): AutoCloseable =
    meter
      .gaugeBuilder("auction.projection.events_behind")
      .ofLongs()
      .setUnit("{event}")
      .setDescription("Events tagged in the journal past the stored offset of the projection")
      .buildWithCallback { measurement =>
        try read().foreach((tag, behind) => measurement.record(behind, attributes(projection, tag)))
        catch {
          case NonFatal(cause) =>
            logger.warn("auction projection backlog not measured", cause)
        }
      }
}

object ProjectionBacklog {

  /**
   * Отставание по каждому тегу проекции: тег, которого нет в подсчёте, не отстаёт. Без этого тег без новых событий
   * пропадал бы из метрики, и его ноль был бы неотличим от отсутствия наблюдения.
   */
  def behind(tags: Seq[String], counted: Map[String, Long]): Map[String, Long] =
    tags.map(tag => tag -> counted.getOrElse(tag, 0L)).toMap
}
