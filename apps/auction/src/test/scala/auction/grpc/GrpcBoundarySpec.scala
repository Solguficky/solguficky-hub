package auction.grpc

import auction.v1.auction_service as wire
import ch.qos.logback.classic.Logger as LogbackLogger
import ch.qos.logback.classic.spi.ILoggingEvent
import ch.qos.logback.core.read.ListAppender
import com.typesafe.config.ConfigFactory
import io.grpc.Status
import org.apache.pekko.actor.testkit.typed.scaladsl.ActorTestKit
import org.apache.pekko.actor.typed.ActorSystem
import org.apache.pekko.grpc.GrpcClientSettings
import org.apache.pekko.grpc.GrpcServiceException
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model.ContentType
import org.apache.pekko.http.scaladsl.model.ContentTypes
import org.apache.pekko.http.scaladsl.model.HttpEntity
import org.apache.pekko.http.scaladsl.model.HttpMethods
import org.apache.pekko.http.scaladsl.model.HttpProtocols
import org.apache.pekko.http.scaladsl.model.HttpRequest
import org.apache.pekko.http.scaladsl.model.HttpResponse
import org.apache.pekko.http.scaladsl.model.MediaType
import org.apache.pekko.http.scaladsl.model.headers.RawHeader
import org.apache.pekko.util.ByteString

import java.nio.ByteBuffer
import org.scalatest.BeforeAndAfterAll
import org.scalatest.BeforeAndAfterEach
import org.scalatest.concurrent.ScalaFutures
import org.scalatest.matchers.should.Matchers
import org.scalatest.time.Seconds
import org.scalatest.time.Span
import org.scalatest.wordspec.AnyWordSpec
import org.slf4j.LoggerFactory

import scala.annotation.tailrec
import scala.concurrent.Future
import scala.jdk.CollectionConverters.*

/**
 * Граница на настоящем сервере и настоящем клиенте, но без базы и шардинга: сервис за ней — заглушка. Так проверяется
 * то, что видит вызывающий по проводу, — код в трейлерах, — и то, что граница пишет в журнал.
 */
final class GrpcBoundarySpec
    extends AnyWordSpec
    with Matchers
    with ScalaFutures
    with BeforeAndAfterAll
    with BeforeAndAfterEach {

  implicit override val patienceConfig: PatienceConfig = PatienceConfig(timeout = Span(10, Seconds))

  private val kit = ActorTestKit(
    "grpc-boundary",
    ConfigFactory
      .parseString("pekko.actor.provider = local")
      .withFallback(ConfigFactory.load())
  )

  private given ActorSystem[?] = kit.system

  private val table = CallerTable
    .fromConfig(
      ConfigFactory.parseString("""auction.grpc.callers { hub-bot = "hub", auction-bot = "auction" }"""),
      MethodAccess.declared
    )
    .fold(reason => fail(reason), table => table)

  /** Заглушка сервиса: ставка принимается, чтение падает неожиданно, остальное не вызывается. */
  private object Stub extends wire.AuctionService {
    private def unused[T]: Future[T] = Future.failed(new GrpcServiceException(Status.UNIMPLEMENTED))
    def placeBid(in: wire.PlaceBidRequest) =
      Future.successful(wire.PlaceBidResponse().withAccepted(wire.BidAccepted("b")))
    def getLot(in: wire.GetLotRequest) = Future.failed(new IllegalStateException("secret title in the message"))
    def setProxyLimit(in: wire.SetProxyLimitRequest) = unused
    def withdrawProxyLimit(in: wire.WithdrawProxyLimitRequest) = unused
    def createLotCard(in: wire.CreateLotCardRequest) = unused
    def editLotCard(in: wire.EditLotCardRequest) = unused
    def listAuctionLots(in: wire.ListAuctionLotsRequest) = unused
    def listLotHistory(in: wire.ListLotHistoryRequest) = unused
    def chooseDisplayName(in: wire.ChooseDisplayNameRequest) = unused
    def getDisplayNames(in: wire.GetDisplayNamesRequest) = unused
    def getFaqAcknowledgement(in: wire.GetFaqAcknowledgementRequest) = unused
    def acknowledgeFaq(in: wire.AcknowledgeFaqRequest) = unused
    def getLotImage(in: wire.GetLotImageRequest) = unused
    def draftAuction(in: wire.DraftAuctionRequest) = unused
    def addLot(in: wire.AddLotRequest) = unused
    def removeLot(in: wire.RemoveLotRequest) = unused
    def getMeetupAuction(in: wire.GetMeetupAuctionRequest) = unused
    def listAuctions(in: wire.ListAuctionsRequest) = unused
    def markInvoicePaid(in: wire.MarkInvoicePaidRequest) = unused
    def markInvoiceHandedOver(in: wire.MarkInvoiceHandedOverRequest) = unused
    def chooseFulfillment(in: wire.ChooseFulfillmentRequest) = unused
    def listMyInvoices(in: wire.ListMyInvoicesRequest) = unused
    def listAuctionInvoices(in: wire.ListAuctionInvoicesRequest) = unused
  }

  private lazy val binding =
    Http().newServerAt("127.0.0.1", 0).bind(GrpcBoundary(table, Stub)).futureValue

  private lazy val client = wire.AuctionServiceClient(
    GrpcClientSettings.connectToServiceAt("127.0.0.1", binding.localAddress.getPort).withTls(false)
  )

  private val appender = new ListAppender[ILoggingEvent]()

  // То же ожидание, что в BoundaryLoggingSpec: пока SLF4J инициализирует backend,
  // он отдаёт SubstituteLogger, и приведение к logback падает.
  private lazy val boundaryLogger: LogbackLogger = {
    @tailrec
    def resolve(attemptsLeft: Int): LogbackLogger =
      LoggerFactory.getLogger(GrpcBoundary.getClass.getName) match {
        case logback: LogbackLogger => logback
        case _ if attemptsLeft > 0 =>
          Thread.sleep(50)
          resolve(attemptsLeft - 1)
        case other => fail(s"slf4j did not settle on logback: ${other.getClass.getName}")
      }
    resolve(attemptsLeft = 40)
  }

  override def beforeEach(): Unit = {
    appender.list.clear()
    appender.start()
    boundaryLogger.addAppender(appender)
  }

  override def afterEach(): Unit = {
    boundaryLogger.detachAppender(appender)
    appender.stop()
  }

  override def afterAll(): Unit = {
    client.close().futureValue
    kit.shutdownTestKit()
  }

  private def record: Map[String, String] = {
    val events = appender.list.asScala.toList
    events should have size 1
    events.head.getArgumentArray.head.toString
      .stripPrefix("{")
      .stripSuffix("}")
      .split(", ")
      .map(_.split("=", 2))
      .collect { case Array(key, value) => key -> value }
      .toMap
  }

  private def statusOf(call: Future[?]): Status.Code =
    call.failed.futureValue match {
      case refused: io.grpc.StatusRuntimeException => refused.getStatus.getCode
      case other => fail(s"expected a status, got $other")
    }

  private val bid = wire.PlaceBidRequest()

  private lazy val boundary = GrpcBoundary(table, Stub)

  /**
   * Запрос, которого сгенерированный клиент не пошлёт: чужой метод, битое тело, чужой content-type. Он идёт в функцию
   * границы напрямую, в кадрировании gRPC — флаг сжатия, длина и тело.
   */
  private def raw(
      method: String,
      payload: Array[Byte],
      authorization: Option[String],
      contentType: ContentType = ContentType(MediaType.customBinary("application", "grpc", MediaType.NotCompressible))
  ): HttpResponse = {
    val framed = ByteString(0.toByte) ++ ByteString(ByteBuffer.allocate(4).putInt(payload.length).array()) ++
      ByteString(payload)
    val request = HttpRequest(
      method = HttpMethods.POST,
      uri = s"/auction.v1.AuctionService/$method",
      headers = authorization.map(value => RawHeader("authorization", value)).toList,
      entity = HttpEntity(contentType, framed),
      protocol = HttpProtocols.`HTTP/2.0`
    )
    boundary(request).futureValue
  }

  private def grpcStatusOf(response: HttpResponse): Option[String] =
    response.headers.find(_.is("grpc-status")).map(_.value())

  private val malformed = Array(0xff.toByte, 0xff.toByte, 0xff.toByte)

  "grpc boundary" should {

    "passes a declared caller to the service and records it with OK" in {
      client
        .placeBid()
        .addHeader("authorization", "Bearer hub")
        .addHeader("x-request-id", "req-7")
        .invoke(bid)
        .futureValue
        .getAccepted
        .bidId shouldBe "b"
      val written = record
      written("operation") shouldBe "auction.v1.AuctionService/PlaceBid"
      written("grpc_code") shouldBe "OK"
      written("caller") shouldBe "hub-bot"
      written("request_id") shouldBe "req-7"
    }

    "answers UNAUTHENTICATED to a call without a token and records the reason" in {
      statusOf(client.placeBid(bid)) shouldBe Status.Code.UNAUTHENTICATED
      val written = record
      written("caller_refusal") shouldBe "missing_token"
      written("error_category") shouldBe "authorization"
      written.keySet should not contain "caller"
    }

    "answers UNAUTHENTICATED to a token no caller holds and keeps the token out of the record" in {
      statusOf(client.placeBid().addHeader("authorization", "Bearer stolen-value").invoke(bid)) shouldBe
        Status.Code.UNAUTHENTICATED
      val entry = appender.list.asScala.head.getArgumentArray.head.toString
      record("caller_refusal") shouldBe "unknown_token"
      entry should not include "stolen-value"
    }

    "answers INTERNAL to an unexpected failure and records its class without its message" in {
      statusOf(client.getLot().addHeader("authorization", "Bearer auction").invoke(wire.GetLotRequest())) shouldBe
        Status.Code.INTERNAL
      val written = record
      written("grpc_code") shouldBe "INTERNAL"
      written("error") shouldBe "java.lang.IllegalStateException"
      written("caller") shouldBe "auction-bot"
      appender.list.asScala.head.getArgumentArray.head.toString should not include "secret title"
    }

    "answers UNAUTHENTICATED to a malformed body without a token rather than an unexpected failure" in {
      grpcStatusOf(raw("PlaceBid", malformed, None)) shouldBe Some(Status.Code.UNAUTHENTICATED.value.toString)
      val written = record
      written("grpc_code") shouldBe "UNAUTHENTICATED"
      written.keySet should not contain "stack"
    }

    "answers INVALID_ARGUMENT to a malformed body from a declared caller without a stack" in {
      grpcStatusOf(raw("PlaceBid", malformed, Some("Bearer hub"))) shouldBe
        Some(Status.Code.INVALID_ARGUMENT.value.toString)
      val written = record
      written("grpc_code") shouldBe "INVALID_ARGUMENT"
      written.keySet should not contain "stack"
    }

    "refuses a method the contract does not have as not declared and records it as unmatched" in {
      raw("Nope", Array.emptyByteArray, Some("Bearer hub"))
      val written = record
      written("operation") shouldBe "<unmatched>"
      written("grpc_code") shouldBe "UNAUTHENTICATED"
      written("caller_refusal") shouldBe "not_declared"
      written.keySet should not contain "stack"
    }

    "records a request with a foreign content type as an error, not as OK" in {
      val response = raw("PlaceBid", Array.emptyByteArray, Some("Bearer hub"), ContentTypes.`application/json`)
      response.status.intValue should not be 200
      val written = record
      written("result") shouldBe "error"
      written("grpc_code") should not be "OK"
    }
  }
}
