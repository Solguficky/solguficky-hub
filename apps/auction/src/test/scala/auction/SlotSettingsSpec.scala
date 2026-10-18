package auction

import com.typesafe.config.ConfigFactory
import org.scalatest.EitherValues
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

import scala.concurrent.duration.*

final class SlotSettingsSpec extends AnyWordSpec with Matchers with EitherValues {

  private def settings(holder: String, ask: String, command: FiniteDuration = 3.seconds) =
    SlotSettings.fromConfig(
      ConfigFactory.parseString(s"auction.slot { holder-timeout = $holder, ask-timeout = $ask }"),
      command
    )

  "SlotSettings" should {

    "takes the nested timeouts of the service configuration" in {
      SlotSettings.fromConfig(ConfigFactory.load(), 3.seconds).value shouldBe SlotSettings(1.second, 2.seconds)
    }

    "refuses a holder timeout that is not shorter than the slot timeout" in {
      settings("2s", "2s").left.value should include("auction.slot.holder-timeout")
    }

    "refuses a slot timeout that is not shorter than the command timeout" in {
      settings("1s", "3s").left.value should include("auction.slot.ask-timeout")
    }
  }
}
