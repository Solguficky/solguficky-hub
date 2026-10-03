package auction.publication

import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

final class OutboxRelaySpec extends AnyWordSpec with Matchers {

  "outbox relay" should {

    "hide the user and password of a bus address in the text it logs" in {
      OutboxRelay.withoutCredentials("Unable to connect to NATS servers: [nats://nats:s3cr3t@localhost:4222]") shouldBe
        "Unable to connect to NATS servers: [nats://***@localhost:4222]"
    }

    "leave an address without credentials and plain text as they are" in {
      OutboxRelay.withoutCredentials("Timeout waiting for nats://localhost:4222 ack") shouldBe
        "Timeout waiting for nats://localhost:4222 ack"
      OutboxRelay.withoutCredentials("") shouldBe ""
    }
  }
}
