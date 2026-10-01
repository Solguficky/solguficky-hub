package auction.grpc

import auction.boundary.OperationFrame
import auction.v1.auction_service.AuctionService
import auction.v1.auction_service.AuctionServiceHandler
import io.grpc.Status
import net.logstash.logback.argument.StructuredArguments
import org.apache.pekko.actor.typed.ActorSystem
import org.apache.pekko.grpc.GrpcServiceException
import org.apache.pekko.grpc.Trailers
import org.apache.pekko.http.scaladsl.model.HttpRequest
import org.apache.pekko.http.scaladsl.model.HttpResponse
import org.slf4j.LoggerFactory

import com.google.protobuf.InvalidProtocolBufferException

import java.util.concurrent.CompletionException
import java.util.concurrent.ExecutionException
import java.util.concurrent.atomic.AtomicReference
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
 * обработчик видит его раньше, чем уходит ответ. Нет исключения — `OK`. Штатный обработчик pekko-grpc сам пишет
 * неожиданный отказ в журнал, поэтому он заменён: у записи об отказе один автор.
 */
object GrpcBoundary {

  private val logger = LoggerFactory.getLogger(getClass)

  /** Итог вызова, который видела граница: статус и, у неожиданного отказа, его причина. */
  private final case class Outcome(status: Status, failure: Option[Throwable])

  def apply(table: CallerTable, service: AuctionService)(using
      system: ActorSystem[?]
  ): HttpRequest => Future[HttpResponse] = {
    import system.executionContext
    val refusing = new RefusingService

    request => {
      val startedAtNanos = System.nanoTime()
      val method = MethodAccess.methodOf(request.uri.path.toString)
      val decision = CallerGate.decide(table, method, header(request, "authorization"))
      val outcome = new AtomicReference[Outcome](Outcome(Status.OK, None))

      val target = decision match {
        case GateDecision.Admitted(_) => service
        case GateDecision.Refused(_, _) => refusing
      }

      val admitted = decision match {
        case GateDecision.Admitted(_) => true
        case GateDecision.Refused(_, _) => false
      }

      AuctionServiceHandler(target, _ => capturing(outcome, admitted))(system)(request).map { response =>
        write(request, method, decision, outcome.get(), response, startedAtNanos)
        response
      }
    }
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

    logger.info("request handled", StructuredArguments.entries((frame ++ caller).asJava))
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
    def chooseDisplayName(in: wire.ChooseDisplayNameRequest): Future[wire.ChooseDisplayNameResponse] = refuse
    def getDisplayNames(in: wire.GetDisplayNamesRequest): Future[wire.GetDisplayNamesResponse] = refuse
  }
}
