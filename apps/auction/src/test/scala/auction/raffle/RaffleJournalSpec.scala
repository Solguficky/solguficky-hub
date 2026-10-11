package auction.raffle

import auction.entity.JournalFixtures.*
import auction.lot.OpId
import auction.lot.ParticipantId
import org.apache.pekko.actor.testkit.typed.scaladsl.ActorTestKit
import org.scalatest.BeforeAndAfterAll
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

import java.time.Instant
import scala.util.Using

final class RaffleJournalSpec extends AnyWordSpec with Matchers with BeforeAndAfterAll {

  private val kit = ActorTestKit("raffle-journal", localConfig)

  override protected def afterAll(): Unit = kit.shutdownTestKit()

  private val closesAt = Instant.parse("2026-10-28T18:00:00Z")
  private val seed = Seed.fromHex("46fb9863b7178feb348aa621d658c5b41b848e398494830bac4837e0b0f539ae").get
  private val randomness =
    Randomness.fromHex("d7941e7b5bcaf8742bfc7136d38c5ab8274286629ffe43081dbda1f05d798300").get
  private val round = Quicknet.roundFor(closesAt)
  private def person(n: Int) = ParticipantId(uuid(100 + n))

  private def golden(name: String): Array[Byte] =
    Using.resource(getClass.getResourceAsStream(s"/journal/$name.json"))(_.readAllBytes())

  private def keepsGolden(name: String, value: AnyRef) = {
    val row = write(kit.system, value)
    row.json shouldBe mapper.readTree(golden(name))
    read(kit.system, row.copy(bytes = golden(name))) shouldBe value
  }

  private def stored(event: RaffleEvent): StoredRaffleEvent =
    RaffleJournal.store(uuid(1), OpId(uuid(2)), decidedAt)(event)

  "raffle journal" should {

    "keeps the stored form of every raffle event equal to its golden file and reads it back" in {
      keepsGolden("raffle-opened", stored(RaffleEvent.RaffleOpened(closesAt, seed, round)))
      keepsGolden("raffle-not-held", stored(RaffleEvent.RaffleNotHeld(closesAt)))
      keepsGolden("raffle-registered", stored(RaffleEvent.Registered(person(1))))
      keepsGolden("raffle-registration-cancelled", stored(RaffleEvent.RegistrationCancelled(person(1))))
      keepsGolden("raffle-pool-fixed", stored(RaffleEvent.PoolFixed(Vector(person(1), person(2)))))
      keepsGolden("raffle-drawn", stored(RaffleEvent.RaffleDrawn(randomness, closesAt.plusSeconds(62))))
    }

    "keeps the stored form of a drawn raffle snapshot and restores the same raffle" in {
      val raffle = Raffle.replay(
        Raffle.initial,
        List(
          RaffleEnvelope(1, OpId(uuid(2)), RaffleEvent.RaffleOpened(closesAt, seed, round)),
          RaffleEnvelope(2, OpId(uuid(3)), RaffleEvent.Registered(person(1))),
          RaffleEnvelope(3, OpId(uuid(4)), RaffleEvent.PoolFixed(Vector(person(1)))),
          RaffleEnvelope(4, OpId(uuid(5)), RaffleEvent.RaffleDrawn(randomness, closesAt.plusSeconds(62)))
        )
      )
      keepsGolden("raffle-snapshot-drawn", RaffleJournal.storeRaffle(raffle, sequence = 4))
      RaffleJournal.restoreRaffle(RaffleJournal.storeRaffle(raffle, sequence = 4)) shouldBe raffle
    }

    "refuses a row whose sections do not match its kind" in {
      val broken = stored(RaffleEvent.Registered(person(1))).event.copy(kind = "PoolFixed")
      an[auction.entity.JournalCorrupted] should be thrownBy RaffleJournal.restoreEvent(broken)
    }
  }
}
