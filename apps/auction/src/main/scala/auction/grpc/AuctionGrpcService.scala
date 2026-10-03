package auction.grpc

import auction.catalog.LotCatalogCommands
import auction.entity.Initiator
import auction.entity.LotGateway
import auction.onboarding.FaqAcknowledgements
import auction.projection.LotViews
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
final class AuctionGrpcService(
    lots: LotGateway,
    catalog: LotCatalogCommands,
    faq: FaqAcknowledgements,
    views: LotViews
)(using ExecutionContext)
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

  def setProxyLimit(in: wire.SetProxyLimitRequest): Future[wire.SetProxyLimitResponse] =
    RequestMapping.setProxyLimit(in) match {
      case Left(error) => invalid(error)
      case Right(command) if !command.acting.viewer.isParticipant =>
        refuse(Status.PERMISSION_DENIED.withDescription("viewer has no public role"))
      case Right(command) =>
        lots
          .setProxyLimit(command.lotId, command.limit, Initiator.Participant(command.acting.participant))
          .recoverWith(awaited)
          .flatMap(outcome => ResponseMapping.setProxyLimit(outcome).fold(refuse, Future.successful))
    }

  def withdrawProxyLimit(in: wire.WithdrawProxyLimitRequest): Future[wire.WithdrawProxyLimitResponse] =
    RequestMapping.withdrawProxyLimit(in) match {
      case Left(error) => invalid(error)
      case Right(command) if !command.acting.viewer.isParticipant =>
        refuse(Status.PERMISSION_DENIED.withDescription("viewer has no public role"))
      case Right(command) =>
        lots
          .withdrawProxyLimit(command.lotId, command.withdrawal, Initiator.Participant(command.acting.participant))
          .recoverWith(awaited)
          .flatMap(outcome => ResponseMapping.withdrawProxyLimit(outcome).fold(refuse, Future.successful))
    }

  /**
   * Чтение лота — из read model проекции, а не из entity: чтение не будит шард. Сразу после команды ответ может ещё не
   * содержать её события; `version` в ответе говорит, до какого события он дошёл.
   */
  def getLot(in: wire.GetLotRequest): Future[wire.LotSnapshot] =
    RequestMapping.getLot(in) match {
      case Left(error) => invalid(error)
      case Right(query) if !query.acting.viewer.isParticipant =>
        refuse(Status.PERMISSION_DENIED.withDescription("viewer has no public role"))
      case Right(query) =>
        views.find(query.lotId).flatMap {
          case Some(view) => Future.successful(SnapshotMapping.snapshot(view, query.acting.participant))
          case None => refuse(Status.NOT_FOUND.withDescription("lot not found"))
        }
    }

  /**
   * Лоты аукциона страницами по возрастанию `lot_id`. Аукцион без лотов и аукцион, которого нет, отвечают одинаково —
   * пустой страницей: агрегата аукциона в сервисе ещё нет, и read model знает аукцион только по его лотам.
   */
  def listAuctionLots(in: wire.ListAuctionLotsRequest): Future[wire.ListAuctionLotsResponse] =
    RequestMapping.listAuctionLots(in) match {
      case Left(error) => invalid(error)
      case Right(query) if !query.acting.viewer.isParticipant =>
        refuse(Status.PERMISSION_DENIED.withDescription("viewer has no public role"))
      case Right(query) =>
        // На одну строку больше страницы: так известно, есть ли продолжение, без второго запроса.
        views.page(query.auctionId, query.after, query.limit + 1).map { found =>
          val page = found.take(query.limit)
          val next = if (found.sizeIs > query.limit) page.lastOption.map(view => PageToken.encode(view.lotId)) else None
          wire.ListAuctionLotsResponse(
            page.map(SnapshotMapping.snapshot(_, query.acting.participant)),
            next.getOrElse("")
          )
        }
    }

  // Имя участника: правила и хранилище есть в `naming/` (ADR-059), провязку с границей и ставкой приносит отдельная задача.
  def chooseDisplayName(in: wire.ChooseDisplayNameRequest): Future[wire.ChooseDisplayNameResponse] = unimplemented

  def getDisplayNames(in: wire.GetDisplayNamesRequest): Future[wire.GetDisplayNamesResponse] = unimplemented

  def getFaqAcknowledgement(in: wire.GetFaqAcknowledgementRequest): Future[wire.FaqAcknowledgement] =
    withParticipant(in.viewer)(participant => faq.acknowledged(participant).map(wire.FaqAcknowledgement(_)))

  def acknowledgeFaq(in: wire.AcknowledgeFaqRequest): Future[wire.FaqAcknowledgement] =
    withParticipant(in.viewer)(participant => faq.acknowledge(participant).map(_ => wire.FaqAcknowledgement(true)))

  private def withParticipant[T](viewer: Option[wire.Viewer])(run: auction.lot.ParticipantId => Future[T]): Future[T] =
    RequestMapping.acting(viewer) match {
      case Left(error) => invalid(error)
      case Right(acting) if !acting.viewer.isParticipant =>
        refuse(Status.PERMISSION_DENIED.withDescription("viewer has no public role"))
      case Right(acting) => run(acting.participant)
    }

  /**
   * Ответа entity не дождались. Команда могла быть принята, поэтому это `DEADLINE_EXCEEDED`, а не `UNAVAILABLE`: повтор
   * с тем же `op_id` вернёт исходный ответ, а не запишет команду второй раз.
   */
  private def awaited[T]: PartialFunction[Throwable, Future[T]] = { case _: TimeoutException =>
    refuse(Status.DEADLINE_EXCEEDED.withDescription("lot did not answer in time"))
  }

  private def invalid[T](error: FormError): Future[T] =
    refuse(Status.INVALID_ARGUMENT.withDescription(s"invalid ${error.field}"))

  private def unimplemented[T]: Future[T] = refuse(Status.UNIMPLEMENTED)

  private def refuse[T](status: Status): Future[T] = Future.failed(new GrpcServiceException(status))
}
