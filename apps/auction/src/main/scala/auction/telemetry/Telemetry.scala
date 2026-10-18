package auction.telemetry

import io.opentelemetry.sdk.OpenTelemetrySdk
import io.opentelemetry.sdk.autoconfigure.AutoConfiguredOpenTelemetrySdk

import scala.jdk.CollectionConverters.*

/**
 * Телеметрия сервиса по OTLP (ADR-053): адрес коллектора, имя сервиса и интервал экспорта приходят переменными `OTEL_*`
 * из окружения — их подставляет AppHost, — а SDK конкретного вендора сервис не получает.
 *
 * Сервис пока отдаёт только метрики: трейсы и логи по OTLP — отдельная работа, и их экспортёры выключены умолчанием, а
 * не оставлены искать коллектор на localhost. Без `OTEL_EXPORTER_OTLP_ENDPOINT` выключены и метрики: процесс,
 * запущенный вне AppHost, не шлёт их в никуда и не пишет в лог отказ каждого экспорта.
 */
object Telemetry {

  def defaults(environment: Map[String, String]): Map[String, String] =
    Map(
      "otel.service.name" -> "auction",
      "otel.traces.exporter" -> "none",
      "otel.logs.exporter" -> "none",
      "otel.metrics.exporter" -> (if (environment.contains("OTEL_EXPORTER_OTLP_ENDPOINT")) "otlp" else "none")
    )

  /** Переменные окружения и системные свойства перекрывают умолчания: их порядок задаёт autoconfigure. */
  def fromEnvironment(): OpenTelemetrySdk =
    AutoConfiguredOpenTelemetrySdk
      .builder()
      .addPropertiesSupplier(() => defaults(sys.env).asJava)
      .build()
      .getOpenTelemetrySdk
}
