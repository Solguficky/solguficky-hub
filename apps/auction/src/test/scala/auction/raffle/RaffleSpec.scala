package auction.raffle

import auction.lot.OpId
import auction.lot.ParticipantId
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

import java.time.Instant
import java.util.UUID

final class RaffleSpec extends AnyWordSpec with Matchers {

  private def uuid(n: Int): UUID = new UUID(0x0190f2a000007000L, 0x8000000000000000L | n.toLong)
  private def person(n: Int) = ParticipantId(uuid(100 + n))
  private def op(n: Int) = OpId(uuid(n))

  private val closesAt = Instant.parse("2026-10-28T18:00:00Z")
  private val before = closesAt.minusSeconds(60)
  private val seed = Seed.fromHex("46fb9863b7178feb348aa621d658c5b41b848e398494830bac4837e0b0f539ae").get
  private val randomness =
    Randomness.fromHex("d7941e7b5bcaf8742bfc7136d38c5ab8274286629ffe43081dbda1f05d798300").get

  /** Применяет принятое решение конвертом со следующим номером, как это делает entity. */
  private def step(raffle: Raffle, opId: OpId, event: RaffleEvent): Raffle =
    Raffle.apply(raffle, RaffleEnvelope(raffle.seen.size.toLong + 1, opId, event))

  private def accepted(raffle: Raffle, opId: OpId, decision: Either[?, RaffleDecision]): Raffle =
    decision match {
      case Right(RaffleDecision.Accepted(event)) => step(raffle, opId, event)
      case other => fail(s"expected an accepted decision, got $other")
    }

  private val open: Raffle =
    Raffle.decide(Raffle.initial, OpenRaffle(closesAt), before, seed) match {
      case RaffleDecision.Accepted(event) => step(Raffle.initial, op(1), event)
      case other => fail(s"raffle did not open: $other")
    }

  private def register(raffle: Raffle, who: Int, opN: Int, at: Instant = before): Raffle =
    accepted(raffle, op(opN), Raffle.decide(raffle, Register(person(who), op(opN)), at))

  private def fixed(raffle: Raffle, excluded: Set[ParticipantId] = Set.empty): Raffle =
    Raffle.decide(raffle, FixPool(excluded), closesAt) match {
      case Right(event) => step(raffle, op(90), event)
      case Left(rejected) => fail(s"pool not fixed: $rejected")
    }

  "opening" should {

    "publishes the commitment of the seed and the first beacon round after closing plus a minute" in {
      open.state shouldBe RaffleState.Open(RaffleTerms(closesAt, seed, Quicknet.roundFor(closesAt)), Vector.empty)
    }

    "does not open registration and does not create a seed when it comes no earlier than closing" in {
      var seeded = false
      def seedOnce = { seeded = true; seed }
      Raffle.decide(Raffle.initial, OpenRaffle(closesAt), closesAt, seedOnce) shouldBe
        RaffleDecision.Accepted(RaffleEvent.RaffleNotHeld(closesAt))
      seeded shouldBe false
    }

    "carries the announced prize in its terms and leaves it out when none was announced" in {
      val withPrize =
        Raffle.decide(Raffle.initial, OpenRaffle(closesAt, Some("кружка")), before, seed) match {
          case RaffleDecision.Accepted(event) => step(Raffle.initial, op(1), event)
          case other => fail(s"raffle did not open: $other")
        }
      withPrize.state match {
        case RaffleState.Open(opened, _) => opened.prize shouldBe Some("кружка")
        case other => fail(s"raffle is not open: $other")
      }
      open.state match {
        case RaffleState.Open(opened, _) => opened.prize shouldBe None
        case other => fail(s"raffle is not open: $other")
      }
    }

    "does not change the announced terms on a repeated opening" in {
      Raffle.decide(open, OpenRaffle(closesAt.plusSeconds(3600)), before, seed) shouldBe RaffleDecision.Unchanged
    }
  }

  "registration" should {

    "gives a participant one ticket however many times they register" in {
      val once = register(open, 1, 2)
      Raffle.decide(once, Register(person(1), op(3)), before) shouldBe Right(RaffleDecision.Unchanged)
      Raffle.decide(once, Register(person(1), op(2)), before) match {
        case Right(RaffleDecision.Repeated(original)) => original.opId shouldBe op(2)
        case other => fail(s"repeat of op_id answered $other")
      }
      fixed(once).state match {
        case RaffleState.Fixed(_, tickets) => tickets shouldBe Vector(person(1))
        case other => fail(s"unexpected $other")
      }
    }

    "is refused by time at closing even while the state is still open" in {
      Raffle.decide(open, Register(person(1), op(2)), closesAt) shouldBe
        Left(RegistrationRejected.RegistrationClosed)
      Raffle.decide(open, CancelRegistration(person(1), op(2)), closesAt) shouldBe
        Left(RegistrationRejected.RegistrationClosed)
    }

    "is refused without a raffle and after the pool is fixed" in {
      Raffle.decide(Raffle.initial, Register(person(1), op(2)), before) shouldBe
        Left(RegistrationRejected.RaffleNotFound)
      Raffle.decide(fixed(open), Register(person(1), op(2)), closesAt.plusSeconds(1)) shouldBe
        Left(RegistrationRejected.RegistrationClosed)
    }

    "is refused as closed in a raffle that was not held" in {
      val notHeld = Raffle.decide(Raffle.initial, OpenRaffle(closesAt), closesAt, seed) match {
        case RaffleDecision.Accepted(event) => step(Raffle.initial, op(1), event)
        case other => fail(s"unexpected $other")
      }
      Raffle.decide(notHeld, Register(person(1), op(2)), before) shouldBe Left(RegistrationRejected.RegistrationClosed)
    }

    "refuses an op_id that another command took" in {
      val once = register(open, 1, 2)
      Raffle.decide(once, CancelRegistration(person(1), op(2)), before) shouldBe Left(RegistrationRejected.OpIdTaken)
      Raffle.decide(once, Register(person(2), op(2)), before) shouldBe Left(RegistrationRejected.OpIdTaken)
    }

    "lets a participant cancel and register again at the end of the queue" in {
      val three = register(register(register(open, 1, 2), 2, 3), 3, 4)
      val cancelled = accepted(three, op(5), Raffle.decide(three, CancelRegistration(person(1), op(5)), before))
      val again = register(cancelled, 1, 6)
      fixed(again).state match {
        case RaffleState.Fixed(_, tickets) => tickets shouldBe Vector(person(2), person(3), person(1))
        case other => fail(s"unexpected $other")
      }
    }

    "accepts a cancellation without a registration without an event" in {
      Raffle.decide(open, CancelRegistration(person(1), op(2)), before) shouldBe Right(RaffleDecision.Unchanged)
    }

    "keeps a late repeat of a registration after its cancellation from registering again" in {
      val once = register(open, 1, 2)
      val cancelled = accepted(once, op(3), Raffle.decide(once, CancelRegistration(person(1), op(3)), before))
      Raffle.decide(cancelled, Register(person(1), op(2)), before) match {
        case Right(RaffleDecision.Repeated(_)) => ()
        case other => fail(s"late repeat answered $other")
      }
    }
  }

  "fixing the pool" should {

    "numbers the remaining registrations 1..N in registration order without gaps" in {
      val pool = register(register(register(open, 1, 2), 2, 3), 3, 4)
      fixed(pool, excluded = Set(person(2))).state match {
        case RaffleState.Fixed(_, tickets) =>
          tickets shouldBe Vector(person(1), person(3))
          Raffle.ticketOf(tickets, person(3)) shouldBe Some(2)
          Raffle.ticketOf(tickets, person(2)) shouldBe None
        case other => fail(s"unexpected $other")
      }
    }

    "waits for closing and happens once" in {
      Raffle.decide(open, FixPool(Set.empty), before) shouldBe Left(FixPoolRejected.NotClosedYet)
      Raffle.decide(fixed(open), FixPool(Set.empty), closesAt) shouldBe Left(FixPoolRejected.AlreadyFixed)
      Raffle.decide(Raffle.initial, FixPool(Set.empty), closesAt) shouldBe Left(FixPoolRejected.NotOpen)
    }

    "treats answers from the time of the beacon round on as too late to change the pool" in {
      val terms = RaffleTerms(closesAt, seed, Quicknet.roundFor(closesAt))
      Raffle.answeredTooLate(terms, closesAt.plusSeconds(30)) shouldBe false
      Raffle.answeredTooLate(terms, Quicknet.roundAt(terms.round)) shouldBe true
    }

    "excludes only those Identity answered without the right and keeps the unanswered" in {
      Raffle.excluded(Map(person(1) -> Some(false), person(2) -> None, person(3) -> Some(true))) shouldBe
        Set(person(1))
    }
  }

  "the draw" should {

    "takes place once on a non-empty pool and refuses a second draw" in {
      val pool = fixed(register(open, 1, 2))
      val drawn = Raffle.decide(pool, DrawWinner(randomness, closesAt.plusSeconds(61))) match {
        case Right(event) => step(pool, op(91), event)
        case Left(rejected) => fail(s"draw refused: $rejected")
      }
      Raffle.decide(drawn, DrawWinner(randomness, closesAt.plusSeconds(62))) shouldBe Left(DrawRejected.AlreadyDrawn)
    }

    "does not take place on an empty pool and not before the pool is fixed" in {
      Raffle.decide(fixed(open), DrawWinner(randomness, closesAt)) shouldBe Left(DrawRejected.NoTickets)
      Raffle.decide(open, DrawWinner(randomness, closesAt)) shouldBe Left(DrawRejected.NotAwaitingBeacon)
    }
  }

  "cancelling with the auction" should {

    val cancelledAt = closesAt.plusSeconds(30)

    def cancelled(raffle: Raffle): Raffle =
      Raffle.decide(raffle, CancelRaffle(op(80)), cancelledAt) match {
        case RaffleDecision.Accepted(event) => step(raffle, op(80), event)
        case other => fail(s"raffle not cancelled: $other")
      }

    "cancels open registration and a pool that waits for the beacon, keeping who held a registration" in {
      val registered = register(open, 1, 2)
      val terms = RaffleTerms(closesAt, seed, Quicknet.roundFor(closesAt))
      cancelled(registered).state shouldBe RaffleState.Cancelled(terms, Vector(person(1)), cancelledAt)
      cancelled(fixed(registered)).state shouldBe RaffleState.Cancelled(terms, Vector(person(1)), cancelledAt)
    }

    "takes no registration, fixes no pool and draws nothing once cancelled" in {
      val gone = cancelled(register(open, 1, 2))
      Raffle.decide(gone, Register(person(2), op(3)), before) shouldBe Left(RegistrationRejected.RegistrationClosed)
      Raffle.decide(gone, CancelRegistration(person(1), op(4)), before) shouldBe
        Left(RegistrationRejected.RegistrationClosed)
      Raffle.decide(gone, FixPool(Set.empty), closesAt) shouldBe Left(FixPoolRejected.NotOpen)
      Raffle.decide(gone, DrawWinner(randomness, closesAt.plusSeconds(61))) shouldBe
        Left(DrawRejected.NotAwaitingBeacon)
    }

    "keeps a draw that took place, an empty pool, a raffle not held and one never opened" in {
      val pool = fixed(register(open, 1, 2))
      val drawn = Raffle.decide(pool, DrawWinner(randomness, closesAt.plusSeconds(61))) match {
        case Right(event) => step(pool, op(91), event)
        case Left(rejected) => fail(s"draw refused: $rejected")
      }
      val notHeld = step(Raffle.initial, op(1), RaffleEvent.RaffleNotHeld(closesAt))
      List(drawn, fixed(open), notHeld, Raffle.initial).foreach { raffle =>
        Raffle.decide(raffle, CancelRaffle(op(80)), cancelledAt) shouldBe RaffleDecision.Unchanged
      }
    }

    "answers a repeated cancel with the original envelope and a new one without an event" in {
      val gone = cancelled(open)
      Raffle.decide(gone, CancelRaffle(op(80)), cancelledAt) shouldBe
        RaffleDecision.Repeated(gone.seen(op(80)))
      Raffle.decide(gone, CancelRaffle(op(81)), cancelledAt) shouldBe RaffleDecision.Unchanged
    }
  }
}
