package auction.grpc

import auction.aggregate.Auction
import auction.aggregate.AuctionCommands
import auction.aggregate.Correlation
import auction.aggregate.Denial
import auction.catalog.LotCatalogCommands
import auction.entity.Initiator
import auction.entity.LotGateway
import auction.lot.AuctionId
import auction.lot.ParticipantId
import auction.naming.DisplayNameCommands
import auction.naming.NameNotChosen
import auction.onboarding.FaqAcknowledgements
import auction.projection.AuctionSnapshotView
import auction.projection.AuctionViews
import auction.projection.LotViews
import auction.v1.auction_service as wire
import io.grpc.Status
import net.logstash.logback.argument.StructuredArguments
import org.apache.pekko.grpc.GrpcServiceException
import org.slf4j.LoggerFactory

import java.time.Clock
import java.time.Duration
import java.util.concurrent.TimeoutException
import scala.concurrent.ExecutionContext
import scala.concurrent.Future
import scala.jdk.CollectionConverters.*
import scala.util.control.NonFatal

/**
 * Реализация `AuctionService`. Вызывающего здесь уже проверила [[GrpcBoundary]]; здесь порядок «форма → право → домен»,
 * и до шлюза лота или каталога доходит только запрос, прошедший оба первых шага.
 *
 * Отказ статусом — неудачное `Future` с `GrpcServiceException`: его превращает в трейлеры сгенерированный обработчик.
 * Описание статуса называет поле или правило, но не значение из запроса.
 */
final class AuctionGrpcService(
    lots: LotGateway,
    catalog: LotCatalogCommands,
    faq: FaqAcknowledgements,
    views: LotViews,
    auctions: AuctionCommands,
    auctionViews: AuctionViews,
    names: DisplayNameCommands,
    correlation: Correlation = Correlation.none,
    clock: Clock = Clock.systemUTC(),
    overdueGrace: Duration = AuctionGrpcService.DefaultOverdueGrace
)(using ExecutionContext)
    extends wire.AuctionService {

  /**
   * Сервис для одного входящего вызова: команды аукциона спрашивают Meetups с его сквозными значениями, а событие сбоя
   * заморозки несёт их, чтобы его можно было связать с записью операции.
   */
  def within(correlation: Correlation): AuctionGrpcService =
    AuctionGrpcService(
      lots,
      catalog,
      faq,
      views,
      auctions.within(correlation),
      auctionViews,
      names,
      correlation,
      clock,
      overdueGrace
    )

  def placeBid(in: wire.PlaceBidRequest): Future[wire.PlaceBidResponse] =
    RequestMapping.placeBid(in) match {
      case Left(error) => invalid(error)
      case Right(command) if !command.acting.viewer.isParticipant =>
        refuse(Status.PERMISSION_DENIED.withDescription("viewer has no auction right"))
      case Right(command) =>
        val participant = command.acting.participant
        asNamed(command.lotId, participant, ResponseMapping.displayNameNotChosen)(
          lots.placeBid(command.lotId, command.bid, Initiator.Participant(participant))
        )(ResponseMapping.placeBid)
    }

  /**
   * Команда участника лоту — ставка или прокси-лимит — с именем по ADR-059. Имя проверяется до лота: аукцион лота
   * граница спрашивает у entity, а не у read model, которая отстаёт на проекцию и не знала бы только что рождённый лот.
   * После принятой команды имя замораживается; отказ лота имя не трогает — обещание «до первой принятой».
   */
  private def asNamed[R, A, T](lotId: java.util.UUID, participant: ParticipantId, notChosen: T)(
      command: => Future[Either[R, A]]
  )(answer: Either[R, A] => Either[Status, T]): Future[T] =
    lots.auctionOf(lotId).recoverWith(awaited).flatMap {
      case None => refuse(Status.NOT_FOUND.withDescription("lot not found"))
      case Some(auction) =>
        names.requireChosen(auction, participant).flatMap {
          case Left(NameNotChosen) => Future.successful(notChosen)
          case Right(_) =>
            command.recoverWith(awaited).flatMap { outcome =>
              val frozen = if (outcome.isRight) freeze(auction, lotId, participant) else Future.unit
              frozen.flatMap(_ => answer(outcome).fold(refuse, Future.successful))
            }
        }
    }

  /**
   * Заморозка после принятой команды. Общей транзакции с лотом нет (ADR-059), поэтому сбой заморозки ставку не
   * отменяет: она повторяется до `FreezeAttempts` раз, а исчерпанные попытки пишутся отдельным событием, и ответ
   * остаётся принятым. Это событие — не вторая запись операции: для границы операция успешна. Сообщения исключения в
   * нём нет, как и в записи операции.
   */
  private def freeze(auction: AuctionId, lotId: java.util.UUID, participant: ParticipantId): Future[Unit] = {
    def attempt(left: Int): Future[Unit] =
      names.participated(auction, participant).map(_ => ()).recoverWith {
        case NonFatal(_) if left > 1 => attempt(left - 1)
      }
    attempt(AuctionGrpcService.FreezeAttempts).recover { case NonFatal(cause) =>
      AuctionGrpcService.logger.warn(
        "display name freeze failed",
        StructuredArguments.entries(
          (Map[String, Any](
            "operation" -> AuctionGrpcService.FreezeOperation,
            "result" -> "error",
            "error_category" -> "unexpected",
            "error" -> cause.getClass.getName,
            "auction_id" -> auction.value.toString,
            "lot_id" -> lotId.toString,
            "attempts" -> AuctionGrpcService.FreezeAttempts
          ) ++ correlation.requestId.filter(_.nonEmpty).map("request_id" -> _) ++
            correlation.useCase.filter(_.nonEmpty).map("use_case" -> _)).asJava
        )
      )
    }
  }

  def createLotCard(in: wire.CreateLotCardRequest): Future[wire.CreateLotCardResponse] =
    RequestMapping.createCard(in) match {
      case Left(error) => invalid(error)
      case Right(card) =>
        catalog
          .create(card.viewer, card.lotId, card.title, card.description, card.image)
          .map(ResponseMapping.createLotCard)
    }

  def editLotCard(in: wire.EditLotCardRequest): Future[wire.EditLotCardResponse] =
    RequestMapping.editCard(in) match {
      case Left(error) => invalid(error)
      case Right(card) =>
        catalog
          .edit(card.viewer, card.lotId, card.title, card.description, card.image)
          .map(ResponseMapping.editLotCard)
    }

  def setProxyLimit(in: wire.SetProxyLimitRequest): Future[wire.SetProxyLimitResponse] =
    RequestMapping.setProxyLimit(in) match {
      case Left(error) => invalid(error)
      case Right(command) if !command.acting.viewer.isParticipant =>
        refuse(Status.PERMISSION_DENIED.withDescription("viewer has no auction right"))
      case Right(command) =>
        val participant = command.acting.participant
        asNamed(command.lotId, participant, ResponseMapping.proxyDisplayNameNotChosen)(
          lots.setProxyLimit(command.lotId, command.limit, Initiator.Participant(participant))
        )(ResponseMapping.setProxyLimit)
    }

  def withdrawProxyLimit(in: wire.WithdrawProxyLimitRequest): Future[wire.WithdrawProxyLimitResponse] =
    RequestMapping.withdrawProxyLimit(in) match {
      case Left(error) => invalid(error)
      case Right(command) if !command.acting.viewer.isParticipant =>
        refuse(Status.PERMISSION_DENIED.withDescription("viewer has no auction right"))
      case Right(command) =>
        lots
          .withdrawProxyLimit(command.lotId, command.withdrawal, Initiator.Participant(command.acting.participant))
          .recoverWith(awaited)
          .flatMap(outcome => ResponseMapping.withdrawProxyLimit(outcome).fold(refuse, Future.successful))
    }

  /**
   * Чтение лота — из read model проекции, а не из entity: чтение не будит шард. Сразу после команды ответ может ещё не
   * содержать её события; `version` в ответе говорит, до какого события он дошёл. Следующая цена и окна шага считаются
   * на момент ответа по часам сервиса — по тем же, по которым entity судит ставку.
   */
  def getLot(in: wire.GetLotRequest): Future[wire.LotSnapshot] =
    RequestMapping.getLot(in) match {
      case Left(error) => invalid(error)
      case Right(query) if !query.acting.viewer.isParticipant =>
        refuse(Status.PERMISSION_DENIED.withDescription("viewer has no auction right"))
      case Right(query) =>
        views.find(query.lotId).flatMap {
          case Some(view) =>
            Future.successful(SnapshotMapping.snapshot(view, query.acting.participant, clock.instant()))
          case None => refuse(Status.NOT_FOUND.withDescription("lot not found"))
        }
    }

  /**
   * Лоты аукциона страницами по возрастанию `lot_id`. Аукцион сходки (UUIDv5) перечисляется по своему реестру: снятый
   * лот из ленты уходит. Тестовый аукцион из настройки бота (UUIDv7) журнала аукциона не имеет и перечисляется по
   * лотам, рождённым в нём. Аукцион без лотов и аукцион, которого нет, отвечают одинаково — пустой страницей.
   */
  def listAuctionLots(in: wire.ListAuctionLotsRequest): Future[wire.ListAuctionLotsResponse] =
    RequestMapping.listAuctionLots(in) match {
      case Left(error) => invalid(error)
      case Right(query) if !query.acting.viewer.isParticipant =>
        refuse(Status.PERMISSION_DENIED.withDescription("viewer has no auction right"))
      case Right(query) =>
        // На одну строку больше страницы: так известно, есть ли продолжение, без второго запроса.
        val read = if (AuctionGrpcService.isMeetupAuction(query.auctionId)) views.registryPage else views.page
        read(query.auctionId, query.after, query.limit + 1).map { found =>
          val at = clock.instant()
          val page = found.take(query.limit)
          val next = if (found.sizeIs > query.limit) page.lastOption.map(view => PageToken.encode(view.lotId)) else None
          wire.ListAuctionLotsResponse(
            page.map(SnapshotMapping.snapshot(_, query.acting.participant, at)),
            next.getOrElse("")
          )
        }
    }

  /**
   * Хронология лота страницами по возрастанию номера события в журнале (RFC-007, «Спор»). Читает read model, как
   * `getLot`, и так же отвечает `NOT_FOUND` на лот, которого она не знает; лот без ставок — пустая страница.
   */
  def listLotHistory(in: wire.ListLotHistoryRequest): Future[wire.ListLotHistoryResponse] =
    RequestMapping.listLotHistory(in) match {
      case Left(error) => invalid(error)
      case Right(query) if !query.acting.viewer.isParticipant =>
        refuse(Status.PERMISSION_DENIED.withDescription("viewer has no auction right"))
      case Right(query) =>
        // На одну строку больше страницы: так известно, есть ли продолжение, без второго запроса.
        views.history(query.lotId, query.after, query.limit + 1).flatMap {
          case None => refuse(Status.NOT_FOUND.withDescription("lot not found"))
          case Some(found) =>
            val page = found.take(query.limit)
            val next =
              if (found.sizeIs > query.limit) page.lastOption.map(bid => SequenceToken.encode(bid.sequence)) else None
            Future.successful(wire.ListLotHistoryResponse(page.map(HistoryMapping.entry), next.getOrElse("")))
        }
    }

  /** Выбор имени в аукционе (ADR-059). Отказ выбора — значение ответа, как отказ торгов. */
  def chooseDisplayName(in: wire.ChooseDisplayNameRequest): Future[wire.ChooseDisplayNameResponse] =
    RequestMapping.chooseDisplayName(in) match {
      case Left(error) => invalid(error)
      case Right(command) if !command.acting.viewer.isParticipant =>
        refuse(Status.PERMISSION_DENIED.withDescription("viewer has no auction right"))
      case Right(command) =>
        names
          .choose(command.auctionId, command.acting.participant, command.choice)
          .map(ResponseMapping.chooseDisplayName)
    }

  /** Готовые имена: каждый запрошенный участник в ответе есть, без выбора — заглушкой. */
  def getDisplayNames(in: wire.GetDisplayNamesRequest): Future[wire.GetDisplayNamesResponse] =
    RequestMapping.getDisplayNames(in) match {
      case Left(error) => invalid(error)
      case Right(query) if !query.acting.viewer.isParticipant =>
        refuse(Status.PERMISSION_DENIED.withDescription("viewer has no auction right"))
      case Right(query) => names.names(query.auctionId, query.participants).map(ResponseMapping.displayNames)
    }

  def getFaqAcknowledgement(in: wire.GetFaqAcknowledgementRequest): Future[wire.FaqAcknowledgement] =
    withParticipant(in.viewer)(participant => faq.acknowledged(participant).map(wire.FaqAcknowledgement(_)))

  def acknowledgeFaq(in: wire.AcknowledgeFaqRequest): Future[wire.FaqAcknowledgement] =
    withParticipant(in.viewer)(participant => faq.acknowledge(participant).map(_ => wire.FaqAcknowledgement(true)))

  private def withParticipant[T](viewer: Option[wire.Viewer])(run: auction.lot.ParticipantId => Future[T]): Future[T] =
    RequestMapping.acting(viewer) match {
      case Left(error) => invalid(error)
      case Right(acting) if !acting.viewer.isParticipant =>
        refuse(Status.PERMISSION_DENIED.withDescription("viewer has no auction right"))
      case Right(acting) => run(acting.participant)
    }

  /**
   * Байты изображения из строки каталога (ADR-057, дополнение). Видимость та же, что у `GetLot`: лота нет в read model,
   * изображения нет или лот не виден — один и тот же `NOT_FOUND`.
   */
  def getLotImage(in: wire.GetLotImageRequest): Future[wire.LotImage] =
    RequestMapping.getLotImage(in) match {
      case Left(error) => invalid(error)
      case Right(query) if !query.acting.viewer.isParticipant =>
        refuse(Status.PERMISSION_DENIED.withDescription("viewer has no auction right"))
      case Right(query) =>
        views.image(query.lotId).flatMap {
          case Some(image) => Future.successful(ResponseMapping.lotImage(image))
          case None => refuse(Status.NOT_FOUND.withDescription("lot image not found"))
        }
    }

  /**
   * Аукцион у сходки (ADR-047, дополнение 2026-10-03). Роли смотрящего права не дают: его спрашивает у Meetups
   * [[AuctionCommands]], и человек команды — `viewer.identity_id`.
   */
  def draftAuction(in: wire.DraftAuctionRequest): Future[wire.DraftAuctionResponse] =
    RequestMapping.draftAuction(in) match {
      case Left(error) => invalid(error)
      case Right(command) =>
        auctions
          .draft(command.meetup, command.opId, command.acting.participant)
          .recoverWith(awaited)
          .flatMap(outcome => ResponseMapping.draftAuction(outcome).fold(refuse, Future.successful))
    }

  def addLot(in: wire.AddLotRequest): Future[wire.AddLotResponse] =
    RequestMapping.addLot(in) match {
      case Left(error) => invalid(error)
      case Right(command) =>
        auctions
          .addLot(command.auctionId, command.lotId, command.opId, command.acting.participant)
          .recoverWith(awaited)
          .flatMap(outcome => ResponseMapping.addLot(outcome).fold(refuse, Future.successful))
    }

  def removeLot(in: wire.RemoveLotRequest): Future[wire.RemoveLotResponse] =
    RequestMapping.removeLot(in) match {
      case Left(error) => invalid(error)
      case Right(command) =>
        auctions
          .removeLot(command.auctionId, command.lotId, command.opId, command.acting.participant)
          .recoverWith(awaited)
          .flatMap(outcome => ResponseMapping.removeLot(outcome).fold(refuse, Future.successful))
    }

  /**
   * Условия торгов лоту идут через аукцион (ADR-047): право — у Meetups, заморозку и реестр решает аукцион, И-15 и
   * валюту — лот. Один срок ожидания накрывает оба перехода.
   */
  def scheduleLot(in: wire.ScheduleLotRequest): Future[wire.ScheduleLotResponse] =
    RequestMapping.scheduleLot(in) match {
      case Left(error) => invalid(error)
      case Right(command) =>
        auctions
          .scheduleLot(
            command.auctionId,
            command.lotId,
            command.startingPrice,
            command.stepPolicy,
            command.opId,
            command.acting.participant
          )
          .recoverWith(awaited)
          .flatMap(outcome => ResponseMapping.scheduleLot(outcome).fold(refuse, Future.successful))
    }

  /** Планирование аукциона (ADR-047, дополнение 2026-10-04): право у Meetups, `ConfigInvalid` решает ядро аукциона. */
  def scheduleAuction(in: wire.ScheduleAuctionRequest): Future[wire.ScheduleAuctionResponse] =
    RequestMapping.scheduleAuction(in) match {
      case Left(error) => invalid(error)
      case Right(command) =>
        auctions
          .schedule(command.auctionId, command.config, command.opId, command.acting.participant)
          .recoverWith(awaited)
          .flatMap(outcome => ResponseMapping.scheduleAuction(outcome).fold(refuse, Future.successful))
    }

  /**
   * Открытие онлайн-торгов. Ответ — запись `PrebiddingStarted`; лоты реестра аукцион открывает после неё по протоколу
   * И-14, и повтор с тем же `op_id` доспрашивает не ответившие.
   */
  def startPrebidding(in: wire.StartPrebiddingRequest): Future[wire.StartPrebiddingResponse] =
    RequestMapping.startPrebidding(in) match {
      case Left(error) => invalid(error)
      case Right(command) =>
        auctions
          .startPrebidding(command.auctionId, command.opId, command.acting.participant)
          .recoverWith(awaited)
          .flatMap(outcome => ResponseMapping.startPrebidding(outcome).fold(refuse, Future.successful))
    }

  /** Удаление аукциона до торгов (ADR-047, дополнение 2026-10-09): право у Meetups, состояние решает аукцион. */
  def discardAuction(in: wire.DiscardAuctionRequest): Future[wire.DiscardAuctionResponse] =
    RequestMapping.discardAuction(in) match {
      case Left(error) => invalid(error)
      case Right(command) =>
        auctions
          .discard(command.auctionId, command.opId, command.acting.participant)
          .recoverWith(awaited)
          .flatMap(outcome => ResponseMapping.discardAuction(outcome).fold(refuse, Future.successful))
    }

  /**
   * Отметка лота для финала и её снятие (ADR-047, дополнение 2026-10-06): право у Meetups, фазу и реестр решает
   * аукцион, дедлайн и сам признак — лот. Один срок ожидания накрывает оба перехода, как у `scheduleLot`.
   */
  def selectForFinal(in: wire.SelectForFinalRequest): Future[wire.SelectForFinalResponse] =
    RequestMapping.selectForFinal(in) match {
      case Left(error) => invalid(error)
      case Right(command) =>
        auctions
          .selectForFinal(command.auctionId, command.lotId, command.opId, command.acting.participant)
          .recoverWith(awaited)
          .flatMap(outcome => ResponseMapping.selectForFinal(outcome).fold(refuse, Future.successful))
    }

  def deselectForFinal(in: wire.DeselectForFinalRequest): Future[wire.DeselectForFinalResponse] =
    RequestMapping.deselectForFinal(in) match {
      case Left(error) => invalid(error)
      case Right(command) =>
        auctions
          .deselectForFinal(command.auctionId, command.lotId, command.opId, command.acting.participant)
          .recoverWith(awaited)
          .flatMap(outcome => ResponseMapping.deselectForFinal(outcome).fold(refuse, Future.successful))
    }

  /**
   * Пульт администратора сходки (PER-320). Аукцион — из entity, а не из read model: из его сроков и финала пульт
   * собирает следующую команду планирования, а она заменяет конфигурацию целиком, и отставшая проекция затёрла бы
   * только что принятое. Лоты — из read model, как у остальных чтений. Право спрашивается у Meetups: пульт называет
   * отмеченные для финала лоты, а это рабочий выбор организатора. Аукциона без журнала — `NOT_FOUND` до вопроса
   * Meetups, как у команд. Реестр не страничный: лоты в него заводит администратор по одному.
   */
  def getAuctionConsole(in: wire.GetAuctionConsoleRequest): Future[wire.GetAuctionConsoleResponse] =
    RequestMapping.getAuctionConsole(in) match {
      case Left(error) => invalid(error)
      case Right(query) =>
        administered(query, ResponseMapping.consoleDenied) { auction =>
          val auctionId = query.auctionId.value
          // Страница — весь реестр: пустой реестр всё равно читается страницей в одну строку.
          val wholeRegistry = auction.lots.size.max(1)
          views.registryPage(auctionId, None, wholeRegistry).map { lots =>
            val view = AuctionSnapshotView(auctionId, auction)
            val console =
              ConsoleMapping.console(view, lots, query.acting.participant, clock.instant(), overdueGrace)
            wire.GetAuctionConsoleResponse().withConsole(console)
          }
        }
    }

  /**
   * Статистика лотов реестра для ручного отбора финалистов (PER-481). Право и отказы — те же, что у пульта, и тем же
   * порядком: статистика сравнивает лоты для рабочего выбора организатора. Числа — из read model и согласованы в
   * конечном счёте.
   */
  def getAuctionLotStatistics(in: wire.GetAuctionLotStatisticsRequest): Future[wire.GetAuctionLotStatisticsResponse] =
    RequestMapping.getAuctionLotStatistics(in) match {
      case Left(error) => invalid(error)
      case Right(query) =>
        administered(query, ResponseMapping.statisticsDenied) { _ =>
          views
            .statistics(query.auctionId.value)
            .map(lots => wire.GetAuctionLotStatisticsResponse().withStatistics(StatisticsMapping.statistics(lots)))
        }
    }

  /**
   * Чтение администратора сходки: аукцион у entity, без журнала или без сходки — `NOT_FOUND` до вопроса Meetups, затем
   * право у Meetups, и только после него `read`.
   */
  private def administered[R](query: ConsoleQuery, denied: Denial => Either[Status, R])(
      read: Auction => Future[R]
  ): Future[R] =
    auctions.current(query.auctionId).recoverWith(awaited).flatMap {
      case None => refuse(Status.NOT_FOUND.withDescription("auction not found"))
      case Some(auction) =>
        auction.meetup match {
          case None => refuse(Status.NOT_FOUND.withDescription("auction not found"))
          case Some(meetup) =>
            auctions.authorize(meetup, query.acting.participant).flatMap {
              case Left(denial) => denied(denial).fold(refuse, Future.successful)
              case Right(()) => read(auction)
            }
        }
    }

  /**
   * Чтения аукционов идут из read model и видимость сходки не проверяют (ADR-047): путь «сходка → аукцион» есть только
   * у бота хаба после ответа Meetups, а списки сходку не называют. Аукциона у сходки нет — пустой ответ, а не ошибка.
   */
  def getMeetupAuction(in: wire.GetMeetupAuctionRequest): Future[wire.GetMeetupAuctionResponse] =
    RequestMapping.getMeetupAuction(in) match {
      case Left(error) => invalid(error)
      case Right(query) =>
        auctionViews
          .byMeetup(query.meetup)
          .map(found => wire.GetMeetupAuctionResponse(found.map(ResponseMapping.auctionSnapshot)))
    }

  def listAuctions(in: wire.ListAuctionsRequest): Future[wire.ListAuctionsResponse] =
    RequestMapping.listAuctions(in) match {
      case Left(error) => invalid(error)
      case Right(query) =>
        auctionViews.page(query.listing, query.after, query.limit + 1).map { found =>
          val page = found.take(query.limit)
          val next =
            if (found.sizeIs > query.limit) page.lastOption.map(view => PageToken.encode(view.auctionId)) else None
          wire.ListAuctionsResponse(page.map(ResponseMapping.auctionSnapshot), next.getOrElse(""))
        }
    }

  // Счета: контракт есть (PER-308), выставление, статусы и чтения приносит лист счёта (PER-338).
  def markInvoicePaid(in: wire.MarkInvoicePaidRequest): Future[wire.MarkInvoicePaidResponse] = unimplemented

  def markInvoiceHandedOver(in: wire.MarkInvoiceHandedOverRequest): Future[wire.MarkInvoiceHandedOverResponse] =
    unimplemented

  def chooseFulfillment(in: wire.ChooseFulfillmentRequest): Future[wire.ChooseFulfillmentResponse] = unimplemented

  def listMyInvoices(in: wire.ListMyInvoicesRequest): Future[wire.ListMyInvoicesResponse] = unimplemented

  def listAuctionInvoices(in: wire.ListAuctionInvoicesRequest): Future[wire.ListAuctionInvoicesResponse] =
    unimplemented

  /**
   * Ответа entity не дождались. Команда могла быть принята, поэтому это `DEADLINE_EXCEEDED`, а не `UNAVAILABLE`: повтор
   * с тем же `op_id` вернёт исходный ответ, а не запишет команду второй раз.
   */
  private def awaited[T]: PartialFunction[Throwable, Future[T]] = { case _: TimeoutException =>
    refuse(Status.DEADLINE_EXCEEDED.withDescription("entity did not answer in time"))
  }

  private def invalid[T](error: FormError): Future[T] =
    refuse(Status.INVALID_ARGUMENT.withDescription(s"invalid ${error.field}"))

  private def unimplemented[T]: Future[T] = refuse(Status.UNIMPLEMENTED)

  private def refuse[T](status: Status): Future[T] = Future.failed(new GrpcServiceException(status))
}

object AuctionGrpcService {

  /** Допуск просрочки по умолчанию; узел передаёт `auction.deadlines.overdue-grace` — тот же, что у метрики. */
  val DefaultOverdueGrace: Duration = Duration.ofMinutes(1)

  /** Попыток заморозки имени после принятой ставки; подряд, без паузы: у сервиса нет планировщика. */
  val FreezeAttempts: Int = 3

  /** Имя события об исчерпанных попытках заморозки в логе. */
  val FreezeOperation: String = "auction.display_name.freeze"

  private val logger = LoggerFactory.getLogger(classOf[AuctionGrpcService])

  /**
   * Аукцион сходки — UUIDv5, выведенный из `meetup_id` (ADR-047); тестовый аукцион из настройки бота — UUIDv7 без
   * журнала аукциона. Форму идентификатора граница уже проверила, поэтому версия здесь различает два вида аукциона.
   */
  def isMeetupAuction(auctionId: java.util.UUID): Boolean = auctionId.version == 5
}
