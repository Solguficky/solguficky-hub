package auction.grpc

import auction.catalog.LotCatalogCommands
import auction.entity.Initiator
import auction.entity.LotGateway
import auction.v1.auction_service as wire
import io.grpc.Status
import org.apache.pekko.grpc.GrpcServiceException

import java.util.concurrent.TimeoutException
import scala.concurrent.ExecutionContext
import scala.concurrent.Future

/**
 * Реализация `AuctionService`. Вызывающего здесь уже проверила [[GrpcBoundary]]; здесь порядок «форма → роль → домен»,
 * и до шлюза лота или каталога доходит только запрос, прошедший оба первых шага.
 *
 * Отказ статусом — неудачное `Future` с `GrpcServiceException`: его превращает в трейлеры сгенерированный обработчик.
 * Описание статуса называет поле или правило, но не значение из запроса.
 */
final class AuctionGrpcService(lots: LotGateway, catalog: LotCatalogCommands)(using ExecutionContext)
    extends wire.AuctionService {

  def placeBid(in: wire.PlaceBidRequest): Future[wire.PlaceBidResponse] =
    RequestMapping.placeBid(in) match {
      case Left(error) => invalid(error)
      case Right(command) if !command.acting.viewer.isParticipant =>
        refuse(Status.PERMISSION_DENIED.withDescription("viewer has no public role"))
      case Right(command) =>
        lots
          .placeBid(command.lotId, command.bid, Initiator.Participant(command.acting.participant))
          .recoverWith(awaited)
          .flatMap(outcome => ResponseMapping.placeBid(outcome).fold(refuse, Future.successful))
    }

  def createLotCard(in: wire.CreateLotCardRequest): Future[wire.CreateLotCardResponse] =
    RequestMapping.card(in.viewer, in.lotId, in.title, in.description) match {
      case Left(error) => invalid(error)
      case Right(card) =>
        catalog.create(card.viewer, card.lotId, card.title, card.description).map(ResponseMapping.createLotCard)
    }

  def editLotCard(in: wire.EditLotCardRequest): Future[wire.EditLotCardResponse] =
    RequestMapping.card(in.viewer, in.lotId, in.title, in.description) match {
      case Left(error) => invalid(error)
      case Right(card) =>
        catalog.edit(card.viewer, card.lotId, card.title, card.description).map(ResponseMapping.editLotCard)
    }

  // Прокси-лимиты — PER-303: в ядре лота их ещё нет.
  def setProxyLimit(in: wire.SetProxyLimitRequest): Future[wire.SetProxyLimitResponse] = unimplemented

  def withdrawProxyLimit(in: wire.WithdrawProxyLimitRequest): Future[wire.WithdrawProxyLimitResponse] = unimplemented

  // Чтение лота и списка лотов аукциона — из проекции, PER-324.
  def getLot(in: wire.GetLotRequest): Future[wire.LotSnapshot] = unimplemented

  def listAuctionLots(in: wire.ListAuctionLotsRequest): Future[wire.ListAuctionLotsResponse] = unimplemented

  // Имя участника: правила и хранилище есть в `naming/` (ADR-059), провязку с границей и ставкой приносит отдельная задача.
  def chooseDisplayName(in: wire.ChooseDisplayNameRequest): Future[wire.ChooseDisplayNameResponse] = unimplemented

  def getDisplayNames(in: wire.GetDisplayNamesRequest): Future[wire.GetDisplayNamesResponse] = unimplemented

  /**
   * Ответа entity не дождались. Команда могла быть принята, поэтому это `DEADLINE_EXCEEDED`, а не `UNAVAILABLE`: повтор
   * с тем же `op_id` вернёт исходный ответ, а не поставит ставку второй раз.
   */
  private def awaited[T]: PartialFunction[Throwable, Future[T]] = { case _: TimeoutException =>
    refuse(Status.DEADLINE_EXCEEDED.withDescription("lot did not answer in time"))
  }

  private def invalid[T](error: FormError): Future[T] =
    refuse(Status.INVALID_ARGUMENT.withDescription(s"invalid ${error.field}"))

  private def unimplemented[T]: Future[T] = refuse(Status.UNIMPLEMENTED)

  private def refuse[T](status: Status): Future[T] = Future.failed(new GrpcServiceException(status))
}
