package auction.grpc

import auction.aggregate.Correlation

import auction.boundary.OperationFrame
import auction.v1.auction_service.AuctionService
import auction.v1.auction_service.AuctionServiceHandler
import io.grpc.Status
import net.logstash.logback.argument.StructuredArguments
import org.apache.pekko.NotUsed
import org.apache.pekko.actor.typed.ActorSystem
import org.apache.pekko.grpc.GrpcServiceException
import org.apache.pekko.grpc.Trailers
import org.apache.pekko.http.scaladsl.model.HttpEntity
import org.apache.pekko.http.scaladsl.model.HttpRequest
import org.apache.pekko.http.scaladsl.model.HttpResponse
import org.apache.pekko.stream.scaladsl.Source
import org.slf4j.LoggerFactory

import com.google.protobuf.InvalidProtocolBufferException

import java.util.concurrent.CompletionException
import java.util.concurrent.ExecutionException
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import scala.concurrent.ExecutionContext
import scala.concurrent.Future
import scala.jdk.CollectionConverters.*
import scala.util.control.NonFatal

/**
 * gRPC-граница Auction: проверка вызывающего (ADR-056) и ровно одна запись об операции на каждый вызов.
 *
 * Проверка стоит перед сгенерированным обработчиком и решает по пути и заголовку `authorization`. Не допущенный вызов
 * уходит в сервис, который на любой метод отвечает `UNAUTHENTICATED`: протокол gRPC — трейлеры, кодирование, формат
 * ответа — остаётся за сгенерированным кодом, а до [[AuctionGrpcService]] и домена такой вызов не доходит.
 *
 * Код ответа граница узнаёт из своего же обработчика исключений: сервис отвечает отказом через неудачное `Future`, и
 * обработчик видит его раньше, чем уходит ответ. Нет исключения — `OK`. У потока ответа отказ приходит после
 * заголовков, поэтому его запись уходит в конце тела, а не с ответом. Штатный обработчик pekko-grpc сам пишет
 * неожиданный отказ в журнал, поэтому он заменён: у записи об отказе один автор.
 */
object GrpcBoundary {

  private val logger = LoggerFactory.getLogger(getClass)

  /** Итог вызова, который видела граница: статус и, у неожиданного отказа, его причина. */
  private final case class Outcome(status: Status, failure: Option[Throwable])

  def apply(table: CallerTable, service: AuctionService)(using
      system: ActorSystem[?]
  ): HttpRequest => Future[HttpResponse] =
    apply(table, (_: Caller, _: Correlation, _: OperationNotes) => service)

  /**
   * Граница, которая собирает сервис на каждый вызов с его сквозными значениями: сгенерированный сервис заголовков не
   * видит, а вызов Meetups обязан их передать (logging.md). Вызывающий тоже едет в сервис: черновик аукциона по
   * идентификатору отдаётся одному боту хаба (PER-605). Обработчик и так строится на каждый запрос. Заметки вызова
   * сервис наполняет полями, которые знает только он, и они уходят в ту же запись операции.
   */
  def apply(table: CallerTable, service: (Caller, Correlation, OperationNotes) => AuctionService)(using
      system: ActorSystem[?]
  ): HttpRequest => Future[HttpResponse] = {
    import system.executionContext
    val refusing = new RefusingService

    request => {
      val startedAtNanos = System.nanoTime()
      val method = MethodAccess.methodOf(request.uri.path.toString)
      val decision = CallerGate.decide(table, method, header(request, "authorization"))
      val outcome = new AtomicReference[Outcome](Outcome(Status.OK, None))
      val notes = OperationNotes()

      val target = decision match {
        case GateDecision.Admitted(caller) =>
          service(caller, Correlation(header(request, "x-request-id"), header(request, "x-use-case")), notes)
        case GateDecision.Refused(_, _) => refusing
      }

      val admitted = decision match {
        case GateDecision.Admitted(_) => true
        case GateDecision.Refused(_, _) => false
      }

      AuctionServiceHandler(target, _ => capturing(outcome, admitted))(system)(request).map { response =>
        def record(): Unit = write(request, method, decision, outcome.get(), notes, response, startedAtNanos)
        if (method.exists(streaming)) afterBody(response)(record)
        else {
          record()
          response
        }
      }
    }
  }

  /** Методы с потоком ответа: их итог известен только в конце тела. */
  private val streaming: Set[String] =
    AuctionService.descriptor
      .findServiceByName("AuctionService")
      .getMethods
      .asScala
      .filter(_.isServerStreaming)
      .map(_.getName)
      .toSet

  /**
   * Ответ, запись о котором уходит, когда кончилось тело. Унарный ответ сервис решает до заголовков, а поток отвечает
   * `200` сразу и отказывает позже — трейлером в последнем куске, и обработчик исключений узнаёт статус только тогда.
   * Куски передаются как есть, поэтому трейлер доходит до клиента нетронутым. Поток, который закрыл клиент, сервис не
   * ронял, и его запись — `OK`: отдельной категории закрытой подписки в словаре отказов нет (PER-335). Запись одна,
   * сколько бы раз тело ни запускали. Тело другой формы граница не ждёт.
   */
  private def afterBody(response: HttpResponse)(record: () => Unit)(using ExecutionContext): HttpResponse =
    response.entity match {
      case chunked: HttpEntity.Chunked =>
        val recorded = new AtomicBoolean(false)
        val watched = chunked.chunks.watchTermination() { (materialized, finished) =>
          finished.onComplete(_ => if (recorded.compareAndSet(false, true)) record())
          materialized
        }
        response.withEntity(chunked.copy(chunks = watched))
      case _ =>
        record()
        response
    }

  /**
   * Отображение отказа в трейлеры и в итог для записи.
   *
   * Не допущенный вызов отвечает `UNAUTHENTICATED` при любом исходе: сгенерированный обработчик разбирает тело раньше,
   * чем зовёт сервис, и битое тело без токена иначе стало бы `INTERNAL` со стеком, то есть неожиданным отказом, который
   * порождает кто угодно. У допущенного вызова `GrpcServiceException` — отказ с кодом, который выбрал сервис; тело,
   * которое не разбирается, — `INVALID_ARGUMENT`; метод, которого нет в контракте, — `UNIMPLEMENTED`, как у штатного
   * обработчика pekko-grpc. Остальное — неожиданный отказ: наружу `INTERNAL` без описания, причина остаётся записи.
   */
  private def capturing(outcome: AtomicReference[Outcome], admitted: Boolean): PartialFunction[Throwable, Trailers] = {
    def answer(status: Status, failure: Option[Throwable] = None): Trailers = {
      outcome.set(Outcome(status, failure))
      Trailers(status)
    }

    @scala.annotation.tailrec
    def classify(cause: Throwable): Trailers =
      cause match {
        case _ if !admitted => answer(Status.UNAUTHENTICATED)
        case wrapped: (ExecutionException | CompletionException) if wrapped.getCause != null =>
          classify(wrapped.getCause)
        case expected: GrpcServiceException => answer(expected.status)
        case _: InvalidProtocolBufferException => answer(Status.INVALID_ARGUMENT.withDescription("malformed request"))
        case _: NotImplementedError => answer(Status.UNIMPLEMENTED)
        case unexpected => answer(Status.INTERNAL, Some(unexpected))
      }

    { case NonFatal(cause) => classify(cause) }
  }

  private def write(
      request: HttpRequest,
      method: Option[String],
      decision: GateDecision,
      outcome: Outcome,
      notes: OperationNotes,
      response: HttpResponse,
      startedAtNanos: Long
  ): Unit = {
    // Метод, которого нет в контракте, придумал клиент: он пишется одним значением,
    // как неизвестный путь у HTTP-границы, иначе перебор имён дал бы столько
    // значений operation, сколько строк клиент прислал.
    val known = method.filter(MethodAccess.byMethod.contains)
    val operation = known.fold("<unmatched>")(name => s"${MethodAccess.Service}/$name")
    // Ответ, который не является gRPC-ответом, — 404 на путь вне сервиса или 415
    // на чужой content-type — сгенерированный обработчик отдаёт статусом HTTP, и
    // обработчик исключений его не видит. Код для записи выводится из статуса HTTP
    // так, как его прочитал бы клиент gRPC, а не остаётся умолчанием OK.
    val status = response.status.intValue match {
      case 200 => outcome.status
      case 404 => Status.UNIMPLEMENTED
      case code => Status.INVALID_ARGUMENT.withDescription(s"http $code")
    }

    val frame = OperationFrame.grpc(
      operation = operation,
      code = status.getCode,
      description = Option(status.getDescription),
      durationUs = (System.nanoTime() - startedAtNanos) / 1000,
      requestId = header(request, "x-request-id"),
      useCase = header(request, "x-use-case"),
      failure = outcome.failure
    )

    val caller = decision match {
      case GateDecision.Admitted(caller) => Map("caller" -> caller.node)
      case GateDecision.Refused(refusal, caller) =>
        Map("caller_refusal" -> refusal.field) ++ caller.map("caller" -> _.node)
    }

    logger.info("request handled", StructuredArguments.entries((notes.all ++ frame ++ caller).asJava))
  }

  private def header(request: HttpRequest, name: String): Option[String] =
    request.headers.find(_.is(name)).map(_.value())

  /** Сервис для не допущенного вызова: любой метод отвечает `UNAUTHENTICATED`, без описания причины наружу. */
  private final class RefusingService extends AuctionService {
    import auction.v1.auction_service as wire

    private def refuse[T]: Future[T] = Future.failed(new GrpcServiceException(Status.UNAUTHENTICATED))

    def placeBid(in: wire.PlaceBidRequest): Future[wire.PlaceBidResponse] = refuse
    def setProxyLimit(in: wire.SetProxyLimitRequest): Future[wire.SetProxyLimitResponse] = refuse
    def withdrawProxyLimit(in: wire.WithdrawProxyLimitRequest): Future[wire.WithdrawProxyLimitResponse] = refuse
    def createLotCard(in: wire.CreateLotCardRequest): Future[wire.CreateLotCardResponse] = refuse
    def editLotCard(in: wire.EditLotCardRequest): Future[wire.EditLotCardResponse] = refuse
    def getLot(in: wire.GetLotRequest): Future[wire.LotSnapshot] = refuse
    def listAuctionLots(in: wire.ListAuctionLotsRequest): Future[wire.ListAuctionLotsResponse] = refuse
    def listLotHistory(in: wire.ListLotHistoryRequest): Future[wire.ListLotHistoryResponse] = refuse
    def chooseDisplayName(in: wire.ChooseDisplayNameRequest): Future[wire.ChooseDisplayNameResponse] = refuse
    def getDisplayNames(in: wire.GetDisplayNamesRequest): Future[wire.GetDisplayNamesResponse] = refuse
    def listAuctionNames(in: wire.ListAuctionNamesRequest): Future[wire.ListAuctionNamesResponse] = refuse
    def getFaqAcknowledgement(in: wire.GetFaqAcknowledgementRequest): Future[wire.FaqAcknowledgement] = refuse
    def acknowledgeFaq(in: wire.AcknowledgeFaqRequest): Future[wire.FaqAcknowledgement] = refuse
    def getLotImage(in: wire.GetLotImageRequest): Future[wire.LotImage] = refuse
    def addLotPhoto(in: wire.AddLotPhotoRequest): Future[wire.AddLotPhotoResponse] = refuse
    def removeLotPhoto(in: wire.RemoveLotPhotoRequest): Future[wire.RemoveLotPhotoResponse] = refuse
    def getLotPhoto(in: wire.GetLotPhotoRequest): Future[wire.LotImage] = refuse
    def draftAuction(in: wire.DraftAuctionRequest): Future[wire.DraftAuctionResponse] = refuse
    def addLot(in: wire.AddLotRequest): Future[wire.AddLotResponse] = refuse
    def removeLot(in: wire.RemoveLotRequest): Future[wire.RemoveLotResponse] = refuse
    def saveLotSet(in: wire.SaveLotSetRequest): Future[wire.SaveLotSetResponse] = refuse
    def deleteLotSet(in: wire.DeleteLotSetRequest): Future[wire.DeleteLotSetResponse] = refuse
    def scheduleLot(in: wire.ScheduleLotRequest): Future[wire.ScheduleLotResponse] = refuse
    def scheduleAuction(in: wire.ScheduleAuctionRequest): Future[wire.ScheduleAuctionResponse] = refuse
    def startPrebidding(in: wire.StartPrebiddingRequest): Future[wire.StartPrebiddingResponse] = refuse
    def discardAuction(in: wire.DiscardAuctionRequest): Future[wire.DiscardAuctionResponse] = refuse
    def publishAuction(in: wire.PublishAuctionRequest): Future[wire.PublishAuctionResponse] = refuse
    def hideAuction(in: wire.HideAuctionRequest): Future[wire.HideAuctionResponse] = refuse
    def cancelAuction(in: wire.CancelAuctionRequest): Future[wire.CancelAuctionResponse] = refuse
    def setFinalTime(in: wire.SetFinalTimeRequest): Future[wire.SetFinalTimeResponse] = refuse
    def setLotLayout(in: wire.SetLotLayoutRequest): Future[wire.SetLotLayoutResponse] = refuse
    def selectForFinal(in: wire.SelectForFinalRequest): Future[wire.SelectForFinalResponse] = refuse
    def deselectForFinal(in: wire.DeselectForFinalRequest): Future[wire.DeselectForFinalResponse] = refuse
    def previewParticipantRemoval(
        in: wire.PreviewParticipantRemovalRequest
    ): Future[wire.PreviewParticipantRemovalResponse] = refuse
    def removeParticipant(in: wire.RemoveParticipantRequest): Future[wire.RemoveParticipantResponse] = refuse
    def launchStepWindow(in: wire.LaunchStepWindowRequest): Future[wire.LaunchStepWindowResponse] = refuse
    def freezeFinalLineup(in: wire.FreezeFinalLineupRequest): Future[wire.FreezeFinalLineupResponse] = refuse
    def startFinal(in: wire.StartFinalRequest): Future[wire.StartFinalResponse] = refuse
    def startNextLot(in: wire.StartNextLotRequest): Future[wire.StartNextLotResponse] = refuse
    def advanceAsk(in: wire.AdvanceAskRequest): Future[wire.AdvanceAskResponse] = refuse
    def closeLot(in: wire.CloseLotRequest): Future[wire.CloseLotResponse] = refuse
    def watchAuction(in: wire.WatchAuctionRequest): Source[wire.AuctionWatch, NotUsed] =
      Source.failed(new GrpcServiceException(Status.UNAUTHENTICATED))
    def getAuctionConsole(in: wire.GetAuctionConsoleRequest): Future[wire.GetAuctionConsoleResponse] = refuse
    def getAuctionLotStatistics(in: wire.GetAuctionLotStatisticsRequest): Future[wire.GetAuctionLotStatisticsResponse] =
      refuse
    def getAuctionDaySummary(in: wire.GetAuctionDaySummaryRequest): Future[wire.GetAuctionDaySummaryResponse] = refuse
    def getAuctionDayChronicle(in: wire.GetAuctionDayChronicleRequest): Future[wire.GetAuctionDayChronicleResponse] =
      refuse
    def getMeetupAuction(in: wire.GetMeetupAuctionRequest): Future[wire.GetMeetupAuctionResponse] = refuse
    def getAuction(in: wire.GetAuctionRequest): Future[wire.GetAuctionResponse] = refuse
    def listAuctions(in: wire.ListAuctionsRequest): Future[wire.ListAuctionsResponse] = refuse
    def registerForRaffle(in: wire.RegisterForRaffleRequest): Future[wire.RegisterForRaffleResponse] = refuse
    def cancelRaffleRegistration(
        in: wire.CancelRaffleRegistrationRequest
    ): Future[wire.CancelRaffleRegistrationResponse] = refuse
    def getRaffle(in: wire.GetRaffleRequest): Future[wire.GetRaffleResponse] = refuse
    def assignRaffleWinner(in: wire.AssignRaffleWinnerRequest): Future[wire.AssignRaffleWinnerResponse] = refuse
    def changeRafflePrize(in: wire.ChangeRafflePrizeRequest): Future[wire.ChangeRafflePrizeResponse] = refuse
    def submitPrediction(in: wire.SubmitPredictionRequest): Future[wire.SubmitPredictionResponse] = refuse
    def getMyPredictions(in: wire.GetMyPredictionsRequest): Future[wire.GetMyPredictionsResponse] = refuse
    def getPredictionResults(in: wire.GetPredictionResultsRequest): Future[wire.GetPredictionResultsResponse] = refuse
    def settlePredictionResultsManually(
        in: wire.SettlePredictionResultsManuallyRequest
    ): Future[wire.SettlePredictionResultsManuallyResponse] = refuse
    def markInvoicePaid(in: wire.MarkInvoicePaidRequest): Future[wire.MarkInvoicePaidResponse] = refuse
    def markInvoiceHandedOver(in: wire.MarkInvoiceHandedOverRequest): Future[wire.MarkInvoiceHandedOverResponse] =
      refuse
    def chooseFulfillment(in: wire.ChooseFulfillmentRequest): Future[wire.ChooseFulfillmentResponse] = refuse
    def listMyInvoices(in: wire.ListMyInvoicesRequest): Future[wire.ListMyInvoicesResponse] = refuse
    def listAuctionInvoices(in: wire.ListAuctionInvoicesRequest): Future[wire.ListAuctionInvoicesResponse] = refuse
    def setPaymentInstructions(in: wire.SetPaymentInstructionsRequest): Future[wire.SetPaymentInstructionsResponse] =
      refuse
  }
}
