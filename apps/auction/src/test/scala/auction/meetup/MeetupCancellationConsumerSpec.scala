package auction.meetup

import auction.telemetry.NatsClientLog
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

final class MeetupCancellationConsumerSpec extends AnyWordSpec with Matchers {

  "the meetup facts consumer connection" should {

    // Без своего слушателя клиент пишет в java.util.logging мимо logback, и L1 «тревоги нет» прошёл бы на любой тревоге.
    "sends client events to the service log" in {
      MeetupCancellationConsumer.options("nats://localhost:4222").getErrorListener shouldBe a[NatsClientLog]
    }
  }
}
