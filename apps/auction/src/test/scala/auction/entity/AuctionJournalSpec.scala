package auction.entity

import auction.aggregate.*
import auction.aggregate.AuctionFixtures.byAuctioneer
import auction.aggregate.AuctionFixtures.config
import auction.catalog.LotId
import auction.entity.JournalFixtures.*
import auction.lot.LotFixtures.*
import org.apache.pekko.actor.testkit.typed.scaladsl.ActorTestKit
import org.scalatest.BeforeAndAfterAll
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

import scala.util.Using

final class AuctionJournalSpec extends AnyWordSpec with Matchers with BeforeAndAfterAll {

  private val kit = ActorTestKit("auction-journal", localConfig)

  override protected def afterAll(): Unit = kit.shutdownTestKit()

  private val meetup = MeetupId(uuid(10))
  private val lot = LotId(uuid(11))

  private def golden(name: String): Array[Byte] =
    Using.resource(getClass.getResourceAsStream(s"/journal/$name.json"))(_.readAllBytes())

  private def stored(event: AuctionEvent, opN: Int): StoredAuctionEvent =
    AuctionJournal.store(uuid(1), uuid(2), op(opN), decidedAt, Initiator.Operator(participant(1)))(event)

  /** Эталон пишется так, как его пишет сервис, и сервис читает эталон в то же значение. */
  private def keepsGolden(name: String, value: AnyRef) = {
    val row = write(kit.system, value)
    row.json shouldBe mapper.readTree(golden(name))
    read(kit.system, row.copy(bytes = golden(name))) shouldBe value
  }

  private val drafted = AuctionEnvelope(1, op(1), AuctionEvent.AuctionDrafted(meetup))

  /** Рождение, записанное до признака видимости: строка без него читается видимым аукционом. */
  private val draftedVisible = AuctionEnvelope(1, op(1), AuctionEvent.AuctionDrafted(meetup, hidden = false))
  private val added = AuctionEnvelope(2, op(2), AuctionEvent.LotAdded(lot))
  private val scheduled = AuctionEnvelope(3, op(3), AuctionEvent.AuctionScheduled(config()))
  private val started = AuctionEnvelope(4, op(4), AuctionEvent.PrebiddingStarted)

  private val prebidding = Auction.replay(Auction.initial, List(drafted, added, scheduled, started))

  private val deadline = AuctionEnvelope(5, op(5), AuctionEvent.PrebiddingDeadlineReached)
  private val ended = AuctionEnvelope(6, op(6), AuctionEvent.PrebiddingEnded(finished = false))
  private val frozen = AuctionEnvelope(7, op(7), AuctionEvent.FinalLineupFrozen(List(lot)))
  private val finalStarted = AuctionEnvelope(8, op(8), AuctionEvent.FinalStarted)
  private val activated = AuctionEnvelope(9, op(9), AuctionEvent.FinalLotActivated(lot))

  private val inFinal = Auction.replay(prebidding, List(deadline, ended, frozen, finalStarted, activated))

  /** Строка прежней формы: байты эталона под manifest и сериализатором нынешнего класса. */
  private def legacy(name: String, current: AnyRef): AnyRef =
    read(kit.system, write(kit.system, current).copy(bytes = golden(s"legacy/$name")))

  "auction journal" should {

    "keeps the stored form of every auction event equal to its golden file and reads the golden file back" in {
      keepsGolden("auction-drafted", stored(drafted.event, 1))
      keepsGolden("lot-added", stored(added.event, 2))
      keepsGolden("lot-removed", stored(AuctionEvent.LotRemoved(lot), 3))
      keepsGolden("auction-scheduled", stored(scheduled.event, 3))
      keepsGolden("prebidding-started", stored(started.event, 4))
      keepsGolden("auction-discarded", stored(AuctionEvent.AuctionDiscarded, 5))
      keepsGolden("auction-published", stored(AuctionEvent.AuctionPublished, 5))
      keepsGolden("auction-hidden", stored(AuctionEvent.AuctionHidden, 5))
    }

    "keeps a hidden auction hidden through its snapshot and a published one visible" in {
      val hidden = Auction.replay(Auction.initial, List(drafted, added))
      hidden.hidden shouldBe true
      AuctionJournal.storeAuction(hidden, sequence = 2).hidden shouldBe Some(true)
      AuctionJournal.restoreAuction(AuctionJournal.storeAuction(hidden, sequence = 2)) shouldBe hidden
      val published = Auction.apply(hidden, AuctionEnvelope(3, op(3), AuctionEvent.AuctionPublished))
      AuctionJournal.storeAuction(published, sequence = 3).hidden shouldBe None
      AuctionJournal.restoreAuction(AuctionJournal.storeAuction(published, sequence = 3)) shouldBe published
    }

    "refuses a snapshot hidden from participants once prebidding started" in {
      val open = AuctionJournal.storeAuction(prebidding, sequence = 4)
      a[JournalCorrupted] should be thrownBy AuctionJournal.restoreAuction(open.copy(hidden = Some(true)))
    }

    "keeps the stored form of a schedule with step windows and reads it back as one" in {
      val windowed = AuctionEvent.AuctionScheduled(
        AuctionFixtures.config(
          AuctionFixtures.configInput(stepWindows =
            List(AuctionFixtures.window(24, 26, Set(lot, LotId(uuid(12)))), AuctionFixtures.window(48, 49, Set(lot)))
          )
        )
      )
      keepsGolden("auction-scheduled-with-step-windows", stored(windowed, 3))
    }

    "keeps the stored form of a launched window and of a snapshot that holds it equal to their golden files" in {
      val window = StepWindowConfig(
        java.time.Instant.parse("2026-10-05T12:00:00Z"),
        java.time.Instant.parse("2026-10-05T14:00:00Z"),
        money(100),
        Set(lot)
      )
      val launched = AuctionEnvelope(5, op(5), AuctionEvent.StepWindowLaunched(window))
      keepsGolden("step-window-launched", stored(launched.event, 5))
      val after = Auction.apply(prebidding, launched)
      after.launched shouldBe List(LaunchedWindow(op(5), window))
      keepsGolden("auction-snapshot-launched", AuctionJournal.storeAuction(after, sequence = 5))
      AuctionJournal.restoreAuction(AuctionJournal.storeAuction(after, sequence = 5)) shouldBe after
    }

    "keeps the stored form of the lot set events and of a snapshot with sets equal to their golden files" in {
      val set = LotSetId(uuid(20))
      val second = LotId(uuid(12))
      val name = LotSetName("Красный сет").toOption.get
      val defined = AuctionEnvelope(3, op(3), AuctionEvent.LotSetDefined(set, name, List(second, lot)))
      keepsGolden("lot-set-defined", stored(defined.event, 3))
      keepsGolden("lot-set-deleted", stored(AuctionEvent.LotSetDeleted(set), 3))
      val collected = AuctionEvent.LotSetSettled(set, LotSetSettlement.Collected(participant(2)))
      keepsGolden("lot-set-settled", stored(collected, 5))
      keepsGolden(
        "lot-set-settled-uncollected",
        stored(AuctionEvent.LotSetSettled(set, LotSetSettlement.NotCollected), 5)
      )

      val registry =
        Auction.replay(Auction.initial, List(drafted, added, AuctionEnvelope(3, op(13), AuctionEvent.LotAdded(second))))
      val withSet = Auction.replay(
        registry,
        List(
          AuctionEnvelope(4, op(3), AuctionEvent.LotSetDefined(set, name, List(second, lot))),
          AuctionEnvelope(5, op(14), AuctionEvent.AuctionScheduled(config())),
          AuctionEnvelope(6, op(4), AuctionEvent.PrebiddingStarted),
          AuctionEnvelope(7, op(5), collected)
        )
      )
      withSet.sets(set).settlement shouldBe Some(LotSetSettlement.Collected(participant(2)))
      keepsGolden("auction-snapshot-sets", AuctionJournal.storeAuction(withSet, sequence = 7))
      AuctionJournal.restoreAuction(AuctionJournal.storeAuction(withSet, sequence = 7)) shouldBe withSet
    }

    "refuses a snapshot with a collector of a set that has no outcome" in {
      val set = LotSetId(uuid(20))
      val unsettled = Auction.apply(
        Auction.replay(Auction.initial, List(drafted, added)),
        AuctionEnvelope(3, op(3), AuctionEvent.LotSetDefined(set, LotSetName("Сет").toOption.get, List(lot)))
      )
      val stored = AuctionJournal.storeAuction(unsettled, sequence = 3)
      val forged = stored.copy(sets = stored.sets.map(_.map(_.copy(collector = Some(uuid(30))))))
      a[JournalCorrupted] should be thrownBy AuctionJournal.restoreAuction(forged)
    }

    "refuses a launched window with no lot instead of recording it" in {
      val body = stored(
        AuctionEvent.StepWindowLaunched(StepWindowConfig(decidedAt, decidedAt.plusSeconds(60), money(100), Set.empty)),
        5
      )
      a[JournalCorrupted] should be thrownBy AuctionJournal.restoreEvent(body.event)
    }

    "keeps the stored form of a schedule without lot defaults and reads it back as one" in {
      val bare = AuctionEvent.AuctionScheduled(AuctionFixtures.config(AuctionFixtures.configInput(lotDefaults = None)))
      keepsGolden("auction-scheduled-without-defaults", stored(bare, 3))
    }

    "keeps the stored form of the estimated time of the final and reads it back" in {
      keepsGolden("final-time-set", stored(AuctionEvent.FinalTimeSet(decidedAt), 5))
      keepsGolden("final-time-cleared", stored(AuctionEvent.FinalTimeCleared, 6))
    }

    "keeps the estimated time of the final in the snapshot and reads it back" in {
      val withTime = Auction.apply(prebidding, AuctionEnvelope(5, op(5), AuctionEvent.FinalTimeSet(decidedAt)))
      val stored = AuctionJournal.storeAuction(withTime, sequence = 5)
      stored.finalAt shouldBe Some(decidedAt)
      AuctionJournal.restoreAuction(stored) shouldBe withTime
      val cleared = Auction.apply(withTime, AuctionEnvelope(6, op(6), AuctionEvent.FinalTimeCleared))
      val without = AuctionJournal.storeAuction(cleared, sequence = 6)
      without.finalAt shouldBe None
      AuctionJournal.restoreAuction(without) shouldBe cleared
    }

    // Строка, записанная до поля времени: аукцион без ориентировочного времени финала (ADR-040, дополнение 2026-10-19).
    "reads a snapshot written before the estimated time of the final as an auction without it" in {
      val snapshot = legacy("auction-snapshot-prebidding", AuctionJournal.storeAuction(prebidding, sequence = 4))
      AuctionJournal.restoreAuction(snapshot.asInstanceOf[StoredAuction]).finalAt shouldBe None
    }

    "keeps the stored form of a snapshot in prebidding with its config and the op_id of the start" in {
      keepsGolden("auction-snapshot-prebidding", AuctionJournal.storeAuction(prebidding, sequence = 4))
      AuctionJournal.restoreAuction(AuctionJournal.storeAuction(prebidding, sequence = 4)) shouldBe prebidding
      prebidding.state shouldBe AuctionState.Prebidding(config(), op(4))
    }

    "keeps the stored form of the events of the break and the final equal to their golden files" in {
      keepsGolden("prebidding-deadline-reached", stored(deadline.event, 5))
      keepsGolden("prebidding-ended", stored(ended.event, 6))
      keepsGolden("final-lineup-frozen", stored(frozen.event, 7))
      keepsGolden("final-started", stored(finalStarted.event, 8))
      keepsGolden("final-lot-activated", stored(activated.event, 9))
    }

    "keeps the stored form of a snapshot in the final with its lineup and the lots returned to trading" in {
      keepsGolden("auction-snapshot-final", AuctionJournal.storeAuction(inFinal, sequence = 9))
      AuctionJournal.restoreAuction(AuctionJournal.storeAuction(inFinal, sequence = 9)) shouldBe inFinal
      inFinal.state shouldBe AuctionState.Final(config(), op(4), List(lot), List(lot), Nil)
    }

    "keeps the stored form of the end of the final and of a snapshot with a completed lot equal to their golden files" in {
      val completed = AuctionEnvelope(10, op(10), AuctionEvent.FinalLotCompleted(lot))
      keepsGolden("final-lot-completed", stored(completed.event, 10))
      keepsGolden("auction-finished", stored(AuctionEvent.AuctionFinished, 11))
      val over = Auction.apply(inFinal, completed)
      over.state shouldBe AuctionState.Final(config(), op(4), List(lot), List(lot), List(lot))
      keepsGolden("auction-snapshot-final-completed", AuctionJournal.storeAuction(over, sequence = 10))
      AuctionJournal.restoreAuction(AuctionJournal.storeAuction(over, sequence = 10)) shouldBe over
      val finished = Auction.apply(over, AuctionEnvelope(11, op(11), AuctionEvent.AuctionFinished))
      finished.state shouldBe AuctionState.Finished(config(), op(4))
      AuctionJournal.restoreAuction(AuctionJournal.storeAuction(finished, sequence = 11)) shouldBe finished
    }

    "reads a snapshot of the final written before lots of the final completed as a final without completed lots" in {
      val snapshot = legacy("auction-snapshot-final", AuctionJournal.storeAuction(inFinal, sequence = 9))
      AuctionJournal.restoreAuction(snapshot.asInstanceOf[StoredAuction]) shouldBe
        Auction.replay(
          Auction.initial,
          List(draftedVisible, added, scheduled, started, deadline, ended, frozen, finalStarted, activated)
        )
    }

    "refuses completed lots of a final in a snapshot of another state and a completed lot never returned to trading" in {
      val open = AuctionJournal.storeAuction(prebidding, sequence = 4)
      a[JournalCorrupted] should be thrownBy AuctionJournal.restoreAuction(open.copy(completed = Some(List(lot.value))))
      val running = AuctionJournal.storeAuction(inFinal, sequence = 9)
      a[JournalCorrupted] should be thrownBy AuctionJournal.restoreAuction(
        running.copy(completed = Some(List(uuid(12))))
      )
    }

    "restores every state of the break and the final from its snapshot" in {
      val states = List(deadline, ended, frozen, finalStarted).scanLeft(prebidding)(Auction.apply)
      val finished = Auction.apply(
        Auction.apply(prebidding, deadline),
        AuctionEnvelope(6, op(6), AuctionEvent.PrebiddingEnded(finished = true))
      )
      finished.state shouldBe AuctionState.Finished(config(), op(4))
      (states :+ finished).foreach { auction =>
        AuctionJournal.restoreAuction(AuctionJournal.storeAuction(auction, sequence = 9)) shouldBe auction
      }
    }

    "keeps the stored form of a cancel and of a cancelled snapshot with the op_id of the cancel" in {
      val cancel = AuctionEnvelope(7, op(7), AuctionEvent.AuctionCancelled)
      keepsGolden("auction-cancelled", stored(cancel.event, 7))
      val cancelled = Auction.replay(prebidding, List(deadline, ended, cancel))
      cancelled.state shouldBe AuctionState.Cancelled(config(), op(4), op(7))
      keepsGolden("auction-snapshot-cancelled", AuctionJournal.storeAuction(cancelled, sequence = 7))
      AuctionJournal.restoreAuction(AuctionJournal.storeAuction(cancelled, sequence = 7)) shouldBe cancelled
    }

    "refuses a cancelled snapshot without the op_id of the cancel and one in another state with it" in {
      val cancelled = Auction.replay(prebidding, List(AuctionEnvelope(5, op(5), AuctionEvent.AuctionCancelled)))
      val snapshot = AuctionJournal.storeAuction(cancelled, sequence = 5)
      a[JournalCorrupted] should be thrownBy AuctionJournal.restoreAuction(snapshot.copy(cancelledBy = None))
      val open = AuctionJournal.storeAuction(prebidding, sequence = 4)
      a[JournalCorrupted] should be thrownBy AuctionJournal.restoreAuction(open.copy(cancelledBy = Some(uuid(5))))
    }

    "refuses a lineup with a repeated lot as a corrupted row" in {
      val twice = stored(frozen.event, 7)
      val corrupted =
        twice.copy(event = twice.event.copy(finalLineupFrozen = Some(StoredLineup(List(lot.value, lot.value)))))
      a[JournalCorrupted] should be thrownBy AuctionJournal.envelope(7, corrupted)
    }

    "reads a snapshot in prebidding written before the break existed into the same auction" in {
      val snapshot = legacy("auction-snapshot-prebidding", AuctionJournal.storeAuction(prebidding, sequence = 4))
      AuctionJournal.restoreAuction(snapshot.asInstanceOf[StoredAuction]) shouldBe
        Auction.replay(Auction.initial, List(draftedVisible, added, scheduled, started))
    }

    "reads rows and a snapshot written before scheduling existed into the same events and a visible auction" in {
      val born = legacy("auction-drafted", stored(drafted.event, 1)).asInstanceOf[StoredAuctionEvent]
      AuctionJournal.envelope(1, born) shouldBe draftedVisible
      legacy("lot-added", stored(added.event, 2)) shouldBe stored(added.event, 2)
      legacy("lot-removed", stored(AuctionEvent.LotRemoved(lot), 3)) shouldBe stored(AuctionEvent.LotRemoved(lot), 3)
      val auction = Auction.replay(Auction.initial, List(draftedVisible, added))
      auction.hidden shouldBe false
      val snapshot = legacy("auction-snapshot", AuctionJournal.storeAuction(auction, sequence = 2))
      AuctionJournal.restoreAuction(snapshot.asInstanceOf[StoredAuction]) shouldBe auction
    }

    "keeps the stored form of a schedule with a raffle and reads it back as one" in {
      val raffled = AuctionEvent.AuctionScheduled(
        AuctionFixtures.config(
          AuctionFixtures.configInput(onlinePhase =
            Some(AuctionFixtures.week.copy(raffleClosesAt = Some(java.time.Instant.parse("2026-10-07T18:00:00Z"))))
          )
        )
      )
      keepsGolden("auction-scheduled-with-raffle", stored(raffled, 3))
    }

    "reads a schedule written before the raffle existed as a schedule without a raffle" in {
      legacy("auction-scheduled-without-raffle", stored(scheduled.event, 3)) shouldBe stored(scheduled.event, 3)
      config().raffleClosesAt shouldBe None
    }

    "reads a schedule written before the raffle prize existed as a raffle without a prize" in {
      val raffled: AuctionEvent.AuctionScheduled = AuctionEvent.AuctionScheduled(
        AuctionFixtures.config(
          AuctionFixtures.configInput(onlinePhase =
            Some(AuctionFixtures.week.copy(raffleClosesAt = Some(java.time.Instant.parse("2026-10-07T18:00:00Z"))))
          )
        )
      )
      legacy("auction-scheduled-with-raffle", stored(raffled, 3)) shouldBe stored(raffled, 3)
      raffled.config.rafflePrize shouldBe None
    }

    "keeps no fractional number in a scheduled config" in {
      val row = write(kit.system, stored(scheduled.event, 3))
      numbers(row.json).filterNot(_.isIntegralNumber) shouldBe empty
    }

    "keeps the stored form of an auction snapshot with its registry and window equal to its golden file" in {
      val auction = Auction.replay(Auction.initial, List(drafted, added))
      keepsGolden("auction-snapshot", AuctionJournal.storeAuction(auction, sequence = 2))
      AuctionJournal.restoreAuction(AuctionJournal.storeAuction(auction, sequence = 2)) shouldBe auction
    }

    "restores every event it stored into the same domain event" in {
      val ledByPerson = AuctionEvent.AuctionScheduled(config(byAuctioneer))
      List(
        drafted.event,
        added.event,
        AuctionEvent.LotRemoved(lot),
        scheduled.event,
        ledByPerson,
        started.event,
        AuctionEvent.AuctionDiscarded,
        draftedVisible.event,
        AuctionEvent.AuctionPublished,
        AuctionEvent.AuctionHidden,
        deadline.event,
        ended.event,
        AuctionEvent.PrebiddingEnded(finished = true),
        frozen.event,
        finalStarted.event,
        activated.event
      ).foreach { event =>
        AuctionJournal.envelope(4, stored(event, 4)) shouldBe AuctionEnvelope(4, op(4), event)
      }
    }

    "refuses a snapshot whose meetup breaks the invariant of the auction instead of failing on a later command" in {
      val born = AuctionJournal.storeAuction(Auction.replay(Auction.initial, List(drafted)), sequence = 1)
      a[JournalCorrupted] should be thrownBy AuctionJournal.restoreAuction(born.copy(meetupId = None))
      a[JournalCorrupted] should be thrownBy AuctionJournal.restoreAuction(born.copy(state = "Initial"))
      a[JournalCorrupted] should be thrownBy AuctionJournal.restoreAuction(born.copy(state = "Unknown"))
    }

    "refuses a snapshot whose config or start does not match its state" in {
      val stored = AuctionJournal.storeAuction(prebidding, sequence = 4)
      a[JournalCorrupted] should be thrownBy AuctionJournal.restoreAuction(stored.copy(startedBy = None))
      a[JournalCorrupted] should be thrownBy AuctionJournal.restoreAuction(stored.copy(config = None))
      a[JournalCorrupted] should be thrownBy AuctionJournal.restoreAuction(stored.copy(state = "Draft"))
      a[JournalCorrupted] should be thrownBy AuctionJournal.restoreAuction(stored.copy(state = "Scheduled"))
    }

    "refuses a stored config that breaks the rules of scheduling instead of restoring it" in {
      val body = stored(scheduled.event, 3).event
      val contradictory = body.auctionScheduled.map { config =>
        config.copy(onlinePhase = config.onlinePhase.map(_.copy(closesAt = None)))
      }
      a[JournalCorrupted] should be thrownBy AuctionJournal.restoreEvent(body.copy(auctionScheduled = contradictory))
      val unknown = body.auctionScheduled.map(_.copy(closingPolicy = StoredClosingPolicy("ByLottery", None)))
      a[JournalCorrupted] should be thrownBy AuctionJournal.restoreEvent(body.copy(auctionScheduled = unknown))
    }

    "refuses an event whose kind does not match its sections" in {
      val body = stored(added.event, 2).event
      a[JournalCorrupted] should be thrownBy AuctionJournal.restoreEvent(body.copy(kind = "LotRemoved"))
      a[JournalCorrupted] should be thrownBy
        AuctionJournal.restoreEvent(body.copy(auctionDrafted = Some(StoredAuctionDrafted(meetup.value))))
      a[JournalCorrupted] should be thrownBy AuctionJournal.restoreEvent(body.copy(kind = "PrebiddingStarted"))
      a[JournalCorrupted] should be thrownBy AuctionJournal.restoreEvent(body.copy(kind = "AuctionDiscarded"))
    }
  }
}
