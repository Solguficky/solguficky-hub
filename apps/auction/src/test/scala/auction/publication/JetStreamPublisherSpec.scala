package auction.publication

import auction.telemetry.NatsClientLog
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

final class JetStreamPublisherSpec extends AnyWordSpec with Matchers {

  "the fact publisher connection" should {

    // Без своего слушателя клиент пишет в java.util.logging мимо logback голым stderr.
    "sends client events to the service log" in {
      JetStreamPublisher.options("nats://localhost:4222").getErrorListener shouldBe a[NatsClientLog]
    }
  }
}
