package auction.aggregate

import auction.aggregate.AuctionFixtures.*
import auction.catalog.LotId
import auction.lot.AntiSnipe
import auction.lot.LotConfigInput
import auction.lot.LotFixtures
import auction.lot.LotFixtures.eur
import auction.lot.LotFixtures.money
import auction.lot.LotFixtures.op
import auction.lot.LotFixtures.rub
import auction.lot.MarkForFinal
import auction.lot.Money
import auction.lot.ScheduleLot
import auction.lot.StepPolicyInput
import auction.lot.UnmarkForFinal
import org.scalacheck.Gen
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec
import org.scalatestplus.scalacheck.ScalaCheckDrivenPropertyChecks

import java.time.Duration
import java.util.UUID

final class AuctionSpec extends AnyWordSpec with Matchers with ScalaCheckDrivenPropertyChecks {

  implicit override val generatorDrivenConfig: PropertyCheckConfiguration =
    PropertyCheckConfiguration(minSuccessful = 100)

  private val meetup = MeetupId(UUID.fromString("0190a0e0-0000-7000-8000-000000000001"))
  private val lot = LotId(new UUID(5L, 1L))

  private def born: Auction =
    Auction.apply(Auction.initial, AuctionEnvelope(1, op(1), AuctionEvent.AuctionDrafted(meetup)))

  private def scheduled: Auction =
    Auction.apply(born, AuctionEnvelope(2, op(2), AuctionEvent.AuctionScheduled(config())))

  private def started: Auction =
    Auction.apply(scheduled, AuctionEnvelope(3, op(3), AuctionEvent.PrebiddingStarted))

  /** Тот же аукцион с `lot` в реестре; номер строки и `op_id` — вне тех, что заняты образцами выше. */
  private def holding(auction: Auction): Auction =
    Auction.apply(auction, AuctionEnvelope(8, op(8), AuctionEvent.LotAdded(lot)))

  private val step = StepPolicyInput.Fixed(money(250))

  private val conditions = ScheduleAuctionLot(lot, money(5000), step, op(9))

  private def applied(auction: Auction, decision: AuctionDecision, sequence: Long, opN: Int): Auction =
    decision match {
      case AuctionDecision.Accepted(event) => Auction.apply(auction, AuctionEnvelope(sequence, op(opN), event))
      case other => fail(s"expected an event, got $other")
    }

  "auction id of a meetup" should {

    "keeps the vector fixed by the contract" in {
      Auction.idOf(meetup).value.toString shouldBe "daef05c7-cd68-5048-b03d-cb4860e8dc73"
    }

    "is a canonical version 5 uuid, the same for one meetup and different for another" in {
      forAll(Gen.uuid, Gen.uuid) { (a, b) =>
        val id = Auction.idOf(MeetupId(a)).value
        id.version shouldBe 5
        id.variant shouldBe 2
        Auction.idOf(MeetupId(a)) shouldBe Auction.idOf(MeetupId(a))
        if (a != b) Auction.idOf(MeetupId(b)) should not be Auction.idOf(MeetupId(a))
      }
    }
  }

  "auction" should {

    "is born at its meetup and keeps that meetup" in {
      Auction.decide(Auction.initial, DraftAuction(meetup, op(1))) shouldBe
        AuctionDecision.Accepted(AuctionEvent.AuctionDrafted(meetup))
      born.state shouldBe AuctionState.Draft
      born.meetup shouldBe Some(meetup)
    }

    "answers a repeated op_id with the original envelope and a new enabling without an event" in {
      Auction.decide(born, DraftAuction(meetup, op(1))) shouldBe
        AuctionDecision.Repeated(AuctionEnvelope(1, op(1), AuctionEvent.AuctionDrafted(meetup)))
      Auction.decide(born, DraftAuction(meetup, op(2))) shouldBe AuctionDecision.Unchanged
    }

    "refuses registry commands before it is born" in {
      Auction.decide(Auction.initial, AddLot(lot, op(2))) shouldBe Left(AddLotRejected.AuctionNotFound)
      Auction.decide(Auction.initial, RemoveLot(lot, op(2))) shouldBe Left(RemoveLotRejected.AuctionNotFound)
      Auction.inspect(Auction.initial, op(2)) shouldBe Inspection.Absent
    }

    "adds a lot, records a repeated addition of it, removes it and refuses to remove a lot it does not hold" in {
      val withLot = applied(born, Auction.decide(born, AddLot(lot, op(2))).toOption.get, 2, 2)
      withLot.lots shouldBe Set(lot)
      // Повторное добавление пишет событие, чтобы его op_id попал в окно: ответ без события повтором не защищён.
      Auction.decide(withLot, AddLot(lot, op(3))) shouldBe Right(AuctionDecision.Accepted(AuctionEvent.LotAdded(lot)))
      Auction.inspect(withLot, op(2)) shouldBe Inspection.Repeated(
        AuctionEnvelope(2, op(2), AuctionEvent.LotAdded(lot))
      )
      Auction.inspect(withLot, op(3)) shouldBe Inspection.Present(meetup, registryOpen = true)
      val without = applied(withLot, Auction.decide(withLot, RemoveLot(lot, op(3))).toOption.get, 3, 3)
      // Запоздавший повтор добавления, записанного событием, лот после снятия не возвращает.
      val twice = applied(withLot, Auction.decide(withLot, AddLot(lot, op(5))).toOption.get, 3, 5)
      val removed = applied(twice, Auction.decide(twice, RemoveLot(lot, op(6))).toOption.get, 4, 6)
      Auction.decide(removed, AddLot(lot, op(5))) shouldBe
        Right(AuctionDecision.Repeated(AuctionEnvelope(3, op(5), AuctionEvent.LotAdded(lot))))
      without.lots shouldBe empty
      Auction.decide(without, RemoveLot(lot, op(4))) shouldBe Left(RemoveLotRejected.LotNotInAuction)
    }

    // Т-44
    "stays a draft when the config closes lots without closesAt" in {
      val invalid = configInput(Some(week.copy(closesAt = None)))
      Auction.decide(born, ScheduleAuction(invalid, op(2))) shouldBe
        Left(ScheduleAuctionRejected.ConfigInvalid(ConfigInvalid.ClosesAtMissing))
      Auction.inspect(born, op(2)) shouldBe Inspection.Present(meetup, registryOpen = true)
    }

    // Т-19
    "does not become scheduled on a deadline policy without closesAt and keeps the config it had" in {
      val invalid =
        configInput(Some(OnlinePhase(opensAt, None, closesLots = false)), closingPolicy = ClosingPolicy.ByDeadline)
      Auction.decide(born, ScheduleAuction(invalid, op(2))) shouldBe
        Left(ScheduleAuctionRejected.ConfigInvalid(ConfigInvalid.ClosesAtMissing))
      Auction.decide(scheduled, ScheduleAuction(invalid, op(3))) shouldBe
        Left(ScheduleAuctionRejected.ConfigInvalid(ConfigInvalid.ClosesAtMissing))
      scheduled.state shouldBe AuctionState.Scheduled(config())
    }

    "replaces the whole config on a repeated scheduling and keeps its registry open" in {
      val again = applied(scheduled, Auction.decide(scheduled, ScheduleAuction(byAuctioneer, op(3))).toOption.get, 3, 3)
      again.state shouldBe AuctionState.Scheduled(config(byAuctioneer))
      val withLot = applied(again, Auction.decide(again, AddLot(lot, op(4))).toOption.get, 4, 4)
      withLot.lots shouldBe Set(lot)
      applied(withLot, Auction.decide(withLot, RemoveLot(lot, op(5))).toOption.get, 5, 5).lots shouldBe empty
    }

    "starts prebidding only once it is scheduled" in {
      Auction.decide(Auction.initial, StartPrebidding(op(3))) shouldBe Left(StartPrebiddingRejected.AuctionNotFound)
      Auction.decide(born, StartPrebidding(op(3))) shouldBe Left(StartPrebiddingRejected.AuctionNotScheduled)
      started.state shouldBe AuctionState.Prebidding(config(), op(3))
    }

    "answers a repeated start with the original envelope and a new one with a refusal, opening once" in {
      Auction.decide(started, StartPrebidding(op(3))) shouldBe
        Right(AuctionDecision.Repeated(AuctionEnvelope(3, op(3), AuctionEvent.PrebiddingStarted)))
      Auction.decide(started, StartPrebidding(op(4))) shouldBe Left(StartPrebiddingRejected.AuctionNotScheduled)
    }

    "freezes its config and its registry once prebidding started" in {
      Auction.decide(started, ScheduleAuction(byAuctioneer, op(4))) shouldBe
        Left(ScheduleAuctionRejected.AuctionAlreadyStarted)
      Auction.decide(started, AddLot(lot, op(4))) shouldBe Left(AddLotRejected.LotsFrozen)
      Auction.decide(started, RemoveLot(lot, op(4))) shouldBe Left(RemoveLotRejected.LotsFrozen)
      Auction.inspect(started, op(4)) shouldBe Inspection.Present(meetup, registryOpen = false)
      Auction.decide(started, DraftAuction(meetup, op(4))) shouldBe AuctionDecision.Unchanged
    }

    "refuses scheduling before it is born" in {
      Auction.decide(Auction.initial, ScheduleAuction(configInput(), op(2))) shouldBe
        Left(ScheduleAuctionRejected.AuctionNotFound)
    }

    "gives a lot of its registry the price and the step of the command and the platform terms while it is a draft" in {
      Auction.decide(holding(born), conditions) shouldBe Right(
        ScheduleLot(money(5000), LotConfigInput(rub, step, LotFixtures.antiSnipe, proxyEnabled = true), op(9))
      )
    }

    "takes the currency, the anti-snipe and the proxy flag from its lot defaults once it is scheduled, never the step" in {
      val defaults = LotConfigInput(
        eur,
        StepPolicyInput.Fixed(Money(1, eur)),
        AntiSnipe(Duration.ofMinutes(1), Duration.ofMinutes(5), 1),
        proxyEnabled = false
      )
      val planned = Auction.apply(
        holding(born),
        AuctionEnvelope(3, op(3), AuctionEvent.AuctionScheduled(config(configInput(lotDefaults = Some(defaults)))))
      )
      Auction.decide(planned, conditions).map(_.config) shouldBe Right(defaults.copy(stepPolicy = step))
    }

    "falls back to the platform defaults when it is scheduled without lot defaults" in {
      val planned = Auction.apply(
        holding(born),
        AuctionEnvelope(3, op(3), AuctionEvent.AuctionScheduled(config(configInput(lotDefaults = None))))
      )
      val platform = LotTerms.platform
      Auction.decide(planned, conditions).map(_.config) shouldBe
        Right(LotConfigInput(platform.currency, step, platform.antiSnipe, platform.proxyEnabled))
    }

    "refuses conditions for a lot outside its registry and before it is born" in {
      Auction.decide(born, conditions) shouldBe Left(ScheduleAuctionLotRejected.LotNotInAuction)
      Auction.decide(Auction.initial, conditions) shouldBe Left(ScheduleAuctionLotRejected.AuctionNotFound)
    }

    "freezes the conditions of every lot once prebidding started, in its registry or not" in {
      val withLot = Auction.apply(holding(scheduled), AuctionEnvelope(4, op(4), AuctionEvent.PrebiddingStarted))
      Auction.decide(withLot, conditions) shouldBe Left(ScheduleAuctionLotRejected.LotsFrozen)
      Auction.decide(started, conditions) shouldBe Left(ScheduleAuctionLotRejected.LotsFrozen)
    }

    "folds the same journal into the same auction whatever order its rows arrive in" in {
      val journal = List(
        AuctionEnvelope(1, op(1), AuctionEvent.AuctionDrafted(meetup)),
        AuctionEnvelope(2, op(2), AuctionEvent.LotAdded(lot)),
        AuctionEnvelope(3, op(3), AuctionEvent.LotRemoved(lot)),
        AuctionEnvelope(4, op(4), AuctionEvent.LotAdded(lot))
      )
      forAll(Gen.oneOf(journal.permutations.toList)) { shuffled =>
        Auction.replay(Auction.initial, shuffled) shouldBe Auction.replay(Auction.initial, journal)
      }
      Auction.replay(Auction.initial, journal).lots shouldBe Set(lot)
    }
  }

  "choice of a finalist" should {

    /** Аукцион в онлайн-торгах с `lot` в реестре: реестр заполняется до старта, после него он заморожен. */
    def trading: Auction = Auction.apply(holding(scheduled), AuctionEnvelope(9, op(9), AuctionEvent.PrebiddingStarted))

    "sends the lot its mark and its unmark with the op_id of the command, writing nothing of its own" in {
      Auction.decide(trading, SelectForFinal(lot, op(10))) shouldBe Right(MarkForFinal(op(10)))
      Auction.decide(trading, DeselectForFinal(lot, op(11))) shouldBe Right(UnmarkForFinal(op(11)))
    }

    "refuses a choice before prebidding, whatever the lot" in {
      List(holding(born), holding(scheduled)).foreach { auction =>
        Auction.decide(auction, SelectForFinal(lot, op(10))) shouldBe Left(FinalChoiceRejected.NotInPrebidding)
        Auction.decide(auction, DeselectForFinal(lot, op(10))) shouldBe Left(FinalChoiceRejected.NotInPrebidding)
      }
    }

    "refuses a mark when the auction has no final or its lots get no deadline, but lets a mark be cleared" in {
      def tradingWith(input: AuctionConfigInput): Auction =
        Auction.replay(
          Auction.initial,
          List(
            AuctionEnvelope(1, op(1), AuctionEvent.AuctionDrafted(meetup)),
            AuctionEnvelope(2, op(2), AuctionEvent.LotAdded(lot)),
            AuctionEnvelope(3, op(3), AuctionEvent.AuctionScheduled(config(input))),
            AuctionEnvelope(4, op(4), AuctionEvent.PrebiddingStarted)
          )
        )
      val withoutFinal = tradingWith(configInput(finalBlocks = 0, closingPolicy = ClosingPolicy.ByDeadline))
      Auction.decide(withoutFinal, SelectForFinal(lot, op(10))) shouldBe
        Left(FinalChoiceRejected.SelectionNotApplicable)
      Auction.decide(withoutFinal, DeselectForFinal(lot, op(11))) shouldBe Right(UnmarkForFinal(op(11)))
    }

    "refuses a lot outside the registry and an auction that was never born" in {
      Auction.decide(started, SelectForFinal(lot, op(10))) shouldBe Left(FinalChoiceRejected.LotNotInAuction)
      Auction.decide(started, DeselectForFinal(lot, op(10))) shouldBe Left(FinalChoiceRejected.LotNotInAuction)
      Auction.decide(Auction.initial, SelectForFinal(lot, op(10))) shouldBe Left(FinalChoiceRejected.AuctionNotFound)
    }
  }
}
