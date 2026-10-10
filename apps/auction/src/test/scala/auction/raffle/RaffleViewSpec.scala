package auction.raffle

import auction.lot.OpId
import auction.lot.ParticipantId
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

import java.time.Instant
import java.util.UUID

final class RaffleViewSpec extends AnyWordSpec with Matchers {

  private def uuid(n: Int): UUID = new UUID(0x0190f2a000007000L, 0x8000000000000000L | n.toLong)
  private def person(n: Int) = ParticipantId(uuid(100 + n))

  private val closesAt = Instant.parse("2026-10-28T18:00:00Z")
  private val seed = Seed.fromHex("46fb9863b7178feb348aa621d658c5b41b848e398494830bac4837e0b0f539ae").get
  private val randomness =
    Randomness.fromHex("d7941e7b5bcaf8742bfc7136d38c5ab8274286629ffe43081dbda1f05d798300").get
  private val terms = RaffleTerms(closesAt, seed, Quicknet.roundFor(closesAt))

  private def raffle(state: RaffleState) = Raffle(state, Map.empty[OpId, RaffleEnvelope])

  private def view(state: RaffleState, at: Instant = closesAt.minusSeconds(1), names: Map[Int, String] = Map.empty) =
    RaffleView.of(raffle(state), person(1), at, names)

  "the raffle view" should {

    "show the commitment and the round, but never the seed, until the draw" in {
      val open = view(RaffleState.Open(terms, Vector(person(1)))).get
      open.status shouldBe RaffleStatus.Open
      open.registered shouldBe true
      open.commitment shouldBe Some(seed.commitment)
      open.reveal shouldBe None
      view(RaffleState.Open(terms, Vector.empty), at = closesAt).get.status shouldBe RaffleStatus.Closing
      val awaiting = view(RaffleState.Fixed(terms, Vector(person(2), person(1)))).get
      awaiting.status shouldBe RaffleStatus.AwaitingBeacon
      awaiting.reveal shouldBe None
      awaiting.toString should not include seed.hex
    }

    "after the draw reveal the seed, the randomness, V and the winning ticket with the names of the pool" in {
      val tickets = Vector(person(2), person(1))
      val drawn = view(RaffleState.Drawn(terms, tickets, randomness, closesAt.plusSeconds(61)), names = Map(1 -> "a*"))
      drawn.get.status shouldBe RaffleStatus.Drawn
      drawn.get.myTicket shouldBe Some(2)
      drawn.get.tickets shouldBe Vector(RaffleTicketView(1, Some("a*")), RaffleTicketView(2, None))
      drawn.get.reveal shouldBe Some(
        RaffleReveal(
          seed,
          Some(RaffleDrawView(randomness, Draw.value(seed, 2, randomness), Draw.winner(seed, 2, randomness)))
        )
      )
    }

    "reveal the seed without a draw when the pool is empty and show nothing without a raffle" in {
      val empty = view(RaffleState.Fixed(terms, Vector.empty)).get
      empty.status shouldBe RaffleStatus.NoTickets
      empty.reveal shouldBe Some(RaffleReveal(seed, None))
      view(RaffleState.Initial) shouldBe None
      view(RaffleState.NotHeld(closesAt)).get.commitment shouldBe None
    }
  }
}
