package auction.telemetry

import io.opentelemetry.sdk.metrics.SdkMeterProvider
import io.opentelemetry.sdk.metrics.data.MetricData
import io.opentelemetry.sdk.testing.exporter.InMemoryMetricReader
import org.apache.pekko.projection.ProjectionId
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

import java.time.Clock
import java.time.Instant
import java.time.ZoneOffset
import scala.jdk.CollectionConverters.*

final class ProjectionMetricsSpec extends AnyWordSpec with Matchers {

  private val now = Instant.parse("2026-10-03T12:00:00Z")

  private def metered(): (ProjectionMetrics, InMemoryMetricReader) = {
    val reader = InMemoryMetricReader.create()
    val provider = SdkMeterProvider.builder().registerMetricReader(reader).build()
    (ProjectionMetrics(provider.get("auction"), Clock.fixed(now, ZoneOffset.UTC)), reader)
  }

  private def metric(reader: InMemoryMetricReader, name: String): Option[MetricData] =
    reader.collectAllMetrics().asScala.find(_.getName == name)

  "projection metrics" should {

    "reports the events behind per tag as the backlog reads them" in {
      val (metrics, reader) = metered()
      metrics.watchBacklog("lot-view", () => Map("lot-0" -> 3L, "lot-1" -> 0L))
      val points = metric(reader, "auction.projection.events_behind").get.getLongGaugeData.getPoints.asScala
      points
        .map(point => point.getAttributes.asMap.asScala.values.map(_.toString).toSet -> point.getValue)
        .toSet shouldBe
        Set(Set("lot-view", "lot-0") -> 3L, Set("lot-view", "lot-1") -> 0L)
    }

    "skips one observation when the backlog cannot be read" in {
      val (metrics, reader) = metered()
      metrics.watchBacklog("lot-view", () => throw new IllegalStateException("database is down"))
      metric(reader, "auction.projection.events_behind") shouldBe None
    }

    "records the seconds from writing an event to processing it" in {
      val (metrics, reader) = metered()
      metrics
        .observer[Long](written => written)
        .afterProcess(ProjectionId("lot-view", "lot-2"), now.toEpochMilli - 1500)
      val histogram = metric(reader, "auction.projection.lag").get.getHistogramData.getPoints.asScala.head
      histogram.getSum shouldBe 1.5
      histogram.getCount shouldBe 1
    }
  }

  "projection backlog" should {

    "counts every tagged event past the stored offset" in {
      ProjectionBacklog.behind(
        Seq("lot-0", "lot-1", "lot-2"),
        Map("lot-0" -> 10L, "lot-1" -> 7L),
        Map("lot-0" -> 4L)
      ) shouldBe
        Map("lot-0" -> 6L, "lot-1" -> 7L, "lot-2" -> 0L)
    }

    "never reports a negative backlog" in {
      ProjectionBacklog.behind(Seq("lot-0"), Map("lot-0" -> 3L), Map("lot-0" -> 5L)) shouldBe Map("lot-0" -> 0L)
    }
  }

  "telemetry defaults" should {

    "exports metrics only when the environment names a collector" in {
      Telemetry.defaults(Map.empty)("otel.metrics.exporter") shouldBe "none"
      Telemetry.defaults(Map("OTEL_EXPORTER_OTLP_ENDPOINT" -> "http://localhost:4317"))(
        "otel.metrics.exporter"
      ) shouldBe "otlp"
    }

    "keeps traces and logs off" in {
      val defaults = Telemetry.defaults(Map("OTEL_EXPORTER_OTLP_ENDPOINT" -> "http://localhost:4317"))
      (defaults("otel.traces.exporter"), defaults("otel.logs.exporter")) shouldBe ("none", "none")
    }
  }
}
