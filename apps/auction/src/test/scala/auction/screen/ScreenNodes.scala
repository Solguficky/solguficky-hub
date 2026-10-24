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
import auction.persistence.DatabaseSettings
import auction.persistence.SlickLotViews
import auction.telemetry.ProjectionMetrics
import auction.testkit.PostgresFixture
import com.typesafe.config.Config
import com.typesafe.config.ConfigFactory
import io.opentelemetry.api.OpenTelemetry
import org.apache.pekko.actor.testkit.typed.scaladsl.ActorTestKit
import org.apache.pekko.actor.typed.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.util.Timeout
import org.scalatest.Suite
import org.scalatest.concurrent.Eventually
import org.scalatest.concurrent.ScalaFutures
import org.scalatest.matchers.should.Matchers

import java.time.Clock
import java.time.Duration
import java.time.Instant
import java.util.UUID
import scala.concurrent.Future
import scala.concurrent.duration.*

/**
 * Узел для сьютов экрана зала, собранный так же, как в `Main`: HTTP-граница с маршрутами экрана, сигнал проекций через
 * настоящий `LISTEN`/`NOTIFY` и состояние из настоящей read model. Meetups подменён ответом сьюта — по умолчанию
 * «сходка видна»: провод к нему держат L0 адаптера и контур.
 */
trait ScreenNodes { self: Suite & Matchers & ScalaFutures & Eventually & PostgresFixture =>

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

  protected object Visible extends MeetupStandings {
    def standing(meetup: UUID): Future[StandingAnswer] =
      Future.successful(StandingAnswer.Found(MeetupStanding(MeetupLifecycle.Planned, MeetupVisibility.Visible)))
  }

  private def newId(): UUID = UuidV7.generator(Clock.systemUTC())()

  private def newOp(): OpId = OpId(newId())

  protected final case class Node(
      commands: AuctionCommands,
      lots: LotGateway,
      sharding: org.apache.pekko.cluster.sharding.typed.scaladsl.ClusterSharding,
      port: Int,
      system: ActorSystem[?]
  ) {

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

    /** Администратор выставляет, меняет или снимает ориентировочное время финала (PER-663). */
    def finalTime(auction: AuctionId, at: Option[Instant]): Unit =
      commands.setFinalTime(auction, at, newOp(), person).futureValue shouldBe Right(())

    /** Ведущий закрывает лот финала; за последним лотом состава аукцион завершается (PER-607). */
    def close(auction: AuctionId, lot: LotId): Unit =
      commands.closeLot(auction, lot, newOp(), person).futureValue.isRight shouldBe true
  }

  protected def withNode[A](
      database: DatabaseSettings,
      overrides: Config = ConfigFactory.empty(),
      standings: MeetupStandings = Visible
  )(use: Node => A): A = {
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
        .bind(AuctionNode.screen(kit.system, changes, standings))
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

  /** Аукцион-черновик: экран показывает его как предстоящий с финалом. */
  protected def drafted(node: Node): AuctionId =
    node.commands
      .draft(MeetupId(newId()), newOp(), person)
      .futureValue
      .fold(denial => fail(s"the auction was not drafted: $denial"), _.auctionId)

  /** Аукцион в живом финале с одним лотом состава — тем же путём, что `AuctionWatchIntegrationSpec`. */
  protected def liveFinal(node: Node): (AuctionId, LotId) = {
    val auction = drafted(node)
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
