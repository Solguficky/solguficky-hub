package auction.slot

import auction.entity.JournalCorrupted
import auction.entity.JournalFixtures.*
import auction.lot.AuctionId
import org.apache.pekko.actor.testkit.typed.scaladsl.ActorTestKit
import org.scalatest.BeforeAndAfterAll
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

import scala.util.Using

final class TradingSlotJournalSpec extends AnyWordSpec with Matchers with BeforeAndAfterAll {

  private val kit = ActorTestKit("trading-slot-journal", localConfig)

  override protected def afterAll(): Unit = kit.shutdownTestKit()

  private val auction = AuctionId(uuid(5))

  private def golden(name: String): Array[Byte] =
    Using.resource(getClass.getResourceAsStream(s"/journal/$name.json"))(_.readAllBytes())

  private def keepsGolden(name: String, event: SlotEvent) = {
    val stored = TradingSlotJournal.store(uuid(1), decidedAt)(event)
    val row = write(kit.system, stored)
    row.json shouldBe mapper.readTree(golden(name))
    val restored = read(kit.system, row.copy(bytes = golden(name)))
    restored shouldBe stored
    TradingSlotJournal.restore(stored) shouldBe event
  }

  "trading slot journal" should {

    "keeps the stored form of every slot event equal to its golden file and reads it back" in {
      keepsGolden("slot-taken", SlotEvent.SlotTaken(auction))
      keepsGolden("slot-released", SlotEvent.SlotReleased(auction))
    }

    "refuses a row of an unknown kind or without an auction" in {
      val stored = TradingSlotJournal.store(uuid(1), decidedAt)(SlotEvent.SlotTaken(auction))
      a[JournalCorrupted] should be thrownBy TradingSlotJournal.restore(stored.copy(kind = "SlotLost"))
      a[JournalCorrupted] should be thrownBy TradingSlotJournal.restore(stored.copy(auctionId = null))
    }
  }
}
