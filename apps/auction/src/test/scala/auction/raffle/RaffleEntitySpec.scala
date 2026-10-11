package auction.raffle

import auction.entity.JournalFixtures.localConfig
import auction.lot.AuctionId
import auction.lot.OpId
import auction.lot.ParticipantId
import org.apache.pekko.Done
import org.apache.pekko.actor.testkit.typed.scaladsl.ActorTestKit
import org.apache.pekko.persistence.testkit.scaladsl.EventSourcedBehaviorTestKit
import org.apache.pekko.persistence.testkit.scaladsl.EventSourcedBehaviorTestKit.SerializationSettings
import org.scalatest.BeforeAndAfterAll
import org.scalatest.concurrent.Eventually
import org.scalatest.matchers.should.Matchers
import org.scalatest.time.Millis
import org.scalatest.time.Seconds
import org.scalatest.time.Span
import org.scalatest.wordspec.AnyWordSpec

import java.time.Clock
import java.time.Instant
import java.time.ZoneId
import java.time.ZoneOffset
import java.util.UUID
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference
import scala.concurrent.Future
import scala.concurrent.duration.*

/**
 * Entity розыгрыша на журнале в памяти: шаги без человека — закрытие, проверка права, снимок имён, опрос маяка и
 * жеребьёвка — идут её собственными таймерами по часам, которые тест переставляет. Identity, маяк и таблица имён —
 * подмены портов.
 */
final class RaffleEntitySpec extends AnyWordSpec with Matchers with BeforeAndAfterAll with Eventually {

  implicit override val patienceConfig: PatienceConfig =
    PatienceConfig(timeout = Span(5, Seconds), interval = Span(20, Millis))

  private val kit = ActorTestKit("raffle-entity", EventSourcedBehaviorTestKit.config.withFallback(localConfig))

  override protected def afterAll(): Unit = kit.shutdownTestKit()

  private type Kit = EventSourcedBehaviorTestKit[RaffleEntity.Command, StoredRaffleEvent, RaffleEntity.State]

  private final class MovableClock(@volatile var now: Instant) extends Clock {
    override def instant(): Instant = now
    override def getZone: ZoneId = ZoneOffset.UTC
    override def withZone(zone: ZoneId): Clock = this
  }

  /** Таблица имён в памяти: что записано и на какой момент назначено стирание. */
  private final class Tickets extends RaffleTickets {
    val recorded = new AtomicReference(Vector.empty[ParticipantId])
    val expiry = new AtomicReference(Option.empty[Instant])
    def record(auction: AuctionId, tickets: Vector[ParticipantId]): Future[Unit] = {
      recorded.set(tickets)
      Future.unit
    }
    def names(auction: AuctionId): Future[Map[Int, String]] = Future.successful(Map.empty)
    def expireAt(auction: AuctionId, at: Instant): Future[Unit] = {
      expiry.compareAndSet(None, Some(at))
      Future.unit
    }
  }

  private def uuid(n: Int): UUID = new UUID(0x0190f2a000007000L, 0x8000000000000000L | n.toLong)
  private def person(n: Int) = ParticipantId(uuid(100 + n))

  private val auctionId = "83a6d0b2-84ed-5444-a77b-dd0338dc84a4"
  private val closesAt = Instant.parse("2026-10-28T18:00:00Z")
  private val seed = Seed.fromHex("46fb9863b7178feb348aa621d658c5b41b848e398494830bac4837e0b0f539ae").get
  private val randomness =
    Randomness.fromHex("d7941e7b5bcaf8742bfc7136d38c5ab8274286629ffe43081dbda1f05d798300").get
  private val settings = RaffleEntity.Settings(30.seconds, 50.millis, java.time.Duration.ofDays(30))

  private def entity(
      clock: Clock,
      access: RaffleAccess,
      beacon: Beacon,
      tickets: Tickets
  ): Kit = {
    val ids = new AtomicLong(0)
    EventSourcedBehaviorTestKit(
      kit.system,
      RaffleEntity(
        auctionId,
        clock,
        () => uuid(ids.incrementAndGet().toInt),
        () => seed,
        access,
        beacon,
        tickets,
        settings
      ),
      SerializationSettings.enabled.withVerifyEquality(true).withVerifyCommands(false).withVerifyState(false)
    )
  }

  private def register(raffle: Kit, who: Int, opN: Int) =
    raffle.runCommand[Either[RegistrationRejected, Raffle]](
      RaffleEntity.Enter(Register(person(who), OpId(uuid(1000 + opN))), _)
    )

  "the raffle entity" should {

    "opens, takes registrations, fixes the pool without those who lost the right and draws from the beacon" in {
      val clock = new MovableClock(closesAt.minusSeconds(3600))
      val tickets = new Tickets
      val access: RaffleAccess = participant => Future.successful(participant != person(2))
      val beaconValue = new AtomicReference(Option.empty[Randomness])
      val raffle = entity(clock, access, _ => Future.successful(beaconValue.get), tickets)

      raffle.runCommand[Done](RaffleEntity.Open(OpenRaffle(closesAt), _)).reply shouldBe Done
      for (who <- 1 to 3) register(raffle, who, who).reply.isRight shouldBe true
      register(raffle, 1, 9).reply.map(_.state) shouldBe Right(
        RaffleState.Open(RaffleTerms(closesAt, seed, Quicknet.roundFor(closesAt)), Vector(1, 2, 3).map(person))
      )

      clock.now = closesAt.plusSeconds(1)
      register(raffle, 4, 4).reply shouldBe Left(RegistrationRejected.RegistrationClosed)
      raffle.runCommand(RaffleEntity.CloseDue)
      eventually {
        raffle.getState().raffle.state shouldBe a[RaffleState.Fixed]
      }
      raffle.getState().raffle.state match {
        case RaffleState.Fixed(_, fixed) => fixed shouldBe Vector(person(1), person(3))
        case other => fail(s"unexpected $other")
      }
      eventually(tickets.recorded.get shouldBe Vector(person(1), person(3)))

      // Маяк молчит: жеребьёвка ждёт и переживает рестарт, запасного пути нет.
      clock.now = Quicknet.roundAt(Quicknet.roundFor(closesAt)).plusSeconds(1)
      raffle.runCommand(RaffleEntity.PollBeacon)
      Thread.sleep(200)
      raffle.getState().raffle.state shouldBe a[RaffleState.Fixed]
      raffle.restart()
      beaconValue.set(Some(randomness))
      eventually {
        raffle.getState().raffle.state shouldBe a[RaffleState.Drawn]
      }
      val drawnAt = raffle.getState().raffle.state match {
        case RaffleState.Drawn(_, fixed, value, at) =>
          value shouldBe randomness
          Draw.winner(seed, fixed.size, value) shouldBe Draw.winner(seed, 2, randomness)
          at
        case other => fail(s"unexpected $other")
      }
      eventually(tickets.expiry.get shouldBe Some(drawnAt.plus(java.time.Duration.ofDays(30))))
    }

    "keeps a candidate in the pool when Identity does not answer before the window ends" in {
      val clock = new MovableClock(closesAt.minusSeconds(60))
      val raffle = entity(
        clock,
        _ => Future.failed(new RuntimeException("identity is down")),
        _ => Future.successful(None),
        new Tickets
      )
      raffle.runCommand[Done](RaffleEntity.Open(OpenRaffle(closesAt), _))
      register(raffle, 1, 1)
      clock.now = closesAt.plusSeconds(31)
      raffle.runCommand(RaffleEntity.CloseDue)
      eventually {
        raffle.getState().raffle.state match {
          case RaffleState.Fixed(_, fixed) => fixed shouldBe Vector(person(1))
          case other => fail(s"unexpected $other")
        }
      }
    }

    "does not hold a raffle opened no earlier than closing and answers registrations that it is closed" in {
      val clock = new MovableClock(closesAt)
      val raffle = entity(clock, _ => Future.successful(true), _ => Future.successful(None), new Tickets)
      raffle.runCommand[Done](RaffleEntity.Open(OpenRaffle(closesAt), _))
      raffle.getState().raffle.state shouldBe RaffleState.NotHeld(closesAt)
      register(raffle, 1, 1).reply shouldBe Left(RegistrationRejected.RegistrationClosed)
    }

    "keeps every candidate when the closing comes after the beacon round, whatever Identity would answer" in {
      val clock = new MovableClock(closesAt.minusSeconds(60))
      val raffle = entity(clock, _ => Future.successful(false), _ => Future.successful(None), new Tickets)
      raffle.runCommand[Done](RaffleEntity.Open(OpenRaffle(closesAt), _))
      register(raffle, 1, 1)
      clock.now = Quicknet.roundAt(Quicknet.roundFor(closesAt)).plusSeconds(5)
      raffle.runCommand(RaffleEntity.CloseDue)
      eventually {
        raffle.getState().raffle.state match {
          case RaffleState.Fixed(_, fixed) => fixed shouldBe Vector(person(1))
          case other => fail(s"unexpected $other")
        }
      }
    }

    "fixes an empty pool without asking the beacon" in {
      val clock = new MovableClock(closesAt.minusSeconds(60))
      val raffle = entity(
        clock,
        _ => Future.successful(true),
        _ => Future.failed(new AssertionError("an empty pool must not ask the beacon")),
        new Tickets
      )
      raffle.runCommand[Done](RaffleEntity.Open(OpenRaffle(closesAt), _))
      clock.now = closesAt
      raffle.runCommand(RaffleEntity.CloseDue)
      eventually(raffle.getState().raffle.state shouldBe a[RaffleState.Fixed])
      raffle.runCommand(RaffleEntity.PollBeacon)
      raffle.getState().raffle.state shouldBe a[RaffleState.Fixed]
    }
  }
}
