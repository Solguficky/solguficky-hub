package auction.naming

import org.scalacheck.Gen
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec
import org.scalatestplus.scalacheck.ScalaCheckDrivenPropertyChecks

final class AliasSpec extends AnyWordSpec with Matchers with ScalaCheckDrivenPropertyChecks {

  implicit override val generatorDrivenConfig: PropertyCheckConfiguration =
    PropertyCheckConfiguration(minSuccessful = 200)

  private val blanks = Gen.listOf(Gen.oneOf(' ', '\t', '\n', '\u00A0', '\u2007', '\u202F', '\u3000')).map(_.mkString)

  private val texts = Gen.listOf(Gen.oneOf(Gen.alphaNumChar, Gen.oneOf('в', 'Я', 'ё', ' ', '\u00A0', '-'))).map(_.mkString)

  "Alias" should {

    "refuses a blank pseudonym" in {
      forAll(blanks)(raw => Alias(raw) shouldBe Left(NamingRefusal.AliasInvalid))
    }

    "refuses a pseudonym that carries a mark of another kind of name" in {
      forAll(Gen.oneOf("Вася*", "*", "@vasya", "Вася\uFF0A", "\uFF20vasya")) { raw =>
        Alias(raw) shouldBe Left(NamingRefusal.AliasInvalid)
      }
    }

    "refuses a pseudonym with characters that make different texts look the same" in {
      forAll(Gen.oneOf("Ва\u200Bся", "Вася\u202E", "Ва\u0000ся", "Вася\n\u0007")) { raw =>
        Alias(raw) shouldBe Left(NamingRefusal.AliasInvalid)
      }
    }

    "accepts a pseudonym of the longest length and refuses a longer one" in {
      Alias("я" * Alias.MaxLength).map(_.value) shouldBe Right("я" * Alias.MaxLength)
      Alias("я" * (Alias.MaxLength + 1)) shouldBe Left(NamingRefusal.AliasInvalid)
    }

    "counts a character outside the basic plane once" in {
      Alias("🐈" * Alias.MaxLength).isRight shouldBe true
    }

    "trims the edges and collapses the spaces inside" in {
      Alias("\u00A0 Кот  в\tсапогах ").map(_.value) shouldBe Right("Кот в сапогах")
    }

    "gives one key to pseudonyms that differ only in case and spaces" in {
      Alias(" вася ").map(_.key) shouldBe Alias("ВАСЯ").map(_.key)
    }

    "gives one key to letters that differ only in case, including the final sigma" in {
      Alias("Σοφία").map(_.key) shouldBe Alias("σοφίΑ").map(_.key)
      Alias("Σ").map(_.key) shouldBe Alias("ς").map(_.key)
    }

    "keeps its text when it is read back" in {
      forAll(texts) { raw =>
        Alias(raw).foreach(alias => Alias(alias.value) shouldBe Right(alias))
      }
    }
  }
}
