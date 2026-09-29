package auction.lot

import auction.lot.LotFixtures.*
import org.scalacheck.Gen
import org.scalacheck.Shrink
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec
import org.scalatestplus.scalacheck.ScalaCheckDrivenPropertyChecks

final class StepPolicySpec extends AnyWordSpec with Matchers with ScalaCheckDrivenPropertyChecks {

  // Умолчание моста — десять проверок, поэтому число задаётся явно.
  implicit override val generatorDrivenConfig: PropertyCheckConfiguration =
    PropertyCheckConfiguration(minSuccessful = 200)

  // Сжатие списка порогов по умолчанию ломает его инвариант — первую границу ноль и рост границ, — и сокращённый
  // контрпример падал бы на построении политики, а не на проверке шага.
  implicit val noTierShrink: Shrink[List[(Long, Long)]] = Shrink.shrinkAny

  "step policy" should {

    "take the step of the new tier once the price crosses its bound (Т-08)" in {
      val policy = tiered(0L -> 10L, 200L -> 20L)

      StepPolicy.step(policy, money(190)) shouldBe money(10)
      StepPolicy.step(policy, money(200)) shouldBe money(20)
    }

    "keep the last tier open above its bound (Т-32)" in {
      StepPolicy.step(tiered(0L -> 10L, 200L -> 20L), money(300)) shouldBe money(20)
    }

    "return the fixed step at any price" in {
      forAll(Gen.chooseNum(0L, 1_000_000_000L)) { (price: Long) =>
        StepPolicy.step(fixedTen, money(price)) shouldBe money(10)
      }
    }

    "match the step of the last tier whose bound does not exceed the price" in {
      val tierLists = for {
        size <- Gen.chooseNum(1, 6)
        bounds <- Gen.listOfN(size - 1, Gen.chooseNum(1L, 10_000L)).map(_.distinct.sorted)
        steps <- Gen.listOfN(bounds.size + 1, Gen.chooseNum(1L, 500L))
      } yield (0L :: bounds).zip(steps)

      forAll(tierLists, Gen.chooseNum(0L, 12_000L)) { (tiers: List[(Long, Long)], price: Long) =>
        val expected = tiers.filter((bound, _) => bound <= price).last._2
        StepPolicy.step(tiered(tiers*), money(price)) shouldBe money(expected)
      }
    }

    "reject an empty tier list (И-15)" in {
      StepPolicy.tiered(Nil) shouldBe Left(StepPolicyInvalid.Empty)
    }

    "reject tiers whose first bound is not zero (И-15)" in {
      StepPolicy.tiered(tiers(10L -> 10L, 200L -> 20L)) shouldBe Left(StepPolicyInvalid.FirstBoundNotZero)
    }

    "reject tiers whose bounds do not strictly ascend (И-15)" in {
      StepPolicy.tiered(tiers(0L -> 10L, 200L -> 20L, 100L -> 30L)) shouldBe Left(StepPolicyInvalid.BoundsNotAscending)
      StepPolicy.tiered(tiers(0L -> 10L, 200L -> 20L, 200L -> 30L)) shouldBe Left(StepPolicyInvalid.BoundsNotAscending)
    }

    "reject a tier with a step that is not positive (И-15)" in {
      StepPolicy.tiered(tiers(0L -> 10L, 200L -> 0L)) shouldBe Left(StepPolicyInvalid.StepNotPositive)
      StepPolicy.tiered(tiers(0L -> -5L)) shouldBe Left(StepPolicyInvalid.StepNotPositive)
    }

    "reject tiers expressed in more than one currency" in {
      StepPolicy.tiered(
        List(StepPolicy.Tier(money(0), money(10)), StepPolicy.Tier(Money(200, eur), money(20)))
      ) shouldBe
        Left(StepPolicyInvalid.MixedCurrency)
    }

    "reject a fixed step that is not positive" in {
      StepPolicy.fixed(money(0)) shouldBe Left(StepPolicyInvalid.StepNotPositive)
    }
  }

  "lot config" should {

    "reject a step policy in a currency other than the lot's" in {
      LotConfig.of(eur, fixedTen) shouldBe Left(StepPolicyInvalid.MixedCurrency)
    }
  }
}
