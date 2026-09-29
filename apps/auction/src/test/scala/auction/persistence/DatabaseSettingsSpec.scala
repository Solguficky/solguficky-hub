package auction.persistence

import com.typesafe.config.ConfigFactory
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

final class DatabaseSettingsSpec extends AnyWordSpec with Matchers {

  private val complete =
    """auction.database {
      |  url = "jdbc:postgresql://localhost:5432/auction"
      |  user = "auction"
      |  password = "secret"
      |}""".stripMargin

  "database settings" should {

    "read the url, user and password the plugin connects with" in {
      DatabaseSettings.fromConfig(ConfigFactory.parseString(complete)) shouldBe
        Right(DatabaseSettings("jdbc:postgresql://localhost:5432/auction", "auction", "secret"))
    }

    "name every environment variable that is not set" in {
      DatabaseSettings.fromConfig(ConfigFactory.parseString("""auction.database.user = "auction"""")) shouldBe
        Left("auction database is not configured: set AUCTION_DATABASE_JDBC_URL, AUCTION_DATABASE_PASSWORD")
    }

    "treat a blank value as not set" in {
      val emptyUrl =
        ConfigFactory.parseString("""auction.database.url = "  """").withFallback(ConfigFactory.parseString(complete))

      DatabaseSettings.fromConfig(emptyUrl) shouldBe
        Left("auction database is not configured: set AUCTION_DATABASE_JDBC_URL")
    }

    "keep the password out of its printed form" in {
      DatabaseSettings(
        "jdbc:postgresql://localhost:5432/auction",
        "auction",
        "secret"
      ).toString should not include "secret"
    }
  }
}
