package auction.grpc

import auction.AuctionNode
import auction.aggregate.*
import auction.aggregate.AuctionFixtures.configInput
import auction.catalog.LotId
import auction.entity.AuctionGateway
import auction.entity.AuctionRaffle
import auction.entity.Initiator
import auction.entity.LotEntity
import auction.entity.LotGateway
import auction.entity.UuidV7
import auction.lot.AuctionId
import auction.lot.Envelope
import auction.lot.LotFixtures.scheduleLot
import auction.lot.OpId
import auction.lot.ParticipantId
import auction.lot.ScheduleLotRejected
import auction.persistence.JournalSchema
import auction.persistence.SlickPredictionStore
import auction.raffle.Beacon
import auction.raffle.RaffleEntity
import auction.raffle.RaffleTickets
import auction.raffle.Randomness
import auction.telemetry.ProjectionMetrics
import auction.testkit.PostgresFixture
import auction.v1.auction as model
import auction.v1.auction_service as wire
import com.typesafe.config.ConfigFactory
import identity.v1.access.AccessRight as AccessRightMessage
import io.grpc.Status
import io.grpc.StatusRuntimeException
import io.opentelemetry.api.OpenTelemetry
import org.apache.pekko.actor.testkit.typed.scaladsl.ActorTestKit
import org.apache.pekko.actor.typed.ActorSystem
import org.apache.pekko.cluster.sharding.typed.scaladsl.ClusterSharding
import org.apache.pekko.grpc.GrpcClientSettings
import org.apache.pekko.grpc.scaladsl.SingleResponseRequestBuilder
import org.apache.pekko.http.scaladsl.Http
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
import java.time.temporal.ChronoUnit
import java.util.UUID
import scala.concurrent.Future
import scala.concurrent.duration.*

/**
 * Участники розыгрыша и прогнозов для Notifications (`ListAuctionEngagement`, PER-777) на узле, собранном так же, как в
 * `Main`: настоящие entity аукциона, лотов, розыгрыша и прогнозов под шардингом, журнал и строки на PostgreSQL и
 * граница с проверкой вызывающего. Регистрация и прогноз идут по проводу токеном бота, чтение — токеном Notifications.
 * Meetups, Identity, маяк и снимок имён — подмены портов.
 */
final class EngagementIntegrationSpec
    extends AnyWordSpec
    with Matchers
    with PostgresFixture
    with ScalaFutures
    with Eventually {

  implicit override val patienceConfig: PatienceConfig =
    PatienceConfig(timeout = Span(30, Seconds), interval = Span(100, Millis))

  private given Timeout = Timeout(20.seconds)

  private val hubToken = "hub-token"
  private val notificationsToken = "notifications-token"

  private val callers = CallerTable
    .fromConfig(
      ConfigFactory.parseString(
        s"""auction.grpc.callers { hub-bot = "$hubToken", auction-bot = "auction", notifications = "$notificationsToken" }"""
      ),
      MethodAccess.declared
    )
    .fold(reason => fail(reason), table => table)

  private object Granted extends MeetupAuthority {
    def check(meetup: MeetupId, person: ParticipantId, correlation: Correlation): Future[Authority] =
      Future.successful(Authority.Granted(Standings.published))
  }

  private object NoNames extends RaffleTickets {
    def record(auction: AuctionId, tickets: Vector[ParticipantId]): Future[Unit] = Future.unit
    def names(auction: AuctionId): Future[Map[Int, String]] = Future.successful(Map.empty)
    def expireAt(auction: AuctionId, at: Instant): Future[Unit] = Future.unit
  }

  /** Маяк, который молчит: жеребьёвка этому сьюту не нужна. */
  private object SilentBeacon extends Beacon {
    def randomness(round: Long): Future[Option[Randomness]] = Future.successful(None)
  }

  /** Часы узла, которые тест переводит вперёд: закрытие регистрации наступает без ожидания по настоящим часам. */
  private final class MovableClock extends Clock {
    @volatile var shift: java.time.Duration = java.time.Duration.ZERO
    override def instant(): Instant = Instant.now().plus(shift)
    override def getZone: java.time.ZoneId = java.time.ZoneOffset.UTC
    override def withZone(zone: java.time.ZoneId): Clock = this
  }

  private final case class Node(
      sharding: ClusterSharding,
      commands: AuctionCommands,
      store: SlickPredictionStore,
      client: wire.AuctionServiceClient,
      clock: MovableClock
  )

  private def withNode[A](use: Node => A): A = {
    val database = freshDatabase()
    JournalSchema.migrate(database)
    val kit = ActorTestKit(s"auction-engagement-${UUID.randomUUID()}", nodeConfig(database))
    given ActorSystem[?] = kit.system
    given scala.concurrent.ExecutionContext = kit.system.executionContext
    try {
      val clock = new MovableClock
      val sharding = AuctionNode.join(kit.system)
      val store = SlickPredictionStore(kit.system)
      AuctionNode.registerLots(sharding, clock, UuidV7.generator(clock))
      AuctionNode.registerRaffles(
        kit.system,
        sharding,
        clock,
        UuidV7.generator(clock),
        _ => Future.successful(true),
        SilentBeacon,
        NoNames,
        RaffleEntity.Settings(5.seconds, 200.millis, java.time.Duration.ofDays(30), byHand = false)
      )
      val predictions = AuctionNode.registerPredictions(sharding, clock, UuidV7.generator(clock), store, 10.seconds)
      AuctionNode.registerAuctions(
        kit.system,
        sharding,
        clock,
        UuidV7.generator(clock),
        10.seconds,
        raffle = AuctionRaffle.sharded(sharding, 10.seconds),
        predictions = predictions
      )
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
            AuctionNode.listenChanges(kit.system),
            clock = clock
          )
        )
        .futureValue
      val client = wire.AuctionServiceClient(
        GrpcClientSettings.connectToServiceAt("127.0.0.1", binding.localAddress.getPort).withTls(false)
      )
      val lots = LotGateway.sharded(sharding, 10.seconds)
      val commands = AuctionCommands(AuctionGateway.sharded(sharding, 10.seconds), lots, Granted)
      try use(Node(sharding, commands, store, client, clock))
      finally client.close().futureValue
    } finally kit.shutdownTestKit()
  }

  private val ids = UuidV7.generator(Clock.systemUTC())

  private def newOp(): OpId = OpId(ids())

  private val admin = ParticipantId(ids())

  private val raffleClosesAt: Instant = Instant.now().plus(10, ChronoUnit.MINUTES).truncatedTo(ChronoUnit.SECONDS)

  private val week = OnlinePhase(
    Instant.now().minusSeconds(3600),
    Some(Instant.now().plus(30, ChronoUnit.DAYS).truncatedTo(ChronoUnit.SECONDS)),
    closesLots = true,
    raffleClosesAt = Some(raffleClosesAt)
  )

  /** Запланированный аукцион сходки с розыгрышем и лотом в реестре: каталог прогнозов открыт, розыгрыш — нет. */
  private def scheduled(node: Node): AuctionId = {
    val auction = node.commands
      .draft(MeetupId(UUID.randomUUID()), newOp(), admin)
      .futureValue
      .fold(denial => fail(s"the auction was not drafted: $denial"), _.auctionId)
    val lot = LotId(UUID.randomUUID())
    node.commands.addLot(auction, lot, newOp(), admin).futureValue shouldBe Right(())
    node.sharding
      .entityRefFor(LotEntity.TypeKey, lot.value.toString)
      .ask[Either[ScheduleLotRejected, Envelope]](LotEntity.Plan(scheduleLot(opN = 2), Initiator.Operator(admin), _))
      .futureValue
      .isRight shouldBe true
    node.commands.schedule(auction, configInput(Some(week)), newOp(), admin).futureValue shouldBe Right(())
    auction
  }

  private def viewer(who: ParticipantId) =
    wire.Viewer(who.value.toString, rights = Seq(AccessRightMessage.ACCESS_RIGHT_PLACE_BIDS))

  private def asHubBot[Req, Res](call: SingleResponseRequestBuilder[Req, Res]) =
    call.addHeader("authorization", s"Bearer $hubToken")

  private def asNotifications[Req, Res](call: SingleResponseRequestBuilder[Req, Res]) =
    call.addHeader("authorization", s"Bearer $notificationsToken")

  private def engagement(node: Node, auction: AuctionId): wire.ListAuctionEngagementResponse =
    asNotifications(node.client.listAuctionEngagement())
      .invoke(wire.ListAuctionEngagementRequest(auction.value.toString))
      .futureValue

  private def named(node: Node, auction: AuctionId, who: ParticipantId): Unit =
    asHubBot(node.client.chooseDisplayName())
      .invoke(
        wire.ChooseDisplayNameRequest(
          Some(viewer(who)),
          auction.value.toString,
          wire.ChooseDisplayNameRequest.Choice.Alias(s"guest-${who.value.toString.takeRight(6)}")
        )
      )
      .futureValue
      .outcome
      .isAccepted shouldBe true

  private def register(node: Node, auction: AuctionId, who: ParticipantId): Unit =
    asHubBot(node.client.registerForRaffle())
      .invoke(wire.RegisterForRaffleRequest(Some(viewer(who)), auction.value.toString, newOp().value.toString))
      .futureValue
      .outcome
      .isAccepted shouldBe true

  private def cancel(node: Node, auction: AuctionId, who: ParticipantId): Unit =
    asHubBot(node.client.cancelRaffleRegistration())
      .invoke(
        wire.CancelRaffleRegistrationRequest(Some(viewer(who)), auction.value.toString, newOp().value.toString)
      )
      .futureValue
      .outcome
      .isAccepted shouldBe true

  private def predict(node: Node, auction: AuctionId, who: ParticipantId, answers: Seq[wire.PredictionAnswer]) =
    asHubBot(node.client.submitPrediction())
      .invoke(
        wire.SubmitPredictionRequest(
          Some(viewer(who)),
          auction.value.toString,
          wire.PredictionRound.PREDICTION_ROUND_CATALOG,
          answers,
          newOp().value.toString
        )
      )
      .futureValue
      .outcome
      .isAccepted shouldBe true

  private val totalBids =
    Seq(
      wire.PredictionAnswer(
        model.PredictionNomination.PREDICTION_NOMINATION_TOTAL_BIDS,
        wire.PredictionAnswer.Answer.Number(120)
      )
    )

  private def statusOf(call: => Future[?]): Status.Code =
    call.failed.futureValue match {
      case failure: StatusRuntimeException => failure.getStatus.getCode
      case other => fail(s"expected a gRPC status, got $other")
    }

  "the engagement read" should {

    "show registration, its cancellation, a prediction and its clearing at once, and close registration at T" in
      withNode { node =>
        val auction = scheduled(node)
        val registrant = ParticipantId(ids())
        val forecaster = ParticipantId(ids())

        // Каталог открывает entity аукциона после записи планирования, а не в ответе на команду.
        eventually {
          val before = engagement(node, auction)
          before.raffleRegistration shouldBe wire.RaffleRegistration.RAFFLE_REGISTRATION_NOT_OPEN
          before.raffleRegistrants shouldBe empty
          before.openPredictionRound shouldBe Some(wire.PredictionRound.PREDICTION_ROUND_CATALOG)
          before.forecasters shouldBe empty
        }

        node.commands.startPrebidding(auction, newOp(), admin).futureValue shouldBe Right(())
        eventually {
          engagement(node, auction).raffleRegistration shouldBe wire.RaffleRegistration.RAFFLE_REGISTRATION_OPEN
        }

        named(node, auction, registrant)
        register(node, auction, registrant)
        engagement(node, auction).raffleRegistrants shouldBe Seq(registrant.value.toString)
        cancel(node, auction, registrant)
        engagement(node, auction).raffleRegistrants shouldBe empty
        register(node, auction, registrant)

        named(node, auction, forecaster)
        predict(node, auction, forecaster, totalBids)
        engagement(node, auction).forecasters shouldBe Seq(forecaster.value.toString)
        predict(node, auction, forecaster, Nil)
        engagement(node, auction).forecasters shouldBe empty

        node.clock.shift = java.time.Duration.between(Instant.now(), raffleClosesAt.plusSeconds(1))
        val after = engagement(node, auction)
        after.raffleRegistration shouldBe wire.RaffleRegistration.RAFFLE_REGISTRATION_CLOSED
        after.raffleRegistrants shouldBe empty
        after.openPredictionRound shouldBe Some(wire.PredictionRound.PREDICTION_ROUND_CATALOG)
      }

    "leave out a subject whose predictions were erased" in withNode { node =>
      val auction = scheduled(node)
      val erased = ParticipantId(ids())
      val kept = ParticipantId(ids())
      eventually(
        engagement(node, auction).openPredictionRound shouldBe Some(wire.PredictionRound.PREDICTION_ROUND_CATALOG)
      )
      Seq(erased, kept).foreach { who =>
        named(node, auction, who)
        predict(node, auction, who, totalBids)
      }
      engagement(node, auction).forecasters.toSet shouldBe Set(erased.value.toString, kept.value.toString)

      node.store.erase(erased).futureValue

      engagement(node, auction).forecasters shouldBe Seq(kept.value.toString)
    }

    "answer NOT_FOUND for an auction without a journal" in withNode { node =>
      val unknown = Auction.idOf(MeetupId(UUID.randomUUID()))
      statusOf(
        asNotifications(node.client.listAuctionEngagement())
          .invoke(wire.ListAuctionEngagementRequest(unknown.value.toString))
      ) shouldBe Status.Code.NOT_FOUND
    }

    "admit Notifications only: a bot token is refused, and Notifications reaches no bot method" in withNode { node =>
      val auction = scheduled(node)
      Seq(hubToken, "auction").foreach { token =>
        statusOf(
          node.client
            .listAuctionEngagement()
            .addHeader("authorization", s"Bearer $token")
            .invoke(wire.ListAuctionEngagementRequest(auction.value.toString))
        ) shouldBe Status.Code.UNAUTHENTICATED
      }
      statusOf(
        asNotifications(node.client.getRaffle())
          .invoke(wire.GetRaffleRequest(Some(viewer(admin)), auction.value.toString))
      ) shouldBe Status.Code.UNAUTHENTICATED
    }
  }
}
