package auction.aggregate

import auction.aggregate.AuctionFixtures.*
import auction.lot.LotFixtures
import auction.lot.LotFixtures.tiers
import auction.lot.StepPolicyInput
import auction.lot.StepPolicyInvalid
import org.scalacheck.Gen
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec
import org.scalatestplus.scalacheck.ScalaCheckDrivenPropertyChecks

final class AuctionConfigSpec extends AnyWordSpec with Matchers with ScalaCheckDrivenPropertyChecks {

  implicit override val generatorDrivenConfig: PropertyCheckConfiguration =
    PropertyCheckConfiguration(minSuccessful = 100)

  private val withoutClosesAt = Some(week.copy(closesAt = None))

  private val policies: Gen[ClosingPolicy] =
    Gen.oneOf(
      ClosingPolicy.ByAuctioneer,
      ClosingPolicy.ByDeadline,
      ClosingPolicy.Mixed(onlineByDeadline = true),
      ClosingPolicy.Mixed(onlineByDeadline = false)
    )

  "auction config" should {

    "accepts the week format and hands lots its closesAt as their deadline" in {
      val accepted = AuctionConfig.parse(configInput())
      accepted.map(_.lotDeadline) shouldBe Right(Some(closesAt))
      accepted.map(_.lotDefaults) shouldBe Right(LotFixtures.config())
    }

    // Т-19
    "refuses closing by deadline without closesAt" in {
      AuctionConfig.parse(
        configInput(Some(OnlinePhase(opensAt, None, closesLots = false)), closingPolicy = ClosingPolicy.ByDeadline)
      ) shouldBe Left(ConfigInvalid.ClosesAtMissing)
    }

    // Т-44
    "refuses closing lots at the end of the online phase without closesAt" in {
      AuctionConfig.parse(configInput(withoutClosesAt, closingPolicy = ClosingPolicy.ByAuctioneer)) shouldBe
        Left(ConfigInvalid.ClosesAtMissing)
    }

    "refuses a mixed policy that closes online lots by deadline without closesAt" in {
      AuctionConfig.parse(
        configInput(
          Some(OnlinePhase(opensAt, None, closesLots = false)),
          closingPolicy = ClosingPolicy.Mixed(onlineByDeadline = true)
        )
      ) shouldBe Left(ConfigInvalid.ClosesAtMissing)
    }

    "accepts a config without closesAt exactly when nothing in it needs a deadline" in {
      forAll(policies, Gen.oneOf(true, false), Gen.oneOf(true, false)) { (policy, closesLots, hasOnlinePhase) =>
        val phase = Option.when(hasOnlinePhase)(OnlinePhase(opensAt, None, closesLots))
        val needsDeadline = (hasOnlinePhase && closesLots) || policy == ClosingPolicy.ByDeadline ||
          policy == ClosingPolicy.Mixed(onlineByDeadline = true)
        AuctionConfig.parse(configInput(phase, closingPolicy = policy)).isRight shouldBe !needsDeadline
      }
    }

    "gives lots no deadline when the end of the online phase does not close them" in {
      val open = Some(OnlinePhase(opensAt, Some(closesAt), closesLots = false))
      AuctionConfig.parse(configInput(open, closingPolicy = ClosingPolicy.ByAuctioneer)).map(_.lotDeadline) shouldBe
        Right(None)
    }

    "refuses closesAt that is not after opensAt" in {
      for (closes <- List(opensAt, opensAt.minusSeconds(1)))
        AuctionConfig.parse(configInput(Some(week.copy(closesAt = Some(closes))))) shouldBe
          Left(ConfigInvalid.ClosesAtNotAfterOpensAt)
    }

    "refuses a number of final blocks outside zero and one" in {
      for (blocks <- List(-1, 2))
        AuctionConfig.parse(configInput(finalBlocks = blocks)) shouldBe Left(ConfigInvalid.FinalBlocksOutOfRange)
      AuctionConfig.parse(configInput(finalBlocks = 0)).isRight shouldBe true
    }

    "refuses lot defaults whose step policy is contradictory" in {
      val unsorted = LotFixtures.configInput(StepPolicyInput.Tiered(tiers((0, 10), (500, 20), (100, 30))))
      AuctionConfig.parse(configInput(lotDefaults = unsorted)) shouldBe
        Left(ConfigInvalid.LotDefaults(StepPolicyInvalid.BoundsNotAscending))
    }
  }
}
