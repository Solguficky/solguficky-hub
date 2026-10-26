package auction.publication

import auction.lot.OpId
import auction.lot.ParticipantId
import auction.raffle.Raffle
import auction.raffle.RaffleEvent
import auction.raffle.RaffleJournal
import auction.raffle.RaffleView
import auction.raffle.Randomness
import auction.raffle.Seed
import auction.raffle.StoredRaffleEvent
import auction.v1.auction_events as bus
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

import java.time.Instant
import java.util.UUID

/** Итог розыгрыша на шине: повод, subject и снимок после жеребьёвки — без базы и без `ActorSystem`. */
final class RaffleFactsSpec extends AnyWordSpec with Matchers {

  private def uuid(n: Int): UUID = new UUID(0x0190f2a000007000L, 0x8000000000000000L | n.toLong)
  private def person(n: Int) = ParticipantId(uuid(100 + n))

  private val auctionId = uuid(20)
  private val closesAt = Instant.parse("2026-10-28T18:00:00Z")
  private val drawnAt = Instant.parse("2026-10-28T18:01:30Z")
  private val seed = Seed.fromHex("46fb9863b7178feb348aa621d658c5b41b848e398494830bac4837e0b0f539ae").get
  private val randomness =
    Randomness.fromHex("d7941e7b5bcaf8742bfc7136d38c5ab8274286629ffe43081dbda1f05d798300").get

  private def stored(event: RaffleEvent, n: Int): StoredRaffleEvent =
    RaffleJournal.store(uuid(n), OpId(uuid(200 + n)), if (n == 6) drawnAt else closesAt)(event)

  private val pool = Vector(person(3), person(1), person(2))

  private val prize = "кружка"

  private val journal = List(
    RaffleEvent.RaffleOpened(closesAt, seed, 9000L, Some(prize)),
    RaffleEvent.Registered(person(3)),
    RaffleEvent.Registered(person(1)),
    RaffleEvent.Registered(person(2)),
    RaffleEvent.PoolFixed(pool),
    RaffleEvent.RaffleDrawn(randomness, drawnAt)
  ).zipWithIndex.map((event, index) => (index + 1).toLong -> stored(event, index + 1))

  /** Факт каждого события журнала, как его кладёт проекция публикации: розыгрыш — свёрнутый сразу после события. */
  private def facts(events: List[(Long, StoredRaffleEvent)]): List[(Raffle, Option[Fact])] =
    events
      .foldLeft((Raffle.initial, List.empty[(Raffle, Option[Fact])])) { case ((raffle, out), (sequence, event)) =>
        val after = Raffle.apply(raffle, RaffleJournal.envelope(sequence, event))
        (after, out :+ (after -> RaffleFacts.fact(auctionId, sequence, event, after)))
      }
      ._2

  private def message(fact: Option[Fact]): bus.RaffleEvent =
    bus.RaffleEvent.parseFrom(fact.getOrElse(fail("expected a published fact")).payload)

  "raffle facts" should {

    "publish only the draw, on the subject named after its oneof branch" in {
      val published = facts(journal).map(_._2)
      published.map(_.map(_.subject)) shouldBe List(None, None, None, None, None, Some("events.auction.raffle_drawn"))
      message(published.last).occasion.isRaffleDrawn shouldBe true
    }

    "carry the envelope of the journal row: event_id, the auction, the position in the raffle journal and the time" in {
      val body = message(facts(journal).last._2)
      body.eventId shouldBe uuid(6).toString
      body.raffleId shouldBe auctionId.toString
      body.version shouldBe 6L
      body.occurredAt shouldBe "2026-10-28T18:01:30Z"
    }

    "name the ticket holders in ticket order and the winning ticket the result screen shows" in {
      val (after, fact) = facts(journal).last
      val state = message(fact).state.getOrElse(fail("expected a state"))
      state.tickets shouldBe pool.map(_.value.toString)
      val shown = RaffleView
        .of(after, person(1), drawnAt, Map.empty)
        .flatMap(_.reveal)
        .flatMap(_.draw)
        .map(_.winningTicket)
      Some(state.winningTicket) shouldBe shown
      state.winningTicket should (be >= 1 and be <= pool.size)
      // Приз едет фактом (PER-649): победитель узнаёт, что получил.
      state.rafflePrize shouldBe Some(prize)
    }

    // Приза нет — поля в факте нет: весть победителя остаётся прежней.
    "publish a drawn raffle without a prize leaving its prize unset" in {
      val plain = List(
        RaffleEvent.RaffleOpened(closesAt, seed, 9000L),
        RaffleEvent.Registered(person(1)),
        RaffleEvent.PoolFixed(Vector(person(1))),
        RaffleEvent.RaffleDrawn(randomness, drawnAt)
      ).zipWithIndex.map((event, index) => (index + 1).toLong -> stored(event, index + 1))
      val state = message(facts(plain).last._2).state.getOrElse(fail("expected a state"))
      state.rafflePrize shouldBe None
    }

    "publish the winner an administrator assigned by hand as the same raffle_drawn, once and without the pool fix" in {
      val byHand = List(
        RaffleEvent.RaffleOpened(closesAt, seed, 9000L, Some(prize)),
        RaffleEvent.Registered(person(3)),
        RaffleEvent.Registered(person(1)),
        RaffleEvent.Registered(person(2)),
        RaffleEvent.PoolFixed(pool, byHand = true),
        RaffleEvent.WinnerAssigned(2, drawnAt)
      ).zipWithIndex.map((event, index) => (index + 1).toLong -> stored(event, index + 1))
      val published = facts(byHand).map(_._2)
      published.map(_.map(_.subject)) shouldBe List(None, None, None, None, None, Some("events.auction.raffle_drawn"))
      val body = message(published.last)
      body.occasion.isRaffleDrawn shouldBe true
      body.state.map(state => (state.tickets, state.winningTicket, state.rafflePrize)) shouldBe
        Some((pool.map(_.value.toString), 2, Some(prize)))
    }

    "publish the prize the administrator changed before the result, and nothing for the change itself" in {
      val changed = List(
        RaffleEvent.RaffleOpened(closesAt, seed, 9000L, Some(prize)),
        RaffleEvent.Registered(person(3)),
        RaffleEvent.Registered(person(1)),
        RaffleEvent.Registered(person(2)),
        RaffleEvent.PoolFixed(pool, byHand = true),
        RaffleEvent.PrizeChanged("кружка и брелок"),
        RaffleEvent.WinnerAssigned(2, drawnAt)
      ).zipWithIndex.map((event, index) => (index + 1).toLong -> stored(event, index + 1))
      val published = facts(changed).map(_._2)
      published.init.forall(_.isEmpty) shouldBe true
      published.last.map(_.subject) shouldBe Some("events.auction.raffle_drawn")
      message(published.last).state.flatMap(_.rafflePrize) shouldBe Some("кружка и брелок")
    }

    "publish nothing for a raffle that is not held" in {
      val notHeld = List(1L -> stored(RaffleEvent.RaffleNotHeld(closesAt), 1))
      facts(notHeld).map(_._2) shouldBe List(None)
    }

    "publish nothing for an empty pool, which is never drawn" in {
      val empty =
        List(RaffleEvent.RaffleOpened(closesAt, seed, 9000L), RaffleEvent.PoolFixed(Vector.empty)).zipWithIndex
          .map((event, index) => (index + 1).toLong -> stored(event, index + 1))
      facts(empty).map(_._2) shouldBe List(None, None)
    }

    "publish nothing for a cancelled raffle" in {
      val cancelled = List(
        RaffleEvent.RaffleOpened(closesAt, seed, 9000L),
        RaffleEvent.Registered(person(1)),
        RaffleEvent.RaffleCancelled(closesAt)
      ).zipWithIndex.map((event, index) => (index + 1).toLong -> stored(event, index + 1))
      facts(cancelled).map(_._2) shouldBe List(None, None, None)
    }
  }
}
