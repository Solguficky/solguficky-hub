package auction.publication

import auction.entity.Initiator
import auction.entity.JournalFixtures.*
import auction.entity.LotJournal
import auction.entity.StoredLotEvent
import auction.lot.*
import auction.lot.LotFixtures.*
import auction.projection.AppliedEvent
import auction.projection.LotView
import auction.v1.auction as model
import auction.v1.auction_events as bus
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

final class LotFactsSpec extends AnyWordSpec with Matchers {

  private val lotId = uuid(100)

  private def stored(opN: Int, event: LotEvent): StoredLotEvent =
    LotJournal.store(uuid(opN), transaction(opN), event)

  /** Журнал лота, свёрнутый так же, как его сворачивает проекция публикации: строка после каждого события. */
  private def applied(events: LotEvent*): List[AppliedEvent] = {
    val numbered = events.zipWithIndex.map((event, index) => (index + 1L, stored(index + 1, event)))
    LotView.replay(None, lotId, numbered).fold(defect => fail(defect.toString), done => done)
  }

  private def facts(events: LotEvent*): List[(AppliedEvent, Option[Fact])] =
    val steps = applied(events*)
    steps.zip(None :: steps.map(step => Some(step.row))).map((step, before) => step -> LotFacts.fact(step, before))

  private def message(fact: Option[Fact]): bus.LotEvent =
    bus.LotEvent.parseFrom(fact.getOrElse(fail("expected a published fact")).payload)

  "lot facts" should {

    "publish each public event on the subject named after its occasion" in {
      val published = facts(lotDrafted, lotScheduled, opened, placed).map((_, fact) => fact.map(_.subject))
      published shouldBe List(
        Some("events.auction.lot_drafted"),
        Some("events.auction.lot_scheduled"),
        Some("events.auction.lot_opened"),
        Some("events.auction.bid_placed")
      )
    }

    "name the subject after the oneof branch the body carries" in {
      facts(lotDrafted, lotScheduled, opened, placed).foreach { (_, fact) =>
        val body = message(fact)
        val branch = bus.LotEvent.scalaDescriptor.fields.find(_.number == body.occasion.number).map(_.name)
        fact.map(_.subject) shouldBe branch.map(LotFacts.SubjectPrefix + _)
      }
    }

    "publish a deadline extension with the new deadline and the count in the state" in {
      val extended = LotEvent.DeadlineExtended(deadline.plusSeconds(120), 1)
      val (_, fact) = facts(lotDrafted, lotScheduled, opened, placed, extended).last

      fact.map(_.subject) shouldBe Some("events.auction.deadline_extended")
      val trading = message(fact).getState.getTrading
      (trading.deadline, trading.extensionsUsed) shouldBe (Some(deadline.plusSeconds(120).toString), 1)
    }

    // ADR-072, п. 5: снимок после снятия и прежний лидер, как у ставки; кого сняли, факт не называет.
    "publish the removal of a participant with the leader before it and the lot it left in the state" in {
      val removed = LotEvent.ParticipantRemoved(participant(2), money(10000), None, None)
      val (_, fact) = facts(lotDrafted, lotScheduled, opened, placed, removed).last

      fact.map(_.subject) shouldBe Some("events.auction.participant_removed")
      val body = message(fact)
      body.getParticipantRemoved.previousLeaderId shouldBe Some(participant(2).value.toString)
      (body.getState.getTrading.leaderId, body.getState.getTrading.getCurrentPrice.minorUnits) shouldBe (None, 10000L)
      bus.ParticipantRemoved.scalaDescriptor.fields.map(_.name) shouldBe Seq("previous_leader_id")
    }

    "publish the hold and the resume but keep the mark off the bus" in {
      val held = LotEvent.LotHeldForFinal(deadline)
      val steps = facts(lotDrafted, lotScheduled, opened, placed, LotEvent.LotMarkedForFinal, held, LotEvent.LotResumed)

      steps.drop(4).map((_, fact) => fact.map(_.subject)) shouldBe List(
        None,
        Some("events.auction.lot_held_for_final"),
        Some("events.auction.lot_resumed")
      )
      message(steps(5)._2).getState.status.isHeld shouldBe true
      val liveState = message(steps(6)._2).getState
      (liveState.getTrading.phase, liveState.getTrading.deadline) shouldBe (model.LotPhase.LOT_PHASE_LIVE, None)
      liveState.stepWindows shouldBe empty
    }

    "publish the withdrawal with the reason of the cancelled auction in the state of the lot" in {
      val withdrawal = LotEvent.LotWithdrawn(WithdrawnReason.AuctionCancelled)
      val (_, fact) = facts(lotDrafted, lotScheduled, opened, placed, withdrawal).last

      fact.map(_.subject) shouldBe Some("events.auction.lot_withdrawn")
      message(fact).getState.status.withdrawn shouldBe Some(model.WithdrawnReason.WITHDRAWN_REASON_AUCTION_CANCELLED)
    }

    "publish a launched window on step_window_added with every window of the lot in the state" in {
      val launched = StepWindow(
        java.time.Instant.parse("2026-10-06T12:00:00Z"),
        java.time.Instant.parse("2026-10-06T13:00:00Z"),
        money(50)
      )
      val (_, fact) = facts(lotDrafted, lotScheduled, openedWithWindows, LotEvent.StepWindowAdded(launched)).last

      fact.map(_.subject) shouldBe Some("events.auction.step_window_added")
      message(fact).occasion.isStepWindowAdded shouldBe true
      message(fact).getState.stepWindows.map(window => (window.from, window.until)) shouldBe List(
        "2026-10-05T12:00:00Z" -> "2026-10-05T14:00:00Z",
        "2026-10-06T12:00:00Z" -> "2026-10-06T13:00:00Z"
      )
    }

    "publish the ask of the auctioneer with the ask in the state of the lot" in {
      val steps = facts(lotDrafted, lotScheduled, opened, LotEvent.AskAdvanced(money(50000)))

      steps.last._2.map(_.subject) shouldBe Some("events.auction.ask_advanced")
      message(steps.last._2).getState.getTrading.ask.map(_.minorUnits) shouldBe Some(50000L)
    }

    "keep proxy limits off the bus while they still take a version" in {
      val steps = facts(lotDrafted, lotScheduled, opened, limitSet, limitWithdrawn, placed)
      steps.map((step, fact) => step.sequence -> fact.isDefined) shouldBe List(
        1L -> true,
        2L -> true,
        3L -> true,
        4L -> false,
        5L -> false,
        6L -> true
      )
      message(steps.last._2).version shouldBe 6L
    }

    "carry the journal row id as the event id, the position as the version and the decision time" in {
      val (step, fact) = facts(lotDrafted, lotScheduled, opened, placed).last
      val body = message(fact)
      fact.map(_.eventId) shouldBe Some(step.stored.eventId)
      body.eventId shouldBe step.stored.eventId.toString
      body.lotId shouldBe lotId.toString
      body.version shouldBe 4L
      body.occurredAt shouldBe "2026-10-01T09:00:00Z"
    }

    "give the same bytes for the same journal row on every build" in {
      val first = facts(lotDrafted, lotScheduled, opened, placed).map(_._2.map(_.payload.toVector))
      val again = facts(lotDrafted, lotScheduled, opened, placed).map(_._2.map(_.payload.toVector))
      first shouldBe again
    }

    "carry the whole state after the event, not a delta" in {
      val steps = facts(lotDrafted, lotScheduled, opened, placed)
      message(steps(0)._2).state.map(_.status.isDraft) shouldBe Some(true)
      message(steps(0)._2).state.flatMap(_.config) shouldBe None
      message(steps(1)._2).state.flatMap(_.status.scheduled) shouldBe Some(
        model.LotSchedule(Some(model.Money(10000, "RUB")))
      )
      val trading = message(steps(3)._2).state.getOrElse(fail("expected a state"))
      trading.id shouldBe lotId.toString
      trading.auctionId shouldBe auctionId(1).value.toString
      trading.config.map(_.currency) shouldBe Some("RUB")
      trading.status.trading.flatMap(_.currentPrice) shouldBe Some(model.Money(10500, "RUB"))
      trading.status.trading.flatMap(_.leaderId) shouldBe Some(participant(2).value.toString)
      trading.status.trading.flatMap(_.leadingBidId) shouldBe Some(bid(1).value.toString)
    }

    "publish the windows the lot recorded at opening with the opened state" in {
      val windows = message(facts(lotDrafted, lotScheduled, openedWithWindows).last._2).getState.stepWindows

      windows shouldBe Seq(
        bus.StepWindow(
          from = "2026-10-05T12:00:00Z",
          until = "2026-10-05T14:00:00Z",
          step = Some(model.Money(100, "RUB"))
        )
      )
    }

    "publish no windows for a lot opened without one" in {
      message(facts(lotDrafted, lotScheduled, opened).last._2).getState.stepWindows shouldBe empty
    }

    "publish the recorded windows by ascending start" in {
      val earlier = stepWindow("12:00", "14:00", step = 10)
      val later = stepWindow("15:00", "16:00", step = 20)
      val openedWithBoth = Lot
        .decide(lotIn(LotState.Scheduled(lotScheduled.schedule)), openLot(3).copy(stepWindows = List(later, earlier)))
        .toOption
        .collect { case Decision.Accepted(event: LotEvent.LotOpened, _) => event }
        .getOrElse(fail("expected the lot to open"))

      val windows = message(facts(lotDrafted, lotScheduled, openedWithBoth).last._2).getState.stepWindows
      windows.map(window => (window.from, window.step.map(_.minorUnits))) shouldBe Seq(
        ("2026-10-07T12:00:00Z", Some(10L)),
        ("2026-10-07T15:00:00Z", Some(20L))
      )
    }

    "leave out the window of another currency the lot did not record" in {
      val own = stepWindow("12:00", "14:00", step = 10)
      val foreign = stepWindow("15:00", "16:00", step = 20, currency = eur)
      val inOwnCurrency = Lot
        .decide(lotIn(LotState.Scheduled(lotScheduled.schedule)), openLot(3).copy(stepWindows = List(foreign, own)))
        .toOption
        .collect { case Decision.Accepted(event: LotEvent.LotOpened, _) => event }
        .getOrElse(fail("expected the lot to open"))

      val windows = message(facts(lotDrafted, lotScheduled, inOwnCurrency).last._2).getState.stepWindows
      windows.map(window => (window.from, window.until, window.step)) shouldBe Seq(
        ("2026-10-07T12:00:00Z", "2026-10-07T14:00:00Z", Some(model.Money(10, "RUB")))
      )
    }

    "say who led before the bid and how the bid was placed" in {
      val manual = message(facts(lotDrafted, lotScheduled, opened, placed).last._2).getBidPlaced
      manual.previousLeaderId shouldBe Some(participant(1).value.toString)
      manual.origin.manual.map(_.source) shouldBe Some(model.BidSource.BID_SOURCE_BOT)

      val first = placed.copy(previousLeader = None, origin = BidOrigin.Proxy)
      val proxy = message(facts(lotDrafted, lotScheduled, opened, first).last._2).getBidPlaced
      proxy.previousLeaderId shouldBe None
      proxy.origin.isProxy shouldBe true
    }

    "carry the overtaken mark of a manual bid and leave it off a bid nobody overtook" in {
      bidOf(placed.copy(overtakenByProxy = true), Initiator.Participant(participant(2))).overtakenByProxy shouldBe true
      bidOf(placed, Initiator.Participant(participant(2))).overtakenByProxy shouldBe false
    }

    "say a proxy bid answers another bidder only when someone else's command placed it" in {
      val proxy = placed.copy(origin = BidOrigin.Proxy)
      bidOf(proxy, Initiator.Participant(participant(1))).answersOtherBidder shouldBe true
      bidOf(proxy, Initiator.Participant(participant(2))).answersOtherBidder shouldBe false
      bidOf(placed, Initiator.Participant(participant(1))).answersOtherBidder shouldBe false
    }
  }

  /** Факт ставки, записанной командой `initiator` после открытия лота. */
  private def bidOf(event: LotEvent.BidPlaced, initiator: Initiator): bus.BidPlaced = {
    val opening =
      List(lotDrafted, lotScheduled, opened).zipWithIndex.map((event, index) => (index + 1L, stored(index + 1, event)))
    val numbered = opening :+ (4L, LotJournal.store(uuid(4), transaction(4, initiator), event))
    val steps = LotView.replay(None, lotId, numbered).fold(defect => fail(defect.toString), done => done)
    message(LotFacts.fact(steps.last, steps.init.lastOption.map(_.row))).getBidPlaced
  }
}
