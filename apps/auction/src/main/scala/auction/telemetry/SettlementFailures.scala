package auction.telemetry

import io.opentelemetry.api.common.AttributeKey
import io.opentelemetry.api.common.Attributes
import io.opentelemetry.api.metrics.Meter
import net.logstash.logback.argument.StructuredArguments
import org.slf4j.LoggerFactory

import java.util.concurrent.TimeoutException
import scala.jdk.CollectionConverters.*

/** Отказ незавершённого эффекта расчётов: одна запись и общий счётчик отказов, без текста исключения. */
final class SettlementFailures(meter: Meter) {
  private val logger = LoggerFactory.getLogger("auction.settlement")
  private val failures = meter.counterBuilder("solguficky.failures").build()

  def record(lotId: String, error: Throwable): Unit = {
    val category = error match {
      case _: TimeoutException => "timeout"
      case _ => "dependency_unavailable"
    }
    failures.add(
      1,
      Attributes.of(AttributeKey.stringKey("service"), "auction", AttributeKey.stringKey("error_category"), category)
    )
    val fields = Map[String, Any](
      "operation" -> "settlement.follow",
      "result" -> "error",
      "error_category" -> category,
      "error" -> error.getClass.getName,
      "stack" -> error.getStackTrace.mkString("\n"),
      "lot_id" -> lotId
    )
    logger.error("settlement effect will retry", StructuredArguments.entries(fields.asJava))
  }
}
