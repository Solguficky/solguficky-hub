package auction.raffle

import org.scalacheck.Gen
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec
import org.scalatestplus.scalacheck.ScalaCheckDrivenPropertyChecks

import java.security.SecureRandom
import java.time.Instant

/**
 * Вектор посчитан независимо от кода сервиса — однострочником на Python из инструкции пересчёта (ADR-066, «Пересчёт
 * участником»): `hashlib.sha256(f"{seed}:{n}:{rnd}".encode()).hexdigest()` и `int(V, 16) % n + 1`.
 */
final class QuicknetSpec extends AnyWordSpec with Matchers with ScalaCheckDrivenPropertyChecks {

  private val seed = Seed.fromHex("46fb9863b7178feb348aa621d658c5b41b848e398494830bac4837e0b0f539ae").get
  private val randomness =
    Randomness.fromHex("d7941e7b5bcaf8742bfc7136d38c5ab8274286629ffe43081dbda1f05d798300").get

  private def hex(n: Int): Randomness = Randomness.fromHex(f"$n%064x").get

  "the draw" should {

    "matches the vector computed by the recount instruction" in {
      seed.commitment shouldBe "4580ac5de3883a30938cd0ce71157b4614e57ec6ea6a39c5a7ef3bb296d37133"
      Draw.value(seed, 1000, randomness) shouldBe "fce17a6af60b41446eb069e7ee815065bb6d11e7f9afa4266041b9d4b78e02ca"
      Draw.winner(seed, 1000, randomness) shouldBe 163
      Draw.winner(seed, 7, randomness) shouldBe 1
      Draw.winner(seed, 1, randomness) shouldBe 1
    }

    "gives the same winner for the same seed and the same pool and stays within 1..N" in {
      val generator = new SecureRandom()
      forAll(Gen.choose(1, 5000)) { tickets =>
        val drawnSeed = Seed.random(generator)
        val winner = Draw.winner(drawnSeed, tickets, randomness)
        Draw.winner(drawnSeed, tickets, randomness) shouldBe winner
        winner should (be >= 1 and be <= tickets)
      }
    }

    "refuses a draw without tickets" in {
      an[IllegalArgumentException] should be thrownBy Draw.winner(seed, 0, randomness)
    }
  }

  "a seed" should {

    "is 32 random bytes in lowercase hex that never prints itself" in {
      val drawn = Seed.random(new SecureRandom())
      drawn.hex should fullyMatch regex "[0-9a-f]{64}"
      drawn.toString should not include drawn.hex
      Seed.fromHex(drawn.hex) shouldBe Some(drawn)
    }

    "refuses anything but 64 lowercase hex characters" in {
      Seed.fromHex(seed.hex.toUpperCase) shouldBe None
      Seed.fromHex(seed.hex.drop(1)) shouldBe None
      Randomness.fromHex("zz" * 32) shouldBe None
    }
  }

  "the quicknet round" should {

    "is the first round not earlier than a minute after closing, on and off the period" in {
      Quicknet.roundFor(Instant.ofEpochSecond(1700000000L)) shouldBe 2398899L
      Quicknet.roundFor(Instant.ofEpochSecond(1700000001L)) shouldBe 2398899L
      Quicknet.roundFor(Instant.ofEpochSecond(1700000002L)) shouldBe 2398900L
      Quicknet.roundAt(2398899L) shouldBe Instant.ofEpochSecond(1700000061L)
    }

    "never comes before closing plus the margin and never a whole period after it" in {
      forAll(Gen.choose(1700000000L, 1900000000L), Gen.choose(0, 999999999)) { (seconds, nanos) =>
        val closesAt = Instant.ofEpochSecond(seconds, nanos.toLong)
        val round = Quicknet.roundFor(closesAt)
        val target = closesAt.plus(Quicknet.Margin)
        Quicknet.roundAt(round).isBefore(target) shouldBe false
        Quicknet.roundAt(round - 1).isBefore(target) shouldBe true
      }
    }
  }

  "the mirror quorum" should {

    "accepts a value two mirrors agree on even when another mirror lies or is silent" in {
      Quicknet.agreed(List(Some(hex(1)), Some(hex(2)), Some(hex(1)), None)) shouldBe Some(hex(1))
    }

    "waits when no two mirrors agree or two values each have two votes" in {
      Quicknet.agreed(List(Some(hex(1)), None, None, None)) shouldBe None
      Quicknet.agreed(List(Some(hex(1)), Some(hex(2)), Some(hex(3)), None)) shouldBe None
      Quicknet.agreed(List(Some(hex(1)), Some(hex(1)), Some(hex(2)), Some(hex(2)))) shouldBe None
    }
  }
}
