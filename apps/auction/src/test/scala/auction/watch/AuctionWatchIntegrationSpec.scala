package auction.watch

import auction.AuctionNode
import auction.aggregate.*
import auction.aggregate.AuctionFixtures.configInput
import auction.catalog.CardEdit
import auction.catalog.ImageChange
import auction.catalog.LotId
import auction.catalog.LotTitle
import auction.catalog.NewCard
import auction.entity.Initiator
import auction.entity.LotEntity
import auction.entity.LotGateway
import auction.entity.AuctionGateway
import auction.entity.UuidV7
import auction.grpc.CallerTable
import auction.grpc.MethodAccess
import auction.lot.AntiSnipe
import auction.lot.AuctionId
import auction.lot.BidSource
import auction.lot.CurrencyCode
import auction.lot.Envelope
import auction.lot.LotFixtures.participant
import auction.lot.LotFixtures.scheduleLot
import auction.lot.Money
import auction.lot.OpId
import auction.lot.ParticipantId
import auction.lot.PlaceBid
import auction.lot.ScheduleLotRejected
import auction.persistence.DatabaseSettings
import auction.persistence.JournalSchema
import auction.persistence.SlickLotCatalogStore
import auction.telemetry.ProjectionMetrics
import auction.testkit.PostgresFixture
import auction.v1.auction_service as wire
import com.typesafe.config.ConfigFactory
import identity.v1.access.AccessRight as AccessRightMessage
import io.grpc.Status
import io.opentelemetry.api.OpenTelemetry
import org.apache.pekko.actor.testkit.typed.scaladsl.ActorTestKit
import org.apache.pekko.actor.typed.ActorSystem
import org.apache.pekko.grpc.GrpcClientSettings
import org.apache.pekko.grpc.GrpcServiceException
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.stream.scaladsl.Sink
import org.apache.pekko.stream.scaladsl.SinkQueueWithCancel
import org.apache.pekko.util.Timeout
import org.scalatest.concurrent.Eventually
import org.scalatest.concurrent.ScalaFutures
import org.scalatest.matchers.should.Matchers
import org.scalatest.time.Millis
import org.scalatest.time.Seconds
import org.scalatest.time.Span
import org.scalatest.wordspec.AnyWordSpec

import java.time.Clock
import java.time.Duration
import java.time.Instant
import java.util.UUID
import scala.concurrent.Future
import scala.concurrent.duration.*
import scala.util.Using

/**
 * Поток `WatchAuction` (PER-335) на узле, собранном так же, как в `Main`: сигнал проекций идёт через настоящий
 * `LISTEN`/`NOTIFY` PostgreSQL, состояние — из настоящей read model, клиент ходит по gRPC с токеном бота хаба.
 */
final class AuctionWatchIntegrationSpec
    extends AnyWordSpec
    with Matchers
    with PostgresFixture
    with ScalaFutures
    with Eventually {

  implicit override val patienceConfig: PatienceConfig =
    PatienceConfig(timeout = Span(30, Seconds), interval = Span(100, Millis))

  private given Timeout = Timeout(20.seconds)

  private val hubToken = "hub-token"

  private val callers = CallerTable
    .fromConfig(
      ConfigFactory.parseString(s"""auction.grpc.callers { hub-bot = "$hubToken", auction-bot = "auction" }"""),
      MethodAccess.declared
    )
    .fold(reason => fail(reason), table => table)

  private val person: ParticipantId = participant(1)

  private object Granted extends MeetupAuthority {
    def check(meetup: MeetupId, person: ParticipantId, correlation: Correlation): Future[Authority] =
      Future.successful(Authority.Granted(Standings.published))
  }

  private val watcher =
    wire.Viewer(
      UuidV7.generator(Clock.systemUTC())().toString,
      rights = Seq(AccessRightMessage.ACCESS_RIGHT_PLACE_BIDS)
    )

  private def newId(): UUID = UuidV7.generator(Clock.systemUTC())()

  private def newOp(): OpId = OpId(newId())

  /**
   * Чтение потока с ожиданием по сроку. `pull` без элемента не завершается, а второй `pull` поверх висящего очередь
   * отклоняет, поэтому незавершённый `pull` переживает вызов и забирается следующим.
   */
  private final class Reader[T](queue: SinkQueueWithCancel[T]) {
    private var waiting: Option[Future[Option[T]]] = None

    def next(within: FiniteDuration): Option[T] = {
      val pull = waiting.getOrElse(queue.pull())
      try {
        val element = pull.futureValue(timeout(Span(within.toMillis, Millis)))
        waiting = None
        element
      } catch {
        case _: org.scalatest.exceptions.TestFailedException if !pull.isCompleted =>
          waiting = Some(pull)
          None
      }
    }

    def cancel(): Unit = queue.cancel()
  }

  "the change listener" should {

    "passes on a committed signal and drops a rolled back one" in onListener { (database, queue) =>
      val auction = queue.auction
      signal(database, auction, commit = false)
      queue.next(1.second) shouldBe None

      signal(database, auction, commit = true)
      queue.next(2.seconds) shouldBe Some(())
    }

    "passes on the auction of a lot whose card was edited" in onListener { (database, queue) =>
      val lot = LotId(newId())
      withConnection(database) { connection =>
        Using.resource(
          connection.prepareStatement(
            "INSERT INTO lot_view (lot_id, auction_id, version, state) VALUES (?, ?, 1, '{}'::jsonb)"
          )
        ) { statement =>
          statement.setObject(1, lot.value)
          statement.setObject(2, queue.auction)
          statement.executeUpdate()
        }
      }
      val kit = ActorTestKit(s"auction-catalog-${UUID.randomUUID()}", nodeConfig(database))
      try {
        val store = SlickLotCatalogStore(kit.system)
        val title = LotTitle("Солегуф").fold(refusal => fail(s"title refused: $refusal"), valid => valid)
        store.insertIfAbsent(NewCard(lot, title, "описание", None)).futureValue shouldBe None
        queue.next(2.seconds) shouldBe Some(())

        store.update(CardEdit(lot, title, "новое описание", ImageChange.Keep)).futureValue should not be empty
        queue.next(2.seconds) shouldBe Some(())
      } finally kit.shutdownTestKit()
    }

    "makes every subscriber reread after its connection is lost" in onListener { (database, queue) =>
      terminateListener(database)
      queue.next(10.seconds) shouldBe Some(())
    }
  }

  "the auction stream" should {

    "shows a bid on the active lot of the final within a second while another watcher reads nothing" in {
      val database = freshDatabase()
      JournalSchema.migrate(database)
      withNode(database) { node =>
        val (request, inFinal) = watchingFinal(node)
        val first = Reader(inFinal.queue)
        val price = inFinal.message.getActiveLot.getNextPrice
        // Подвешенный подписчик: подключён, но ничего не читает. Ставки его не ждут.
        val idle = node.watch(request)

        bid(node, inFinal.lot, price, participant(2))
        val acceptedAt = System.nanoTime()
        val raised = first.next(1.second).getOrElse(fail("the new price did not arrive within a second"))

        (System.nanoTime() - acceptedAt).nanos should be <= 1.second
        raised.getActiveLot.getTrading.getCurrentPrice shouldBe price
        first.cancel()
        idle.cancel()
      }
    }

    "gives a watcher who reconnects after leaving the snapshot of the read model" in {
      val database = freshDatabase()
      JournalSchema.migrate(database)
      withNode(database) { node =>
        val (request, inFinal) = watchingFinal(node)
        val price = inFinal.message.getActiveLot.getNextPrice
        // Ушедший подписчик ставок не трогает: ставка после отключения принимается.
        inFinal.queue.cancel()
        bid(node, inFinal.lot, price, participant(3))

        eventually {
          val again = node.watch(request)
          val snapshot = again.pull().futureValue.getOrElse(fail("the stream ended"))
          again.cancel()
          val lot = node.client
            .getLot()
            .addHeader("authorization", s"Bearer $hubToken")
            .invoke(wire.GetLotRequest(Some(watcher), inFinal.lot.value.toString))
            .futureValue
          snapshot.getActiveLot.getTrading.getCurrentPrice shouldBe price
          snapshot.getActiveLot.version shouldBe lot.version
          snapshot.getActiveLot.getTrading shouldBe lot.getTrading
        }
      }
    }

    "sends the sale of the last lot of the final before it ends the stream" in {
      val database = freshDatabase()
      JournalSchema.migrate(database)
      withNode(database) { node =>
        val (_, inFinal) = watchingFinal(node)
        sellLast(node, inFinal)

        val last = untilEnd(inFinal.queue).lastOption.getOrElse(fail("the stream ended without a message"))
        last.getAuction.status.isFinished shouldBe true
        last.lineup.map(lot => lot.id -> lot.status.isSold) shouldBe Seq(inFinal.lot.value.toString -> true)
      }
    }

    "gives a watcher who comes after the end one message with the sold lineup and ends the stream" in {
      val database = freshDatabase()
      JournalSchema.migrate(database)
      withNode(database) { node =>
        val (request, inFinal) = watchingFinal(node)
        inFinal.queue.cancel()
        sellLast(node, inFinal)
        // Продажа лота и конец аукциона уже в read model: поздний подписчик читает их одним чтением.
        eventually {
          node.client
            .getAuction()
            .addHeader("authorization", s"Bearer $hubToken")
            .invoke(wire.GetAuctionRequest(Some(watcher), inFinal.message.getAuction.id))
            .futureValue
            .getAuction
            .status
            .isFinished shouldBe true
        }

        val messages = untilEnd(node.watch(request))
        messages.last.getAuction.status.isFinished shouldBe true
        messages.last.lineup.map(lot => lot.id -> lot.status.isSold) shouldBe Seq(inFinal.lot.value.toString -> true)
      }
    }

    "carries the estimated time of the final to the open stream without a reconnect" in {
      val database = freshDatabase()
      JournalSchema.migrate(database)
      withNode(database) { node =>
        val auction = onlineWeek(node)
        awaitVisible(node, auction)
        val queue = node.watch(wire.WatchAuctionRequest(Some(watcher), auction.value.toString))
        val reader = Reader(queue)
        reader.next(10.seconds).getOrElse(fail("the stream ended")).getAuction.finalAt shouldBe empty
        val at = Instant.now().plusSeconds(3600)

        node.commands.setFinalTime(auction, Some(at), newOp(), person).futureValue shouldBe Right(())

        val changed = reader.next(10.seconds).getOrElse(fail("the estimated time did not arrive"))
        Instant.parse(changed.getAuction.finalAt.getOrElse(fail("the estimated time is absent"))) shouldBe at
        reader.cancel()
      }
    }

    "answers an auction that was never drafted with not found" in {
      val database = freshDatabase()
      JournalSchema.migrate(database)
      withNode(database) { node =>
        val unknown = Auction.idOf(MeetupId(newId())).value.toString
        node.watch(wire.WatchAuctionRequest(Some(watcher), unknown)).pull().failed.futureValue match {
          case refused: io.grpc.StatusRuntimeException => refused.getStatus.getCode shouldBe Status.Code.NOT_FOUND
          case refused: GrpcServiceException => refused.status.getCode shouldBe Status.Code.NOT_FOUND
          case other => fail(s"expected a status, got $other")
        }
      }
    }
  }

  /**
   * Подписка на аукцион, чей слушатель уже подключён: повод от подключения забран, дальше идут только сигналы теста.
   */
  private final class Subscription(val auction: UUID, reader: Reader[Unit]) {
    def next(within: FiniteDuration): Option[Unit] = reader.next(within)
  }

  private def onListener(test: (DatabaseSettings, Subscription) => Unit): Unit = {
    val database = freshDatabase()
    JournalSchema.migrate(database)
    val kit = ActorTestKit(s"auction-listener-${UUID.randomUUID()}", nodeConfig(database))
    given ActorSystem[?] = kit.system
    val registry = ChangeRegistry()
    val listener = PgChangeListener(database, registry, 200.millis, 200.millis).start()
    try {
      val auction = newId()
      val queue = registry.subscribe(auction).runWith(Sink.queue[Unit]())
      val reader = Reader(queue)
      reader.next(5.seconds) shouldBe Some(())
      eventually(listening(database) shouldBe true)
      reader.next(500.millis)
      try test(database, Subscription(auction, reader))
      finally queue.cancel()
    } finally {
      listener.close()
      kit.shutdownTestKit()
    }
  }

  /** Первое сообщение живого финала с активным лотом и поток, который его отдал. */
  private final case class InFinal(
      lot: LotId,
      message: wire.AuctionWatch,
      queue: SinkQueueWithCancel[wire.AuctionWatch]
  )

  private def watchingFinal(node: Node): (wire.WatchAuctionRequest, InFinal) = {
    val (auction, finalist) = liveFinal(node)
    val request = wire.WatchAuctionRequest(Some(watcher), auction.value.toString)
    val queue = node.watch(request)
    val message = eventually {
      val next = queue.pull().futureValue.getOrElse(fail("the stream ended"))
      next.activeLot.map(_.id) shouldBe Some(finalist.value.toString)
      next
    }
    message.getAuction.status.isInFinal shouldBe true
    message.lineup.map(_.id) shouldBe Seq(finalist.value.toString)
    (request, InFinal(finalist, message, queue))
  }

  private def bid(node: Node, lot: LotId, price: _root_.auction.v1.auction.Money, who: ParticipantId): Unit =
    node.lots
      .placeBid(
        lot.value,
        PlaceBid(who, Money(price.minorUnits, CurrencyCode(price.currency)), newOp(), BidSource.Bot),
        Initiator.Participant(who)
      )
      .futureValue
      .isRight shouldBe true

  /** Ставка по следующей цене и продажа активного лота ведущим: состав из одного лота, и аукцион заканчивается. */
  private def sellLast(node: Node, inFinal: InFinal): Unit = {
    bid(node, inFinal.lot, inFinal.message.getActiveLot.getNextPrice, participant(2))
    val auction = AuctionId(UUID.fromString(inFinal.message.getAuction.id))
    eventually(node.commands.closeLot(auction, inFinal.lot, newOp(), person).futureValue.isRight shouldBe true)
  }

  /** Сообщения потока до его конца; поток, не закрывшийся за срок, — провал. */
  private def untilEnd(queue: SinkQueueWithCancel[wire.AuctionWatch]): List[wire.AuctionWatch] =
    Iterator
      .continually(queue.pull().futureValue)
      .takeWhile(_.isDefined)
      .flatten
      .toList

  private final case class Node(
      commands: AuctionCommands,
      lots: LotGateway,
      sharding: org.apache.pekko.cluster.sharding.typed.scaladsl.ClusterSharding,
      client: wire.AuctionServiceClient,
      system: ActorSystem[?]
  ) {
    def watch(request: wire.WatchAuctionRequest): SinkQueueWithCancel[wire.AuctionWatch] =
      client
        .watchAuction()
        .addHeader("authorization", s"Bearer $hubToken")
        .invoke(request)
        .runWith(Sink.queue[wire.AuctionWatch]())(using org.apache.pekko.stream.Materializer(system))
  }

  private def withNode[A](database: DatabaseSettings)(use: Node => A): A = {
    val kit = ActorTestKit(s"auction-watch-${UUID.randomUUID()}", nodeConfig(database))
    given ActorSystem[?] = kit.system
    given scala.concurrent.ExecutionContext = kit.system.executionContext
    try {
      val clock = Clock.systemUTC()
      val sharding = AuctionNode.join(kit.system)
      AuctionNode.registerLots(sharding, clock, UuidV7.generator(clock))
      AuctionNode.registerAuctions(kit.system, sharding, clock, UuidV7.generator(clock), 10.seconds)
      AuctionNode.startProjection(
        kit.system,
        ProjectionMetrics(OpenTelemetry.noop().getMeter("auction"), clock),
        5.seconds
      )
      val binding = Http()
        .newServerAt("127.0.0.1", 0)
        .withSettings(AuctionNode.grpcServerSettings(kit.system))
        .bind(
          AuctionNode.grpc(
            kit.system,
            sharding,
            callers,
            10.seconds,
            Granted,
            _ => Future.successful(true),
            AuctionNode.listenChanges(kit.system)
          )
        )
        .futureValue
      val client = wire.AuctionServiceClient(
        GrpcClientSettings.connectToServiceAt("127.0.0.1", binding.localAddress.getPort).withTls(false)
      )
      val lots = LotGateway.sharded(sharding, 10.seconds)
      val commands = AuctionCommands(AuctionGateway.sharded(sharding, 10.seconds), lots, Granted)
      try use(Node(commands, lots, sharding, client, kit.system))
      finally client.close().futureValue
    } finally kit.shutdownTestKit()
  }

  /**
   * Аукцион в живом финале с одним лотом состава: онлайн-неделя с коротким общим дедлайном, отметка финалиста, перерыв,
   * заморозка, старт финала и возврат лота в торги — тем же путём, что `AuctionFinalIntegrationSpec`.
   */
  private def liveFinal(node: Node): (AuctionId, LotId) = {
    val auction = node.commands
      .draft(MeetupId(newId()), newOp(), person)
      .futureValue
      .fold(denial => fail(s"the auction was not drafted: $denial"), _.auctionId)
    val finalist = LotId(newId())
    val quiet = quietLot()
    node.commands.addLot(auction, finalist, newOp(), person).futureValue shouldBe Right(())
    node.sharding
      .entityRefFor(LotEntity.TypeKey, finalist.value.toString)
      .ask[Either[ScheduleLotRejected, Envelope]](
        LotEntity.Plan(scheduleLot(opN = 2, input = quiet), Initiator.Operator(person), _)
      )
      .futureValue
      .isRight shouldBe true
    val week = OnlinePhase(Instant.now().minusSeconds(3600), Some(Instant.now().plusSeconds(6)), closesLots = true)
    node.commands.schedule(auction, configInput(Some(week)), newOp(), person).futureValue shouldBe Right(())
    node.commands.startPrebidding(auction, newOp(), person).futureValue shouldBe Right(())
    eventually(node.commands.selectForFinal(auction, finalist, newOp(), person).futureValue shouldBe Right(()))
    eventually(
      node.commands.freezeFinalLineup(auction, List(finalist), newOp(), person).futureValue shouldBe Right(())
    )
    node.commands.startFinal(auction, newOp(), person).futureValue shouldBe Right(())
    node.commands.startNextLot(auction, newOp(), person).futureValue shouldBe Right(finalist)
    (auction, finalist)
  }

  /**
   * Аукцион с открытой онлайн-неделей: время финала в нём ещё можно выставить, а снимок читается.
   */
  private def onlineWeek(node: Node): AuctionId = {
    val auction = node.commands
      .draft(MeetupId(newId()), newOp(), person)
      .futureValue
      .fold(denial => fail(s"the auction was not drafted: $denial"), _.auctionId)
    val week = OnlinePhase(Instant.now().minusSeconds(3600), Some(Instant.now().plusSeconds(600)), closesLots = true)
    node.commands.schedule(auction, configInput(Some(week)), newOp(), person).futureValue shouldBe Right(())
    node.commands.startPrebidding(auction, newOp(), person).futureValue shouldBe Right(())
    auction
  }

  /**
   * Ждёт, пока проекция опубликует аукцион: до этого он скрыт, и поток отвечает «не найден».
   */
  private def awaitVisible(node: Node, auction: AuctionId): Unit =
    eventually {
      val read = node.client
        .getAuction()
        .addHeader("authorization", s"Bearer $hubToken")
        .invoke(wire.GetAuctionRequest(Some(watcher), auction.value.toString))
        .futureValue
      read.auction.isDefined shouldBe true
    }

  private def quietLot() =
    _root_.auction.lot.LotFixtures
      .configInput()
      .copy(antiSnipe = AntiSnipe(Duration.ofSeconds(1), Duration.ofSeconds(1), 3))

  private def signal(database: DatabaseSettings, auction: UUID, commit: Boolean): Unit =
    withConnection(database) { connection =>
      connection.setAutoCommit(false)
      AuctionChanges.announce(connection, auction)
      if (commit) connection.commit() else connection.rollback()
    }

  private def listening(database: DatabaseSettings): Boolean =
    withConnection(database) { connection =>
      Using.resource(
        connection.prepareStatement(
          "SELECT count(*) FROM pg_stat_activity WHERE query = ? AND datname = current_database() AND pid <> pg_backend_pid()"
        )
      ) { statement =>
        statement.setString(1, s"LISTEN ${AuctionChanges.Channel}")
        Using.resource(statement.executeQuery())(rows => rows.next() && rows.getLong(1) > 0)
      }
    }

  private def terminateListener(database: DatabaseSettings): Unit =
    withConnection(database) { connection =>
      Using.resource(
        connection.prepareStatement(
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE query = ? AND datname = current_database() AND pid <> pg_backend_pid()"
        )
      ) { statement =>
        statement.setString(1, s"LISTEN ${AuctionChanges.Channel}")
        Using.resource(statement.executeQuery())(_ => ())
      }
    }
}
