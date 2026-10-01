package auction.naming

import org.scalacheck.Gen
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec
import org.scalatestplus.scalacheck.ScalaCheckDrivenPropertyChecks

final class TelegramUsernameSpec extends AnyWordSpec with Matchers with ScalaCheckDrivenPropertyChecks {

  "TelegramUsername" should {

    "rejects text that Telegram never sends as a username" in {
      forAll(Gen.oneOf("", "@vasya", "вася", "va sya", "vasya*", "a" * 33)) { raw =>
        TelegramUsername.from(raw) shouldBe None
      }
    }

    "keeps a username as Telegram sent it" in {
      TelegramUsername.from("Vasya_1990").map(_.value) shouldBe Some("Vasya_1990")
    }
  }
}
