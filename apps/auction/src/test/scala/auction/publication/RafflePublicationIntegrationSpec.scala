package auction.publication

import auction.AuctionNode
import auction.entity.UuidV7
import auction.lot.AuctionId
import auction.lot.OpId
import auction.lot.ParticipantId
import auction.persistence.DatabaseSettings
import auction.persistence.JournalSchema
import auction.raffle.Beacon
import auction.raffle.Draw
import auction.raffle.OpenRaffle
import auction.raffle.Raffle
import auction.raffle.RaffleEntity
import auction.raffle.RegistrationRejected
import auction.raffle.RaffleState
import auction.raffle.RaffleTags
import auction.raffle.RaffleTickets
import auction.raffle.Quicknet
import auction.raffle.Randomness
import auction.raffle.Register
import auction.telemetry.ProjectionMetrics
import auction.telemetry.PublicationMetrics
import auction.testkit.PostgresFixture
import auction.v1.auction_events as bus
import io.opentelemetry.sdk.metrics.SdkMeterProvider
import io.opentelemetry.sdk.testing.exporter.InMemoryMetricReader
import org.apache.pekko.Done
import org.apache.pekko.actor.testkit.typed.scaladsl.ActorTestKit
import org.apache.pekko.cluster.sharding.typed.scaladsl.ClusterSharding
import org.apache.pekko.util.Timeout
import org.scalatest.concurrent.Eventually
import org.scalatest.concurrent.ScalaFutures
import org.scalatest.matchers.should.Matchers
import org.scalatest.time.Millis
import org.scalatest.time.Seconds
import org.scalatest.time.Span
import org.scalatest.wordspec.AnyWordSpec

import java.time.Clock
import java.time.Instant
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import scala.concurrent.Future
import scala.concurrent.duration.*
import scala.util.Using

/**
 * Публикация итога розыгрыша на настоящем PostgreSQL (PER-620): узел собран так же, как в `Main`, розыгрыш идёт своими
 * таймерами по настоящим часам, а факт читается из `lot_outbox` — релей без адреса шины не стартует, и строка остаётся.
 * Identity, маяк и таблица имён — подмены портов.
 */
final class RafflePublicationIntegrationSpec
    extends AnyWordSpec
    with Matchers
    with PostgresFixture
    with ScalaFutures
    with Eventually {

  implicit override val patienceConfig: PatienceConfig =
    PatienceConfig(timeout = Span(30, Seconds), interval = Span(100, Millis))

  private given Timeout = Timeout(20.seconds)

  private val randomness =
    Randomness.fromHex("d7941e7b5bcaf8742bfc7136d38c5ab8274286629ffe43081dbda1f05d798300").get

  private object NoNames extends RaffleTickets {
    def record(auction: AuctionId, tickets: Vector[ParticipantId]): Future[Unit] = Future.unit
    def names(auction: AuctionId): Future[Map[Int, String]] = Future.successful(Map.empty)
    def expireAt(auction: AuctionId, at: Instant): Future[Unit] = Future.unit
  }

  /** Маяк, который отдаёт значение, только когда тест его выпустил. */
  private final class HeldBeacon(released: Boolean) extends Beacon {
    val open = new AtomicBoolean(released)
    def randomness(round: Long): Future[Option[Randomness]] =
      Future.successful(Option.when(open.get)(RafflePublicationIntegrationSpec.this.randomness))
  }

  /**
   * Часы розыгрыша, которые тест переводит вперёд: раунд маяка наступает через минуту после закрытия
   * (`Quicknet.Margin`), и ждать его по настоящим часам — минута на тест. Таймеры entity взводятся по разнице с этими
   * часами, поэтому переведённые часы делают просроченное сразу.
   */
  private final class MovableClock extends Clock {
    @volatile var shift: java.time.Duration = java.time.Duration.ZERO
    override def instant(): Instant = Instant.now().plus(shift)
    override def getZone: java.time.ZoneId = java.time.ZoneOffset.UTC
    override def withZone(zone: java.time.ZoneId): Clock = this
  }

  /** Переводит часы за раунд маяка розыгрыша, который закрывается в `closesAt`. */
  private def pastBeaconRound(clock: MovableClock, closesAt: Instant): Unit =
    clock.shift =
      java.time.Duration.between(Instant.now(), Quicknet.roundAt(Quicknet.roundFor(closesAt)).plusSeconds(1))

  private def withNode[A](database: DatabaseSettings, beacon: Beacon, clock: MovableClock = new MovableClock)(
      use: ClusterSharding => A
  ): A = {
    val kit = ActorTestKit(s"raffle-publication-${UUID.randomUUID()}", nodeConfig(database))
    try {
      val sharding = AuctionNode.join(kit.system)
      AuctionNode.registerRaffles(
        kit.system,
        sharding,
        clock,
        UuidV7.generator(clock),
        _ => Future.successful(true),
        beacon,
        NoNames,
        RaffleEntity.Settings(5.seconds, 200.millis, java.time.Duration.ofDays(30))
      )
      val meter = SdkMeterProvider.builder().registerMetricReader(InMemoryMetricReader.create()).build().get("t")
      AuctionNode.startPublication(
        kit.system,
        ProjectionMetrics(meter, Clock.systemUTC()),
        PublicationMetrics(meter),
        PublicationSettings(None, interval = 100.millis, batch = 100, ackTimeout = 1.second),
        5.seconds
      )
      use(sharding)
    } finally kit.shutdownTestKit()
  }

  private def migrated(): DatabaseSettings = {
    val database = freshDatabase()
    JournalSchema.migrate(database)
    database
  }

  private val ids = UuidV7.generator(Clock.systemUTC())

  private def raffle(sharding: ClusterSharding, auction: UUID) =
    sharding.entityRefFor(RaffleEntity.TypeKey, auction.toString)

  private def open(sharding: ClusterSharding, auction: UUID, closesAt: Instant): Unit =
    raffle(sharding, auction).ask[Done](RaffleEntity.Open(OpenRaffle(closesAt), _)).futureValue

  private def register(sharding: ClusterSharding, auction: UUID, who: ParticipantId): Unit =
    raffle(sharding, auction)
      .ask[Either[RegistrationRejected, Raffle]](RaffleEntity.Enter(Register(who, OpId(ids())), _))
      .futureValue
      .isRight shouldBe true

  private def state(sharding: ClusterSharding, auction: UUID): RaffleState =
    raffle(sharding, auction).ask[Raffle](RaffleEntity.Get(_)).futureValue.state

  /** Факты `raffle_drawn` в outbox: тело, разобранное как `auction.v1.RaffleEvent`. */
  private def published(database: DatabaseSettings): List[bus.RaffleEvent] =
    withConnection(database) { connection =>
      Using.resource(
        connection.prepareStatement("SELECT subject, payload FROM lot_outbox ORDER BY position")
      ) { statement =>
        Using.resource(statement.executeQuery()) { rows =>
          Iterator
            .continually(rows)
            .takeWhile(_.next())
            .map(row => row.getString(1) -> row.getBytes(2))
            .toList
            .collect { case ("events.auction.raffle_drawn", payload) => bus.RaffleEvent.parseFrom(payload) }
        }
      }
    }

  private def people(n: Int): Vector[ParticipantId] = Vector.fill(n)(ParticipantId(ids()))

  "the raffle publication" should {

    "publish one raffle_drawn with the pool in ticket order and the winning ticket, and no second one after a restart" in {
      val database = migrated()
      val auction = UUID.randomUUID()
      val pool = people(3)
      val clock = new MovableClock
      val closesAt = Instant.now().plusSeconds(8)
      val drawn = withNode(database, new HeldBeacon(released = true), clock) { sharding =>
        open(sharding, auction, closesAt)
        pool.foreach(register(sharding, auction, _))
        pastBeaconRound(clock, closesAt)
        eventually(published(database) should have size 1)
        state(sharding, auction)
      }
      val fact = published(database).head
      fact.raffleId shouldBe auction.toString
      fact.occasion.isRaffleDrawn shouldBe true
      val body = fact.state.getOrElse(fail("expected a state"))
      body.tickets shouldBe pool.map(_.value.toString)
      drawn match {
        case RaffleState.Drawn(terms, tickets, value, _) =>
          body.winningTicket shouldBe Draw.winner(terms.seed, tickets.size, value)
        case other => fail(s"expected a drawn raffle, got $other")
      }

      withNode(database, new HeldBeacon(released = true), clock) { sharding =>
        state(sharding, auction) shouldBe a[RaffleState.Drawn]
        Thread.sleep(2000)
        published(database) should have size 1
      }
    }

    "publish the draw of a raffle whose earlier journal rows carry no tag, as rows written before tagging do" in {
      val database = migrated()
      val auction = UUID.randomUUID()
      val pool = people(2)
      val beacon = new HeldBeacon(released = false)
      val clock = new MovableClock
      val closesAt = Instant.now().plusSeconds(8)
      withNode(database, beacon, clock) { sharding =>
        open(sharding, auction, closesAt)
        pool.foreach(register(sharding, auction, _))
        pastBeaconRound(clock, closesAt)
        eventually(state(sharding, auction) shouldBe a[RaffleState.Fixed])
        withConnection(database) { connection =>
          Using.resource(
            connection.prepareStatement(
              "DELETE FROM event_tag WHERE tag = ANY(?) AND event_id IN (SELECT ordering FROM event_journal WHERE persistence_id = ?)"
            )
          ) { statement =>
            statement.setArray(1, connection.createArrayOf("varchar", RaffleTags.all.toArray[AnyRef]))
            statement.setString(2, s"${RaffleEntity.TypeKey.name}|$auction")
            statement.executeUpdate() should be > 0
          }
        }
        beacon.open.set(true)
        eventually(published(database) should have size 1)
      }
      published(database).head.state.map(_.tickets) shouldBe Some(pool.map(_.value.toString))
    }

    "publish nothing for an empty pool and for a raffle that is not held" in {
      val database = migrated()
      val noTickets = UUID.randomUUID()
      val notHeld = UUID.randomUUID()
      withNode(database, new HeldBeacon(released = true)) { sharding =>
        open(sharding, noTickets, Instant.now().plusSeconds(1))
        open(sharding, notHeld, Instant.now().minusSeconds(1))
        state(sharding, notHeld) shouldBe a[RaffleState.NotHeld]
        eventually(state(sharding, noTickets) shouldBe a[RaffleState.Fixed])
        Thread.sleep(2000)
        published(database) shouldBe empty
      }
    }
  }
}
