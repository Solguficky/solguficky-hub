package auction.projection

import auction.AuctionNode
import auction.entity.Initiator
import auction.entity.LotEntity
import auction.entity.LotJournal
import auction.entity.LotTags
import auction.entity.UuidV7
import auction.lot.*
import auction.lot.LotFixtures.*
import auction.persistence.DatabaseSettings
import auction.persistence.JournalSchema
import auction.telemetry.ProjectionMetrics
import auction.testkit.PostgresFixture
import com.typesafe.config.ConfigFactory
import io.opentelemetry.sdk.metrics.SdkMeterProvider
import io.opentelemetry.sdk.testing.exporter.InMemoryMetricReader
import org.apache.pekko.actor.testkit.typed.scaladsl.ActorTestKit
import org.apache.pekko.cluster.sharding.typed.scaladsl.ClusterSharding
import org.apache.pekko.projection.jdbc.JdbcSession
import org.apache.pekko.projection.jdbc.scaladsl.JdbcHandler
import org.apache.pekko.util.Timeout
import org.scalatest.concurrent.Eventually
import org.scalatest.concurrent.ScalaFutures
import org.scalatest.matchers.should.Matchers
import org.scalatest.time.Millis
import org.scalatest.time.Seconds
import org.scalatest.time.Span
import org.scalatest.wordspec.AnyWordSpec

import java.sql.Connection
import java.time.Clock
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import scala.concurrent.ExecutionContext
import scala.concurrent.Future
import scala.concurrent.duration.*
import scala.jdk.CollectionConverters.*
import scala.util.Using

/**
 * Проекция лота на настоящем PostgreSQL: offset и read model в одной базе, узел собран так же, как в `Main`, только
 * обработчик обёрнут счётчиком или отказом. In-memory журнал тут ничего бы не доказал: offset и рестарт — свойства
 * базы, а не `ActorSystem`.
 */
final class LotProjectionIntegrationSpec
    extends AnyWordSpec
    with Matchers
    with PostgresFixture
    with ScalaFutures
    with Eventually {

  implicit override val patienceConfig: PatienceConfig =
    PatienceConfig(timeout = Span(30, Seconds), interval = Span(100, Millis))

  private given Timeout = Timeout(20.seconds)

  /** Обработчик-обёртка: считает вызовы и может отказать после того, как рабочий обработчик уже записал строки. */
  private final class Probe(working: () => LotViewHandler) {
    val calls = new AtomicInteger(0)
    val failNext = new AtomicInteger(0)
    val failing = new AtomicBoolean(false)
    val failed = new AtomicBoolean(false)

    def handler(): JdbcHandler[LotProjection.Envelope, JdbcSession] = {
      val inner = working()
      JdbcHandler { (session: JdbcSession, envelope: LotProjection.Envelope) =>
        if (failing.get()) throw new IllegalStateException("handler is down")
        calls.incrementAndGet()
        inner.process(session, envelope)
        if (failNext.get() > 0 && failNext.decrementAndGet() == 0) {
          failed.set(true)
          throw new IllegalStateException("handler failed after its writes")
        }
      }
    }
  }

  private final case class Node(
      kit: ActorTestKit,
      sharding: ClusterSharding,
      probe: Probe,
      reader: InMemoryMetricReader
  )

  private def withNode[A](database: DatabaseSettings)(use: Node => A): A = {
    val config = ConfigFactory
      .parseString("""pekko.projection.restart-backoff { min-backoff = 100ms, max-backoff = 300ms }""")
      .withFallback(nodeConfig(database))
    val kit = ActorTestKit(s"auction-projection-${UUID.randomUUID()}", config)
    try {
      val clock = Clock.systemUTC()
      val sharding = AuctionNode.join(kit.system)
      AuctionNode.registerLots(sharding, clock, UuidV7.generator(clock))
      val reader = InMemoryMetricReader.create()
      val metrics = ProjectionMetrics(SdkMeterProvider.builder().registerMetricReader(reader).build().get("t"), clock)
      val probe = Probe(() => LotViewHandler(kit.system))
      LotProjection.init(kit.system, metrics, () => probe.handler())
      metrics.watchBacklog(LotProjection.Name, LotProjection.backlog(kit.system, 5.seconds))
      use(Node(kit, sharding, probe, reader))
    } finally kit.shutdownTestKit()
  }

  private def migrated(): DatabaseSettings = {
    val database = freshDatabase()
    JournalSchema.migrate(database)
    database
  }

  private def lot(node: Node, id: UUID) = node.sharding.entityRefFor(LotEntity.TypeKey, id.toString)

  private val ids = UuidV7.generator(Clock.systemUTC())

  /** Лот в торгах: рождение, условия со стартовой ценой 100 и шагом 10, открытие — три события. */
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

  private def bidOn(node: Node, id: UUID, who: Int, amount: Long): Future[Either[PlaceBidRejected, Envelope]] =
    lot(node, id).ask[Either[PlaceBidRejected, Envelope]](
      LotEntity.Bid(PlaceBid(participant(who), money(amount), OpId(ids()), BidSource.Bot), Initiator.Scheduler, _)
    )

  private def limitOn(node: Node, id: UUID, who: Int, max: Long): Either[SetProxyLimitRejected, Envelope] =
    lot(node, id)
      .ask[Either[SetProxyLimitRejected, Envelope]](
        LotEntity.SetLimit(SetProxyLimit(participant(who), money(max), OpId(ids())), Initiator.Scheduler, _)
      )
      .futureValue

  private def query[A](database: DatabaseSettings, sql: String, params: Any*)(read: java.sql.ResultSet => A): List[A] =
    withConnection(database) { connection =>
      Using.resource(connection.prepareStatement(sql)) { statement =>
        params.zipWithIndex.foreach((value, index) => statement.setObject(index + 1, value))
        Using.resource(statement.executeQuery()) { rows =>
          Iterator.continually(rows).takeWhile(_.next()).map(read).toList
        }
      }
    }

  private def version(database: DatabaseSettings, id: UUID): Option[Long] =
    query(database, "SELECT version FROM lot_view WHERE lot_id = ?", id)(_.getLong(1)).headOption

  private def journalVersion(database: DatabaseSettings, id: UUID): Long =
    query(database, "SELECT MAX(sequence_number) FROM event_journal WHERE persistence_id = ?", s"lot|$id")(
      _.getLong(1)
    ).head

  private def bidRows(database: DatabaseSettings, id: UUID): Int =
    query(database, "SELECT COUNT(*) FROM lot_bid WHERE lot_id = ?", id)(_.getInt(1)).head

  /**
   * Последнее событие лота, которое offset его тега уже покрыл: read model не может быть впереди него. Offset тега —
   * это `ordering` строки журнала, поэтому событие покрыто, если его `ordering` не больше offset.
   */
  private def coveredVersion(connection: Connection, id: UUID): Long =
    Using.resource(
      connection.prepareStatement(
        """SELECT COALESCE(MAX(j.sequence_number), 0) FROM event_journal j
          |JOIN event_tag t ON t.event_id = j.ordering
          |JOIN pekko_projection_offset_store o ON o.projection_name = 'lot-view' AND o.projection_key = t.tag
          |WHERE j.persistence_id = ? AND j.ordering <= o.current_offset::bigint""".stripMargin
      )
    ) { statement =>
      statement.setString(1, s"lot|$id")
      Using.resource(statement.executeQuery()) { rows =>
        rows.next(); rows.getLong(1)
      }
    }

  private def readModelAndOffset(database: DatabaseSettings, id: UUID): (Long, Long) =
    withConnection(database) { connection =>
      // Одно соединение и одна транзакция с REPEATABLE READ: обе величины из одного снимка базы.
      connection.setAutoCommit(false)
      connection.setTransactionIsolation(Connection.TRANSACTION_REPEATABLE_READ)
      val view = Using.resource(connection.prepareStatement("SELECT version FROM lot_view WHERE lot_id = ?")) {
        statement =>
          statement.setObject(1, id)
          Using.resource(statement.executeQuery())(rows => if (rows.next()) rows.getLong(1) else 0L)
      }
      val covered = coveredVersion(connection, id)
      connection.commit()
      (view, covered)
    }

  private def eventsBehind(node: Node): Map[String, Long] =
    node.reader
      .collectAllMetrics()
      .asScala
      .find(_.getName == "auction.projection.events_behind")
      .map(
        _.getLongGaugeData.getPoints.asScala
          .map { point =>
            point.getAttributes.asMap.asScala.collectFirst {
              case (key, value) if key.getKey == "tag" => value.toString
            }.get ->
              point.getValue
          }
          .toMap
      )
      .getOrElse(Map.empty)

  "lot projection" should {

    "tags every event of a lot with the tag of its slice in the journal" in {
      val database = migrated()
      val id = UUID.fromString("01926f3c-8b7a-7cde-8f00-000000000001")
      withNode(database) { node =>
        tradingLot(node, id)
        val tags = query(
          database,
          "SELECT t.tag FROM event_tag t JOIN event_journal j ON j.ordering = t.event_id WHERE j.persistence_id = ?",
          s"lot|$id"
        )(_.getString(1))
        // Литерал, а не LotTags: тест падает при любой смене формулы, которая переписала бы уже записанные строки.
        tags shouldBe List("lot-1", "lot-1", "lot-1")
      }
    }

    "continues after a restart from the stored offset without replaying the journal (Т-06а)" in {
      val database = migrated()
      val id = withNode(database) { node =>
        val id = tradingLot(node)
        bidOn(node, id, who = 1, amount = 110).futureValue.isRight shouldBe true
        bidOn(node, id, who = 2, amount = 120).futureValue.isRight shouldBe true
        eventually(version(database, id) shouldBe Some(5L))
        node.probe.calls.get() shouldBe 5
        id
      }
      withNode(database) { node =>
        bidOn(node, id, who = 1, amount = 130).futureValue.isRight shouldBe true
        eventually(version(database, id) shouldBe Some(6L))
        node.probe.calls.get() shouldBe 1
      }
      bidRows(database, id) shouldBe 3

      // Отрицательный контроль: без offset тот же узел переигрывает журнал целиком, и счётчик это видит. Строки
      // хронологии при этом не дублируются: обработчик пропускает уже применённые события по версии.
      withConnection(database)(_.createStatement().execute("DELETE FROM pekko_projection_offset_store"))
      withNode(database) { node =>
        eventually(node.probe.calls.get() shouldBe 6)
        version(database, id) shouldBe Some(6L)
      }
      bidRows(database, id) shouldBe 3
    }

    "never leaves the read model ahead of the offset when the handler fails inside a transaction of two events" in {
      val database = migrated()
      withNode(database) { node =>
        val id = tradingLot(node)
        bidOn(node, id, who = 1, amount = 110).futureValue.isRight shouldBe true
        eventually(version(database, id) shouldBe Some(4L))
        // Лимит второго участника перебивает лидера: ProxyLimitSet и производный BidPlaced одной записью журнала.
        // Обработчик отказывает на втором из них уже после своих INSERT и UPDATE.
        node.probe.failNext.set(2)
        limitOn(node, id, who = 2, max = 200).isRight shouldBe true
        eventually(node.probe.failed.get() shouldBe true)
        val (view, covered) = readModelAndOffset(database, id)
        view should be <= covered
        eventually(version(database, id) shouldBe Some(6L))
        val (after, coveredAfter) = readModelAndOffset(database, id)
        after shouldBe coveredAfter
        bidRows(database, id) shouldBe 2
      }
    }

    "holds the same lot as the entity after a volley of bids and limits on many lots" in {
      val database = migrated()
      withNode(database) { node =>
        given ExecutionContext = node.kit.system.executionContext
        val lots = List.fill(8)(tradingLot(node))
        lots.foreach(id => limitOn(node, id, who = 9, max = 400))
        val volley = for {
          id <- lots
          who <- 1 to 4
        } yield bidOn(node, id, who, amount = 100 + who * 20)
        Future.sequence(volley).futureValue
        lots.foreach { id =>
          eventually(version(database, id) shouldBe Some(journalVersion(database, id)))
          val stored = query(database, "SELECT state::text FROM lot_view WHERE lot_id = ?", id)(_.getString(1)).head
          val viewed = LotJournal.restoreLot(LotViewJson(node.kit.system).read(stored))
          viewed shouldBe lot(node, id).ask[Lot](LotEntity.Get(_)).futureValue
        }
      }
    }

    "reads the events its tag stream does not carry from the journal of the lot" in {
      val database = migrated()
      withNode(database) { node =>
        node.probe.failing.set(true)
        val id = tradingLot(node)
        // Поток тега без первых двух событий лота — так выглядят события, записанные до тегов, и транзакция,
        // закоммиченная позже окна read journal. Проекция видит первым третье событие лота.
        withConnection(database)(
          _.prepareStatement(
            s"DELETE FROM event_tag WHERE event_id IN (SELECT ordering FROM event_journal WHERE persistence_id = 'lot|$id' AND sequence_number <= 2)"
          ).executeUpdate()
        )
        node.probe.failing.set(false)
        bidOn(node, id, who = 1, amount = 110).futureValue.isRight shouldBe true
        eventually(version(database, id) shouldBe Some(4L))
        val stored = query(database, "SELECT state::text FROM lot_view WHERE lot_id = ?", id)(_.getString(1)).head
        LotJournal.restoreLot(LotViewJson(node.kit.system).read(stored)) shouldBe
          lot(node, id).ask[Lot](LotEntity.Get(_)).futureValue
        node.probe.calls.get() shouldBe 2
      }
    }

    "shows the events it has not processed as the backlog metric" in {
      val database = migrated()
      withNode(database) { node =>
        node.probe.failing.set(true)
        val id = tradingLot(node)
        bidOn(node, id, who = 1, amount = 110).futureValue.isRight shouldBe true
        eventually(eventsBehind(node).values.sum shouldBe 4L)
        node.probe.failing.set(false)
        eventually(version(database, id) shouldBe Some(4L))
        eventually(eventsBehind(node).values.sum shouldBe 0L)
        eventsBehind(node).keySet shouldBe LotTags.all.toSet
      }
    }
  }
}
