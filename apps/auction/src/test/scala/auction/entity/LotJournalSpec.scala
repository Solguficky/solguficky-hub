package auction.entity

import auction.entity.JournalFixtures.*
import auction.lot.*
import auction.lot.LotFixtures.*
import org.apache.pekko.actor.testkit.typed.scaladsl.ActorTestKit
import org.scalacheck.Gen
import org.scalatest.BeforeAndAfterAll
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec
import org.scalatestplus.scalacheck.ScalaCheckDrivenPropertyChecks

import java.nio.charset.StandardCharsets
import java.time.Duration
import java.time.Instant
import scala.util.Using

final class LotJournalSpec
    extends AnyWordSpec
    with Matchers
    with ScalaCheckDrivenPropertyChecks
    with BeforeAndAfterAll {

  implicit override val generatorDrivenConfig: PropertyCheckConfiguration =
    PropertyCheckConfiguration(minSuccessful = 100)

  private val kit = ActorTestKit("lot-journal", localConfig)

  override protected def afterAll(): Unit = kit.shutdownTestKit()

  private def golden(name: String): Array[Byte] =
    Using.resource(getClass.getResourceAsStream(s"/journal/$name.json"))(_.readAllBytes())

  private def storedEvent(event: LotEvent, opN: Int = 1): StoredLotEvent =
    LotJournal.store(uuid(1), transaction(opN), event)

  /** Лот, прошедший полный путь до торгов: рождение, планирование, открытие и первая ставка. */
  private val tradingLot: Lot =
    Lot.replay(
      Lot.initial,
      List(
        Envelope(1, op(1), lotDrafted),
        Envelope(2, op(2), lotScheduled),
        Envelope(3, op(3), opened),
        Envelope(4, op(4), placed.copy(previousLeader = None))
      )
    )

  private val lotSold = LotEvent.LotSold(participant(2), money(20000), bid(1), deadline)

  private val lotUnsold = LotEvent.LotUnsold(UnsoldReason.NoBids)

  private val extension = LotEvent.DeadlineExtended(deadline.plus(Duration.ofMinutes(2)), 1)

  /** Тот же лот после лимита, который лидер поставил себе пятой строкой. */
  private val limitedLot: Lot = Lot.apply(tradingLot, Envelope(5, op(5), limitSet))

  private val heldForFinal = LotEvent.LotHeldForFinal(deadline)

  /** Тот же лот, отмеченный для финала шестой строкой и удержанный на дедлайне седьмой. */
  private val heldLot: Lot =
    Lot.replay(limitedLot, List(Envelope(6, op(6), LotEvent.LotMarkedForFinal), Envelope(7, op(7), heldForFinal)))

  /** Эталон пишется так, как его пишет сервис, и сервис читает эталон в то же значение. */
  private def keepsGolden(name: String, stored: StoredLotEvent) = {
    val row = write(kit.system, stored)

    row.json shouldBe mapper.readTree(golden(name))
    read(kit.system, row.copy(bytes = golden(name))) shouldBe stored
  }

  "lot journal" should {

    "write a lot event as jackson json under the name of its storage class" in {
      val row = write(kit.system, storedEvent(opened))

      row.manifest shouldBe classOf[StoredLotEvent].getName
      new String(row.bytes, StandardCharsets.UTF_8) should startWith("{")
    }

    "keep the stored form of a drafted lot equal to its golden file and read the golden file back" in {
      keepsGolden("lot-drafted", storedEvent(lotDrafted))
    }

    "keep the stored form of a scheduled lot equal to its golden file and read the golden file back" in {
      keepsGolden("lot-scheduled", storedEvent(lotScheduled))
    }

    "keep the stored form of an opened lot equal to its golden file and read the golden file back" in {
      keepsGolden("lot-opened", storedEvent(opened))
    }

    "read an opening written before the auction and the schedule into the same event" in {
      val row = write(kit.system, storedEvent(opened)).copy(bytes = golden("legacy/lot-opened"))

      val stored = read(kit.system, row).asInstanceOf[StoredLotEvent]

      stored shouldBe storedEvent(opened).copy(auctionId = None)
      LotJournal.envelope(1, stored) shouldBe Envelope(1, op(1), opened)
    }

    "keep the stored form of a placed bid equal to its golden file and read the golden file back" in {
      keepsGolden(
        "bid-placed",
        LotJournal.store(uuid(1), transaction(2, Initiator.Participant(participant(2))), placed)
      )
    }

    "keep the stored form of a bid a proxy overtook in the same command and read the golden file back" in {
      keepsGolden(
        "bid-placed-overtaken",
        LotJournal.store(
          uuid(1),
          transaction(2, Initiator.Participant(participant(2))),
          placed.copy(overtakenByProxy = true)
        )
      )
    }

    "read a bid written before the overtaken flag as a bid nobody overtook" in {
      val stored = LotJournal.store(uuid(1), transaction(2, Initiator.Participant(participant(2))), placed)
      val row = write(kit.system, stored).copy(bytes = golden("legacy/bid-placed"))

      LotJournal.envelope(1, read(kit.system, row).asInstanceOf[StoredLotEvent]).event shouldBe placed
    }

    "keep the stored form of a bid placed by a proxy without a source and read the golden file back" in {
      keepsGolden(
        "bid-placed-proxy",
        LotJournal.store(uuid(1), transaction(2, Initiator.Participant(participant(2))), placedByProxy)
      )
    }

    "keep the stored form of a proxy limit and its withdrawal equal to their golden files" in {
      keepsGolden(
        "proxy-limit-set",
        LotJournal.store(uuid(1), transaction(2, Initiator.Participant(participant(2))), limitSet)
      )
      keepsGolden(
        "proxy-limit-withdrawn",
        LotJournal.store(uuid(1), transaction(2, Initiator.Participant(participant(2))), limitWithdrawn)
      )
    }

    "keep the stored form of a sold and an unsold lot equal to their golden files and read them back" in {
      keepsGolden("lot-sold", storedEvent(lotSold, opN = 4))
      keepsGolden("lot-unsold", storedEvent(lotUnsold, opN = 4))
    }

    "keep the stored form of a deadline extension equal to its golden file and read the golden file back" in {
      keepsGolden(
        "deadline-extended",
        LotJournal.store(uuid(1), transaction(4, Initiator.Participant(participant(2))), extension)
      )
    }

    "keep the stored form of a mark, an unmark, a hold and a resume equal to their golden files and read them back" in {
      keepsGolden("lot-marked-for-final", storedEvent(LotEvent.LotMarkedForFinal, opN = 4))
      keepsGolden("lot-unmarked-for-final", storedEvent(LotEvent.LotUnmarkedForFinal, opN = 4))
      keepsGolden("lot-held-for-final", storedEvent(heldForFinal, opN = 4))
      keepsGolden("lot-resumed", storedEvent(LotEvent.LotResumed, opN = 4))
    }

    "read an event written before the hold section into the same event" in {
      val row = write(kit.system, storedEvent(opened)).copy(bytes = golden("legacy/lot-opened"))

      read(kit.system, row).asInstanceOf[StoredLotEvent].event.lotHeldForFinal shouldBe None
    }

    "keep the stored form of a held lot snapshot equal to its golden file and read it back" in {
      val row = write(kit.system, LotJournal.storeLot(heldLot, sequence = 7))

      row.json shouldBe mapper.readTree(golden("lot-snapshot-held"))
      LotJournal.restoreLot(
        read(kit.system, row.copy(bytes = golden("lot-snapshot-held"))).asInstanceOf[StoredLot]
      ) shouldBe
        heldLot
      heldLot.state shouldBe a[LotState.Held]
    }

    "read an event written before the closing sections into the same event" in {
      val row = write(kit.system, storedEvent(opened)).copy(bytes = golden("legacy/lot-opened"))

      read(kit.system, row).asInstanceOf[StoredLotEvent].event.lotSold shouldBe None
    }

    "restore the extended deadline and the extension count from a snapshot" in {
      val extended = Lot.apply(tradingLot, Envelope(5, op(4), extension))
      val row = write(kit.system, LotJournal.storeLot(extended, sequence = 5))

      LotJournal.restoreLot(read(kit.system, row).asInstanceOf[StoredLot]) shouldBe extended
      (tradingOf(extended).deadline, tradingOf(extended).extensionsUsed) shouldBe
        (Some(deadline.plus(Duration.ofMinutes(2))), 1)
    }

    "keep the stored form of a lot snapshot with its proxy limits equal to its golden file and read it back" in {
      val stored = LotJournal.storeLot(limitedLot, sequence = 5)
      val row = write(kit.system, stored)

      row.manifest shouldBe classOf[StoredLot].getName
      row.json shouldBe mapper.readTree(golden("lot-snapshot"))
      LotJournal.restoreLot(read(kit.system, row.copy(bytes = golden("lot-snapshot"))).asInstanceOf[StoredLot]) shouldBe
        limitedLot
      tradingOf(limitedLot).proxyLimits shouldBe Map(participant(2) -> limit(20000, setSeq = 5))
    }

    "read a snapshot written before proxy limits, anti-sniping and the mark as unmarked trading without limits" in {
      val row =
        write(kit.system, LotJournal.storeLot(tradingLot, sequence = 4)).copy(bytes = golden("legacy/lot-snapshot"))

      LotJournal.restoreLot(read(kit.system, row).asInstanceOf[StoredLot]) shouldBe tradingLot
    }

    "tell the owner's repeat from another participant's in a snapshot written before the rule (ADR-047, 2026-10-05)" in {
      val row =
        write(kit.system, LotJournal.storeLot(tradingLot, sequence = 4)).copy(bytes = golden("legacy/lot-snapshot"))
      val lot = LotJournal.restoreLot(read(kit.system, row).asInstanceOf[StoredLot])
      val original = lot.seen(op(4))

      Lot.decide(lot, placeBid(who = 2, amount = 10500, opN = 4), bid(9), proxyBid(9), calm) shouldBe
        Right(Decision.Repeated(original))
      Lot.decide(lot, placeBid(who = 1, amount = 11000, opN = 4), bid(9), proxyBid(9), calm) shouldBe
        Left(PlaceBidRejected.OpIdTaken)
    }

    "restore every event and the whole lot with its deduplication window from what it stored" in {
      List(
        lotDrafted,
        lotScheduled,
        opened,
        placed,
        placedByProxy,
        limitSet,
        limitWithdrawn,
        extension,
        lotSold,
        lotUnsold,
        LotEvent.LotMarkedForFinal,
        heldForFinal,
        LotEvent.LotResumed
      ).zipWithIndex
        .foreach { (event, index) =>
          LotJournal.envelope(index.toLong + 7, storedEvent(event)) shouldBe Envelope(index.toLong + 7, op(1), event)
        }
      List(
        Lot.initial,
        drafted,
        scheduled(),
        tradingLot,
        limitedLot,
        lotIn(LotState.Trading(tradingOf(limitedLot).copy(markedForFinal = true))),
        heldLot,
        lotIn(LotState.Held(heldOf(heldLot).copy(extensionsUsed = 2))),
        held(price = 700, leader = participant(3), limits = Map(participant(5) -> limit(900, setSeq = 8))),
        sold(price = 900, winner = participant(4)),
        lotIn(LotState.Unsold(UnsoldReason.NoBids))
      ).foreach(lot => LotJournal.restoreLot(LotJournal.storeLot(lot, sequence = 5)) shouldBe lot)
    }

    "restore every initiator it stored" in {
      List(Initiator.Participant(participant(1)), Initiator.Operator(participant(2)), Initiator.Scheduler)
        .foreach(initiator => LotJournal.restoreInitiator(LotJournal.storeInitiator(initiator)) shouldBe initiator)
    }

    "write no floating point number for any amount, deadline or anti-snipe window" in {
      val cases = for {
        price <- Gen.chooseNum(1L, Long.MaxValue / 4)
        step <- Gen.chooseNum(1L, 1000000L)
        millis <- Gen.chooseNum(0L, 4102444800000L)
        nanos <- Gen.chooseNum(0L, 999999999L)
        window <- Gen.chooseNum(0L, 86400000L)
      } yield (price, step, Instant.ofEpochMilli(millis).plusNanos(nanos % 1000000L), Duration.ofMillis(window))

      forAll(cases) { (sample: (Long, Long, Instant, Duration)) =>
        val (price, step, at, window) = sample
        val lotConfig = LotConfig
          .of(rub, StepPolicy.fixed(money(step)).toOption.get, AntiSnipe(window, window, 3), proxyEnabled = false)
          .toOption
          .get
        val stored = storedEvent(LotEvent.LotOpened(money(price), lotConfig, Some(at)))
        val row = write(kit.system, stored)

        numbers(row.json).filterNot(_.isIntegralNumber) shouldBe Nil
        read(kit.system, row) shouldBe stored
        LotJournal.envelope(1, stored).event shouldBe LotEvent.LotOpened(money(price), lotConfig, Some(at))
      }
    }

    "refuse to restore a snapshot whose auction breaks the invariant of the lot instead of failing on a later command" in {
      val stored = LotJournal.storeLot(tradingLot, sequence = 4)

      a[JournalCorrupted] should be thrownBy LotJournal.restoreLot(stored.copy(auction = None))
      a[JournalCorrupted] should be thrownBy
        LotJournal.restoreLot(LotJournal.storeLot(Lot.initial, sequence = 0).copy(auction = stored.auction))
    }

    "refuse to restore a draft without the auction that drafted the lot" in {
      val stored = storedEvent(lotDrafted).copy(auctionId = None)

      a[JournalCorrupted] should be thrownBy LotJournal.envelope(1, stored)
    }

    "refuse to restore an event whose kind does not match its sections" in {
      val stored = storedEvent(opened)
      val mismatched = stored.copy(event = stored.event.copy(kind = "BidPlaced"))
      val doubled = storedEvent(limitSet).event.copy(lotOpened = stored.event.lotOpened)

      a[JournalCorrupted] should be thrownBy LotJournal.envelope(1, mismatched)
      a[JournalCorrupted] should be thrownBy LotJournal.envelope(1, stored.copy(event = doubled))
    }

    "refuse to restore a bid whose origin and source contradict each other" in {
      val manual = storedEvent(placed)
      val proxy = storedEvent(placedByProxy)
      val manualWithout = manual.event.bidPlaced.map(_.copy(source = None))
      val proxyWith = proxy.event.bidPlaced.map(_.copy(source = Some("Bot")))

      a[JournalCorrupted] should be thrownBy LotJournal.envelope(
        1,
        manual.copy(event = manual.event.copy(bidPlaced = manualWithout))
      )
      a[JournalCorrupted] should be thrownBy LotJournal.envelope(
        1,
        proxy.copy(event = proxy.event.copy(bidPlaced = proxyWith))
      )
    }

    "refuse to restore a snapshot with two limits of one participant or a limit in another currency" in {
      val stored = LotJournal.storeLot(limitedLot, sequence = 5)
      val trading = stored.state.trading.get
      val limits = trading.proxyLimits.get
      def withLimits(changed: List[StoredProxyLimit]) =
        stored.copy(state = stored.state.copy(trading = Some(trading.copy(proxyLimits = Some(changed)))))

      a[JournalCorrupted] should be thrownBy LotJournal.restoreLot(withLimits(limits ++ limits.map(_.copy(setSeq = 9))))
      a[JournalCorrupted] should be thrownBy
        LotJournal.restoreLot(withLimits(limits.map(l => l.copy(max = l.max.copy(currency = "EUR")))))
    }

    "refuse to restore a configuration that breaks the step policy invariant instead of trusting the row" in {
      val stored = storedEvent(opened)
      val lotOpened = stored.event.lotOpened.get
      val broken = lotOpened.config.stepPolicy.copy(tiers = lotOpened.config.stepPolicy.tiers.reverse)
      val corrupted = stored.copy(event =
        stored.event.copy(lotOpened = Some(lotOpened.copy(config = lotOpened.config.copy(stepPolicy = broken))))
      )

      a[JournalCorrupted] should be thrownBy LotJournal.envelope(1, corrupted)
    }
  }
}
