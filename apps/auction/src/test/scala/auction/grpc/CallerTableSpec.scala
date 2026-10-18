package auction.grpc

import com.typesafe.config.ConfigFactory
import org.scalatest.EitherValues
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

final class CallerTableSpec extends AnyWordSpec with Matchers with EitherValues {

  private val both = Set(Caller.HubBot, Caller.AuctionBot)

  private def config(entries: (String, String)*) =
    ConfigFactory.parseString(
      entries.map((node, token) => s"""auction.grpc.callers."$node" = "$token"""").mkString("\n")
    )

  private val complete = config("hub-bot" -> "hub-secret", "auction-bot" -> "auction-secret")

  "caller table" should {

    "identifies each declared caller by its own token" in {
      val table = CallerTable.fromConfig(complete, both).value
      table.identify("hub-secret") shouldBe Some(Caller.HubBot)
      table.identify("auction-secret") shouldBe Some(Caller.AuctionBot)
    }

    "identifies nobody by a token it does not hold" in {
      val table = CallerTable.fromConfig(complete, both).value
      table.identify("hub-secret-2") shouldBe None
      table.identify("") shouldBe None
    }

    "refuses to start when a declared caller has no token and names its variable" in {
      val refusal = CallerTable.fromConfig(config("hub-bot" -> "hub-secret"), both).left.value
      refusal should include("AUCTION_CALLER_TOKEN_AUCTION_BOT")
    }

    "refuses to start when a declared caller has an empty token" in {
      val refusal = CallerTable.fromConfig(config("hub-bot" -> "", "auction-bot" -> "x"), both).left.value
      refusal should include("AUCTION_CALLER_TOKEN_HUB_BOT")
    }

    "refuses to start when a declared caller has a token of blanks only" in {
      val refusal = CallerTable.fromConfig(config("hub-bot" -> "  ", "auction-bot" -> "x"), both).left.value
      refusal should include("AUCTION_CALLER_TOKEN_HUB_BOT")
    }

    "identifies a caller whose configured token ends with a line break" in {
      val table =
        CallerTable.fromConfig(config("hub-bot" -> "hub-secret\\n", "auction-bot" -> "auction-secret"), both).value
      table.identify("hub-secret") shouldBe Some(Caller.HubBot)
    }

    "refuses to start when two callers share one token without printing it" in {
      val refusal =
        CallerTable.fromConfig(config("hub-bot" -> "same", "auction-bot" -> "same"), both).left.value
      refusal should include("auction-bot and hub-bot")
      refusal should not include "same"
    }

    "reads the tokens the service config binds from the environment variables" in {
      val service = ConfigFactory.parseResourcesAnySyntax("application")
      val variables = both.map(CallerTable.environmentVariable)
      variables shouldBe Set("AUCTION_CALLER_TOKEN_HUB_BOT", "AUCTION_CALLER_TOKEN_AUCTION_BOT")
      // Переменные окружения подкладываются корнем конфигурации: так их видит
      // подстановка `${?NAME}`, и тест не зависит от окружения машины.
      val resolved = ConfigFactory
        .parseString(variables.map(name => s"""$name = "$name-value"""").mkString("\n"))
        .withFallback(service)
        .resolve()
      val table = CallerTable.fromConfig(resolved, both).value
      table.identify("AUCTION_CALLER_TOKEN_AUCTION_BOT-value") shouldBe Some(Caller.AuctionBot)
    }
  }
}
