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

    "keep the stored form of a lot snapshot equal to its golden file and read the golden file back" in {
      val stored = LotJournal.storeLot(tradingLot, sequence = 4)
      val row = write(kit.system, stored)

      row.manifest shouldBe classOf[StoredLot].getName
      row.json shouldBe mapper.readTree(golden("lot-snapshot"))
      LotJournal.restoreLot(read(kit.system, row.copy(bytes = golden("lot-snapshot"))).asInstanceOf[StoredLot]) shouldBe
        tradingLot
    }

    "restore every event and the whole lot with its deduplication window from what it stored" in {
      List(lotDrafted, lotScheduled, opened, placed).zipWithIndex.foreach { (event, index) =>
        LotJournal.envelope(index.toLong + 7, storedEvent(event)) shouldBe Envelope(index.toLong + 7, op(1), event)
      }
      List(
        Lot.initial,
        drafted,
        scheduled(),
        tradingLot,
        held(price = 700, leader = participant(3)),
        sold(price = 900, winner = participant(4))
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

      a[JournalCorrupted] should be thrownBy LotJournal.envelope(1, mismatched)
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
