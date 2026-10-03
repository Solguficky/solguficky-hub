package auction.publication

import auction.AuctionNode
import auction.entity.Initiator
import auction.entity.LotEntity
import auction.entity.UuidV7
import auction.lot.*
import auction.lot.LotFixtures.*
import auction.persistence.DatabaseSettings
import auction.persistence.JournalSchema
import auction.telemetry.ProjectionMetrics
import auction.telemetry.PublicationMetrics
import auction.testkit.NatsFixture
import auction.testkit.PostgresFixture
import auction.v1.auction_events as bus
import com.typesafe.config.ConfigFactory
import io.opentelemetry.sdk.metrics.SdkMeterProvider
import io.opentelemetry.sdk.testing.exporter.InMemoryMetricReader
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

import java.sql.DriverManager
import java.time.Clock
import java.util.UUID
import scala.concurrent.duration.*
import scala.jdk.CollectionConverters.*
import scala.util.Using

/**
 * Публикация фактов лота на настоящих PostgreSQL и NATS: узел собран так же, как в `Main`, и факты читаются из стрима
 * сервера, а не из заглушки публикатора. Рестарт, отказ шины и повтор — свойства базы и сервера, а не `ActorSystem`.
 */
final class LotPublicationIntegrationSpec
    extends AnyWordSpec
    with Matchers
    with PostgresFixture
    with NatsFixture
    with ScalaFutures
    with Eventually {

  implicit override val patienceConfig: PatienceConfig =
    PatienceConfig(timeout = Span(30, Seconds), interval = Span(100, Millis))

  private given Timeout = Timeout(20.seconds)

  private final case class Node(kit: ActorTestKit, sharding: ClusterSharding, reader: InMemoryMetricReader)

  private def withNode[A](database: DatabaseSettings, nats: Option[String])(use: Node => A): A = {
    val config = ConfigFactory
      .parseString("""pekko.projection.restart-backoff { min-backoff = 100ms, max-backoff = 300ms }""")
      .withFallback(nodeConfig(database))
    val kit = ActorTestKit(s"auction-publication-${UUID.randomUUID()}", config)
    try {
      val clock = Clock.systemUTC()
      val sharding = AuctionNode.join(kit.system)
      AuctionNode.registerLots(sharding, clock, UuidV7.generator(clock))
      val reader = InMemoryMetricReader.create()
      val meter = SdkMeterProvider.builder().registerMetricReader(reader).build().get("t")
      AuctionNode.startPublication(
        kit.system,
        ProjectionMetrics(meter, clock),
        PublicationMetrics(meter),
        PublicationSettings(nats, interval = 100.millis, batch = 100, ackTimeout = 1.second),
        5.seconds
      )
      use(Node(kit, sharding, reader))
    } finally kit.shutdownTestKit()
  }

  private def migrated(): DatabaseSettings = {
    val database = freshDatabase()
    JournalSchema.migrate(database)
    freshStream()
    database
  }

  private def lot(node: Node, id: UUID) = node.sharding.entityRefFor(LotEntity.TypeKey, id.toString)

  private val ids = UuidV7.generator(Clock.systemUTC())

  /** Лот в торгах: рождение, условия, открытие — три публичных факта. */
  private def tradingLot(node: Node, id: UUID = ids()): UUID = {
    val entity = lot(node, id)
    entity
      .ask[Either[DraftLotRejected, Envelope]](LotEntity.Draft(draftLot(opN = 1), Initiator.Scheduler, _))
      .futureValue
    entity
      .ask[Either[ScheduleLotRejected, Envelope]](LotEntity.Plan(scheduleLot(opN = 2), Initiator.Scheduler, _))
      .futureValue
    entity.ask[Either[OpenLotRejected, Envelope]](LotEntity.Open(openLot(opN = 3), Initiator.Scheduler, _)).futureValue
    id
  }

  private def bidOn(node: Node, id: UUID, who: Int, amount: Long): Either[PlaceBidRejected, Envelope] =
    lot(node, id)
      .ask[Either[PlaceBidRejected, Envelope]](
        LotEntity.Bid(PlaceBid(participant(who), money(amount), OpId(ids()), BidSource.Bot), Initiator.Scheduler, _)
      )
      .futureValue

  private def limitOn(node: Node, id: UUID, who: Int, max: Long): Either[SetProxyLimitRejected, Envelope] =
    lot(node, id)
      .ask[Either[SetProxyLimitRejected, Envelope]](
        LotEntity.SetLimit(SetProxyLimit(participant(who), money(max), OpId(ids())), Initiator.Scheduler, _)
      )
      .futureValue

  /** Факты стрима: subject, `Nats-Msg-Id` и тело, разобранное как `auction.v1.LotEvent`. */
  private def published(): List[(String, String, bus.LotEvent)] =
    streamMessages().map { message =>
      (message.getSubject, message.getHeaders.getFirst("Nats-Msg-Id"), bus.LotEvent.parseFrom(message.getData))
    }

  private def outboxSize(database: DatabaseSettings): Long =
    Using.resource(DriverManager.getConnection(database.url, database.user, database.password)) { connection =>
      Using.resource(connection.createStatement().executeQuery("SELECT COUNT(*) FROM lot_outbox")) { rows =>
        rows.next(); rows.getLong(1)
      }
    }

  private def pending(node: Node): Option[Long] =
    node.reader.collectAllMetrics().asScala.find(_.getName == "auction.publication.pending").flatMap {
      _.getLongGaugeData.getPoints.asScala.headOption.map(_.getValue)
    }

  "lot publication" should {

    "publish every public fact of a lot as Protobuf with the event id as the message id" in {
      val database = migrated()
      withNode(database, Some(natsUrl)) { node =>
        val id = tradingLot(node)
        bidOn(node, id, who = 1, amount = 110).isRight shouldBe true
        // Лимит второго участника перебивает лидера: приватный ProxyLimitSet и публичный производный BidPlaced.
        limitOn(node, id, who = 2, max = 200).isRight shouldBe true
        eventually(published() should have size 5)
        val facts = published()
        facts.map(_._1) shouldBe List(
          "events.auction.lot_drafted",
          "events.auction.lot_scheduled",
          "events.auction.lot_opened",
          "events.auction.bid_placed",
          "events.auction.bid_placed"
        )
        facts.foreach((_, messageId, event) => messageId shouldBe event.eventId)
        facts.map(_._3.version) shouldBe List(1L, 2L, 3L, 4L, 6L)
        facts.map(_._3.lotId).distinct shouldBe List(id.toString)
        facts.last._3.getBidPlaced.previousLeaderId shouldBe Some(participant(1).value.toString)
        facts.last._3.getBidPlaced.origin.isProxy shouldBe true
        eventually(outboxSize(database) shouldBe 0L)
      }
    }

    "not publish again after a restart what it already published" in {
      val database = migrated()
      val id = withNode(database, Some(natsUrl)) { node =>
        val id = tradingLot(node)
        eventually(published() should have size 3)
        id
      }
      withNode(database, Some(natsUrl)) { node =>
        bidOn(node, id, who = 1, amount = 110).isRight shouldBe true
        eventually(published() should have size 4)
        // Пауза дольше нескольких тиков: повтор, если бы он был, успел бы дойти до стрима.
        Thread.sleep(1000)
        published().map(_._3.version) shouldBe List(1L, 2L, 3L, 4L)
      }
    }

    "keep accepting bids while the bus is down and deliver the facts once it is back" in {
      val database = migrated()
      withNode(database, Some(natsUrl)) { node =>
        val id = tradingLot(node)
        eventually(published() should have size 3)
        pauseNats()
        try {
          bidOn(node, id, who = 1, amount = 110).isRight shouldBe true
          bidOn(node, id, who = 2, amount = 120).isRight shouldBe true
          eventually(outboxSize(database) shouldBe 2L)
          eventually(pending(node) shouldBe Some(2L))
        } finally resumeNats()
        eventually(published() should have size 5)
        eventually(outboxSize(database) shouldBe 0L)
        published().map(_._3.version) shouldBe List(1L, 2L, 3L, 4L, 5L)
      }
    }

    "hold the facts in the outbox while no bus address is configured" in {
      val database = migrated()
      withNode(database, None) { node =>
        tradingLot(node)
        eventually(outboxSize(database) shouldBe 3L)
        eventually(pending(node) shouldBe Some(3L))
      }
      withNode(database, Some(natsUrl)) { _ =>
        eventually(published() should have size 3)
        eventually(outboxSize(database) shouldBe 0L)
      }
    }

    "republish a fact under the same message id, and the stream drops the repeat" in {
      val database = migrated()
      withNode(database, Some(natsUrl)) { node =>
        tradingLot(node)
        eventually(published() should have size 3)
        // Падение между ack и удалением строки: строка того же факта снова в outbox.
        val (subject, messageId, event) = published().head
        Using.resource(DriverManager.getConnection(database.url, database.user, database.password)) { connection =>
          Using.resource(
            connection.prepareStatement("INSERT INTO lot_outbox (event_id, subject, payload) VALUES (?, ?, ?)")
          ) { statement =>
            statement.setObject(1, UUID.fromString(messageId))
            statement.setString(2, subject)
            statement.setBytes(3, event.toByteArray)
            statement.executeUpdate()
          }
        }
        eventually(outboxSize(database) shouldBe 0L)
        published() should have size 3
      }
    }
  }
}
