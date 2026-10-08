package auction.aggregate

import auction.aggregate.AuctionFixtures.*
import auction.catalog.LotId
import auction.lot.CurrencyCode
import auction.lot.LotFixtures
import auction.lot.Money
import auction.lot.StepWindow
import auction.lot.LotFixtures.tiers
import auction.lot.StepPolicyInput
import auction.lot.StepPolicyInvalid
import org.scalacheck.Gen
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec
import org.scalatestplus.scalacheck.ScalaCheckDrivenPropertyChecks

import java.util.UUID

final class AuctionConfigSpec extends AnyWordSpec with Matchers with ScalaCheckDrivenPropertyChecks {

  implicit override val generatorDrivenConfig: PropertyCheckConfiguration =
    PropertyCheckConfiguration(minSuccessful = 100)

  private val withoutClosesAt = Some(week.copy(closesAt = None))

  private val lotA = LotId(new UUID(5L, 1L))
  private val lotB = LotId(new UUID(5L, 2L))
  private val lotC = LotId(new UUID(5L, 3L))

  private def withWindows(windows: StepWindowConfig*): Either[ConfigInvalid, AuctionConfig] =
    AuctionConfig.parse(configInput(stepWindows = windows.toList))

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
      accepted.map(_.lotDefaults) shouldBe Right(Some(LotFixtures.config()))
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

    "accepts step windows inside the week and hands each lot only the windows it is named in, by start" in {
      val late = window(48, 50, Set(lotA))
      val early = window(24, 26, Set(lotA, lotB))
      val accepted = withWindows(late, early)

      accepted.map(_.windowsOf(lotA)) shouldBe Right(
        List(
          StepWindow(early.from, early.until, early.step),
          StepWindow(late.from, late.until, late.step)
        )
      )
      accepted.map(_.windowsOf(lotB)) shouldBe Right(List(StepWindow(early.from, early.until, early.step)))
      accepted.map(_.windowsOf(lotC)) shouldBe Right(Nil)
    }

    "accepts a window that spans the whole week, both ends on its bounds" in {
      withWindows(StepWindowConfig(opensAt, closesAt, LotFixtures.money(1), Set(lotA))).isRight shouldBe true
    }

    // Т-68
    "refuses a window that starts before the week, ends after it or ends before it starts" in {
      val cases = List(
        StepWindowConfig(opensAt.minusSeconds(1), opensAt.plusSeconds(3600), LotFixtures.money(1), Set(lotA)),
        StepWindowConfig(opensAt, closesAt.plusSeconds(1), LotFixtures.money(1), Set(lotA)),
        window(5, 5, Set(lotA)),
        window(6, 5, Set(lotA))
      )
      for (invalid <- cases)
        withWindows(window(1, 2, Set(lotB)), invalid) shouldBe Left(ConfigInvalid.StepWindowOutsideOnlinePhase(1))
    }

    // Т-68
    "refuses a window when the week has no closesAt or there is no online phase at all" in {
      val ledByPerson = configInput(
        Some(OnlinePhase(opensAt, None, closesLots = false)),
        closingPolicy = ClosingPolicy.ByAuctioneer,
        stepWindows = List(window(1, 2, Set(lotA)))
      )
      AuctionConfig.parse(ledByPerson) shouldBe Left(ConfigInvalid.StepWindowWithoutClosesAt(0))
      AuctionConfig.parse(ledByPerson.copy(onlinePhase = None)) shouldBe
        Left(ConfigInvalid.StepWindowWithoutClosesAt(0))
    }

    // Т-69
    "refuses two windows that share a lot and intersect, and accepts the same intervals on different lots" in {
      withWindows(window(1, 3, Set(lotA)), window(5, 6, Set(lotC)), window(2, 4, Set(lotA, lotB))) shouldBe
        Left(ConfigInvalid.StepWindowsOverlap(0, 2))
      withWindows(window(1, 3, Set(lotA)), window(2, 4, Set(lotB))).isRight shouldBe true
      withWindows(window(1, 3, Set(lotA)), window(3, 4, Set(lotA))).isRight shouldBe true
    }

    // Т-69
    "refuses a window with no lots or with a step that is not positive" in {
      withWindows(window(1, 2, Set.empty)) shouldBe Left(ConfigInvalid.StepWindowLotsEmpty(0))
      withWindows(window(1, 2, Set(lotA), step = 0)) shouldBe Left(ConfigInvalid.StepWindowStepInvalid(0))
      withWindows(window(1, 2, Set(lotA), step = -1)) shouldBe Left(ConfigInvalid.StepWindowStepInvalid(0))
    }

    "refuses a window in another currency than the lot defaults, or than the platform without them" in {
      val euro = window(1, 2, Set(lotA)).copy(step = Money(1, CurrencyCode("EUR")))
      withWindows(euro) shouldBe Left(ConfigInvalid.StepWindowStepInvalid(0))
      AuctionConfig.parse(configInput(lotDefaults = None, stepWindows = List(euro))) shouldBe
        Left(ConfigInvalid.StepWindowStepInvalid(0))
      AuctionConfig.parse(configInput(lotDefaults = None, stepWindows = List(window(1, 2, Set(lotA))))).isRight shouldBe
        true
    }

    "refuses lot defaults whose step policy is contradictory" in {
      val unsorted = LotFixtures.configInput(StepPolicyInput.Tiered(tiers((0, 10), (500, 20), (100, 30))))
      AuctionConfig.parse(configInput(lotDefaults = Some(unsorted))) shouldBe
        Left(ConfigInvalid.LotDefaults(StepPolicyInvalid.BoundsNotAscending))
    }
  }
}
