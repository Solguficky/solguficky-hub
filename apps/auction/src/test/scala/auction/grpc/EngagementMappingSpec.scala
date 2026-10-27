package auction.grpc

import auction.aggregate.AuctionFixtures.config
import auction.aggregate.AuctionFixtures.configInput
import auction.aggregate.AuctionFixtures.opensAt
import auction.aggregate.AuctionFixtures.week
import auction.aggregate.AuctionState
import auction.lot.OpId
import auction.lot.ParticipantId
import auction.prediction.OpenRoundForecasters
import auction.prediction.PredictionRound
import auction.raffle.Quicknet
import auction.raffle.RaffleState
import auction.raffle.RaffleTerms
import auction.raffle.Seed
import auction.v1.auction_service as wire
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

import java.time.Instant
import java.util.UUID

/** Участники розыгрыша и прогнозов для Notifications (PER-777): где регистрация и что уходит в ответ. */
final class EngagementMappingSpec extends AnyWordSpec with Matchers {

  private val closesAt: Instant = opensAt.plusSeconds(3 * 24 * 3600)
  private val withRaffle = config(configInput(Some(week.copy(raffleClosesAt = Some(closesAt)))))
  private val withoutRaffle = config(configInput(Some(week)))
  private val seed = Seed.fromHex("46fb9863b7178feb348aa621d658c5b41b848e398494830bac4837e0b0f539ae").get
  private val terms = RaffleTerms(closesAt, seed, Quicknet.roundFor(closesAt))
  private val started = OpId(UUID.fromString("01890a5d-ac98-7c2b-9f3a-0d1b2c3d4e01"))
  private def person(n: Int) = ParticipantId(new UUID(0x0190f2a000007000L, 0x8000000000000000L | n.toLong))
  private val before = closesAt.minusSeconds(1)

  "registration" should {

    "be open with the entries in registration order before T" in {
      EngagementMapping.registration(
        AuctionState.Prebidding(withRaffle, started),
        RaffleState.Open(terms, Vector(person(2), person(1))),
        before
      ) shouldBe Registration.Open(Vector(person(2), person(1)))
    }

    "be closed from T on, while the pool is still being fixed" in {
      EngagementMapping.registration(
        AuctionState.Prebidding(withRaffle, started),
        RaffleState.Open(terms, Vector(person(1))),
        closesAt
      ) shouldBe Registration.Closed
    }

    "be closed once the pool is fixed, the raffle not held or cancelled" in {
      val auction = AuctionState.Settling(withRaffle, started)
      Seq(
        RaffleState.Fixed(terms, Vector(person(1))),
        RaffleState.NotHeld(closesAt),
        RaffleState.Cancelled(terms, Vector(person(1)), closesAt)
      ).foreach(raffle => EngagementMapping.registration(auction, raffle, before) shouldBe Registration.Closed)
    }

    "not be open yet for a draft and for a raffle that opens with prebidding ahead of T" in {
      EngagementMapping.registration(AuctionState.Draft, RaffleState.Initial, before) shouldBe Registration.NotOpen
      EngagementMapping.registration(AuctionState.Scheduled(withRaffle), RaffleState.Initial, before) shouldBe
        Registration.NotOpen
      EngagementMapping.registration(AuctionState.Prebidding(withRaffle, started), RaffleState.Initial, before) shouldBe
        Registration.NotOpen
    }

    "be closed for an auction without a raffle and for a raffle whose T has passed before it opened" in {
      EngagementMapping.registration(AuctionState.Scheduled(withoutRaffle), RaffleState.Initial, before) shouldBe
        Registration.Closed
      EngagementMapping.registration(AuctionState.Scheduled(withRaffle), RaffleState.Initial, closesAt) shouldBe
        Registration.Closed
      EngagementMapping.registration(AuctionState.Finished(withRaffle, started), RaffleState.Initial, before) shouldBe
        Registration.Closed
    }
  }

  "the response" should {

    "carry the registrants only while registration is open and the forecasters of the open round" in {
      val open = EngagementMapping.response(
        Registration.Open(Vector(person(1))),
        Some(OpenRoundForecasters(PredictionRound.Final, Set(person(3), person(2))))
      )
      open.raffleRegistration shouldBe wire.RaffleRegistration.RAFFLE_REGISTRATION_OPEN
      open.raffleRegistrants shouldBe Seq(person(1).value.toString)
      open.openPredictionRound shouldBe Some(wire.PredictionRound.PREDICTION_ROUND_FINAL)
      open.forecasters shouldBe Seq(person(2), person(3)).map(_.value.toString)

      val closed = EngagementMapping.response(Registration.Closed, None)
      closed.raffleRegistration shouldBe wire.RaffleRegistration.RAFFLE_REGISTRATION_CLOSED
      closed.raffleRegistrants shouldBe empty
      closed.openPredictionRound shouldBe None
      closed.forecasters shouldBe empty
    }
  }
}
