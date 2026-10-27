package auction.aggregate

import auction.aggregate.AuctionFixtures.*
import auction.catalog.LotId
import auction.lot.LotFixtures.op
import auction.lot.OpId
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

import java.time.Instant
import java.util.UUID

/**
 * Период «Счастливых часов» аукциона (ADR-047, дополнение 2026-10-27): создание и удаление до начала, без акторов и
 * журнала. Часы — подставленный `now`.
 */
final class HappyHourPeriodSpec extends AnyWordSpec with Matchers {

  private val meetup = MeetupId(new UUID(6L, 1L))
  private val lot = LotId(new UUID(5L, 1L))

  /** Сутки онлайн-торгов: период от `now` раньше конца недели. */
  private val now: Instant = opensAt.plusSeconds(24 * 3600)

  private def hours(n: Long): Instant = opensAt.plusSeconds(n * 3600)

  private def prebidding(input: AuctionConfigInput = configInput()): Auction =
    Auction(AuctionState.Prebidding(config(input), op(3)), Some(meetup), Set(lot), Map.empty)

  private def create(from: Instant = hours(30), until: Instant = hours(32), opN: Int = 7): CreateHappyHourPeriod =
    CreateHappyHourPeriod(from, until, op(opN))

  private def period(from: Instant = hours(30), until: Instant = hours(32), opN: Int = 7): HappyHourPeriod =
    HappyHourPeriod(HappyHourPeriod.idOf(op(opN)), from, until)

  private def delete(opN: Int = 7, deleteN: Int = 8): DeleteHappyHourPeriod =
    DeleteHappyHourPeriod(HappyHourPeriod.idOf(op(opN)), op(deleteN))

  private def written(auction: Auction, command: CreateHappyHourPeriod): Auction =
    applied(auction, command.opId, Auction.decide(auction, command, now))

  private def applied[R](auction: Auction, opId: OpId, decision: Either[R, AuctionDecision]): Auction =
    decision match {
      case Right(AuctionDecision.Accepted(event)) =>
        Auction.apply(auction, AuctionEnvelope(auction.seen.size.toLong + 1, opId, event))
      case other => fail(s"the command was not accepted: $other")
    }

  "happy hour period creation" should {

    "record a period of the online phase with an id derived from its op_id" in {
      Auction.decide(prebidding(), create(), now) shouldBe Right(
        AuctionDecision.Accepted(AuctionEvent.HappyHourPeriodCreated(period()))
      )
      HappyHourPeriod.idOf(op(7)) shouldBe HappyHourPeriod.idOf(op(7))
      HappyHourPeriod.idOf(op(7)) should not be HappyHourPeriod.idOf(op(8))
    }

    "keep the periods in the order they were created" in {
      val once = written(prebidding(), create(opN = 7))
      val twice = written(once, create(from = hours(40), until = hours(41), opN = 8))

      twice.happyHours shouldBe List(period(), period(hours(40), hours(41), opN = 8))
    }

    "accept a period that overlaps another: the terms of a lot are what may not overlap" in {
      val once = written(prebidding(), create(opN = 7))

      Auction.decide(once, create(from = hours(31), until = hours(33), opN = 8), now).isRight shouldBe true
    }

    "accept a period that starts at the instant of the command and one that fills the whole online phase" in {
      Auction.decide(prebidding(), create(from = now), now).isRight shouldBe true
      Auction.decide(prebidding(), create(from = now, until = closesAt), now).isRight shouldBe true
    }

    "answer a repeated op_id with the original before the phase and the clock" in {
      val once = written(prebidding(), create())
      val original = once.seen(op(7))
      val later = once.copy(state = AuctionState.Settling(config(), op(3)))

      Auction.decide(once, create(), hours(31)) shouldBe Right(AuctionDecision.Repeated(original))
      Auction.decide(later, create(), now) shouldBe Right(AuctionDecision.Repeated(original))
    }

    "refuse an auction that is not trading online" in {
      for (state <- List(AuctionState.Scheduled(config()), AuctionState.Settling(config(), op(3))))
        Auction.decide(prebidding().copy(state = state), create(), now) shouldBe
          Left(CreateHappyHourPeriodRejected.NotInPrebidding)
      Auction.decide(Auction.initial, create(), now) shouldBe Left(CreateHappyHourPeriodRejected.AuctionNotFound)
    }

    "refuse a start earlier than the instant of the command" in {
      Auction.decide(prebidding(), create(from = now.minusSeconds(1)), now) shouldBe
        Left(CreateHappyHourPeriodRejected.PeriodInPast)
    }

    "refuse an end that is not later than the start" in {
      for (until <- List(hours(30), hours(29)))
        Auction.decide(prebidding(), create(until = until), now) shouldBe
          Left(CreateHappyHourPeriodRejected.PeriodEmpty)
    }

    "refuse a period outside the online phase and on a phase without its end" in {
      Auction.decide(prebidding(), create(until = closesAt.plusSeconds(1)), now) shouldBe
        Left(CreateHappyHourPeriodRejected.PeriodOutsideOnlinePhase)
      Auction.decide(prebidding(), create(from = opensAt.minusSeconds(60)), opensAt.minusSeconds(120)) shouldBe
        Left(CreateHappyHourPeriodRejected.PeriodOutsideOnlinePhase)
      Auction.decide(prebidding(byAuctioneer), create(), now) shouldBe
        Left(CreateHappyHourPeriodRejected.PeriodOutsideOnlinePhase)
    }
  }

  "happy hour period deletion" should {

    "delete a period that has not started and drop it from the auction" in {
      val created = written(prebidding(), create())
      val decision = Auction.decide(created, delete(), hours(30).minusSeconds(1))

      decision shouldBe Right(
        AuctionDecision.Accepted(AuctionEvent.HappyHourPeriodDeleted(HappyHourPeriod.idOf(op(7))))
      )
      applied(created, op(8), decision).happyHours shouldBe empty
    }

    "refuse a period that has started, from its first instant" in {
      val created = written(prebidding(), create())

      for (moment <- List(hours(30), hours(31), hours(33)))
        Auction.decide(created, delete(), moment) shouldBe Left(DeleteHappyHourPeriodRejected.PeriodStarted)
    }

    "refuse a period the auction does not have, including a deleted one" in {
      val created = written(prebidding(), create())
      val deleted = applied(created, op(8), Auction.decide(created, delete(), now))

      Auction.decide(prebidding(), delete(), now) shouldBe Left(DeleteHappyHourPeriodRejected.PeriodNotFound)
      Auction.decide(deleted, delete(deleteN = 9), now) shouldBe Left(DeleteHappyHourPeriodRejected.PeriodNotFound)
    }

    "answer a repeated op_id with the original even once the period would have started" in {
      val created = written(prebidding(), create())
      val deleted = applied(created, op(8), Auction.decide(created, delete(), now))

      Auction.decide(deleted, delete(), hours(31)) shouldBe Right(AuctionDecision.Repeated(deleted.seen(op(8))))
    }

    "refuse an auction that is not trading online" in {
      val created = written(prebidding(), create())

      Auction.decide(created.copy(state = AuctionState.Settling(config(), op(3))), delete(), now) shouldBe
        Left(DeleteHappyHourPeriodRejected.NotInPrebidding)
      Auction.decide(Auction.initial, delete(), now) shouldBe Left(DeleteHappyHourPeriodRejected.AuctionNotFound)
    }
  }
}
