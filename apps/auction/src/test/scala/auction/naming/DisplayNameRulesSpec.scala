package auction.naming

import auction.lot.ParticipantId
import org.scalacheck.Gen
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec
import org.scalatestplus.scalacheck.ScalaCheckDrivenPropertyChecks

import java.util.UUID

final class DisplayNameRulesSpec extends AnyWordSpec with Matchers with ScalaCheckDrivenPropertyChecks {

  implicit override val generatorDrivenConfig: PropertyCheckConfiguration =
    PropertyCheckConfiguration(minSuccessful = 200)

  private val participants = Gen.uuid.map(ParticipantId(_))

  private val usernames = Gen
    .choose(1, 32)
    .flatMap(Gen.listOfN(_, Gen.oneOf(Gen.alphaNumChar, Gen.const('_'))))
    .map(chars => TelegramUsername.from(chars.mkString).getOrElse(fail(s"not a username: ${chars.mkString}")))

  private def username(raw: String) = TelegramUsername.from(raw).getOrElse(fail(s"not a username: $raw"))

  private def alias(raw: String) = Alias(raw).getOrElse(fail(s"not a pseudonym: $raw"))

  private val participant = ParticipantId(UUID.fromString("0190a0e0-0000-7000-8000-00000000beef"))

  "DisplayNameRules" should {

    "refuses the username choice of a participant who has no username" in {
      DisplayNameRules.decide(NameChoice.Username(None)) shouldBe Left(NamingRefusal.UsernameMissing)
    }

    "refuses an invalid pseudonym" in {
      DisplayNameRules.decide(NameChoice.Pseudonym("  ")) shouldBe Left(NamingRefusal.AliasInvalid)
    }

    "shows a username with @ and a pseudonym with a star" in {
      DisplayNameRules.render(participant, Some(ChosenName.Telegram(username("vasya")))) shouldBe
        DisplayName("@vasya", DisplayKind.Username)
      DisplayNameRules.render(participant, Some(ChosenName.Pseudonym(alias("Кот")))) shouldBe
        DisplayName("Кот*", DisplayKind.Pseudonym)
    }

    "tells a pseudonym apart from the same text taken as someone's username" in {
      forAll(usernames, participants, participants) { (taken, owner, impostor) =>
        val real = DisplayNameRules.render(owner, Some(ChosenName.Telegram(taken)))
        val copied = DisplayNameRules.render(impostor, Some(ChosenName.Pseudonym(alias(taken.value))))

        copied.text should not be real.text
      }
    }

    "gives a participant without a choice a placeholder that is neither a username nor a pseudonym" in {
      forAll(participants) { someone =>
        val shown = DisplayNameRules.render(someone, None)

        shown.kind shouldBe DisplayKind.Placeholder
        shown.text should startWith("Участник ")
        shown.text should not endWith "*"
        shown.text.trim should not be empty
      }
    }

    "admits a bid only with a chosen name" in {
      DisplayNameRules.requireChosen(None) shouldBe Left(NameNotChosen)
      DisplayNameRules.requireChosen(Some(ChosenName.Telegram(username("vasya")))).isRight shouldBe true
    }
  }
}
