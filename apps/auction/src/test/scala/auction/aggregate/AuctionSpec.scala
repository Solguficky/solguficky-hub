package auction.aggregate

import auction.aggregate.AuctionFixtures.*
import auction.catalog.LotId
import auction.lot.AdvanceAsk
import auction.lot.AntiSnipe
import auction.lot.CloseLot
import auction.lot.CloseReason
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

  "op_id of a meetup cancellation" should {

    "keeps the vector fixed by its namespace" in {
      // Сменённое пространство имён дало бы повторной доставке факта новый `op_id`, и окно `seen` её бы не узнало.
      Auction.meetupCancellationOf(UUID.fromString("0190a0e0-0000-7000-8000-0000000000aa")).value.toString shouldBe
        "5e8b899a-97a5-5112-b58e-0a4d5892ffb0"
    }

    "is a version 5 uuid, the same for one event and different for another" in {
      forAll(Gen.uuid, Gen.uuid) { (a, b) =>
        val id = Auction.meetupCancellationOf(a).value
        id.version shouldBe 5
        Auction.meetupCancellationOf(a) shouldBe Auction.meetupCancellationOf(a)
        if (a != b) Auction.meetupCancellationOf(b) should not be Auction.meetupCancellationOf(a)
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

    "is discarded from a draft and once scheduled, losing its meetup, registry and config but not its window" in {
      for (auction <- List(holding(born), holding(scheduled))) {
        val decision = Auction.decide(auction, DiscardAuction(op(10)))
        decision shouldBe Right(AuctionDecision.Accepted(AuctionEvent.AuctionDiscarded))
        val discarded = applied(auction, decision.toOption.get, 10, 10)
        discarded.state shouldBe AuctionState.Initial
        discarded.meetup shouldBe None
        discarded.lots shouldBe empty
        discarded.seen.keySet shouldBe auction.seen.keySet + op(10)
        Auction.inspect(discarded, op(11)) shouldBe Inspection.Absent
      }
    }

    "refuses a discard before it is born and once prebidding started" in {
      Auction.decide(Auction.initial, DiscardAuction(op(4))) shouldBe Left(DiscardAuctionRejected.AuctionNotFound)
      Auction.decide(started, DiscardAuction(op(4))) shouldBe Left(DiscardAuctionRejected.AuctionAlreadyStarted)
    }

    "answers a repeated discard with the original envelope, and a repeated command from before it with its own" in {
      val discarded = Auction.apply(holding(born), AuctionEnvelope(10, op(10), AuctionEvent.AuctionDiscarded))
      Auction.decide(discarded, DiscardAuction(op(10))) shouldBe
        Right(AuctionDecision.Repeated(AuctionEnvelope(10, op(10), AuctionEvent.AuctionDiscarded)))
      Auction.decide(discarded, AddLot(lot, op(8))) shouldBe
        Right(AuctionDecision.Repeated(AuctionEnvelope(8, op(8), AuctionEvent.LotAdded(lot))))
    }

    "is born again at the same meetup after a discard, with an empty registry" in {
      val discarded = Auction.apply(holding(scheduled), AuctionEnvelope(10, op(10), AuctionEvent.AuctionDiscarded))
      val decision = Auction.decide(discarded, DraftAuction(meetup, op(11)))
      decision shouldBe AuctionDecision.Accepted(AuctionEvent.AuctionDrafted(meetup))
      val reborn = applied(discarded, decision, 11, 11)
      reborn.state shouldBe AuctionState.Draft
      reborn.meetup shouldBe Some(meetup)
      reborn.lots shouldBe empty
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

  "ask of the auctioneer" should {

    "sends the lot its ask with the op_id of the command in any phase" in {
      val trading = Auction.apply(holding(scheduled), AuctionEnvelope(9, op(9), AuctionEvent.PrebiddingStarted))
      List(holding(born), trading).foreach { auction =>
        Auction.decide(auction, AdvanceLotAsk(lot, money(50000), op(10))) shouldBe Right(
          AdvanceAsk(money(50000), op(10))
        )
      }
    }

    "refuses an ask to a lot outside the registry and of an auction that was never born" in {
      Auction.decide(started, AdvanceLotAsk(lot, money(50000), op(10))) shouldBe
        Left(AdvanceLotAskRejected.LotNotInAuction)
      Auction.decide(Auction.initial, AdvanceLotAsk(lot, money(50000), op(10))) shouldBe
        Left(AdvanceLotAskRejected.AuctionNotFound)
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
    "refuses a mark when the lots of the auction get no deadline (Т-45)" in {
      val ledByPerson = configInput(
        onlinePhase = Some(week.copy(closesLots = false)),
        closingPolicy = ClosingPolicy.ByAuctioneer
      )
      val auction = Auction.replay(
        Auction.initial,
        List(
          AuctionEnvelope(1, op(1), AuctionEvent.AuctionDrafted(meetup)),
          AuctionEnvelope(2, op(2), AuctionEvent.LotAdded(lot)),
          AuctionEnvelope(3, op(3), AuctionEvent.AuctionScheduled(config(ledByPerson))),
          AuctionEnvelope(4, op(4), AuctionEvent.PrebiddingStarted)
        )
      )
      Auction.decide(auction, SelectForFinal(lot, op(10))) shouldBe Left(FinalChoiceRejected.SelectionNotApplicable)
    }

    "refuses a choice once the common deadline passed: the auction is no longer in prebidding" in {
      val settling = Auction.apply(trading, AuctionEnvelope(10, op(10), AuctionEvent.PrebiddingDeadlineReached))
      Auction.decide(settling, SelectForFinal(lot, op(11))) shouldBe Left(FinalChoiceRejected.NotInPrebidding)
      Auction.decide(settling, DeselectForFinal(lot, op(11))) shouldBe Left(FinalChoiceRejected.NotInPrebidding)
    }
  }

  "break and final of an auction" should {

    val other = LotId(new UUID(5L, 2L))

    /** Аукцион с двумя лотами в реестре в онлайн-торгах: события 1…5, старт — `op(5)`. */
    def trading: Auction =
      Auction.replay(
        Auction.initial,
        List(
          AuctionEnvelope(1, op(1), AuctionEvent.AuctionDrafted(meetup)),
          AuctionEnvelope(2, op(2), AuctionEvent.LotAdded(lot)),
          AuctionEnvelope(3, op(3), AuctionEvent.LotAdded(other)),
          AuctionEnvelope(4, op(4), AuctionEvent.AuctionScheduled(config())),
          AuctionEnvelope(5, op(5), AuctionEvent.PrebiddingStarted)
        )
      )

    def settling: Auction = applied(trading, Auction.decide(trading, EndPrebidding(op(6), closesAt)).toOption.get, 6, 6)

    def onBreak: Auction =
      applied(settling, Auction.decide(settling, EndSettling(Set(lot), op(7))).toOption.get, 7, 7)

    def frozen: Auction =
      applied(onBreak, Auction.decide(onBreak, FreezeFinalLineup(List(lot), op(8)), Some(Set(lot))).toOption.get, 8, 8)

    def inFinal: Auction = applied(frozen, Auction.decide(frozen, StartFinal(op(9))).toOption.get, 9, 9)

    "waits for the common deadline of the config and then settles" in {
      Auction.decide(trading, EndPrebidding(op(6), closesAt.minusMillis(1))) shouldBe
        Left(EndPrebiddingRejected.DeadlineNotReached)
      Auction.decide(trading, EndPrebidding(op(6), closesAt)) shouldBe
        Right(AuctionDecision.Accepted(AuctionEvent.PrebiddingDeadlineReached))
      settling.state shouldBe AuctionState.Settling(config(), op(5))
      Auction.decide(settling, EndPrebidding(op(16), closesAt)) shouldBe Left(EndPrebiddingRejected.NotInPrebidding)
      Auction.prebiddingDeadline(trading) shouldBe Some(closesAt)
      Auction.prebiddingDeadline(settling) shouldBe None
    }

    "never settles an auction whose lots a person closes: it has no common deadline" in {
      val ledByPerson = Auction.replay(
        Auction.initial,
        List(
          AuctionEnvelope(1, op(1), AuctionEvent.AuctionDrafted(meetup)),
          AuctionEnvelope(2, op(2), AuctionEvent.AuctionScheduled(config(byAuctioneer))),
          AuctionEnvelope(3, op(3), AuctionEvent.PrebiddingStarted)
        )
      )
      Auction.prebiddingDeadline(ledByPerson) shouldBe None
      Auction.decide(ledByPerson, EndPrebidding(op(6), closesAt.plusSeconds(86400))) shouldBe
        Left(EndPrebiddingRejected.DeadlineNotReached)
    }

    // Конец недели задан, а лоты дедлайна не получают: их закрывает человек, и ждать их по часам нельзя.
    "never settles an auction whose week ends but whose lots get no deadline" in {
      val openEnded =
        configInput(onlinePhase = Some(week.copy(closesLots = false)), closingPolicy = ClosingPolicy.ByAuctioneer)
      val auction = Auction.replay(
        Auction.initial,
        List(
          AuctionEnvelope(1, op(1), AuctionEvent.AuctionDrafted(meetup)),
          AuctionEnvelope(2, op(2), AuctionEvent.AuctionScheduled(config(openEnded))),
          AuctionEnvelope(3, op(3), AuctionEvent.PrebiddingStarted)
        )
      )
      Auction.prebiddingDeadline(auction) shouldBe None
      Auction.decide(auction, EndPrebidding(op(6), closesAt.plusSeconds(1))) shouldBe
        Left(EndPrebiddingRejected.DeadlineNotReached)
    }

    "goes to the break with held lots and finishes at once without them" in {
      Auction.decide(settling, EndSettling(Set(lot), op(7))) shouldBe
        Right(AuctionDecision.Accepted(AuctionEvent.PrebiddingEnded(finished = false)))
      onBreak.state shouldBe AuctionState.Break(config(), op(5))
      val none = Auction.decide(settling, EndSettling(Set.empty, op(7)))
      none shouldBe Right(AuctionDecision.Accepted(AuctionEvent.PrebiddingEnded(finished = true)))
      applied(settling, none.toOption.get, 7, 7).state shouldBe AuctionState.Finished(config(), op(5))
      Auction.decide(onBreak, EndSettling(Set(lot), op(17))) shouldBe Left(EndSettlingRejected.NotSettling)
      Auction.decide(onBreak, EndSettling(Set(lot), op(7))) shouldBe
        Right(AuctionDecision.Repeated(AuctionEnvelope(7, op(7), AuctionEvent.PrebiddingEnded(finished = false))))
    }

    "freezes exactly the held lots in the order the organizer gave" in {
      val order = List(other, lot)
      val both = applied(settling, Auction.decide(settling, EndSettling(Set(lot, other), op(7))).toOption.get, 7, 7)
      Auction.decide(both, FreezeFinalLineup(order, op(8)), Some(Set(lot, other))) shouldBe
        Right(AuctionDecision.Accepted(AuctionEvent.FinalLineupFrozen(order)))
      frozen.state shouldBe AuctionState.LineupFrozen(config(), op(5), List(lot))
    }

    "refuses a lineup with a lot that did not confirm its hold (Т-47)" in {
      Auction.decide(onBreak, FreezeFinalLineup(List(lot, other), op(8)), Some(Set(lot))) shouldBe
        Left(FreezeFinalLineupRejected.LineupMismatch(Set(lot)))
      Auction.decide(onBreak, FreezeFinalLineup(List(lot, lot), op(8)), Some(Set(lot))) shouldBe
        Left(FreezeFinalLineupRejected.LineupMismatch(Set(lot)))
      Auction.decide(onBreak, FreezeFinalLineup(Nil, op(8)), Some(Set(lot))) shouldBe
        Left(FreezeFinalLineupRejected.LineupMismatch(Set(lot)))
    }

    "refuses a lineup outside the break, with no held lot, and while the lots are still being asked" in {
      Auction.decide(settling, FreezeFinalLineup(List(lot), op(8)), Some(Set(lot))) shouldBe
        Left(FreezeFinalLineupRejected.NotInBreak)
      Auction.decide(frozen, FreezeFinalLineup(List(lot), op(18)), Some(Set(lot))) shouldBe
        Left(FreezeFinalLineupRejected.NotInBreak)
      Auction.decide(onBreak, FreezeFinalLineup(Nil, op(8)), Some(Set.empty)) shouldBe
        Left(FreezeFinalLineupRejected.LineupEmpty)
      Auction.decide(onBreak, FreezeFinalLineup(List(lot), op(8)), None) shouldBe
        Left(FreezeFinalLineupRejected.LineupUnknown)
      Auction.decide(Auction.initial, FreezeFinalLineup(List(lot), op(8)), None) shouldBe
        Left(FreezeFinalLineupRejected.AuctionNotFound)
    }

    "refuses to start the final before the lineup is frozen and stays in the break (Т-46)" in {
      Auction.decide(onBreak, StartFinal(op(9))) shouldBe Left(StartFinalRejected.LineupNotFrozen)
      Auction.decide(settling, StartFinal(op(9))) shouldBe Left(StartFinalRejected.LineupNotFrozen)
      Auction.decide(inFinal, StartFinal(op(19))) shouldBe Left(StartFinalRejected.LineupNotFrozen)
      Auction.decide(frozen, StartFinal(op(9))) shouldBe Right(AuctionDecision.Accepted(AuctionEvent.FinalStarted))
      inFinal.state shouldBe AuctionState.Final(config(), op(5), List(lot), Nil, Nil)
    }

    "returns the lots of the lineup to trading one by one in its order" in {
      val order = List(other, lot)
      val both = applied(settling, Auction.decide(settling, EndSettling(Set(lot, other), op(7))).toOption.get, 7, 7)
      val lineup = Auction.apply(both, AuctionEnvelope(8, op(8), AuctionEvent.FinalLineupFrozen(order)))
      val running = Auction.apply(lineup, AuctionEnvelope(9, op(9), AuctionEvent.FinalStarted))
      Auction.decide(running, StartNextLot(op(10))) shouldBe Right(NextLot.Resume(other))
      Auction.activate(running, StartNextLot(op(10)), other) shouldBe
        Right(AuctionDecision.Accepted(AuctionEvent.FinalLotActivated(other)))
      val first = Auction.apply(running, AuctionEnvelope(10, op(10), AuctionEvent.FinalLotActivated(other)))
      first.state shouldBe AuctionState.Final(config(), op(5), order, List(other), Nil)
      // Активный лот завершается закрытием ведущим; до него следующего лота нет.
      Auction.decide(first, StartNextLot(op(11))) shouldBe Left(StartNextLotRejected.AnotherLotActive(other))
      Auction.decide(first, StartNextLot(op(10))) shouldBe
        Right(NextLot.Repeated(AuctionEnvelope(10, op(10), AuctionEvent.FinalLotActivated(other))))
    }

    "records one activation for two commands that chose the same lot before either was written" in {
      Auction.decide(inFinal, StartNextLot(op(10))) shouldBe Right(NextLot.Resume(lot))
      Auction.decide(inFinal, StartNextLot(op(11))) shouldBe Right(NextLot.Resume(lot))
      val first = applied(inFinal, Auction.activate(inFinal, StartNextLot(op(10)), lot).toOption.get, 10, 10)
      Auction.activate(first, StartNextLot(op(11)), lot) shouldBe Left(StartNextLotRejected.AnotherLotActive(lot))
    }

    "refuses the next lot outside the final" in {
      List(onBreak, frozen).foreach { auction =>
        Auction.decide(auction, StartNextLot(op(10))) shouldBe Left(StartNextLotRejected.NotInFinal)
      }
      Auction.decide(Auction.initial, StartNextLot(op(10))) shouldBe Left(StartNextLotRejected.AuctionNotFound)
    }

    "freezes the registry and refuses scheduling and discarding in every state after the start" in {
      List(settling, onBreak, frozen, inFinal).foreach { auction =>
        Auction.decide(auction, AddLot(lot, op(20))) shouldBe Left(AddLotRejected.LotsFrozen)
        Auction.decide(auction, ScheduleAuction(configInput(), op(20))) shouldBe
          Left(ScheduleAuctionRejected.AuctionAlreadyStarted)
        Auction.decide(auction, DiscardAuction(op(20))) shouldBe Left(DiscardAuctionRejected.AuctionAlreadyStarted)
        Auction.decide(auction, StartPrebidding(op(20))) shouldBe Left(StartPrebiddingRejected.AuctionNotScheduled)
      }
    }

    def finished: Auction =
      applied(settling, Auction.decide(settling, EndSettling(Set.empty, op(7))).toOption.get, 7, 7)

    def cancelled(auction: Auction, sequence: Long): Auction =
      applied(auction, Auction.decide(auction, CancelAuction(op(30))).toOption.get, sequence, 30)

    "is cancelled from every phase of trading and keeps its config, its opening and the op_id of the cancel" in {
      List(trading -> 6L, settling -> 7L, onBreak -> 8L, frozen -> 9L, inFinal -> 10L).foreach { (auction, sequence) =>
        Auction.decide(auction, CancelAuction(op(30))) shouldBe Right(
          AuctionDecision.Accepted(AuctionEvent.AuctionCancelled)
        )
        cancelled(auction, sequence).state shouldBe AuctionState.Cancelled(config(), op(5), op(30))
        cancelled(auction, sequence).lots shouldBe Set(lot, other)
      }
    }

    "refuses a cancel before trading, after the end and of an auction that was never born" in {
      Auction.decide(Auction.initial, CancelAuction(op(30))) shouldBe Left(CancelAuctionRejected.AuctionNotFound)
      Auction.decide(born, CancelAuction(op(30))) shouldBe Left(CancelAuctionRejected.AuctionNotStarted)
      Auction.decide(scheduled, CancelAuction(op(30))) shouldBe Left(CancelAuctionRejected.AuctionNotStarted)
      finished.state shouldBe a[AuctionState.Finished]
      Auction.decide(finished, CancelAuction(op(30))) shouldBe Left(CancelAuctionRejected.AuctionAlreadyFinished)
    }

    "answers a repeated cancel with the original envelope and a new one on a cancelled auction without an event" in {
      val gone = cancelled(onBreak, 8)
      Auction.decide(gone, CancelAuction(op(30))) shouldBe
        Right(AuctionDecision.Repeated(AuctionEnvelope(8, op(30), AuctionEvent.AuctionCancelled)))
      Auction.decide(gone, CancelAuction(op(31))) shouldBe Right(AuctionDecision.Unchanged)
    }

    "stays at its meetup for good once cancelled and refuses every step of trading" in {
      val gone = cancelled(trading, 6)
      Auction.decide(gone, DraftAuction(meetup, op(40))) shouldBe AuctionDecision.Unchanged
      Auction.decide(gone, DiscardAuction(op(40))) shouldBe Left(DiscardAuctionRejected.AuctionAlreadyStarted)
      Auction.decide(gone, StartPrebidding(op(40))) shouldBe Left(StartPrebiddingRejected.AuctionNotScheduled)
      Auction.decide(gone, AddLot(lot, op(40))) shouldBe Left(AddLotRejected.LotsFrozen)
      Auction.decide(gone, SelectForFinal(lot, op(40))) shouldBe Left(FinalChoiceRejected.NotInPrebidding)
      Auction.decide(gone, EndPrebidding(op(40), closesAt)) shouldBe Left(EndPrebiddingRejected.NotInPrebidding)
      Auction.decide(gone, StartFinal(op(40))) shouldBe Left(StartFinalRejected.LineupNotFrozen)
      Auction.decide(gone, StartNextLot(op(40))) shouldBe Left(StartNextLotRejected.NotInFinal)
      Auction.prebiddingDeadline(gone) shouldBe None
    }

    def active: Auction = applied(inFinal, Auction.activate(inFinal, StartNextLot(op(10)), lot).toOption.get, 10, 10)

    def completed: Auction =
      applied(active, Auction.decide(active, CompleteFinalLot(lot, op(11))).toOption.get, 11, 11)

    "sends the closing of the auctioneer to the active lot of the final and to a lot held in the break" in {
      val close = CloseLot(CloseReason.ByAuctioneer, op(40))
      Auction.decide(active, CloseAuctionLot(lot, op(40))) shouldBe Right(close)
      Auction.decide(onBreak, CloseAuctionLot(lot, op(40))) shouldBe Right(close)
      // Лот, который не в составе, кончился раньше: его ответ решает лот, и повтор получит исходное закрытие.
      Auction.decide(active, CloseAuctionLot(other, op(40))) shouldBe Right(close)
      Auction.decide(completed, CloseAuctionLot(lot, op(40))) shouldBe Right(close)
    }

    "refuses the closing of the auctioneer while the deadline closes lots and for a lot of the lineup before its turn" in {
      List(trading, settling).foreach { auction =>
        Auction.decide(auction, CloseAuctionLot(lot, op(40))) shouldBe Left(CloseAuctionLotRejected.DeadlineNotReached)
      }
      Auction.decide(frozen, CloseAuctionLot(lot, op(40))) shouldBe Left(CloseAuctionLotRejected.LotNotOpen)
      Auction.decide(inFinal, CloseAuctionLot(lot, op(40))) shouldBe Left(CloseAuctionLotRejected.LotNotOpen)
      Auction.decide(active, CloseAuctionLot(LotId(new UUID(5L, 99L)), op(40))) shouldBe
        Left(CloseAuctionLotRejected.LotNotInAuction)
      Auction.decide(Auction.initial, CloseAuctionLot(lot, op(40))) shouldBe
        Left(CloseAuctionLotRejected.AuctionNotFound)
    }

    "finishes a break whose every held lot the auctioneer sold, and only once the lots of the break all answered" in {
      Auction.decide(onBreak, FinishAuction(op(20)), Some(Set.empty)) shouldBe
        Right(AuctionDecision.Accepted(AuctionEvent.AuctionFinished))
      Auction.decide(onBreak, FinishAuction(op(20)), Some(Set(lot))) shouldBe
        Left(FinishAuctionRejected.LineupNotCompleted)
      Auction.decide(onBreak, FinishAuction(op(20)), None) shouldBe Left(FinishAuctionRejected.LineupNotCompleted)
      Auction.decide(frozen, FinishAuction(op(20)), Some(Set.empty)) shouldBe
        Left(FinishAuctionRejected.NotInBreakOrFinal)
      val over = applied(onBreak, AuctionDecision.Accepted(AuctionEvent.AuctionFinished), 8, 20)
      over.state shouldBe AuctionState.Finished(config(), op(5))
      // Отмена, обогнавшая запись конца пустого перерыва, уже опоздала; перерыв с удержанным отменяется.
      Auction.decide(onBreak, CancelAuction(op(30)), Some(Set.empty)) shouldBe
        Left(CancelAuctionRejected.AuctionAlreadyFinished)
      Auction.decide(onBreak, CancelAuction(op(30)), Some(Set(lot))) shouldBe
        Right(AuctionDecision.Accepted(AuctionEvent.AuctionCancelled))
    }

    "inherits a cancelled meetup: discards before trading, cancels while trading and leaves the rest untouched" in {
      val inherit = ApplyMeetupCancelled(op(50))
      Auction.decide(Auction.initial, inherit, None) shouldBe AuctionDecision.Unchanged
      List(born, scheduled).foreach { auction =>
        Auction.decide(auction, inherit, None) shouldBe AuctionDecision.Accepted(AuctionEvent.AuctionDiscarded)
      }
      List(trading, settling, frozen, inFinal, active).foreach { auction =>
        Auction.decide(auction, inherit, None) shouldBe AuctionDecision.Accepted(AuctionEvent.AuctionCancelled)
      }
      Auction.decide(onBreak, inherit, Some(Set(lot))) shouldBe AuctionDecision.Accepted(AuctionEvent.AuctionCancelled)
      // Уже кончившиеся торги отмена сходки не трогает, как и отмена администратором.
      Auction.decide(onBreak, inherit, Some(Set.empty)) shouldBe AuctionDecision.Unchanged
      Auction.decide(completed, inherit, None) shouldBe AuctionDecision.Unchanged
      Auction.decide(finished, inherit, None) shouldBe AuctionDecision.Unchanged
      Auction.decide(cancelled(trading, 6), inherit, None) shouldBe AuctionDecision.Unchanged
    }

    "answers a repeated meetup cancellation with the original envelope, even after the discard emptied the auction" in {
      val inherit = ApplyMeetupCancelled(op(50))
      val discarded = applied(scheduled, Auction.decide(scheduled, inherit, None), 3, 50)
      discarded.state shouldBe AuctionState.Initial
      Auction.decide(discarded, inherit, None) shouldBe
        AuctionDecision.Repeated(AuctionEnvelope(3, op(50), AuctionEvent.AuctionDiscarded))
      val gone = applied(trading, Auction.decide(trading, inherit, None), 6, 50)
      Auction.decide(gone, inherit, None) shouldBe
        AuctionDecision.Repeated(AuctionEnvelope(6, op(50), AuctionEvent.AuctionCancelled))
    }

    "sends no closing to a lot of a cancelled auction, though its withdrawal may not have reached the lot" in {
      Auction.decide(cancelled(active, 11), CloseAuctionLot(lot, op(40))) shouldBe
        Left(CloseAuctionLotRejected.LotNotOpen)
    }

    "completes only the active lot of the final and answers a repeated step with the original envelope" in {
      Auction.decide(inFinal, CompleteFinalLot(lot, op(11))) shouldBe Left(CompleteFinalLotRejected.NotActive)
      Auction.decide(active, CompleteFinalLot(other, op(11))) shouldBe Left(CompleteFinalLotRejected.NotActive)
      completed.state shouldBe AuctionState.Final(config(), op(5), List(lot), List(lot), List(lot))
      completed.state.activeLot shouldBe None
      Auction.decide(completed, CompleteFinalLot(lot, op(11))) shouldBe
        Right(AuctionDecision.Repeated(AuctionEnvelope(11, op(11), AuctionEvent.FinalLotCompleted(lot))))
      Auction.decide(completed, CompleteFinalLot(lot, op(12))) shouldBe Left(CompleteFinalLotRejected.NotActive)
    }

    "returns the next lot of the lineup once the active one is completed and finishes only after the last one" in {
      val order = List(other, lot)
      val both = applied(settling, Auction.decide(settling, EndSettling(Set(lot, other), op(7))).toOption.get, 7, 7)
      val running = Auction.replay(
        both,
        List(
          AuctionEnvelope(8, op(8), AuctionEvent.FinalLineupFrozen(order)),
          AuctionEnvelope(9, op(9), AuctionEvent.FinalStarted),
          AuctionEnvelope(10, op(10), AuctionEvent.FinalLotActivated(other))
        )
      )
      Auction.decide(running, FinishAuction(op(20)), None) shouldBe Left(FinishAuctionRejected.LineupNotCompleted)
      val first = applied(running, Auction.decide(running, CompleteFinalLot(other, op(11))).toOption.get, 11, 11)
      Auction.lineupCompleted(first) shouldBe false
      Auction.decide(first, FinishAuction(op(20)), None) shouldBe Left(FinishAuctionRejected.LineupNotCompleted)
      Auction.decide(first, StartNextLot(op(12))) shouldBe Right(NextLot.Resume(lot))
      val second = Auction.replay(
        first,
        List(
          AuctionEnvelope(12, op(12), AuctionEvent.FinalLotActivated(lot)),
          AuctionEnvelope(13, op(13), AuctionEvent.FinalLotCompleted(lot))
        )
      )
      Auction.decide(second, StartNextLot(op(14))) shouldBe Left(StartNextLotRejected.LineupExhausted)
      Auction.lineupCompleted(second) shouldBe true
      Auction.decide(second, FinishAuction(op(20)), None) shouldBe
        Right(AuctionDecision.Accepted(AuctionEvent.AuctionFinished))
      val over = applied(second, AuctionDecision.Accepted(AuctionEvent.AuctionFinished), 14, 20)
      over.state shouldBe AuctionState.Finished(config(), op(5))
      Auction.decide(over, FinishAuction(op(20)), None) shouldBe
        Right(AuctionDecision.Repeated(AuctionEnvelope(14, op(20), AuctionEvent.AuctionFinished)))
      Auction.decide(over, FinishAuction(op(21)), None) shouldBe Left(FinishAuctionRejected.NotInBreakOrFinal)
      Auction.decide(over, CancelAuction(op(30))) shouldBe Left(CancelAuctionRejected.AuctionAlreadyFinished)
      // Конец ещё не записан, но состав завершён: отмена, обогнавшая его, уже опоздала.
      Auction.decide(second, CancelAuction(op(30))) shouldBe Left(CancelAuctionRejected.AuctionAlreadyFinished)
      Auction.decide(first, CancelAuction(op(30))) shouldBe Right(
        AuctionDecision.Accepted(AuctionEvent.AuctionCancelled)
      )
    }
  }
}
