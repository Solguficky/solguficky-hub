package auction.watch

import auction.AuctionNode
import auction.aggregate.*
import auction.aggregate.AuctionFixtures.configInput
import auction.catalog.LotId
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
      Future.successful(Authority.Granted)
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

    "pass on a committed signal, drop a rolled back one and make everyone reread after a lost connection" in {
      val database = freshDatabase()
      JournalSchema.migrate(database)
      val kit = ActorTestKit(s"auction-listener-${UUID.randomUUID()}", nodeConfig(database))
      given ActorSystem[?] = kit.system
      val registry = ChangeRegistry()
      val listener = PgChangeListener(database, registry, 200.millis, 200.millis).start()
      try {
        val auction = newId()
        val queue = Reader(registry.subscribe(auction).runWith(Sink.queue[Unit]()))
        queue.next(5.seconds) shouldBe Some(())
        // Подключение слушателя само даёт повод всем: дождаться его, чтобы дальше считать только сигналы теста.
        eventually(listening(database) shouldBe true)
        queue.next(500.millis)

        signal(database, auction, commit = false)
        queue.next(1.second) shouldBe None

        signal(database, auction, commit = true)
        queue.next(2.seconds) shouldBe Some(())

        terminateListener(database)
        queue.next(10.seconds) shouldBe Some(())
        queue.cancel()
      } finally {
        listener.close()
        kit.shutdownTestKit()
      }
    }
  }

  "the auction stream" should {

    "show a bid on the active lot of the final within a second and give a reconnecting watcher the same state" in {
      val database = freshDatabase()
      JournalSchema.migrate(database)
      withNode(database) { node =>
        val (auction, finalist) = liveFinal(node)
        val request = wire.WatchAuctionRequest(Some(watcher), auction.value.toString)

        val first = node.watch(request)
        val inFinal = eventually {
          val message = first.pull().futureValue.getOrElse(fail("the stream ended"))
          message.activeLot.map(_.id) shouldBe Some(finalist.value.toString)
          message
        }
        inFinal.getAuction.status.isInFinal shouldBe true
        inFinal.lineup.map(_.id) shouldBe Seq(finalist.value.toString)
        val price = inFinal.getActiveLot.getNextPrice

        // Подвешенный подписчик: подключён, но ничего не читает. Ставки его не ждут.
        val idle = node.watch(request)

        val accepted = node.lots
          .placeBid(
            finalist.value,
            PlaceBid(participant(2), Money(price.minorUnits, CurrencyCode(price.currency)), newOp(), BidSource.Bot),
            Initiator.Participant(participant(2))
          )
          .futureValue
        accepted.isRight shouldBe true
        val acceptedAt = System.nanoTime()
        val raised = Reader(first).next(1.second).getOrElse(fail("the new price did not arrive within a second"))
        (System.nanoTime() - acceptedAt).nanos should be <= 1.second
        raised.getActiveLot.getTrading.getCurrentPrice shouldBe price

        // Отключение подписчика ставок не трогает.
        first.cancel()
        idle.cancel()
        val next = raised.getActiveLot.getNextPrice
        node.lots
          .placeBid(
            finalist.value,
            PlaceBid(participant(3), Money(next.minorUnits, CurrencyCode(next.currency)), newOp(), BidSource.Bot),
            Initiator.Participant(participant(3))
          )
          .futureValue
          .isRight shouldBe true

        // Переподключение отдаёт снимок, равный read model: той же цене, что читает GetLot.
        eventually {
          val again = node.watch(request)
          val snapshot = again.pull().futureValue.getOrElse(fail("the stream ended"))
          again.cancel()
          val lot = node.client
            .getLot()
            .addHeader("authorization", s"Bearer $hubToken")
            .invoke(wire.GetLotRequest(Some(watcher), finalist.value.toString))
            .futureValue
          snapshot.getActiveLot.getTrading.getCurrentPrice shouldBe next
          snapshot.getActiveLot.version shouldBe lot.version
          snapshot.getActiveLot.getTrading shouldBe lot.getTrading
        }
      }
    }

    "answer an auction that was never drafted with not found" in {
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
          AuctionNode.grpc(kit.system, sharding, callers, 10.seconds, Granted, AuctionNode.listenChanges(kit.system))
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
