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
import auction.persistence.SlickLotViews
import auction.persistence.SlickSetOutcomes
import auction.aggregate.AuctionEvent
import auction.aggregate.LotSetId
import auction.aggregate.LotSetSettlement
import auction.catalog.LotId
import auction.entity.AuctionJournal
import org.apache.pekko.persistence.query.Sequence
import org.apache.pekko.projection.eventsourced.EventEnvelope
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
import java.time.Instant
import java.time.ZoneId
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

  /** Часы узла, которые тест двигает: удержание лота наступает только на дедлайне (PER-608). */
  private final class ProjectionClock(var now: Instant) extends Clock {
    override def getZone: ZoneId = ZoneId.of("UTC")
    override def withZone(zone: ZoneId): Clock = this
    override def instant(): Instant = now
  }

  /** Строка статистики для сравнения: значения, а не снимок лота целиком (PER-481, PER-608). */
  private final case class Statistics(
      lotId: UUID,
      bidCount: Long,
      participantCount: Long,
      priceGrowth: Option[Money],
      lastBidAt: Option[Instant],
      finalGrowth: Option[Money],
      finalBidCount: Option[Long]
  )

  private def withNode[A](database: DatabaseSettings, clock: Clock = Clock.systemUTC())(use: Node => A): A = {
    val config = ConfigFactory
      .parseString("""pekko.projection.restart-backoff { min-backoff = 100ms, max-backoff = 300ms }""")
      .withFallback(nodeConfig(database))
    val kit = ActorTestKit(s"auction-projection-${UUID.randomUUID()}", config)
    try {
      val sharding = AuctionNode.join(kit.system)
      AuctionNode.registerLots(sharding, clock, UuidV7.generator(clock))
      val reader = InMemoryMetricReader.create()
      val metrics = ProjectionMetrics(SdkMeterProvider.builder().registerMetricReader(reader).build().get("t"), clock)
      val probe = Probe(() => LotViewHandler(kit.system))
      LotProjection.init(kit.system, LotProjection.Name, metrics, () => probe.handler())
      metrics.watchBacklog(LotProjection.Name, LotProjection.backlog(kit.system, LotProjection.Name, 5.seconds))
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
  /** Рождение лота, условия (старт 100, шаг 10) и открытие торгов с дедлайном `deadline` — три события. */
  private def draftPlanOpen(node: Node, id: UUID, deadline: Instant): Unit = {
    val entity = lot(node, id)
    entity
      .ask[Either[DraftLotRejected, Envelope]](LotEntity.Draft(draftLot(opN = 1), Initiator.Scheduler, _))
      .futureValue
    entity
      .ask[Either[ScheduleLotRejected, Envelope]](LotEntity.Plan(scheduleLot(opN = 2), Initiator.Scheduler, _))
      .futureValue
    entity
      .ask[Either[OpenLotRejected, Envelope]](
        LotEntity.Open(openLot(opN = 3, deadline = Some(deadline)), Initiator.Scheduler, _)
      )
      .futureValue
  }

  /** Лот в торгах: рождение, условия и открытие. */
  private def tradingLot(node: Node, id: UUID = ids()): UUID = {
    draftPlanOpen(node, id, distantDeadline)
    id
  }

  /**
   * Лот, прошедший неделю и финал (PER-608): рождение, условия, открытие с дедлайном `deadline`, ставка недели 110,
   * отметка для финала, удержание на дедлайне (`time` двигает тест), возврат в торги и ставка финала 120. Ведущий
   * продаёт его по 120.
   */
  private def lineupLot(node: Node, time: ProjectionClock, id: UUID, deadline: Instant): UUID = {
    draftPlanOpen(node, id, deadline)
    val entity = lot(node, id)
    bidOn(node, id, who = 1, amount = 110).futureValue.isRight shouldBe true
    entity
      .ask[Either[MarkForFinalRejected, Envelope]](LotEntity.MarkFinal(markForFinal(opN = 5), Initiator.Scheduler, _))
      .futureValue
      .isRight shouldBe true
    time.now = deadline
    entity
      .ask[Either[CloseLotRejected, Envelope]](LotEntity.Close(closeLot(opN = 6), Initiator.Scheduler, _))
      .futureValue
      .isRight shouldBe true
    entity
      .ask[Either[ResumeLotRejected, Envelope]](LotEntity.Resume(resumeLot(opN = 7), Initiator.Scheduler, _))
      .futureValue
      .isRight shouldBe true
    bidOn(node, id, who = 2, amount = 120).futureValue.isRight shouldBe true
    entity
      .ask[Either[CloseLotRejected, Envelope]](
        LotEntity.Close(closeLot(opN = 9, reason = CloseReason.ByAuctioneer), Initiator.Scheduler, _)
      )
      .futureValue
      .isRight shouldBe true
    id
  }

  /**
   * Лот, удержанный на дедлайне и проданный ведущим до заморозки состава (PER-608): рождение, условия, открытие, ставка
   * недели 110, отметка, удержание и продажа по цене удержания. Возврата в торги и ставок финала у него нет.
   */
  private def heldLotSoldBeforeLineup(node: Node, time: ProjectionClock, id: UUID, deadline: Instant): UUID = {
    draftPlanOpen(node, id, deadline)
    val entity = lot(node, id)
    bidOn(node, id, who = 1, amount = 110).futureValue.isRight shouldBe true
    entity
      .ask[Either[MarkForFinalRejected, Envelope]](LotEntity.MarkFinal(markForFinal(opN = 5), Initiator.Scheduler, _))
      .futureValue
      .isRight shouldBe true
    time.now = deadline
    entity
      .ask[Either[CloseLotRejected, Envelope]](LotEntity.Close(closeLot(opN = 6), Initiator.Scheduler, _))
      .futureValue
      .isRight shouldBe true
    entity
      .ask[Either[CloseLotRejected, Envelope]](
        LotEntity.Close(closeLot(opN = 7, reason = CloseReason.ByAuctioneer), Initiator.Scheduler, _)
      )
      .futureValue
      .isRight shouldBe true
    id
  }

  private def bidOn(
      node: Node,
      id: UUID,
      who: Int,
      amount: Long
  ): Future[Either[PlaceBidRejected, LotEntity.Recorded]] =
    lot(node, id).ask[Either[PlaceBidRejected, LotEntity.Recorded]](
      LotEntity.Bid(PlaceBid(participant(who), money(amount), OpId(ids()), BidSource.Bot), Initiator.Scheduler, _)
    )

  private def limitOn(node: Node, id: UUID, who: Int, max: Long): Either[SetProxyLimitRejected, LotEntity.Recorded] =
    lot(node, id)
      .ask[Either[SetProxyLimitRejected, LotEntity.Recorded]](
        LotEntity.SetLimit(SetProxyLimit(participant(who), money(max), OpId(ids())), Initiator.Scheduler, _)
      )
      .futureValue

  private def withdrawOn(node: Node, id: UUID, who: Int): Either[WithdrawProxyLimitRejected, Envelope] =
    lot(node, id)
      .ask[Either[WithdrawProxyLimitRejected, Envelope]](
        LotEntity.WithdrawLimit(WithdrawProxyLimit(participant(who), OpId(ids())), Initiator.Scheduler, _)
      )
      .futureValue

  /**
   * Лот в реестре аукциона: статистика перечисляет реестр, а проекцию аукционов этот сьют не поднимает. Строки
   * `auction_view` и `auction_lineup` статистика читает только как опоры: первая держит реестр внешним ключом, вторая —
   * состав финала (PER-608); лот в `lineup` — лот состава, у остальных метрик финала нет.
   */
  private def registered(database: DatabaseSettings, auctionId: UUID, lineup: Set[UUID], lots: UUID*): Unit =
    withConnection(database) { connection =>
      Using.resource(
        connection.prepareStatement(
          """INSERT INTO auction_view (auction_id, meetup_id, version, status, state) VALUES (?, ?, 1, 'prebidding', '{}')"""
        )
      ) { statement =>
        statement.setObject(1, auctionId)
        statement.setObject(2, UUID.randomUUID())
        statement.executeUpdate()
      }
      (lots.toSet ++ lineup).foreach { id =>
        Using.resource(connection.prepareStatement("INSERT INTO auction_lot (auction_id, lot_id) VALUES (?, ?)")) {
          statement =>
            statement.setObject(1, auctionId)
            statement.setObject(2, id)
            statement.executeUpdate()
        }
      }
      lineup.foreach { id =>
        Using.resource(connection.prepareStatement("INSERT INTO auction_lineup (auction_id, lot_id) VALUES (?, ?)")) {
          statement =>
            statement.setObject(1, auctionId)
            statement.setObject(2, id)
            statement.executeUpdate()
        }
      }
    }

  /** Статистика тем же чтением, что у gRPC; сравнивается по значениям, а не по снимку лота целиком. */
  private def statisticsOf(node: Node, auctionId: UUID): List[Statistics] =
    SlickLotViews(node.kit.system)
      .statistics(auctionId)
      .futureValue
      .map(view =>
        Statistics(
          view.lotId,
          view.bidCount,
          view.participantCount,
          view.priceGrowth,
          view.lastBidAt,
          view.finalGrowth,
          view.finalBidCount
        )
      )

  private def bidders(database: DatabaseSettings, id: UUID): Set[UUID] =
    query(database, "SELECT DISTINCT participant_id FROM lot_bid WHERE lot_id = ?", id)(
      _.getObject(1, classOf[UUID])
    ).toSet

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

    "counts the statistics of a lot once per event and the same again after a rebuild from scratch" in {
      val database = migrated()
      val auctionId = UUID.randomUUID()
      val (busy, quiet) = (UUID.fromString("01926f3c-8b7a-7cde-8f00-000000000011"), ids())
      val (incremental, limitOwners) = withNode(database) { node =>
        tradingLot(node, busy)
        tradingLot(node, quiet)
        registered(database, auctionId, Set.empty, busy, quiet)
        bidOn(node, busy, who = 1, amount = 110).futureValue.isRight shouldBe true
        // Лимит второго ставит производную ставку от его имени, ответ первому — ещё одну.
        limitOn(node, busy, who = 2, max = 300).isRight shouldBe true
        bidOn(node, busy, who = 1, amount = 150).futureValue.isRight shouldBe true
        // Лимит третьего ниже лимита лидера: он поднимает цену ставкой от имени лидера, своих ставок у него нет.
        limitOn(node, busy, who = 3, max = 200).isRight shouldBe true
        // Лимит четвёртого отозван: участия это не снимает.
        val withdrawn = limitOn(node, busy, who = 4, max = 250).isRight
        withdrawn shouldBe true
        withdrawOn(node, busy, who = 4).isRight shouldBe true
        // Отказанная ставка ниже цены в журнал не попадает и участника не добавляет.
        bidOn(node, busy, who = 9, amount = 50).futureValue.isLeft shouldBe true
        eventually(version(database, busy) shouldBe Some(journalVersion(database, busy)))
        eventually(version(database, quiet) shouldBe Some(3L))
        (statisticsOf(node, auctionId), Set(2, 3, 4).map(participant(_).value))
      }

      val busyStatistics = incremental.find(_.lotId == busy).getOrElse(fail("busy lot is missing"))
      val lastBid = query(
        database,
        "SELECT occurred_at FROM lot_bid WHERE lot_id = ? ORDER BY sequence DESC LIMIT 1",
        busy
      )(_.getTimestamp(1).toInstant).headOption
      busyStatistics.bidCount shouldBe bidRows(database, busy).toLong
      busyStatistics.participantCount shouldBe (bidders(database, busy) ++ limitOwners).size.toLong
      bidders(database, busy) should not contain participant(9).value
      busyStatistics.lastBidAt shouldBe lastBid
      busyStatistics.priceGrowth.map(_.minorUnits).exists(_ > 0) shouldBe true
      incremental.find(_.lotId == quiet) shouldBe
        Some(Statistics(quiet, 0L, 0L, Some(money(0)), None, None, None))

      // Повторная доставка: без offset журнал переигрывается целиком, а числа не меняются.
      withConnection(database)(_.createStatement().execute("DELETE FROM pekko_projection_offset_store"))
      withNode(database) { node =>
        eventually(node.probe.calls.get() shouldBe (journalVersion(database, busy) + 3).toInt)
        statisticsOf(node, auctionId) shouldBe incremental
      }

      // Перестройка с нуля, как в V9 и V12: read model пуста, offset проекции нет, числа — те же, что инкрементальные.
      withConnection(database) { connection =>
        val statement = connection.createStatement()
        List("lot_bid", "lot_view", "lot_participant", "lot_starting_price", "lot_hold", "lot_resume").foreach(table =>
          statement.execute(s"DELETE FROM $table")
        )
        statement.execute("DELETE FROM pekko_projection_offset_store WHERE projection_name = 'lot-view'")
      }
      withNode(database) { node =>
        eventually(version(database, busy) shouldBe Some(journalVersion(database, busy)))
        eventually(version(database, quiet) shouldBe Some(3L))
        statisticsOf(node, auctionId) shouldBe incremental
      }
    }

    "counts the final growth and final bids of a held lot of the lineup and leaves them absent outside it" in {
      val database = migrated()
      val auctionId = UUID.fromString("01926f3c-8b7a-7cde-8f00-000000000020")
      val base = Instant.parse("2026-10-07T18:00:00Z")
      val time = new ProjectionClock(base)
      val deadline = base.plusSeconds(600)
      val (lineup, excluded, plain) =
        (
          UUID.fromString("01926f3c-8b7a-7cde-8f00-000000000021"),
          UUID.fromString("01926f3c-8b7a-7cde-8f00-000000000023"),
          UUID.fromString("01926f3c-8b7a-7cde-8f00-000000000022")
        )

      withNode(database, time) { node =>
        lineupLot(node, time, lineup, deadline)
        // Часы узла тест двигает сам, и удержание оставляет их на дедлайне: перед следующим лотом время возвращается к
        // началу, иначе лот открылся бы уже на своём дедлайне, а его ставка продлила бы дедлайн анти-снайпом.
        time.now = base
        // Удержан, но продан ведущим до заморозки: в состав не входит, и обеих метрик у него нет.
        heldLotSoldBeforeLineup(node, time, excluded, deadline)
        time.now = base
        tradingLot(node, plain)
        registered(database, auctionId, Set(lineup), lineup, excluded, plain)
        eventually(version(database, lineup) shouldBe Some(9L))
        eventually(version(database, excluded) shouldBe Some(7L))
        eventually(version(database, plain) shouldBe Some(3L))

        val statistics = statisticsOf(node, auctionId)
        val held = statistics.find(_.lotId == lineup).getOrElse(fail("the held lot is missing"))
        // Обе ставки — недели и финала; рост от стартовой цены и рост финала от цены удержания; в финале одна ставка.
        held.bidCount shouldBe 2L
        held.priceGrowth shouldBe Some(money(20))
        held.finalGrowth shouldBe Some(money(10))
        held.finalBidCount shouldBe Some(1L)

        // Удержанный вне состава и вовсе не удержанный лот: метрик финала нет, а не ноль.
        List(excluded, plain).foreach { id =>
          val outside = statistics.find(_.lotId == id).getOrElse(fail(s"lot $id is missing"))
          outside.finalGrowth shouldBe None
          outside.finalBidCount shouldBe None
        }
      }
    }

    "shows a complete set of the auction in the snapshot of its lots, with the collector once the set is settled" in {
      val database = migrated()
      // Аукцион, в котором фикстура рождает лоты: сет ищется в аукционе лота.
      val auctionId = LotFixtures.auctionId(1).value
      val set = UUID.fromString("01926f3c-8b7a-7cde-8f00-000000000031")
      withNode(database) { node =>
        val (first, second) = (tradingLot(node), tradingLot(node))
        eventually(version(database, second) shouldBe Some(3L))
        val name = auction.aggregate.LotSetName("Красный сет").toOption.get
        val events = List(
          AuctionEvent.AuctionDrafted(auction.aggregate.MeetupId(UUID.randomUUID())),
          AuctionEvent.LotAdded(LotId(first)),
          AuctionEvent.LotAdded(LotId(second)),
          AuctionEvent.LotSetDefined(LotSetId(set), name, List(LotId(first))),
          AuctionEvent.LotSetDefined(LotSetId(set), name, List(LotId(second), LotId(first))),
          AuctionEvent.AuctionScheduled(auction.aggregate.AuctionFixtures.config()),
          AuctionEvent.PrebiddingStarted,
          AuctionEvent.LotSetSettled(LotSetId(set), LotSetSettlement.Collected(participant(2)))
        )
        val handler = AuctionViewHandler(node.kit.system)
        val views = SlickLotViews(node.kit.system)
        events.zipWithIndex.foreach { (event, index) =>
          val sequence = index + 1L
          withConnection(database) { connection =>
            val session = new JdbcSession {
              def withConnection[R](func: org.apache.pekko.japi.function.Function[Connection, R]): R = func(connection)
              def commit(): Unit = ()
              def rollback(): Unit = ()
              def close(): Unit = ()
            }
            val stored = AuctionJournal.store(ids(), ids(), op(200 + index), Instant.now(), Initiator.Scheduler)(event)
            handler.process(
              session,
              EventEnvelope(Sequence(sequence), s"auction|$auctionId", sequence, stored, 0L)
            )
          }
          val seen = views.find(first).futureValue.flatMap(_.lotSet)
          sequence match {
            // Сет из одного лота неполный: участнику он не показывается.
            case 4 => seen shouldBe None
            case 5 => seen shouldBe Some(LotSetView(set, "Красный сет", List(second, first), None))
            case 8 =>
              seen shouldBe Some(LotSetView(set, "Красный сет", List(second, first), Some(participant(2).value)))
            case _ => ()
          }
        }
        views.registryPage(auctionId, None, 10).futureValue.map(_.lotSet.map(_.lotSetId)) shouldBe List(
          Some(set),
          Some(set)
        )
        // Лоты ещё торгуются: исхода нет ни у одного.
        SlickSetOutcomes(node.kit.system).outcomes(Set(LotId(first), LotId(second))).futureValue shouldBe empty
      }
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
