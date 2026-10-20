package auction.screen

import auction.AuctionNode
import auction.aggregate.*
import auction.aggregate.AuctionFixtures.configInput
import auction.catalog.LotId
import auction.entity.AuctionGateway
import auction.entity.Initiator
import auction.entity.LotEntity
import auction.entity.LotGateway
import auction.entity.UuidV7
import auction.grpc.CallerTable
import auction.grpc.MethodAccess
import auction.lot.AntiSnipe
import auction.lot.AuctionId
import auction.lot.BidSource
import auction.lot.Envelope
import auction.lot.LotFixtures.participant
import auction.lot.LotFixtures.scheduleLot
import auction.lot.Lot
import auction.lot.LotState
import auction.lot.Money
import auction.lot.OpId
import auction.lot.ParticipantId
import auction.lot.PlaceBid
import auction.lot.ScheduleLotRejected
import auction.naming.ChosenName
import auction.naming.TelegramUsername
import auction.persistence.DatabaseSettings
import auction.persistence.JournalSchema
import auction.persistence.SlickDisplayNameStore
import auction.persistence.SlickLotViews
import auction.telemetry.ProjectionMetrics
import auction.testkit.PostgresFixture
import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.typesafe.config.Config
import com.typesafe.config.ConfigFactory
import io.opentelemetry.api.OpenTelemetry
import org.apache.pekko.actor.testkit.typed.scaladsl.ActorTestKit
import org.apache.pekko.actor.typed.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model.HttpRequest
import org.apache.pekko.http.scaladsl.model.HttpResponse
import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.stream.Materializer
import org.apache.pekko.stream.scaladsl.Sink
import org.apache.pekko.stream.scaladsl.SinkQueueWithCancel
import org.apache.pekko.util.ByteString
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

/**
 * Поток экрана зала (PER-484) на узле, собранном так же, как в `Main`: HTTP-граница с маршрутами экрана, сигнал
 * проекций через настоящий `LISTEN`/`NOTIFY` и состояние из настоящей read model. Meetups подменён ответом «сходка
 * видна»: провод к нему держат L0 адаптера и контур.
 */
final class ScreenStreamIntegrationSpec
    extends AnyWordSpec
    with Matchers
    with PostgresFixture
    with ScalaFutures
    with Eventually {

  implicit override val patienceConfig: PatienceConfig =
    PatienceConfig(timeout = Span(30, Seconds), interval = Span(100, Millis))

  private given Timeout = Timeout(20.seconds)

  private val callers = CallerTable
    .fromConfig(
      ConfigFactory.parseString("""auction.grpc.callers { hub-bot = "hub", auction-bot = "auction" }"""),
      MethodAccess.declared
    )
    .fold(reason => fail(reason), table => table)

  private val person: ParticipantId = participant(1)

  private object Granted extends MeetupAuthority {
    def check(meetup: MeetupId, person: ParticipantId, correlation: Correlation): Future[Authority] =
      Future.successful(Authority.Granted(Standings.published))
  }

  private object Visible extends MeetupStandings {
    def standing(meetup: UUID): Future[StandingAnswer] =
      Future.successful(StandingAnswer.Found(MeetupStanding(MeetupLifecycle.Planned, MeetupVisibility.Visible)))
  }

  private val json = ObjectMapper()

  private def newId(): UUID = UuidV7.generator(Clock.systemUTC())()

  private def newOp(): OpId = OpId(newId())

  "the screen stream" should {

    "show a bid within a second while a hung reader holds its stream and does not delay the bid" in {
      val database = freshDatabase()
      JournalSchema.migrate(database)
      withNode(database) { node =>
        val (auction, lot) = liveFinal(node)
        val active = node.screen(auction)
        active.state(_.at("/phase").asText == "lot")
        // Подвешенный читатель: подключён и ничего не читает. Ни ставка, ни второй поток его не ждут.
        val hung = node.open(auction)
        hung.status shouldBe StatusCodes.OK

        val next = node.nextPrice(lot)
        val startedAt = System.nanoTime()
        node.bid(lot, next, participant(2))
        (System.nanoTime() - startedAt).nanos should be <= 1.second
        val raised = active.state(_.at("/lot/price/amount").asLong == next.minorUnits, within = 1.second)

        raised.at("/lot/bids/0/channel").asText shouldBe "online"
        active.cancel()
        node.discard(hung)
      }
    }

    "give a reader who reconnects after the node restarts the snapshot of the read model" in {
      val database = freshDatabase()
      JournalSchema.migrate(database)
      val (auction, lot, price) = withNode(database) { node =>
        val (auction, lot) = liveFinal(node)
        val next = node.nextPrice(lot)
        node.bid(lot, next, participant(3))
        val stream = node.screen(auction)
        stream.state(_.at("/lot/price/amount").asLong == next.minorUnits)
        stream.cancel()
        (auction, lot, next)
      }

      withNode(database) { node =>
        val again = node.screen(auction)
        val snapshot = again.state(_.at("/phase").asText == "lot")
        again.cancel()
        val stored = SlickLotViews(node.system).find(lot.value).futureValue.getOrElse(fail("lot is not in read model"))
        val trading = stored.lot.state match {
          case LotState.Trading(state) => state
          case other => fail(s"lot is not trading: $other")
        }
        snapshot.at("/lot/id").asText shouldBe lot.value.toString
        snapshot.at("/lot/price/amount").asLong shouldBe trading.currentPrice.minorUnits
        trading.currentPrice shouldBe price
      }
    }

    "refuse a stream over the limit and keep taking bids" in {
      val database = freshDatabase()
      JournalSchema.migrate(database)
      withNode(database, ConfigFactory.parseString("auction.screen.max-streams = 1")) { node =>
        val (auction, lot) = liveFinal(node)
        val held = node.screen(auction)
        held.state(_.at("/phase").asText == "lot")

        val refused = node.open(auction)
        refused.status shouldBe StatusCodes.ServiceUnavailable
        node.discard(refused)

        val startedAt = System.nanoTime()
        node.bid(lot, node.nextPrice(lot), participant(2))
        (System.nanoTime() - startedAt).nanos should be <= 1.second
        held.cancel()
      }
    }

    "show a chosen display name without a projection event" in {
      val database = freshDatabase()
      JournalSchema.migrate(database)
      withNode(database) { node =>
        val (auction, lot) = liveFinal(node)
        val bidder = participant(4)
        node.bid(lot, node.nextPrice(lot), bidder)
        val stream = node.screen(auction)
        stream.state(_.at("/lot/leader").asText.startsWith("Участник"))

        val name = TelegramUsername.from("solegoof").getOrElse(fail("username refused"))
        SlickDisplayNameStore(node.system).choose(auction, bidder, ChosenName.Telegram(name)).futureValue
        stream.state(_.at("/lot/leader").asText == "@solegoof")
        stream.cancel()
      }
    }
  }

  /** Поток экрана, разобранный на события: heartbeat пропускается, `state` читается JSON. */
  private final class ScreenReader(queue: SinkQueueWithCancel[ByteString]) {
    private var buffer = ""
    private var waiting: Option[Future[Option[ByteString]]] = None

    /** Следующее состояние, удовлетворяющее `matches`, не позже `within`; промежуточные пропускаются. */
    def state(matches: JsonNode => Boolean, within: FiniteDuration = 20.seconds): JsonNode = {
      val deadline = within.fromNow
      var found: Option[JsonNode] = None
      while (found.isEmpty) {
        if (deadline.isOverdue()) fail(s"no matching screen state within $within")
        nextEvent(deadline).foreach(event => if (matches(event)) found = Some(event))
      }
      found.get
    }

    private def nextEvent(deadline: Deadline): Option[JsonNode] = {
      val end = buffer.indexOf("\n\n")
      if (end >= 0) {
        val frame = buffer.substring(0, end)
        buffer = buffer.substring(end + 2)
        frame.linesIterator.find(_.startsWith("data: ")).map(line => json.readTree(line.stripPrefix("data: ")))
      } else {
        val pull = waiting.getOrElse(queue.pull())
        try {
          val chunk = pull.futureValue(timeout(Span(deadline.timeLeft.max(1.milli).toMillis, Millis)))
          waiting = None
          buffer += chunk.getOrElse(fail("the screen stream ended")).utf8String
        } catch {
          case _: org.scalatest.exceptions.TestFailedException if !pull.isCompleted => waiting = Some(pull)
        }
        None
      }
    }

    def cancel(): Unit = queue.cancel()
  }

  private final case class Node(
      commands: AuctionCommands,
      lots: LotGateway,
      sharding: org.apache.pekko.cluster.sharding.typed.scaladsl.ClusterSharding,
      port: Int,
      system: ActorSystem[?]
  ) {
    private given Materializer = Materializer(system)

    def open(auction: AuctionId): HttpResponse =
      Http()(using system)
        .singleRequest(HttpRequest(uri = s"http://127.0.0.1:$port/screen/${auction.value}/events"))
        .futureValue

    def discard(response: HttpResponse): Unit = response.discardEntityBytes(): Unit

    def screen(auction: AuctionId): ScreenReader = {
      val response = open(auction)
      response.status shouldBe StatusCodes.OK
      ScreenReader(response.entity.dataBytes.runWith(Sink.queue[ByteString]()))
    }

    def nextPrice(lot: LotId): Money =
      eventually {
        SlickLotViews(system).find(lot.value).futureValue.map(_.lot.state) match {
          case Some(LotState.Trading(state)) => Lot.minRequired(state, Instant.now())
          case other => fail(s"lot is not trading: $other")
        }
      }

    def bid(lot: LotId, price: Money, who: ParticipantId): Unit =
      lots
        .placeBid(lot.value, PlaceBid(who, price, newOp(), BidSource.Bot), Initiator.Participant(who))
        .futureValue
        .isRight shouldBe true
  }

  private def withNode[A](database: DatabaseSettings, overrides: Config = ConfigFactory.empty())(use: Node => A): A = {
    val kit = ActorTestKit(s"auction-screen-${UUID.randomUUID()}", overrides.withFallback(nodeConfig(database)))
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
      val changes = AuctionNode.listenChanges(kit.system)
      val binding = Http()
        .newServerAt("127.0.0.1", 0)
        .bind(AuctionNode.screen(kit.system, changes, Visible))
        .futureValue
      // gRPC-граница поднимается, как в Main, но тест ходит к лотам напрямую через шардинг.
      Http()
        .newServerAt("127.0.0.1", 0)
        .withSettings(AuctionNode.grpcServerSettings(kit.system))
        .bind(
          AuctionNode.grpc(kit.system, sharding, callers, 10.seconds, Granted, _ => Future.successful(true), changes)
        )
        .futureValue
      val lots = LotGateway.sharded(sharding, 10.seconds)
      val commands = AuctionCommands(AuctionGateway.sharded(sharding, 10.seconds), lots, Granted)
      use(Node(commands, lots, sharding, binding.localAddress.getPort, kit.system))
    } finally kit.shutdownTestKit()
  }

  /** Аукцион в живом финале с одним лотом состава — тем же путём, что `AuctionWatchIntegrationSpec`. */
  private def liveFinal(node: Node): (AuctionId, LotId) = {
    val auction = node.commands
      .draft(MeetupId(newId()), newOp(), person)
      .futureValue
      .fold(denial => fail(s"the auction was not drafted: $denial"), _.auctionId)
    val finalist = LotId(newId())
    node.commands.addLot(auction, finalist, newOp(), person).futureValue shouldBe Right(())
    node.sharding
      .entityRefFor(LotEntity.TypeKey, finalist.value.toString)
      .ask[Either[ScheduleLotRejected, Envelope]](
        LotEntity.Plan(scheduleLot(opN = 2, input = quietLot()), Initiator.Operator(person), _)
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
}
