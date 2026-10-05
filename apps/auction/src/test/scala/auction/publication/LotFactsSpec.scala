package auction.publication

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

  private def facts(events: LotEvent*): List[(AppliedEvent, Option[LotFact])] =
    applied(events*).map(step => step -> LotFacts.fact(step))

  private def message(fact: Option[LotFact]): bus.LotEvent =
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

    "publish the hold and the resume but keep the mark off the bus" in {
      val held = LotEvent.LotHeldForFinal(deadline)
      val steps = facts(lotDrafted, lotScheduled, opened, placed, LotEvent.LotMarkedForFinal, held, LotEvent.LotResumed)

      steps.drop(4).map((_, fact) => fact.map(_.subject)) shouldBe List(
        None,
        Some("events.auction.lot_held_for_final"),
        Some("events.auction.lot_resumed")
      )
      message(steps(5)._2).getState.status.isHeld shouldBe true
      val live = message(steps(6)._2).getState.getTrading
      (live.phase, live.deadline) shouldBe (model.LotPhase.LOT_PHASE_LIVE, None)
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

    "say who led before the bid and how the bid was placed" in {
      val manual = message(facts(lotDrafted, lotScheduled, opened, placed).last._2).getBidPlaced
      manual.previousLeaderId shouldBe Some(participant(1).value.toString)
      manual.origin.manual.map(_.source) shouldBe Some(model.BidSource.BID_SOURCE_BOT)

      val first = placed.copy(previousLeader = None, origin = BidOrigin.Proxy)
      val proxy = message(facts(lotDrafted, lotScheduled, opened, first).last._2).getBidPlaced
      proxy.previousLeaderId shouldBe None
      proxy.origin.isProxy shouldBe true
    }
  }
}
