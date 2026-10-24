package auction.grpc

import auction.v1.auction_service as wire
import ch.qos.logback.classic.Logger as LogbackLogger
import ch.qos.logback.classic.spi.ILoggingEvent
import ch.qos.logback.core.read.ListAppender
import com.typesafe.config.ConfigFactory
import io.grpc.Status
import org.apache.pekko.Done
import org.apache.pekko.NotUsed
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
import org.apache.pekko.stream.scaladsl.Keep
import org.apache.pekko.stream.scaladsl.Sink
import org.apache.pekko.stream.scaladsl.Source
import org.apache.pekko.stream.scaladsl.Tcp
import org.apache.pekko.util.ByteString

import java.nio.ByteBuffer
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicLong
import org.scalatest.BeforeAndAfterAll
import org.scalatest.BeforeAndAfterEach
import org.scalatest.concurrent.Eventually
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
    with Eventually
    with BeforeAndAfterAll
    with BeforeAndAfterEach {

  implicit override val patienceConfig: PatienceConfig = PatienceConfig(timeout = Span(10, Seconds))

  private val kit = ActorTestKit(
    "grpc-boundary",
    ConfigFactory
      // Keepalive клиента pekko-http (PER-705) сжат до долей секунды: PING после 100 мс тишины.
      .parseString("""
        pekko.actor.provider = local
        pekko.http.client.http2 { ping-interval = 100ms, ping-timeout = 100ms }
      """)
      .withFallback(ConfigFactory.load())
  )

  private given ActorSystem[?] = kit.system

  private val table = CallerTable
    .fromConfig(
      ConfigFactory.parseString("""auction.grpc.callers { hub-bot = "hub", auction-bot = "auction" }"""),
      MethodAccess.declared
    )
    .fold(reason => fail(reason), table => table)

  /** Конец каждого открытого потока `open` в порядке открытия: по нему видно, что сервер поток отпустил. */
  private val watchEnds = ConcurrentLinkedQueue[Future[Done]]()

  /** Заглушка сервиса: ставка принимается, чтение падает неожиданно, остальное не вызывается. */
  private object Stub extends wire.AuctionService {
    private def unused[T]: Future[T] = Future.failed(new GrpcServiceException(Status.UNIMPLEMENTED))
    def placeBid(in: wire.PlaceBidRequest) =
      Future.successful(wire.PlaceBidResponse().withAccepted(wire.BidAccepted("b")))
    def getLot(in: wire.GetLotRequest) = Future.failed(new IllegalStateException("secret title in the message"))
    def setProxyLimit(in: wire.SetProxyLimitRequest) = unused
    def withdrawProxyLimit(in: wire.WithdrawProxyLimitRequest) = unused
    def selectForFinal(in: wire.SelectForFinalRequest) = unused
    def deselectForFinal(in: wire.DeselectForFinalRequest) = unused
    def previewParticipantRemoval(in: wire.PreviewParticipantRemovalRequest) = unused
    def removeParticipant(in: wire.RemoveParticipantRequest) = unused
    def launchStepWindow(in: wire.LaunchStepWindowRequest) = unused
    def freezeFinalLineup(in: wire.FreezeFinalLineupRequest) = unused
    def startFinal(in: wire.StartFinalRequest) = unused
    def startNextLot(in: wire.StartNextLotRequest) = unused
    def advanceAsk(in: wire.AdvanceAskRequest) = unused
    def closeLot(in: wire.CloseLotRequest) = unused
    def watchAuction(in: wire.WatchAuctionRequest) =
      if (in.auctionId == "open")
        Source
          .single(wire.AuctionWatch())
          .concat(Source.never)
          .watchTermination() { (_, done) =>
            watchEnds.add(done)
            NotUsed
          }
      else Source.failed(new GrpcServiceException(Status.UNIMPLEMENTED))
    def getAuctionConsole(in: wire.GetAuctionConsoleRequest) = unused
    def getAuctionLotStatistics(in: wire.GetAuctionLotStatisticsRequest) = unused
    def getAuctionDaySummary(in: wire.GetAuctionDaySummaryRequest) = unused
    def createLotCard(in: wire.CreateLotCardRequest) = unused
    def editLotCard(in: wire.EditLotCardRequest) = unused
    def listAuctionLots(in: wire.ListAuctionLotsRequest) = unused
    def listLotHistory(in: wire.ListLotHistoryRequest) = unused
    def chooseDisplayName(in: wire.ChooseDisplayNameRequest) = unused
    def getDisplayNames(in: wire.GetDisplayNamesRequest) = unused
    def listAuctionNames(in: wire.ListAuctionNamesRequest) = unused
    def getFaqAcknowledgement(in: wire.GetFaqAcknowledgementRequest) = unused
    def acknowledgeFaq(in: wire.AcknowledgeFaqRequest) = unused
    def getLotImage(in: wire.GetLotImageRequest) = unused
    def addLotPhoto(in: wire.AddLotPhotoRequest) = unused
    def removeLotPhoto(in: wire.RemoveLotPhotoRequest) = unused
    def getLotPhoto(in: wire.GetLotPhotoRequest) = unused
    def draftAuction(in: wire.DraftAuctionRequest) = unused
    def addLot(in: wire.AddLotRequest) = unused
    def removeLot(in: wire.RemoveLotRequest) = unused
    def saveLotSet(in: wire.SaveLotSetRequest) = unused
    def deleteLotSet(in: wire.DeleteLotSetRequest) = unused
    def scheduleLot(in: wire.ScheduleLotRequest) = unused
    def scheduleAuction(in: wire.ScheduleAuctionRequest) = unused
    def startPrebidding(in: wire.StartPrebiddingRequest) = unused
    def discardAuction(in: wire.DiscardAuctionRequest) = unused
    def publishAuction(in: wire.PublishAuctionRequest) = unused
    def hideAuction(in: wire.HideAuctionRequest) = unused
    def cancelAuction(in: wire.CancelAuctionRequest) = unused
    def setFinalTime(in: wire.SetFinalTimeRequest) = unused
    def getMeetupAuction(in: wire.GetMeetupAuctionRequest) = unused
    def getAuction(in: wire.GetAuctionRequest) = unused
    def listAuctions(in: wire.ListAuctionsRequest) = unused
    def registerForRaffle(in: wire.RegisterForRaffleRequest) = unused
    def cancelRaffleRegistration(in: wire.CancelRaffleRegistrationRequest) = unused
    def getRaffle(in: wire.GetRaffleRequest) = unused
    def assignRaffleWinner(in: wire.AssignRaffleWinnerRequest) = unused
    def submitPrediction(in: wire.SubmitPredictionRequest) = unused
    def getMyPredictions(in: wire.GetMyPredictionsRequest) = unused
    def getPredictionResults(in: wire.GetPredictionResultsRequest) = unused
    def settlePredictionResultsManually(in: wire.SettlePredictionResultsManuallyRequest) = unused
    def markInvoicePaid(in: wire.MarkInvoicePaidRequest) = unused
    def markInvoiceHandedOver(in: wire.MarkInvoiceHandedOverRequest) = unused
    def chooseFulfillment(in: wire.ChooseFulfillmentRequest) = unused
    def listMyInvoices(in: wire.ListMyInvoicesRequest) = unused
    def listAuctionInvoices(in: wire.ListAuctionInvoicesRequest) = unused
    def setPaymentInstructions(in: wire.SetPaymentInstructionsRequest) = unused
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

    "adds the fields the service noted to its record without letting them replace the frame" in {
      val noting = GrpcBoundary(
        table,
        (_: Caller, _: auction.aggregate.Correlation, notes: OperationNotes) => {
          notes.add(OperationNotes.Source, "FLOOR")
          notes.add("result", "forged")
          Stub
        }
      )
      val request = HttpRequest(
        method = HttpMethods.POST,
        uri = "/auction.v1.AuctionService/PlaceBid",
        headers = List(RawHeader("authorization", "Bearer hub")),
        entity = HttpEntity(
          ContentType(MediaType.customBinary("application", "grpc", MediaType.NotCompressible)),
          ByteString(0.toByte) ++ ByteString(ByteBuffer.allocate(4).putInt(bid.serializedSize).array()) ++
            ByteString(bid.toByteArray)
        ),
        protocol = HttpProtocols.`HTTP/2.0`
      )
      // Успешный унарный ответ несёт grpc-status трейлером в теле, а не заголовком: код читается из записи.
      noting(request).futureValue.discardEntityBytes()
      val written = record
      written("grpc_code") shouldBe "OK"
      written("source") shouldBe "FLOOR"
      written("result") shouldBe "ok"
    }

    "admits the hub bot to lot statistics with its token" in {
      statusOf(
        client
          .getAuctionLotStatistics()
          .addHeader("authorization", "Bearer hub")
          .invoke(wire.GetAuctionLotStatisticsRequest())
      ) shouldBe Status.Code.UNIMPLEMENTED
      val written = record
      written("operation") shouldBe "auction.v1.AuctionService/GetAuctionLotStatistics"
      written("grpc_code") shouldBe "UNIMPLEMENTED"
      written("caller") shouldBe "hub-bot"
    }

    "records a stream that the service refused with its status and caller" in {
      statusOf(
        client
          .watchAuction()
          .addHeader("authorization", "Bearer auction")
          .invoke(wire.WatchAuctionRequest())
          .runWith(Sink.seq)
      ) shouldBe Status.Code.UNIMPLEMENTED
      eventually {
        val written = record
        written("operation") shouldBe "auction.v1.AuctionService/WatchAuction"
        written("grpc_code") shouldBe "UNIMPLEMENTED"
        written("caller") shouldBe "auction-bot"
      }
    }

    "records a stream the client closed once, when its body ends" in {
      client
        .watchAuction()
        .addHeader("authorization", "Bearer hub")
        .invoke(wire.WatchAuctionRequest(auctionId = "open"))
        .take(1)
        .runWith(Sink.seq)
        .futureValue should have size 1
      eventually {
        val written = record
        written("operation") shouldBe "auction.v1.AuctionService/WatchAuction"
        written("grpc_code") shouldBe "OK"
        written("caller") shouldBe "hub-bot"
      }
    }

    "answers UNAUTHENTICATED to a stream without a token" in {
      statusOf(client.watchAuction().invoke(wire.WatchAuctionRequest()).runWith(Sink.seq)) shouldBe
        Status.Code.UNAUTHENTICATED
      eventually(record("grpc_code") shouldBe "UNAUTHENTICATED")
    }

    "refuses the commands of the final to the auction bot before reaching the service" in {
      statusOf(
        client
          .startFinal()
          .addHeader("authorization", "Bearer auction")
          .invoke(wire.StartFinalRequest())
      ) shouldBe Status.Code.UNAUTHENTICATED
      record("caller_refusal") shouldBe "not_declared"
    }

    "refuses lot statistics to the auction bot before reaching the service" in {
      statusOf(
        client
          .getAuctionLotStatistics()
          .addHeader("authorization", "Bearer auction")
          .invoke(wire.GetAuctionLotStatisticsRequest())
      ) shouldBe Status.Code.UNAUTHENTICATED
      val written = record
      written("caller_refusal") shouldBe "not_declared"
      written("caller") shouldBe "auction-bot"
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

  private def openWatch(through: wire.AuctionServiceClient): (Future[Done], Future[Done]) = {
    val opened = watchEnds.size
    val stream = through
      .watchAuction()
      .addHeader("authorization", "Bearer hub")
      .invoke(wire.WatchAuctionRequest(auctionId = "open"))
      .runWith(Sink.ignore)
    eventually(watchEnds.size shouldBe opened + 1)
    (stream, watchEnds.asScala.last)
  }

  // Полуоткрытое соединение замечает клиент своим PING (PER-705): сервер обязан на них отвечать, сколько бы их ни было.
  "grpc boundary keepalive" should {

    "keeps a watch open under the pings of a client far more frequent than the hub bot's" in {
      // Ответы сервера клиенту: PING ACK — 17 байт кадра. Сам сервер не пингует, а поток после первого сообщения
      // молчит, поэтому байты ответа за паузу — ответы на PING клиента: их там раз в 100 мс.
      val answered = AtomicLong(0)
      val relay = Tcp(kit.system)
        .bind("127.0.0.1", 0)
        .toMat(Sink.foreach { incoming =>
          incoming.handleWith(
            Tcp(kit.system).outgoingConnection("127.0.0.1", binding.localAddress.getPort).map { chunk =>
              answered.addAndGet(chunk.length.toLong)
              chunk
            }
          )
        })(Keep.left)
        .run()
        .futureValue
      val pinging = wire.AuctionServiceClient(
        GrpcClientSettings
          .connectToServiceAt("127.0.0.1", relay.localAddress.getPort)
          .withTls(false)
          .withBackend("pekko-http")
      )
      try {
        val (stream, released) = openWatch(pinging)
        val before = answered.get
        Thread.sleep(2000)
        (answered.get - before) should be >= 10L * 17
        stream.isCompleted shouldBe false
        released.isCompleted shouldBe false
      } finally {
        pinging.close().futureValue
        relay.unbind().futureValue
      }
    }
  }
}
