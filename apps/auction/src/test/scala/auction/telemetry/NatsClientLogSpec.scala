package auction.telemetry

import ch.qos.logback.classic.Level
import ch.qos.logback.classic.Logger as LogbackLogger
import ch.qos.logback.classic.spi.ILoggingEvent
import ch.qos.logback.core.read.ListAppender
import io.nats.client.JetStreamSubscription
import org.scalatest.BeforeAndAfterEach
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec
import org.slf4j.LoggerFactory

import java.lang.reflect.Proxy
import scala.annotation.tailrec
import scala.jdk.CollectionConverters.*

final class NatsClientLogSpec extends AnyWordSpec with Matchers with BeforeAndAfterEach {

  private val appender = new ListAppender[ILoggingEvent]()

  // Пока backend SLF4J инициализирует другой поток, фабрика отдаёт `SubstituteLogger` (как в `BoundaryLoggingSpec`).
  private lazy val clientLogger: LogbackLogger = {
    @tailrec
    def resolve(attemptsLeft: Int): LogbackLogger =
      LoggerFactory.getLogger(classOf[NatsClientLog]) match {
        case logback: LogbackLogger => logback
        case _ if attemptsLeft > 0 =>
          Thread.sleep(50)
          resolve(attemptsLeft - 1)
        case other => fail(s"slf4j did not settle on logback: ${other.getClass.getName}")
      }
    resolve(attemptsLeft = 40)
  }

  override def beforeEach(): Unit = {
    appender.list.clear()
    appender.start()
    clientLogger.addAppender(appender)
  }

  override def afterEach(): Unit = {
    clientLogger.detachAppender(appender)
    appender.stop()
  }

  // Подписка клиента — интерфейс с десятками методов; записи нужно только имя durable.
  private val subscription: JetStreamSubscription =
    Proxy
      .newProxyInstance(
        getClass.getClassLoader,
        Array(classOf[JetStreamSubscription]),
        (_, method, _) => if (method.getName == "getConsumerName") "auction-meetups-events" else null
      )
      .asInstanceOf[JetStreamSubscription]

  private def single: ILoggingEvent = {
    val events = appender.list.asScala.toList
    events should have size 1
    events.head
  }

  private def fields(event: ILoggingEvent): String = event.getArgumentArray.head.toString

  "the nats client log" should {

    "writes a heartbeat alarm as one error record with the durable and sequences" in {
      NatsClientLog("auction.meetup_facts").heartbeatAlarm(null, subscription, 7, 3)
      val event = single
      event.getLevel shouldBe Level.ERROR
      fields(event) should (
        include("operation=auction.meetup_facts") and include("result=error") and
          include("error_category=dependency_unavailable") and include("nats_event=heartbeatAlarm") and
          include("consumer=auction-meetups-events") and include("last_stream_sequence=7") and
          include("last_consumer_sequence=3")
      )
    }

    "names only the class of a client exception and warns, as the connection owner does" in {
      NatsClientLog("auction.outbox.dispatch")
        .exceptionOccurred(null, new java.io.IOException("nats://user:secret@bus:4222 refused"))
      val event = single
      event.getLevel shouldBe Level.WARN
      fields(event) should include("error=java.io.IOException")
      fields(event) should not include "secret"
    }

    "masks credentials in a server error text" in {
      NatsClientLog("auction.outbox.dispatch").errorOccurred(null, "Authorization Violation at nats://user:secret@bus")
      val event = single
      event.getLevel shouldBe Level.ERROR
      fields(event) should (include("nats_event=errorOccurred") and include("nats://***@bus"))
      fields(event) should not include "secret"
    }

    "writes a pull status error with its code" in {
      NatsClientLog("auction.meetup_facts")
        .pullStatusError(null, subscription, new io.nats.client.support.Status(409, "Consumer Deleted"))
      val event = single
      event.getLevel shouldBe Level.ERROR
      fields(event) should (
        include("nats_event=pullStatusError") and include("nats_status=409") and include("error=Consumer Deleted") and
          include("consumer=auction-meetups-events")
      )
    }

    "warns about a discarded message as a lost delivery" in {
      NatsClientLog("auction.meetup_facts").messageDiscarded(null, null)
      val event = single
      event.getLevel shouldBe Level.WARN
      fields(event) should (include("nats_event=messageDiscarded") and include("error_category=unexpected"))
    }
  }
}
