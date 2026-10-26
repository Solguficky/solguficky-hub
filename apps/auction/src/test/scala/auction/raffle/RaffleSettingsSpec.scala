package auction.raffle

import com.typesafe.config.ConfigFactory
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

/** Режим итога розыгрыша — настройка сервиса (PER-727): разбирается до `ActorSystem`, неизвестное значение — отказ. */
final class RaffleSettingsSpec extends AnyWordSpec with Matchers {

  private def settings(draw: String) =
    RaffleSettings.fromConfig(
      ConfigFactory.parseString(
        s"""auction.raffle { screening-window = 30s, retry-every = 3s, name-retention = 30d, draw = "$draw" }"""
      )
    )

  "the raffle settings" should {

    "draw from the beacon by default and leave the winner to an administrator only when told so" in {
      RaffleSettings.fromConfig(ConfigFactory.load()).map(_.byHand) shouldBe Right(false)
      settings("automatic").map(_.byHand) shouldBe Right(false)
      settings("manual").map(_.byHand) shouldBe Right(true)
    }

    "refuse to start on a draw it does not know rather than draw from the beacon silently" in {
      settings("wheel").isLeft shouldBe true
      settings("Manual").isLeft shouldBe true
    }
  }
}
