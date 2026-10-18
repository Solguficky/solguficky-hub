package auction.telemetry

import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

final class TelemetrySpec extends AnyWordSpec with Matchers {

  private val collector = Map("OTEL_EXPORTER_OTLP_ENDPOINT" -> "http://localhost:4317")

  "telemetry defaults" should {

    "exports metrics only when the environment names a collector" in {
      Telemetry.defaults(Map.empty)("otel.metrics.exporter") shouldBe "none"
      Telemetry.defaults(collector)("otel.metrics.exporter") shouldBe "otlp"
    }

    "keeps traces and logs off" in {
      val defaults = Telemetry.defaults(collector)
      (defaults("otel.traces.exporter"), defaults("otel.logs.exporter")) shouldBe ("none", "none")
    }

    "names the service when the environment does not" in {
      Telemetry.defaults(Map.empty)("otel.service.name") shouldBe "auction"
    }
  }
}
