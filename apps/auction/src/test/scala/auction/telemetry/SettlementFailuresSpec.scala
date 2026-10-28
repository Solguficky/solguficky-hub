package auction.telemetry

import ch.qos.logback.classic.Logger
import ch.qos.logback.classic.spi.ILoggingEvent
import ch.qos.logback.core.read.ListAppender
import io.opentelemetry.api.common.AttributeKey
import io.opentelemetry.sdk.metrics.SdkMeterProvider
import io.opentelemetry.sdk.testing.exporter.InMemoryMetricReader
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec
import org.slf4j.LoggerFactory

import java.util.concurrent.TimeoutException
import scala.jdk.CollectionConverters.*

final class SettlementFailuresSpec extends AnyWordSpec with Matchers {
  "settlement failure reporting" should {
    "counts timeouts separately from dependency failures and keeps exception messages out of the log" in {
      val reader = InMemoryMetricReader.create()
      val provider = SdkMeterProvider.builder().registerMetricReader(reader).build()
      val logger = LoggerFactory.getLogger("auction.settlement").asInstanceOf[Logger]
      val appender = new ListAppender[ILoggingEvent]
      appender.start()
      logger.addAppender(appender)
      try {
        val reporting = new SettlementFailures(provider.get("test"))
        reporting.record("lot", new TimeoutException("private user input"))
        reporting.record("lot", new IllegalStateException("private user input"))
        val metric = reader.collectAllMetrics().asScala.find(_.getName == "solguficky.failures").get
        val points = metric.getLongSumData.getPoints.asScala.toList
        points
          .map(point => point.getAttributes.get(AttributeKey.stringKey("error_category")) -> point.getValue)
          .toMap shouldBe Map("timeout" -> 1L, "dependency_unavailable" -> 1L)
        points.foreach(point => point.getAttributes.get(AttributeKey.stringKey("service")) shouldBe "auction")
        appender.list.asScala should have size 2
        val records = appender.list.asScala.map(_.getArgumentArray.toList.mkString)
        records.head should include("timeout")
        records.last should include("dependency_unavailable")
        records.foreach(record => record should not include "private user input")
      } finally {
        logger.detachAppender(appender)
        appender.stop()
        provider.close()
      }
    }
  }
}
