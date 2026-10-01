package auction.grpc

import auction.AuctionNode
import auction.entity.Initiator
import auction.entity.LotEntity
import auction.entity.UuidV7
import auction.lot.*
import auction.lot.LotFixtures.*
import auction.persistence.JournalSchema
import auction.testkit.PostgresFixture
import auction.v1.auction.Money as MoneyMessage
import auction.v1.auction_service as wire
import com.typesafe.config.ConfigFactory
import identity.v1.roles.GlobalRole as GlobalRoleMessage
import io.grpc.Status
import io.grpc.StatusRuntimeException
import org.apache.pekko.actor.testkit.typed.scaladsl.ActorTestKit
import org.apache.pekko.actor.typed.ActorSystem
import org.apache.pekko.cluster.sharding.typed.scaladsl.ClusterSharding
import org.apache.pekko.grpc.GrpcClientSettings
import org.apache.pekko.grpc.scaladsl.SingleResponseRequestBuilder
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.util.Timeout
import org.scalatest.concurrent.ScalaFutures
import org.scalatest.matchers.should.Matchers
import org.scalatest.time.Seconds
import org.scalatest.time.Span
import org.scalatest.wordspec.AnyWordSpec

import java.time.Clock
import java.util.UUID
import scala.concurrent.Future
import scala.concurrent.duration.*

/**
 * Ставка через gRPC на узле, собранном так же, как в `Main`: кластер, шардинг лота, журнал и каталог на PostgreSQL и
 * граница с проверкой вызывающего. Клиент ходит по проводу с токеном бота хаба, как будет ходить бот.
 */
final class AuctionGrpcIntegrationSpec extends AnyWordSpec with Matchers with PostgresFixture with ScalaFutures {

  implicit override val patienceConfig: PatienceConfig = PatienceConfig(timeout = Span(30, Seconds))

  private val hubToken = "hub-token"

  private val callers = CallerTable
    .fromConfig(
      ConfigFactory.parseString(s"""auction.grpc.callers { telegram-bot = "$hubToken", auction-bot = "auction" }"""),
      MethodAccess.declared
    )
    .fold(reason => fail(reason), table => table)

  private final case class Node(kit: ActorTestKit, sharding: ClusterSharding, client: wire.AuctionServiceClient)

  private def withNode[A](use: Node => A): A = {
    val database = freshDatabase()
    JournalSchema.migrate(database)
    val kit = ActorTestKit(s"auction-grpc-${UUID.randomUUID()}", nodeConfig(database))
    given ActorSystem[?] = kit.system
    try {
      val clock = Clock.systemUTC()
      val sharding = AuctionNode.join(kit.system)
      AuctionNode.registerLots(sharding, clock, UuidV7.generator(clock))
      val binding = Http()
        .newServerAt("127.0.0.1", 0)
        .bind(AuctionNode.grpc(kit.system, sharding, callers, 10.seconds))
        .futureValue
      val client = wire.AuctionServiceClient(
        GrpcClientSettings.connectToServiceAt("127.0.0.1", binding.localAddress.getPort).withTls(false)
      )
      try use(Node(kit, sharding, client))
      finally client.close().futureValue
    } finally kit.shutdownTestKit()
  }

  private given Timeout = Timeout(20.seconds)

  /** Лот в торгах: рождение, планирование со стартовой ценой 100 и шагом 10, открытие. */
  private def tradingLot(node: Node): UUID = {
    val id = UuidV7.generator(Clock.systemUTC())()
    val lot = node.sharding.entityRefFor(LotEntity.TypeKey, id.toString)
    lot
      .ask[Either[DraftLotRejected, Envelope]](LotEntity.Draft(draftLot(opN = 1), Initiator.Scheduler, _))
      .futureValue
      .isRight shouldBe true
    lot
      .ask[Either[ScheduleLotRejected, Envelope]](
        LotEntity.Plan(scheduleLot(opN = 2), Initiator.Operator(participant(9)), _)
      )
      .futureValue
      .isRight shouldBe true
    lot
      .ask[Either[OpenLotRejected, Envelope]](LotEntity.Open(openLot(opN = 3), Initiator.Scheduler, _))
      .futureValue
      .isRight shouldBe true
    id
  }

  private def currentPrice(node: Node, lotId: UUID): Money =
    node.sharding.entityRefFor(LotEntity.TypeKey, lotId.toString).ask[Lot](LotEntity.Get(_)).futureValue.state match {
      case LotState.Trading(trading) => trading.currentPrice
      case other => fail(s"lot is not trading: $other")
    }

  private def viewer(roles: GlobalRoleMessage*): wire.Viewer =
    wire.Viewer(UuidV7.generator(Clock.systemUTC())().toString, roles)

  private def bid(lotId: UUID, amount: Long, who: wire.Viewer): wire.PlaceBidRequest =
    wire.PlaceBidRequest(
      Some(who),
      lotId.toString,
      Some(MoneyMessage(amount, "RUB")),
      UuidV7.generator(Clock.systemUTC())().toString
    )

  private def asHubBot[Req, Res](call: SingleResponseRequestBuilder[Req, Res]) =
    call.addHeader("authorization", s"Bearer $hubToken")

  private def statusOf(call: Future[?]): Status.Code =
    call.failed.futureValue match {
      case refused: StatusRuntimeException => refused.getStatus.getCode
      case other => fail(s"expected a status, got $other")
    }

  "auction grpc" should {

    "places a bid through the wire and leaves the new price in the lot" in withNode { node =>
      val lotId = tradingLot(node)
      val response =
        asHubBot(node.client.placeBid()).invoke(bid(lotId, 150, viewer(GlobalRoleMessage.GLOBAL_ROLE_PUBLIC)))
      response.futureValue.outcome.isAccepted shouldBe true
      currentPrice(node, lotId) shouldBe money(150)
    }

    "answers a bid below the minimum with the minimum price and leaves the price as it was" in withNode { node =>
      val lotId = tradingLot(node)
      val refused = asHubBot(node.client.placeBid())
        .invoke(bid(lotId, 105, viewer(GlobalRoleMessage.GLOBAL_ROLE_PUBLIC)))
        .futureValue
        .getRefused
      refused.getBidBelowMinimum.minRequired shouldBe Some(MoneyMessage(110, "RUB"))
      currentPrice(node, lotId) shouldBe money(100)
    }

    "refuses a viewer without the public role and leaves the lot untouched" in withNode { node =>
      val lotId = tradingLot(node)
      val call = asHubBot(node.client.placeBid()).invoke(bid(lotId, 150, viewer(GlobalRoleMessage.GLOBAL_ROLE_MEMBER)))
      statusOf(call) shouldBe Status.Code.PERMISSION_DENIED
      currentPrice(node, lotId) shouldBe money(100)
    }

    "refuses a call without a caller token before the lot is reached" in withNode { node =>
      val lotId = tradingLot(node)
      statusOf(node.client.placeBid(bid(lotId, 150, viewer(GlobalRoleMessage.GLOBAL_ROLE_PUBLIC)))) shouldBe
        Status.Code.UNAUTHENTICATED
      currentPrice(node, lotId) shouldBe money(100)
    }

    "answers NOT_FOUND to a bid on a lot that was never drafted" in withNode { node =>
      val unknown = UuidV7.generator(Clock.systemUTC())()
      val call =
        asHubBot(node.client.placeBid()).invoke(bid(unknown, 150, viewer(GlobalRoleMessage.GLOBAL_ROLE_PUBLIC)))
      statusOf(call) shouldBe Status.Code.NOT_FOUND
    }

    "creates a lot card for an administrator and answers the stored card" in withNode { node =>
      val admin = viewer(GlobalRoleMessage.GLOBAL_ROLE_ADMIN)
      val lotId = UuidV7.generator(Clock.systemUTC())().toString
      val created = asHubBot(node.client.createLotCard())
        .invoke(wire.CreateLotCardRequest(Some(admin), lotId, "Лот", "описание"))
        .futureValue
      created.getAccepted shouldBe wire.LotCard("Лот", "описание")
      val conflict = asHubBot(node.client.createLotCard())
        .invoke(wire.CreateLotCardRequest(Some(admin), lotId, "Другой", ""))
        .futureValue
      conflict.getRefused.reason.isCardConflict shouldBe true
    }
  }
}
