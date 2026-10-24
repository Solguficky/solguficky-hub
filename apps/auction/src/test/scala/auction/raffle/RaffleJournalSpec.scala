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

  /** Строка прежней формы: байты эталона под manifest и сериализатором нынешнего класса. */
  private def legacy(name: String, current: AnyRef): AnyRef =
    read(kit.system, write(kit.system, current).copy(bytes = golden(s"legacy/$name")))

  private def stored(event: RaffleEvent): StoredRaffleEvent =
    RaffleJournal.store(uuid(1), OpId(uuid(2)), decidedAt)(event)

  "raffle journal" should {

    "keeps the stored form of every raffle event equal to its golden file and reads it back" in {
      keepsGolden("raffle-opened", stored(RaffleEvent.RaffleOpened(closesAt, seed, round)))
      keepsGolden(
        "raffle-opened-with-prize",
        stored(RaffleEvent.RaffleOpened(closesAt, seed, round, Some("кружка")))
      )
      keepsGolden("raffle-not-held", stored(RaffleEvent.RaffleNotHeld(closesAt)))
      keepsGolden("raffle-registered", stored(RaffleEvent.Registered(person(1))))
      keepsGolden("raffle-registration-cancelled", stored(RaffleEvent.RegistrationCancelled(person(1))))
      keepsGolden("raffle-pool-fixed", stored(RaffleEvent.PoolFixed(Vector(person(1), person(2)))))
      keepsGolden("raffle-drawn", stored(RaffleEvent.RaffleDrawn(randomness, closesAt.plusSeconds(62))))
      keepsGolden("raffle-cancelled", stored(RaffleEvent.RaffleCancelled(closesAt.plusSeconds(30))))
      keepsGolden(
        "raffle-pool-fixed-by-hand",
        stored(RaffleEvent.PoolFixed(Vector(person(1), person(2)), byHand = true))
      )
      keepsGolden("raffle-winner-assigned", stored(RaffleEvent.WinnerAssigned(2, closesAt.plusSeconds(5400))))
    }

    "reads a pool fixed before the winner by hand existed as a pool that waits for the beacon" in {
      val fixed = stored(RaffleEvent.PoolFixed(Vector(person(1), person(2))))
      legacy("raffle-pool-fixed", fixed) shouldBe fixed
    }

    "keeps the stored form of a raffle that waits for the winner by hand and of its assigned winner" in {
      val awaiting = Raffle.replay(
        Raffle.initial,
        List(
          RaffleEnvelope(1, OpId(uuid(2)), RaffleEvent.RaffleOpened(closesAt, seed, round)),
          RaffleEnvelope(2, OpId(uuid(3)), RaffleEvent.Registered(person(1))),
          RaffleEnvelope(3, OpId(uuid(4)), RaffleEvent.PoolFixed(Vector(person(1)), byHand = true))
        )
      )
      awaiting.state shouldBe a[RaffleState.AwaitingWinner]
      keepsGolden("raffle-snapshot-awaiting-winner", RaffleJournal.storeRaffle(awaiting, sequence = 3))
      RaffleJournal.restoreRaffle(RaffleJournal.storeRaffle(awaiting, sequence = 3)) shouldBe awaiting

      val assigned = Raffle.apply(
        awaiting,
        RaffleEnvelope(4, OpId(uuid(5)), RaffleEvent.WinnerAssigned(1, closesAt.plusSeconds(5400)))
      )
      assigned.state shouldBe a[RaffleState.Assigned]
      keepsGolden("raffle-snapshot-assigned", RaffleJournal.storeRaffle(assigned, sequence = 4))
      RaffleJournal.restoreRaffle(RaffleJournal.storeRaffle(assigned, sequence = 4)) shouldBe assigned
    }

    "keeps the stored form of a cancelled raffle snapshot and restores the same raffle" in {
      val raffle = Raffle.replay(
        Raffle.initial,
        List(
          RaffleEnvelope(1, OpId(uuid(2)), RaffleEvent.RaffleOpened(closesAt, seed, round)),
          RaffleEnvelope(2, OpId(uuid(3)), RaffleEvent.Registered(person(1))),
          RaffleEnvelope(3, OpId(uuid(4)), RaffleEvent.RaffleCancelled(closesAt.plusSeconds(30)))
        )
      )
      raffle.state shouldBe a[RaffleState.Cancelled]
      keepsGolden("raffle-snapshot-cancelled", RaffleJournal.storeRaffle(raffle, sequence = 3))
      RaffleJournal.restoreRaffle(RaffleJournal.storeRaffle(raffle, sequence = 3)) shouldBe raffle
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

    "reads a raffle opened before the prize existed as a raffle without a prize" in {
      val opened = stored(RaffleEvent.RaffleOpened(closesAt, seed, round))
      legacy("raffle-opened", opened) shouldBe opened
    }

    "restores a snapshot written before the prize existed" in {
      val raffle = Raffle.replay(
        Raffle.initial,
        List(
          RaffleEnvelope(1, OpId(uuid(2)), RaffleEvent.RaffleOpened(closesAt, seed, round)),
          RaffleEnvelope(2, OpId(uuid(3)), RaffleEvent.Registered(person(1))),
          RaffleEnvelope(3, OpId(uuid(4)), RaffleEvent.PoolFixed(Vector(person(1)))),
          RaffleEnvelope(4, OpId(uuid(5)), RaffleEvent.RaffleDrawn(randomness, closesAt.plusSeconds(62)))
        )
      )
      val snapshot = legacy("raffle-snapshot-drawn", RaffleJournal.storeRaffle(raffle, sequence = 4))
      RaffleJournal.restoreRaffle(snapshot.asInstanceOf[StoredRaffle]) shouldBe raffle
    }

    "refuses a row whose sections do not match its kind" in {
      val broken = stored(RaffleEvent.Registered(person(1))).event.copy(kind = "PoolFixed")
      an[auction.entity.JournalCorrupted] should be thrownBy RaffleJournal.restoreEvent(broken)
    }
  }
}
