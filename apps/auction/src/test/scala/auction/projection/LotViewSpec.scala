package auction.projection

import auction.entity.JournalFixtures.*
import auction.entity.LotJournal
import auction.entity.StoredLotEvent
import auction.lot.*
import auction.lot.LotFixtures.*
import org.scalacheck.Gen
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec
import org.scalatestplus.scalacheck.ScalaCheckDrivenPropertyChecks

final class LotViewSpec extends AnyWordSpec with Matchers with ScalaCheckDrivenPropertyChecks {

  implicit override val generatorDrivenConfig: PropertyCheckConfiguration =
    PropertyCheckConfiguration(minSuccessful = 100)

  private val lotId = uuid(100)

  private def stored(opN: Int, event: LotEvent): StoredLotEvent = LotJournal.store(uuid(opN), transaction(opN), event)

  /** Журнал лота в торгах: рождение, условия, открытие и ставки по возрастанию от разных участников. */
  private def journal(raises: List[Long]): Vector[StoredLotEvent] = {
    val bids = raises
      .scanLeft(10000L)(_ + _)
      .drop(1)
      .zipWithIndex
      .map((amount, index) =>
        LotEvent.BidPlaced(bid(index), participant(index % 2), money(amount), None, BidOrigin.Manual(BidSource.Bot))
      )
    (Vector(lotDrafted, lotScheduled, opened) ++ bids).zipWithIndex.map((event, index) => stored(index + 1, event))
  }

  /** Свёртка доставок через проекцию; каждая доставка — номер события и строка журнала. */
  private def deliver(deliveries: Seq[(Long, StoredLotEvent)]): (Option[LotViewRow], List[BidRecord]) =
    deliveries.foldLeft((Option.empty[LotViewRow], List.empty[BidRecord])) { case ((row, bids), (sequence, event)) =>
      LotView.project(row, lotId, sequence, event) match {
        case Right(LotViewStep.Skip) => (row, bids)
        case Right(LotViewStep.Write(next, bid)) => (Some(next), bids ++ bid)
        case Left(defect) => fail(s"projection refused delivery $sequence: $defect")
      }
    }

  private def numbered(events: Vector[StoredLotEvent]): Vector[(Long, StoredLotEvent)] =
    events.zipWithIndex.map((event, index) => (index + 1L, event))

  private val raises: Gen[List[Long]] = Gen.listOf(Gen.choose(500L, 5000L).map(_ / 500 * 500))

  "lot view" should {

    "holds the same lot as the replay of its journal after every event" in {
      forAll(raises) { steps =>
        val events = journal(steps)
        val (row, _) = deliver(numbered(events))
        val replayed = Lot.replay(Lot.initial, numbered(events).map((n, e) => LotJournal.envelope(n, e)))
        row.map(view => LotJournal.restoreLot(view.stored)) shouldBe Some(replayed)
        row.map(_.version) shouldBe Some(events.size.toLong)
      }
    }

    "ends in the same row when every event is delivered again after it was applied" in {
      forAll(raises, Gen.listOf(Gen.choose(0, 20))) { (steps, repeats) =>
        val once = numbered(journal(steps))
        val repeated = once.zipWithIndex.flatMap { case (delivery, index) =>
          if (repeats.contains(index)) Vector(delivery, delivery) else Vector(delivery)
        }
        deliver(repeated) shouldBe deliver(once)
      }
    }

    "records one bid in the chronology per placed bid, keyed by its journal position" in {
      val events = journal(List(500, 500))
      val (_, bids) = deliver(numbered(events))
      bids.map(record => (record.sequence, record.minorUnits, record.participant)) shouldBe List(
        (4L, 10500L, participant(0).value),
        (5L, 11000L, participant(1).value)
      )
      bids.map(_.lotId).distinct shouldBe List(lotId)
    }

    "takes the auction of the lot from the event that drafted it" in {
      val (row, _) = deliver(numbered(journal(Nil)))
      row.map(_.auctionId) shouldBe Some(auctionId(1).value)
    }

    "refuses an event that skips over the version of the row" in {
      val events = journal(List(500, 500))
      val (row, _) = deliver(numbered(events.take(3)))
      LotView.project(row, lotId, 5, events(4)) shouldBe Left(LotViewDefect.Gap(lotId, 3, 5))
    }

    "refuses a journal of a lot that starts after its first event" in {
      LotView.project(None, lotId, 2, stored(2, lotScheduled)) shouldBe Left(LotViewDefect.Gap(lotId, 0, 2))
    }

    "refuses a first event that does not draft the lot" in {
      LotView.project(None, lotId, 1, stored(1, lotScheduled)) shouldBe Left(LotViewDefect.Unborn(lotId, 1))
    }

    "catches up over a gap when the missing events are folded in before the delivered one" in {
      val events = numbered(journal(List(500, 500)))
      val (row, _) = deliver(events.take(2))
      val (folded, bids) = LotView.fold(row, lotId, events.drop(2)).fold(defect => fail(defect.toString), done => done)
      folded shouldBe deliver(events)._1
      bids.map(_.sequence) shouldBe List(4L, 5L)
    }

    "folds a redelivered prefix without writing a row" in {
      val events = numbered(journal(Nil))
      val (row, _) = deliver(events)
      LotView.fold(row, lotId, events) shouldBe Right((None, Nil))
    }

    "keeps a gap a defect when the catch-up still misses an event" in {
      val events = numbered(journal(List(500, 500)))
      LotView.fold(None, lotId, Vector(events(0), events(2))) shouldBe Left(LotViewDefect.Gap(lotId, 1, 3))
    }

    "replays the row after every applied event, not only after the last one" in {
      val events = numbered(journal(List(500, 500)))
      val (row, _) = deliver(events.take(1))
      val applied = LotView.replay(row, lotId, events).fold(defect => fail(defect.toString), done => done)
      applied.map(_.sequence) shouldBe List(2L, 3L, 4L, 5L)
      applied.map(step => Some(step.row)) shouldBe (2 to 5).map(n => deliver(events.take(n))._1).toList
    }

    "skips an event at or below the version of the row" in {
      val events = journal(Nil)
      val (row, _) = deliver(numbered(events))
      LotView.project(row, lotId, 2, events(1)) shouldBe Right(LotViewStep.Skip)
      LotView.project(row, lotId, 3, events(2)) shouldBe Right(LotViewStep.Skip)
    }
  }
}
