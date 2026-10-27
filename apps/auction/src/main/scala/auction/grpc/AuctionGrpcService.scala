package auction.grpc

import auction.aggregate.Auction
import auction.aggregate.AuctionCommands
import auction.aggregate.AuctionConfig
import auction.aggregate.AuctionState
import auction.aggregate.MeetupGate
import auction.aggregate.PaymentInstructions
import auction.aggregate.Correlation
import auction.aggregate.Denial
import auction.invoice.Invoice
import auction.invoice.InvoiceAction
import auction.invoice.InvoiceGateway
import auction.invoice.InvoiceViews
import auction.access.Viewer
import auction.catalog.CatalogRefusal
import auction.catalog.LotCatalogCommands
import auction.catalog.LotId
import auction.catalog.LotImage as CatalogImage
import auction.entity.Initiator
import auction.entity.LotGateway
import auction.lot.AuctionId
import auction.lot.BidSource
import auction.lot.OpId
import auction.lot.ParticipantId
import auction.naming.DisplayNameCommands
import auction.naming.DisplayName
import auction.naming.NamedParticipant
import auction.naming.NameNotChosen
import auction.onboarding.FaqAcknowledgements
import auction.projection.AuctionSnapshotView
import auction.projection.AuctionViews
import auction.projection.AuctionWatchViews
import auction.projection.FinalBids
import auction.prediction.PredictionGateway
import auction.prediction.PredictionRound
import auction.prediction.PredictionTally
import auction.prediction.SubmitForecast
import auction.prediction.SubmitRejected
import auction.projection.LotSnapshotView
import auction.projection.LotViews
import auction.raffle.AssignRejected
import auction.raffle.AssignWinner
import auction.raffle.CancelRegistration
import auction.raffle.ChangePrize
import auction.raffle.ChangePrizeRejected
import auction.raffle.PrizePhoto
import auction.raffle.PrizePhotoBytes
import auction.raffle.Raffle
import auction.raffle.RaffleGateway
import auction.raffle.RafflePrizePhotos
import auction.raffle.RaffleState
import auction.raffle.RaffleView
import auction.raffle.Register
import auction.raffle.RemovePrizePhoto
import auction.raffle.SetPrizePhoto
import auction.results.ResultsGateway
import auction.results.ResultsView
import auction.v1.auction_service as wire
import auction.v1.auction_service.RafflePrizePhotoRefusal.Reason as PhotoReason
import auction.watch.AuctionChanges
import com.google.protobuf.ByteString
import io.grpc.Status
import net.logstash.logback.argument.StructuredArguments
import org.apache.pekko.NotUsed
import org.apache.pekko.grpc.GrpcServiceException
import org.apache.pekko.stream.scaladsl.Flow
import org.apache.pekko.stream.scaladsl.Source
import org.slf4j.LoggerFactory

import java.time.Clock
import java.time.Duration
import java.time.Instant
import java.util.Locale
import java.util.UUID
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
    overdueGrace: Duration = AuctionGrpcService.DefaultOverdueGrace,
    raffles: RaffleGateway = AuctionGrpcService.NoRaffles,
    raffleNames: AuctionId => Future[Map[Int, String]] = _ => Future.successful(Map.empty),
    watchViews: AuctionWatchViews = AuctionGrpcService.NoWatch,
    changes: AuctionChanges = AuctionGrpcService.NoChanges,
    caller: Option[Caller] = None,
    predictions: PredictionGateway = AuctionGrpcService.NoPredictions,
    results: ResultsGateway = AuctionGrpcService.NoResults,
    placeBidsRight: ParticipantId => Future[Boolean] = AuctionGrpcService.NoIdentity,
    notes: OperationNotes = OperationNotes.discarded,
    finalBids: FinalBids = FinalBids.empty,
    invoices: InvoiceGateway = InvoiceGateway.none,
    invoiceViews: InvoiceViews = InvoiceViews.none,
    raffleByHand: Boolean = false,
    prizePhotos: RafflePrizePhotos = RafflePrizePhotos.absent
)(using ExecutionContext)
    extends wire.AuctionService {

  /**
   * Сервис для одного входящего вызова: команды аукциона спрашивают Meetups с его сквозными значениями, а событие сбоя
   * заморозки несёт их, чтобы его можно было связать с записью операции.
   */
  def within(
      correlation: Correlation,
      caller: Option[Caller] = None,
      notes: OperationNotes = OperationNotes.discarded
  ): AuctionGrpcService =
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
      overdueGrace,
      raffles,
      raffleNames,
      watchViews,
      changes,
      caller,
      predictions,
      results,
      placeBidsRight,
      notes,
      finalBids,
      invoices,
      invoiceViews,
      raffleByHand,
      prizePhotos
    )

  def placeBid(in: wire.PlaceBidRequest): Future[wire.PlaceBidResponse] =
    RequestMapping.placeBid(in) match {
      case Left(error) => invalid(error)
      case Right(command) =>
        // Источник называет запись операции (ADR-049, дополнение 2026-10-18): отказы зала и бота считаются раздельно.
        notes.add(OperationNotes.Source, OperationNotes.source(command.bid.source))
        command.bid.source match {
          case BidSource.Floor => placeFloorBid(command)
          case BidSource.Bot if !command.acting.viewer.isParticipant =>
            refuse(Status.PERMISSION_DENIED.withDescription("viewer has no auction right"))
          case BidSource.Bot =>
            val participant = command.acting.participant
            asNamed(command.lotId, participant, ResponseMapping.displayNameNotChosen)(
              lots.placeBid(command.lotId, command.bid, Initiator.Participant(participant))
            )(ResponseMapping.placeBid)
        }
    }

  /**
   * Ставка зала (integration.md, «Финал и его поток»): помощник ведущего записывает, что человек в зале принял
   * объявленную цену. Право помощника — вести аукцион (`run_auctions`), и проверяет его Meetups отношением ведущего
   * аукциона (ADR-070, п. 1). Право человека зала — `place_bids` у Identity (п. 3): без него ставка получает
   * `ParticipantCannotBid` и до лота не доходит. Не ответивший Identity ставку не останавливает: человек считается
   * держателем права, как неответивший кандидат розыгрыша. Имя нужно человеку в зале, а не помощнику: лидером и
   * победителем станет он. В журнал ставка ложится с инициатором-оператором.
   */
  private def placeFloorBid(command: BidCommand): Future[wire.PlaceBidResponse] =
    lots.auctionOf(command.lotId).recoverWith(awaited).flatMap {
      case None => refuse(Status.NOT_FOUND.withDescription("lot not found"))
      case Some(auction) =>
        auctions.hosts(auction, command.acting.participant).flatMap {
          case Left(denial) => ResponseMapping.floorDenied(denial).fold(refuse, Future.successful)
          case Right(()) =>
            holdsPlaceBids(command.lotId, command.bid.participant).flatMap {
              case false => Future.successful(ResponseMapping.participantCannotBid)
              case true =>
                asNamed(command.lotId, command.bid.participant, ResponseMapping.displayNameNotChosen)(
                  lots.placeBid(command.lotId, command.bid, Initiator.Operator(command.acting.participant))
                )(ResponseMapping.placeBid)
            }
        }
    }

  /**
   * Право человека зала у Identity; отказ вызова — «нет ответа», и человек считается держателем права (ADR-070, п. 3).
   * Пропущенная проверка пишется событием: на время сбоя в зал мог попасть заблокированный, и это должно быть видно.
   * Человека событие не называет — хватает лота и `request_id`, — а сообщения исключения в нём нет, как в записи
   * операции.
   */
  private def holdsPlaceBids(lotId: java.util.UUID, participant: ParticipantId): Future[Boolean] =
    Future.delegate(placeBidsRight(participant)).recover { case NonFatal(cause) =>
      AuctionGrpcService.logger.warn(
        "floor bid right unconfirmed",
        StructuredArguments.entries(
          (Map[String, Any](
            "operation" -> AuctionGrpcService.FloorRightOperation,
            "result" -> "error",
            "error_category" -> "dependency_unavailable",
            "error" -> cause.getClass.getName,
            "lot_id" -> lotId.toString
          ) ++ correlation.requestId.filter(_.nonEmpty).map("request_id" -> _) ++
            correlation.useCase.filter(_.nonEmpty).map("use_case" -> _)).asJava
        )
      )
      true
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
          .recoverWith(awaited)
    }

  /** Фото в конец списка (ADR-057, дополнение 2026-10-24): правило правки то же, что у карточки. */
  def addLotPhoto(in: wire.AddLotPhotoRequest): Future[wire.AddLotPhotoResponse] =
    RequestMapping.addLotPhoto(in) match {
      case Left(error) => invalid(error)
      case Right(command) =>
        catalog
          .addPhoto(command.viewer, command.lotId, command.photoId, command.photo)
          .map(ResponseMapping.addLotPhoto)
          .recoverWith(awaited)
    }

  def removeLotPhoto(in: wire.RemoveLotPhotoRequest): Future[wire.RemoveLotPhotoResponse] =
    RequestMapping.removeLotPhoto(in) match {
      case Left(error) => invalid(error)
      case Right(command) =>
        catalog
          .removePhoto(command.viewer, command.lotId, command.photoId)
          .map(ResponseMapping.removeLotPhoto)
          .recoverWith(awaited)
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
            concealed(view.auctionId, query.acting.viewer).flatMap {
              case false =>
                collectorNames(view.auctionId, List(view)).map { collectors =>
                  SnapshotMapping.snapshot(view, query.acting.participant, clock.instant(), collectors)
                }
              case true => refuse(Status.NOT_FOUND.withDescription("lot not found"))
            }
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
        concealed(query.auctionId, query.acting.viewer)
          .flatMap {
            case true => Future.successful(Vector.empty)
            case false => read(query.auctionId, query.after, query.limit + 1)
          }
          .flatMap { found =>
            val page = found.take(query.limit)
            collectorNames(query.auctionId, page).map { collectors =>
              val at = clock.instant()
              val next =
                if (found.sizeIs > query.limit) page.lastOption.map(view => PageToken.encode(view.lotId)) else None
              wire.ListAuctionLotsResponse(
                page.map(SnapshotMapping.snapshot(_, query.acting.participant, at, collectors)),
                next.getOrElse("")
              )
            }
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
        lotConcealed(query.lotId, query.acting.viewer)
          .flatMap {
            case true => Future.successful(None)
            case false => views.history(query.lotId, query.after, query.limit + 1)
          }
          .flatMap {
            case None => refuse(Status.NOT_FOUND.withDescription("lot not found"))
            case Some(found) =>
              val page = found.take(query.limit)
              val next =
                if (found.sizeIs > query.limit) page.lastOption.map(entry => SequenceToken.encode(entry.position))
                else None
              Future.successful(wire.ListLotHistoryResponse(page.map(HistoryMapping.entry), next.getOrElse("")))
          }
    }

  /**
   * Имена собравших сеты лотов (ADR-073, п. 7): лоты без собранного сета запроса к именам не делают. Имя — украшение
   * снимка, поле в контракте необязательно, поэтому сбой хранилища имён не роняет ни чтение лота, ни ленту, ни поток:
   * снимок уходит без имени собравшего, а сбой пишется событием. Собравшего событие не называет — хватает аукциона и
   * `request_id`, — а сообщения исключения в нём нет, как в записи операции.
   */
  private def collectorNames(
      auctionId: UUID,
      views: Iterable[LotSnapshotView]
  ): Future[Map[ParticipantId, DisplayName]] =
    Future
      .delegate(names.names(AuctionId(auctionId), SnapshotMapping.collectors(views)))
      .recover { case NonFatal(cause) =>
        AuctionGrpcService.logger.warn(
          "collector names unavailable",
          StructuredArguments.entries(
            (Map[String, Any](
              "operation" -> AuctionGrpcService.CollectorNamesOperation,
              "result" -> "error",
              "error_category" -> "dependency_unavailable",
              "error" -> cause.getClass.getName,
              "auction_id" -> auctionId.toString
            ) ++ correlation.requestId.filter(_.nonEmpty).map("request_id" -> _) ++
              correlation.useCase.filter(_.nonEmpty).map("use_case" -> _)).asJava
          )
        )
        Map.empty
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

  /**
   * Имена аукциона для выбора человека зала (ADR-070, пп. 3–4): только держателю `run_auctions`. В список входят те,
   * кто выбрал имя в аукционе и держит `place_bids`; не ответивший Identity человека не отсеивает. Сверху ставившие в
   * финале, последний ставивший первым. Аукцион без выбранных имён отвечает пустым списком.
   */
  def listAuctionNames(in: wire.ListAuctionNamesRequest): Future[wire.ListAuctionNamesResponse] =
    RequestMapping.listAuctionNames(in) match {
      case Left(error) => invalid(error)
      case Right(query) if !query.acting.viewer.runsAuctions =>
        refuse(Status.PERMISSION_DENIED.withDescription("viewer may not run the auction"))
      case Right(query) =>
        for {
          chosen <- names.chosen(query.auctionId)
          allowed <- allowedBidders(query.auctionId, chosen.keySet)
          lastBids <- finalBids.lastBids(query.auctionId)
        } yield ResponseMapping.auctionNames(ranked(chosen, allowed, lastBids))
    }

  /**
   * Кого Identity подтвердил держателем `place_bids` (ADR-070, «Последствия»). Не ответивший Identity человека не
   * отсеивает: финал не встаёт на сбое соседа, как у кандидатов розыгрыша. Пропущенная проверка пишется в журнал: на
   * время сбоя в список мог попасть заблокированный, и это должно быть видно.
   */
  private def allowedBidders(auction: AuctionId, participants: Set[ParticipantId]): Future[Set[ParticipantId]] =
    Future
      .traverse(participants)(participant =>
        Future
          .delegate(placeBidsRight(participant))
          .recover { case NonFatal(cause) =>
            AuctionGrpcService.logger.warn(
              "auction names right unconfirmed",
              StructuredArguments.entries(
                (Map[String, Any](
                  "operation" -> AuctionGrpcService.AuctionNamesRightOperation,
                  "result" -> "error",
                  "error_category" -> "dependency_unavailable",
                  "error" -> cause.getClass.getName,
                  "auction_id" -> auction.value.toString
                ) ++ correlation.requestId.filter(_.nonEmpty).map("request_id" -> _) ++
                  correlation.useCase.filter(_.nonEmpty).map("use_case" -> _)).asJava
              )
            )
            true
          }
          .map(participant -> _)
      )
      .map(_.collect { case (participant, true) => participant })

  /**
   * Порядок экрана помощника (ADR-070, п. 4): сверху ставившие в финале, последний ставивший первым; остальные — по
   * тексту имени без учёта регистра. Момент последней ставки у человека один, поэтому порядок между людьми устойчив.
   */
  private def ranked(
      chosen: Map[ParticipantId, DisplayName],
      allowed: Set[ParticipantId],
      lastBids: Map[ParticipantId, Instant]
  ): List[NamedParticipant] =
    chosen.toList
      .filter((participant, _) => allowed(participant))
      .sortBy { (participant, name) =>
        val text = name.text
        lastBids.get(participant) match {
          case Some(at) => (0, -at.toEpochMilli, text.toLowerCase(Locale.ROOT), text)
          case None => (1, 0L, text.toLowerCase(Locale.ROOT), text)
        }
      }
      .map((participant, name) => NamedParticipant(participant, name))

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
        lotConcealed(query.lotId, query.acting.viewer)
          .flatMap {
            case true => Future.successful(None)
            case false => views.image(query.lotId)
          }
          .flatMap {
            case Some(image) => Future.successful(ResponseMapping.lotImage(image))
            case None => refuse(Status.NOT_FOUND.withDescription("lot image not found"))
          }
    }

  /** Байты одного фото лота (ADR-057, дополнение 2026-10-24). Видимость и `NOT_FOUND` — те же, что у `GetLotImage`. */
  def getLotPhoto(in: wire.GetLotPhotoRequest): Future[wire.LotImage] =
    RequestMapping.getLotPhoto(in) match {
      case Left(error) => invalid(error)
      case Right(query) if !query.acting.viewer.isParticipant =>
        refuse(Status.PERMISSION_DENIED.withDescription("viewer has no auction right"))
      case Right(query) =>
        lotConcealed(query.lotId, query.acting.viewer)
          .flatMap {
            case true => Future.successful(None)
            case false => views.photo(query.lotId, query.photoId)
          }
          .flatMap {
            case Some(image) => Future.successful(ResponseMapping.lotImage(image))
            case None => refuse(Status.NOT_FOUND.withDescription("lot photo not found"))
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

  /** Определение сета лотов (ADR-073): право — у Meetups, заморозку, название и лоты решает аукцион. */
  def saveLotSet(in: wire.SaveLotSetRequest): Future[wire.SaveLotSetResponse] =
    RequestMapping.saveLotSet(in) match {
      case Left(error) => invalid(error)
      case Right(command) =>
        auctions
          .saveLotSet(
            command.auctionId,
            command.set,
            command.name,
            command.lots,
            command.opId,
            command.acting.participant
          )
          .recoverWith(awaited)
          .flatMap(outcome => ResponseMapping.saveLotSet(outcome).fold(refuse, Future.successful))
    }

  def deleteLotSet(in: wire.DeleteLotSetRequest): Future[wire.DeleteLotSetResponse] =
    RequestMapping.deleteLotSet(in) match {
      case Left(error) => invalid(error)
      case Right(command) =>
        auctions
          .deleteLotSet(command.auctionId, command.set, command.opId, command.acting.participant)
          .recoverWith(awaited)
          .flatMap(outcome => ResponseMapping.deleteLotSet(outcome).fold(refuse, Future.successful))
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

  /** Публикация аукциона участникам (ADR-047, дополнение 2026-10-20): право у Meetups, состояние решает аукцион. */
  def publishAuction(in: wire.PublishAuctionRequest): Future[wire.PublishAuctionResponse] =
    RequestMapping.publishAuction(in) match {
      case Left(error) => invalid(error)
      case Right(command) =>
        changeVisibility(command).map(
          _.fold(wire.PublishAuctionResponse().withAccepted(wire.AuctionVisibilityAccepted()))(
            wire.PublishAuctionResponse().withRefused(_)
          )
        )
    }

  /** Снятие аукциона с публикации до торгов (ADR-047, дополнение 2026-10-20). */
  def hideAuction(in: wire.HideAuctionRequest): Future[wire.HideAuctionResponse] =
    RequestMapping.hideAuction(in) match {
      case Left(error) => invalid(error)
      case Right(command) =>
        changeVisibility(command).map(
          _.fold(wire.HideAuctionResponse().withAccepted(wire.AuctionVisibilityAccepted()))(
            wire.HideAuctionResponse().withRefused(_)
          )
        )
    }

  private def changeVisibility(command: VisibilityCommand): Future[Option[wire.AuctionVisibilityRefusal]] =
    auctions
      .changeVisibility(command.auctionId, command.published, command.opId, command.acting.participant)
      .recoverWith(awaited)
      .flatMap(outcome => ResponseMapping.auctionVisibility(outcome).fold(refuse, Future.successful))

  /**
   * Ориентировочное время финала (ADR-040, дополнение 2026-10-19): право у Meetups, состояние решает аукцион. Время
   * выставляется, меняется и снимается одной командой.
   */
  def setFinalTime(in: wire.SetFinalTimeRequest): Future[wire.SetFinalTimeResponse] =
    RequestMapping.setFinalTime(in) match {
      case Left(error) => invalid(error)
      case Right(command) =>
        auctions
          .setFinalTime(command.auctionId, command.at, command.opId, command.acting.participant)
          .recoverWith(awaited)
          .flatMap(outcome => ResponseMapping.setFinalTime(outcome).fold(refuse, Future.successful))
    }

  /**
   * Порядок и разделы ленты (PER-719): право у Meetups, состояние решает аукцион. Раскладка заменяется целиком одной
   * командой.
   */
  def setLotLayout(in: wire.SetLotLayoutRequest): Future[wire.SetLotLayoutResponse] =
    RequestMapping.setLotLayout(in) match {
      case Left(error) => invalid(error)
      case Right(command) =>
        auctions
          .setLotLayout(command.auctionId, command.layout, command.opId, command.acting.participant)
          .recoverWith(awaited)
          .flatMap(outcome => ResponseMapping.setLotLayout(outcome).fold(refuse, Future.successful))
    }

  /**
   * Текст «как оплатить и получить» (PER-322): право у Meetups без ворот по сходке, затем аукцион. Текст выставляется,
   * меняется и снимается одной командой.
   */
  def setPaymentInstructions(in: wire.SetPaymentInstructionsRequest): Future[wire.SetPaymentInstructionsResponse] =
    RequestMapping.setPaymentInstructions(in) match {
      case Left(error) => invalid(error)
      case Right(command) =>
        auctions
          .setPaymentInstructions(command.auctionId, command.text, command.opId, command.acting.participant)
          .recoverWith(awaited)
          .flatMap(outcome => ResponseMapping.setPaymentInstructions(outcome).fold(refuse, Future.successful))
    }

  /**
   * Промо-видео аукциона (PER-781): право у Meetups с воротами «сходка не отменена», затем аукцион. Видео выставляется,
   * заменяется и снимается одной командой.
   */
  def setPromoVideo(in: wire.SetPromoVideoRequest): Future[wire.SetPromoVideoResponse] =
    RequestMapping.setPromoVideo(in) match {
      case Left(error) => invalid(error)
      case Right(command) =>
        auctions
          .setPromoVideo(command.auctionId, command.video, command.opId, command.acting.participant)
          .recoverWith(awaited)
          .flatMap(outcome => ResponseMapping.setPromoVideo(outcome).fold(refuse, Future.successful))
    }

  /**
   * Видимость аукциона смотрящему (ADR-047, дополнение 2026-10-20): скрытый видит только держатель `run_auctions`, и
   * всем остальным чтения отвечают так, будто аукциона нет.
   */
  private def shown(viewer: Viewer)(view: AuctionSnapshotView): Boolean = viewer.runsAuctions || !view.auction.hidden

  /**
   * Аукцион скрыт от смотрящего. Тестовый аукцион из настройки бота (UUIDv7) журнала аукциона не имеет, и скрывать
   * нечего. Аукцион сходки без строки read model скрыт: новый рождается скрытым, а проекция лотов может обогнать
   * проекцию аукциона; без строки же отдаётся и удалённый, чьи лоты участнику не нужны.
   */
  /**
   * Лот скрытого аукциона: `lot_id` у участника остаётся и после снятия аукциона с публикации, поэтому чтения по нему
   * спрашивают аукцион лота. Лота нет в read model — скрывать нечего, ответ даст само чтение.
   */
  private def lotConcealed(lotId: UUID, viewer: Viewer): Future[Boolean] =
    if (viewer.runsAuctions) Future.successful(false)
    else
      views.find(lotId).flatMap {
        case Some(view) => concealed(view.auctionId, viewer)
        case None => Future.successful(false)
      }

  private def concealed(auctionId: UUID, viewer: Viewer): Future[Boolean] =
    if (viewer.runsAuctions || !AuctionGrpcService.isMeetupAuction(auctionId)) Future.successful(false)
    else auctionViews.byId(auctionId).map(_.forall(view => !shown(viewer)(view)))

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

  /** Отмена после старта торгов (ADR-047, дополнение 2026-10-12): право у Meetups, состояние решает аукцион. */
  def cancelAuction(in: wire.CancelAuctionRequest): Future[wire.CancelAuctionResponse] =
    RequestMapping.cancelAuction(in) match {
      case Left(error) => invalid(error)
      case Right(command) =>
        auctions
          .cancel(command.auctionId, command.opId, command.acting.participant)
          .recoverWith(awaited)
          .flatMap(outcome => ResponseMapping.cancelAuction(outcome).fold(refuse, Future.successful))
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
   * Предпросмотр снятия участника с лота (ADR-072; PER-658): право у Meetups, фазу, реестр и состав финала решает
   * аукцион, а итог — лот тем же решением, что у снятия, без записи.
   */
  def previewParticipantRemoval(
      in: wire.PreviewParticipantRemovalRequest
  ): Future[wire.PreviewParticipantRemovalResponse] =
    RequestMapping.previewParticipantRemoval(in) match {
      case Left(error) => invalid(error)
      case Right(preview) =>
        auctions
          .previewParticipantRemoval(preview.auctionId, preview.command, preview.acting.participant)
          .recoverWith(awaited)
          .flatMap(outcome => ResponseMapping.previewParticipantRemoval(outcome).fold(refuse, Future.successful))
    }

  /**
   * Снятие участника с лота (ADR-072; PER-658): путь выбора финалиста. Лот сверяет номер из предпросмотра и пишет итог,
   * только если лот от него не ушёл; ответ — номер лота, с которого чтение показывает снятие целиком.
   */
  def removeParticipant(in: wire.RemoveParticipantRequest): Future[wire.RemoveParticipantResponse] =
    RequestMapping.removeParticipant(in) match {
      case Left(error) => invalid(error)
      case Right(removal) =>
        auctions
          .removeParticipant(removal.auctionId, removal.command, removal.acting.participant)
          .recoverWith(awaited)
          .flatMap(outcome => ResponseMapping.removeParticipant(outcome).fold(refuse, Future.successful))
    }

  /**
   * Создание периода «Счастливых часов» (ADR-047, дополнение 2026-10-27): право у Meetups с воротами «сходка не
   * отменена», фазу и время решает аукцион по своим часам.
   */
  def createHappyHourPeriod(in: wire.CreateHappyHourPeriodRequest): Future[wire.CreateHappyHourPeriodResponse] =
    RequestMapping.createHappyHourPeriod(in) match {
      case Left(error) => invalid(error)
      case Right(create) =>
        auctions
          .createHappyHourPeriod(create.auctionId, create.command, create.acting.participant)
          .recoverWith(awaited)
          .flatMap(outcome => ResponseMapping.createHappyHourPeriod(outcome).fold(refuse, Future.successful))
    }

  /** Удаление периода «Счастливых часов» до его начала тем же путём, что создание. */
  def deleteHappyHourPeriod(in: wire.DeleteHappyHourPeriodRequest): Future[wire.DeleteHappyHourPeriodResponse] =
    RequestMapping.deleteHappyHourPeriod(in) match {
      case Left(error) => invalid(error)
      case Right(delete) =>
        auctions
          .deleteHappyHourPeriod(delete.auctionId, delete.command, delete.acting.participant)
          .recoverWith(awaited)
          .flatMap(outcome => ResponseMapping.deleteHappyHourPeriod(outcome).fold(refuse, Future.successful))
    }

  /**
   * Запуск окна сниженного шага (ADR-047, дополнение 2026-10-12): право у Meetups, фазу, время, реестр и пересечения
   * решает аукцион. Ответ — после записи `StepWindowLaunched`: лотам окно уходит после него.
   */
  def launchStepWindow(in: wire.LaunchStepWindowRequest): Future[wire.LaunchStepWindowResponse] =
    RequestMapping.launchStepWindow(in) match {
      case Left(error) => invalid(error)
      case Right(launch) =>
        auctions
          .launchStepWindow(launch.auctionId, launch.command, launch.acting.participant)
          .recoverWith(awaited)
          .flatMap(outcome => ResponseMapping.launchStepWindow(outcome).fold(refuse, Future.successful))
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
          val registrations = raffleRegistrations(query.auctionId, auction)
          val tally = predictionTally(query.auctionId)
          for {
            lots <- views.registryPage(auctionId, None, wholeRegistry)
            registered <- registrations
            predicted <- tally
          } yield {
            val view = AuctionSnapshotView(auctionId, auction)
            val console = ConsoleMapping.withParticipation(
              ConsoleMapping.console(view, lots, query.acting.participant, clock.instant(), overdueGrace),
              registered,
              predicted
            )
            wire.GetAuctionConsoleResponse().withConsole(console)
          }
        }
    }

  /**
   * Число регистраций в розыгрыше для пульта (PER-734) — из entity, пока розыгрыш держит регистрации: открыт он только
   * в онлайн-торгах, поэтому в остальных фазах entity не спрашивается. Число — украшение пульта, а не его условие:
   * отказ чтения отдаёт пульт без числа, и брошенный до `Future` — тоже: узел без шардинга розыгрыша бросает сразу.
   */
  private def raffleRegistrations(auctionId: AuctionId, auction: Auction): Future[Option[Int]] =
    auction.state match {
      case AuctionState.Prebidding(_, _) | AuctionState.Settling(_, _) =>
        Future
          .delegate(raffles.get(auctionId))
          .map(raffle =>
            raffle.state match {
              case RaffleState.Open(_, entries) => Some(entries.size)
              case _ => None
            }
          )
          .recover(participationUnavailable[Int](auctionId, "raffle"))
      case _ => Future.successful(None)
    }

  /** Прогнозы аукциона числами для пульта (PER-734); отказ чтения, как у розыгрыша, отдаёт пульт без них. */
  private def predictionTally(auctionId: AuctionId): Future[Option[PredictionTally]] =
    Future
      .delegate(predictions.tally(auctionId))
      .recover(participationUnavailable[PredictionTally](auctionId, "predictions"))

  /** Пульт без числа розыгрыша или прогнозов пишется событием, как снимок без имени собравшего сет. */
  private def participationUnavailable[T](
      auctionId: AuctionId,
      source: String
  ): PartialFunction[Throwable, Option[T]] = { case NonFatal(cause) =>
    AuctionGrpcService.logger.warn(
      "console participation unavailable",
      StructuredArguments.entries(
        (Map[String, Any](
          "operation" -> AuctionGrpcService.ConsoleParticipationOperation,
          "result" -> "error",
          "error_category" -> "dependency_unavailable",
          "error" -> cause.getClass.getName,
          "auction_id" -> auctionId.value.toString,
          "source" -> source
        ) ++ correlation.requestId.filter(_.nonEmpty).map("request_id" -> _) ++
          correlation.useCase.filter(_.nonEmpty).map("use_case" -> _)).asJava
      )
    )
    None
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
   * Сводка дня торгов за окно, которое назвал вызывающий (PER-492). Право и отказы — те же, что у пульта и статистики:
   * сводку читает администратор сходки. Числа — из read model и согласованы в конечном счёте.
   */
  def getAuctionDaySummary(in: wire.GetAuctionDaySummaryRequest): Future[wire.GetAuctionDaySummaryResponse] =
    RequestMapping.getAuctionDaySummary(in) match {
      case Left(error) => invalid(error)
      case Right(query) =>
        administered(ConsoleQuery(query.auctionId, query.acting), ResponseMapping.daySummaryDenied) { _ =>
          views
            .dayStatistics(query.auctionId.value, query.from, query.until)
            .map(lots => wire.GetAuctionDaySummaryResponse().withSummary(DaySummaryMapping.summary(lots)))
        }
    }

  /**
   * Чтение или команда администратора сходки мимо аукциона: аукцион у entity, без журнала или без сходки — `NOT_FOUND`
   * до вопроса Meetups, затем право у Meetups и ворота `gate` по состоянию сходки, и только после них `read`.
   */
  private def administered[R](
      query: ConsoleQuery,
      denied: Denial => Either[Status, R],
      gate: MeetupGate = MeetupGate.Unconditional
  )(
      read: Auction => Future[R]
  ): Future[R] =
    auctions.current(query.auctionId).recoverWith(awaited).flatMap {
      case None => refuse(Status.NOT_FOUND.withDescription("auction not found"))
      case Some(auction) =>
        auction.meetup match {
          case None => refuse(Status.NOT_FOUND.withDescription("auction not found"))
          case Some(meetup) =>
            auctions.authorize(meetup, query.acting.participant, gate).flatMap {
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
          .map(found =>
            wire.GetMeetupAuctionResponse(
              found.filter(shown(query.acting.viewer)).map(ResponseMapping.auctionSnapshot)
            )
          )
    }

  /**
   * Аукцион по идентификатору — корень аукциона у обоих ботов (PER-605). Черновик видит только бот хаба, как в
   * `GetMeetupAuction`: бот аукциона черновиков не показывает и в списках, и по идентификатору (integration.md).
   */
  def getAuction(in: wire.GetAuctionRequest): Future[wire.GetAuctionResponse] =
    RequestMapping.getAuction(in) match {
      case Left(error) => invalid(error)
      case Right(query) =>
        auctionViews
          .byId(query.auctionId.value)
          .map { found =>
            val drafts =
              found.filter(view => view.auction.state != AuctionState.Draft || caller.contains(Caller.HubBot))
            wire.GetAuctionResponse(drafts.filter(shown(query.acting.viewer)).map(ResponseMapping.auctionSnapshot))
          }
    }

  def listAuctions(in: wire.ListAuctionsRequest): Future[wire.ListAuctionsResponse] =
    RequestMapping.listAuctions(in) match {
      case Left(error) => invalid(error)
      case Right(query) =>
        val revealHidden = query.acting.viewer.runsAuctions
        auctionViews.page(query.listing, query.after, query.limit + 1, revealHidden).map { found =>
          val page = found.take(query.limit)
          val next =
            if (found.sizeIs > query.limit) page.lastOption.map(view => PageToken.encode(view.auctionId)) else None
          wire.ListAuctionsResponse(page.map(ResponseMapping.auctionSnapshot), next.getOrElse(""))
        }
    }

  /**
   * Регистрация в розыгрыше (ADR-066, пп. 2–4): право `place_bids` смотрящего, затем имя в аукционе — тем же правилом,
   * что перед ставкой, но без заморозки: регистрация не ставка, — затем розыгрыш. Торгов граница здесь не спрашивает.
   */
  def registerForRaffle(in: wire.RegisterForRaffleRequest): Future[wire.RegisterForRaffleResponse] =
    RequestMapping.registerForRaffle(in) match {
      case Left(error) => invalid(error)
      case Right(command) if !command.acting.viewer.isParticipant =>
        refuse(Status.PERMISSION_DENIED.withDescription("viewer has no auction right"))
      case Right(command) =>
        val participant = command.acting.participant
        names.requireChosen(command.auctionId, participant).flatMap {
          case Left(NameNotChosen) => Future.successful(RaffleMapping.displayNameNotChosen)
          case Right(_) =>
            raffles
              .register(command.auctionId, Register(participant, command.opId))
              .recoverWith(awaited)
              .flatMap(outcome => viewed(command.auctionId, participant, outcome))
              .flatMap(outcome => RaffleMapping.register(outcome).fold(refuse, Future.successful))
        }
    }

  def cancelRaffleRegistration(
      in: wire.CancelRaffleRegistrationRequest
  ): Future[wire.CancelRaffleRegistrationResponse] =
    RequestMapping.cancelRaffleRegistration(in) match {
      case Left(error) => invalid(error)
      case Right(command) if !command.acting.viewer.isParticipant =>
        refuse(Status.PERMISSION_DENIED.withDescription("viewer has no auction right"))
      case Right(command) =>
        val participant = command.acting.participant
        raffles
          .cancel(command.auctionId, CancelRegistration(participant, command.opId))
          .recoverWith(awaited)
          .flatMap(outcome => viewed(command.auctionId, participant, outcome))
          .flatMap(outcome => RaffleMapping.cancel(outcome).fold(refuse, Future.successful))
    }

  /** Розыгрыш смотрящего: из entity, а не из read model, — отметка «ты зарегистрирован» видна сразу после команды. */
  def getRaffle(in: wire.GetRaffleRequest): Future[wire.GetRaffleResponse] =
    RequestMapping.getRaffle(in) match {
      case Left(error) => invalid(error)
      case Right(query) if !query.acting.viewer.isParticipant =>
        refuse(Status.PERMISSION_DENIED.withDescription("viewer has no auction right"))
      case Right(query) =>
        concealed(query.auctionId.value, query.acting.viewer).flatMap {
          case true => Future.successful(wire.GetRaffleResponse())
          case false =>
            raffles
              .get(query.auctionId)
              .recoverWith(awaited)
              .flatMap(raffle => view(query.auctionId, query.acting.participant, raffle))
              .map(found => wire.GetRaffleResponse(found))
        }
    }

  /**
   * Ручной итог розыгрыша (ADR-066, дополнение 2026-10-24, PER-727): форма, затем право вести аукцион у Meetups с
   * воротами отменённой сходки, как у ручной отметки итогов прогнозов, затем розыгрыш. Повтор своего `op_id` отвечает
   * раньше права, как у отметок счёта (ADR-047): принятый итог не превращается в отказ сходки или `UNAVAILABLE`. Номер
   * билета и итог судит розыгрыш; ответ — розыгрыш глазами администратора.
   */
  def assignRaffleWinner(in: wire.AssignRaffleWinnerRequest): Future[wire.AssignRaffleWinnerResponse] =
    RequestMapping.assignRaffleWinner(in) match {
      case Left(error) => invalid(error)
      case Right(command) =>
        val assign = AssignWinner(command.ticket, command.opId)
        def answer(outcome: Either[AssignRejected, Raffle]) =
          viewed(command.auctionId, command.acting.participant, outcome)
            .flatMap(viewedOutcome => RaffleMapping.assign(viewedOutcome).fold(refuse, Future.successful))
        raffles.get(command.auctionId).recoverWith(awaited).flatMap { raffle =>
          raffle.seen.get(command.opId) match {
            case Some(_) =>
              Raffle.decide(raffle, assign, clock.instant()) match {
                case Left(rejected) => answer(Left(rejected))
                case Right(_) => answer(Right(raffle))
              }
            case None =>
              val query = ConsoleQuery(command.auctionId, command.acting)
              administered(query, ResponseMapping.assignWinnerDenied, MeetupGate.NotCancelled) { _ =>
                raffles.assign(command.auctionId, assign).recoverWith(awaited).flatMap(answer)
              }
          }
        }
    }

  /**
   * Смена приза розыгрыша (ADR-066, дополнение 2026-10-25, PER-737) путём ручного итога: форма, затем текст теми же
   * правилами, что приз конфигурации (`RafflePrizeBlank`, `RafflePrizeTooLong`), затем повтор своего `op_id` раньше
   * права, затем право вести аукцион у Meetups с воротами отменённой сходки, затем розыгрыш. Конфигурацию аукциона
   * команда не трогает: приз меняется только в розыгрыше, который скопировал его при открытии.
   */
  def changeRafflePrize(in: wire.ChangeRafflePrizeRequest): Future[wire.ChangeRafflePrizeResponse] =
    RequestMapping.changeRafflePrize(in) match {
      case Left(error) => invalid(error)
      case Right(command) if command.prize.isBlank => Future.successful(RaffleMapping.prizeBlank)
      case Right(command) if command.prize.length > AuctionConfig.MaxRafflePrize =>
        Future.successful(RaffleMapping.prizeTooLong)
      case Right(command) =>
        val change = ChangePrize(command.prize, command.opId)
        def answer(outcome: Either[ChangePrizeRejected, Raffle]) =
          viewed(command.auctionId, command.acting.participant, outcome)
            .flatMap(viewedOutcome => RaffleMapping.changePrize(viewedOutcome).fold(refuse, Future.successful))
        raffles.get(command.auctionId).recoverWith(awaited).flatMap { raffle =>
          raffle.seen.get(command.opId) match {
            case Some(_) =>
              Raffle.decide(raffle, change) match {
                case Left(rejected) => answer(Left(rejected))
                case Right(_) => answer(Right(raffle))
              }
            case None =>
              val query = ConsoleQuery(command.auctionId, command.acting)
              administered(query, ResponseMapping.changePrizeDenied, MeetupGate.NotCancelled) { _ =>
                raffles.changePrize(command.auctionId, change).recoverWith(awaited).flatMap(answer)
              }
          }
        }
    }

  /**
   * Фото приза розыгрыша (PER-772) путём смены приза: форма, затем байты тем же правилом, что фото лота (предел и
   * сигнатура), затем повтор своего id фото раньше права, затем право вести аукцион у Meetups с воротами отменённой
   * сходки, затем решение розыгрыша по прочитанному — отказ не пишет байтов, — запись байтов под id фото и команда
   * розыгрыша, которая решает заново. Уборка — [[tidyPrizePhotos]]: отвергнутая команда убирает свои байты, принятая —
   * байты фото, которое было у приза при чтении и перестало им быть.
   */
  def setRafflePrizePhoto(in: wire.SetRafflePrizePhotoRequest): Future[wire.SetRafflePrizePhotoResponse] =
    RequestMapping.setRafflePrizePhoto(in) match {
      case Left(error) => invalid(error)
      case Right(command) =>
        CatalogImage(command.photo) match {
          case Left(CatalogRefusal.ImageTooLarge(maxBytes)) =>
            Future.successful(
              RaffleMapping.prizePhotoRefused(PhotoReason.ImageTooLarge(wire.ImageTooLarge(maxBytes.toLong)))
            )
          case Left(_) =>
            Future.successful(RaffleMapping.prizePhotoRefused(PhotoReason.UnsupportedImage(wire.UnsupportedImage())))
          case Right(image) =>
            val auction = command.auctionId
            val set = SetPrizePhoto(PrizePhoto(command.photoId, image.version.value), OpId(command.photoId))
            def answer(outcome: Either[ChangePrizeRejected, Raffle]) =
              viewed(auction, command.acting.participant, outcome)
                .flatMap(viewedOutcome => RaffleMapping.setPrizePhoto(viewedOutcome).fold(refuse, Future.successful))
            def store(read: Raffle): Future[wire.SetRafflePrizePhotoResponse] = {
              val bytes = PrizePhotoBytes(image.content, image.mediaType.value, image.version.value)
              prizePhotos.store(auction, command.photoId, bytes).flatMap {
                case false => answer(Left(ChangePrizeRejected.OpIdTaken))
                case true =>
                  raffles.setPrizePhoto(auction, set).recoverWith(awaited).flatMap { outcome =>
                    tidyPrizePhotos(auction, read, outcome, Some(command.photoId)).flatMap(_ => answer(outcome))
                  }
              }
            }
            raffles.get(auction).recoverWith(awaited).flatMap { raffle =>
              Raffle.decide(raffle, set) match {
                case Left(rejected) if raffle.seen.contains(set.opId) => answer(Left(rejected))
                case Right(_) if raffle.seen.contains(set.opId) => answer(Right(raffle))
                case decision =>
                  val query = ConsoleQuery(auction, command.acting)
                  def denied(denial: Denial) =
                    ResponseMapping.prizePhotoDenied(denial).map(RaffleMapping.prizePhotoRefused)
                  administered(query, denied, MeetupGate.NotCancelled) { _ =>
                    decision match {
                      case Left(rejected) => answer(Left(rejected))
                      case Right(_) => store(raffle)
                    }
                  }
              }
            }
        }
    }

  /** Снятие фото приза (PER-772) путём смены приза; уборка байтов — [[tidyPrizePhotos]]. */
  def removeRafflePrizePhoto(in: wire.RemoveRafflePrizePhotoRequest): Future[wire.RemoveRafflePrizePhotoResponse] =
    RequestMapping.removeRafflePrizePhoto(in) match {
      case Left(error) => invalid(error)
      case Right(command) =>
        val auction = command.auctionId
        val remove = RemovePrizePhoto(command.opId)
        def answer(outcome: Either[ChangePrizeRejected, Raffle]) =
          viewed(auction, command.acting.participant, outcome)
            .flatMap(viewedOutcome => RaffleMapping.removePrizePhoto(viewedOutcome).fold(refuse, Future.successful))
        raffles.get(auction).recoverWith(awaited).flatMap { raffle =>
          raffle.seen.get(command.opId) match {
            case Some(_) =>
              Raffle.decide(raffle, remove) match {
                case Left(rejected) => answer(Left(rejected))
                case Right(_) => answer(Right(raffle))
              }
            case None =>
              val query = ConsoleQuery(auction, command.acting)
              def denied(denial: Denial) =
                ResponseMapping
                  .prizePhotoDenied(denial)
                  .map(reason =>
                    wire.RemoveRafflePrizePhotoResponse().withRefused(wire.RafflePrizePhotoRefusal(reason))
                  )
              administered(query, denied, MeetupGate.NotCancelled) { _ =>
                raffles.removePrizePhoto(auction, remove).recoverWith(awaited).flatMap { outcome =>
                  tidyPrizePhotos(auction, raffle, outcome, None).flatMap(_ => answer(outcome))
                }
              }
          }
        }
    }

  /**
   * Байты фото приза (PER-772): право и видимость — как у `GetRaffle`, фото — то, что у приза сейчас по журналу
   * розыгрыша. Розыгрыша, фото или его байтов нет — `NOT_FOUND`.
   */
  def getRafflePrizePhoto(in: wire.GetRafflePrizePhotoRequest): Future[wire.LotImage] =
    RequestMapping.getRafflePrizePhoto(in) match {
      case Left(error) => invalid(error)
      case Right(query) if !query.acting.viewer.isParticipant =>
        refuse(Status.PERMISSION_DENIED.withDescription("viewer has no auction right"))
      case Right(query) =>
        concealed(query.auctionId.value, query.acting.viewer)
          .flatMap {
            case true => Future.successful(None)
            case false =>
              raffles.get(query.auctionId).recoverWith(awaited).flatMap { raffle =>
                Raffle.prizePhoto(raffle.state) match {
                  case Some(photo) => prizePhotos.read(query.auctionId, photo.photoId)
                  case None => Future.successful(None)
                }
              }
          }
          .flatMap {
            case Some(photo) =>
              Future.successful(
                wire.LotImage(
                  ByteString.copyFrom(IArray.genericWrapArray(photo.content).toArray),
                  photo.mediaType,
                  photo.version
                )
              )
            case None => refuse(Status.NOT_FOUND.withDescription("raffle prize photo not found"))
          }
    }

  /**
   * Уборка байтов фото приза по решению розыгрыша, а не по времени записи: какое фото текущее, решает порядок команд у
   * entity. Убирается только то, что текущим уже не станет. Фото, которое было у приза при чтении `read` и которого нет
   * после команды, вернуть нельзя: его id лежит в окне `seen`, и повтор события не даёт. Байты отвергнутой команды
   * `stored` — тоже: отказ значит, что её id не текущий. Уборка не часть ответа: сбой пишется предупреждением, а лишняя
   * строка не видна ни одному чтению.
   */
  private def tidyPrizePhotos(
      auction: AuctionId,
      read: Raffle,
      outcome: Either[ChangePrizeRejected, Raffle],
      stored: Option[UUID]
  ): Future[Unit] = {
    val stale = outcome match {
      case Right(after) =>
        Raffle
          .prizePhoto(read.state)
          .map(_.photoId)
          .filterNot(id => Raffle.prizePhoto(after.state).exists(_.photoId == id))
      case Left(_) => stored
    }
    stale.fold(Future.unit) { photoId =>
      Future.delegate(prizePhotos.delete(auction, photoId)).recover { case NonFatal(cause) =>
        AuctionGrpcService.logger.warn(
          "raffle prize photo not deleted",
          StructuredArguments.keyValue("auction_id", auction.value.toString),
          StructuredArguments.keyValue("error", cause.getClass.getName)
        )
      }
    }
  }

  /**
   * Прогноз раунда (ADR-067, пп. 2–5): форма, право `place_bids` на каждой отправке, аукцион и лоты раунда, имя в
   * аукционе — тем же правилом, что перед ставкой, но без заморозки, — затем игра. Лоты сверяются, только пока раунд
   * может быть открыт: в остальное время отказ раунда даёт сама игра, и чужой лот его не подменяет.
   */
  def submitPrediction(in: wire.SubmitPredictionRequest): Future[wire.SubmitPredictionResponse] =
    PredictionMapping.submit(in).flatMap(command => PredictionMapping.forecast(command).map(command -> _)) match {
      case Left(error) => invalid(error)
      case Right((command, _)) if !command.acting.viewer.isParticipant =>
        refuse(Status.PERMISSION_DENIED.withDescription("viewer has no auction right"))
      case Right((command, forecast)) =>
        val participant = command.acting.participant
        auctions.current(command.auctionId).recoverWith(awaited).flatMap {
          case None => refuse(Status.NOT_FOUND.withDescription("auction not found"))
          // Общий дедлайн закрывает раунд каталога в свой момент (ADR-067, дополнение 2026-10-24), а не когда entity
          // прогнозов подтвердит закрытие: отправка в этом зазоре — отказ, а повтор принятой — исходный ответ.
          case Some(auction) if catalogDeadlinePassed(auction, forecast.round) =>
            predictions
              .recall(command.auctionId, participant, forecast.round, command.opId)
              .recoverWith(awaited)
              .flatMap {
                case Some(Right(accepted)) => Future.successful(PredictionMapping.accepted(accepted))
                case Some(Left(rejected)) => PredictionMapping.refused(rejected).fold(refuse, Future.successful)
                case None =>
                  PredictionMapping.refused(SubmitRejected.RoundClosed).fold(refuse, Future.successful)
              }
          case Some(auction) =>
            roundLots(auction, forecast.round).flatMap(forecast.foreignLot) match {
              // Повтор принятой отправки получает исходный ответ, даже если её лот с тех пор сняли из реестра.
              case Some((nomination, lot)) =>
                predictions
                  .recall(command.auctionId, participant, forecast.round, command.opId)
                  .recoverWith(awaited)
                  .flatMap {
                    case Some(Right(accepted)) => Future.successful(PredictionMapping.accepted(accepted))
                    case Some(Left(rejected)) => PredictionMapping.refused(rejected).fold(refuse, Future.successful)
                    case None => Future.successful(PredictionMapping.lotNotInRound(nomination, lot))
                  }
              case None =>
                names.requireChosen(command.auctionId, participant).flatMap {
                  case Left(NameNotChosen) => Future.successful(PredictionMapping.displayNameNotChosen)
                  case Right(_) =>
                    predictions
                      .submit(command.auctionId, SubmitForecast(participant, forecast, command.opId))
                      .recoverWith(awaited)
                      .flatMap {
                        case Right(accepted) => Future.successful(PredictionMapping.accepted(accepted))
                        case Left(rejected) => PredictionMapping.refused(rejected).fold(refuse, Future.successful)
                      }
                }
            }
        }
    }

  /**
   * Участники розыгрыша и прогнозов аукциона для аудитории объявления (PER-777, решение PER-768). Вызывающий — только
   * Notifications (`MethodAccess`), смотрящего нет: право администратора проверил он. Аукцион — у entity, розыгрыш — из
   * entity, а не из read model, и прогнозы — из строк после ответа игры: регистрация, её отмена, прогноз и его очистка
   * видны сразу, а стёртого субъекта в строках нет. Скрытый аукцион не прячется: экранов у чтения нет.
   */
  def listAuctionEngagement(in: wire.ListAuctionEngagementRequest): Future[wire.ListAuctionEngagementResponse] =
    RequestMapping.listAuctionEngagement(in) match {
      case Left(error) => invalid(error)
      case Right(auctionId) =>
        auctions.current(auctionId).recoverWith(awaited).flatMap {
          case None => refuse(Status.NOT_FOUND.withDescription("auction not found"))
          case Some(auction) =>
            val raffle = raffles.get(auctionId).recoverWith(awaited)
            val forecasters = predictions.forecasters(auctionId).recoverWith(awaited)
            for {
              found <- raffle
              open <- forecasters
            } yield EngagementMapping.response(
              EngagementMapping.registration(auction.state, found.state, clock.instant()),
              open
            )
        }
    }

  /** Свои прогнозы смотрящего по раундам; чужих это чтение не отдаёт (ADR-067, п. 9). */
  def getMyPredictions(in: wire.GetMyPredictionsRequest): Future[wire.GetMyPredictionsResponse] =
    PredictionMapping.mine(in) match {
      case Left(error) => invalid(error)
      case Right(query) if !query.acting.viewer.isParticipant =>
        refuse(Status.PERMISSION_DENIED.withDescription("viewer has no auction right"))
      case Right(query) =>
        auctions.current(query.auctionId).recoverWith(awaited).flatMap {
          case None => refuse(Status.NOT_FOUND.withDescription("auction not found"))
          case Some(_) =>
            predictions
              .mine(query.auctionId, query.acting.participant)
              .recoverWith(awaited)
              .map(PredictionMapping.mine)
        }
    }

  /**
   * Итоги прогнозов аукциона (ADR-067, пп. 8–9): право `place_bids`, аукцион — у entity, затем чтение. Отменённый
   * аукцион итогов не отдаёт: `cancelled`, даже если подсчёт каким-то образом состоялся. Чужие прогнозы не раскрываются
   * и здесь: чтение несёт только победителей по именам и результат смотрящего.
   */
  def getPredictionResults(in: wire.GetPredictionResultsRequest): Future[wire.GetPredictionResultsResponse] =
    RequestMapping.getPredictionResults(in) match {
      case Left(error) => invalid(error)
      case Right(query) if !query.acting.viewer.isParticipant =>
        refuse(Status.PERMISSION_DENIED.withDescription("viewer has no auction right"))
      case Right(query) =>
        auctions.current(query.auctionId).recoverWith(awaited).flatMap {
          case None => refuse(Status.NOT_FOUND.withDescription("auction not found"))
          case Some(auction) =>
            auction.state match {
              case AuctionState.Cancelled(_, _, _) =>
                Future.successful(PredictionResultsMapping.read(ResultsView.Cancelled, query.acting.participant))
              case _ =>
                results
                  .read(query.auctionId)
                  .recoverWith(awaited)
                  .map(PredictionResultsMapping.read(_, query.acting.participant))
            }
        }
    }

  /**
   * Хроники дня участника (PER-725): та же сводка окна, что у пульта, за последние сутки по часам сервиса, и счётчики
   * жизни лота, без которых не найти «тёмную лошадку». Право — `place_bids`, скрытый аукцион — как отсутствующий.
   * Служебного пульта — числа участников и времени последней ставки — ответ не несёт. Окно выбирает сервис, а не
   * вызывающий: участник читает последние сутки, а не любой срез недели.
   */
  def getAuctionDayChronicle(in: wire.GetAuctionDayChronicleRequest): Future[wire.GetAuctionDayChronicleResponse] =
    RequestMapping.getAuctionDayChronicle(in) match {
      case Left(error) => invalid(error)
      case Right(query) if !query.acting.viewer.isParticipant =>
        refuse(Status.PERMISSION_DENIED.withDescription("viewer has no auction right"))
      case Right(query) =>
        val auctionId = query.auctionId.value
        concealed(auctionId, query.acting.viewer).flatMap {
          case true => refuse(Status.NOT_FOUND.withDescription("auction not found"))
          case false =>
            auctions.current(query.auctionId).recoverWith(awaited).flatMap {
              case None => refuse(Status.NOT_FOUND.withDescription("auction not found"))
              case Some(_) =>
                val until = clock.instant()
                val from = until.minus(AuctionGrpcService.ChronicleWindow)
                // Сутки — раньше жизни лота, как у пульта (PER-511): ставка между чтениями попадает только в число
                // ставок за всё время и лишь завышает «до суток».
                for {
                  day <- views.dayStatistics(auctionId, from, until)
                  lifetime <- views.statistics(auctionId)
                } yield DaySummaryMapping.chronicle(from, until, day, lifetime)
            }
        }
    }

  /**
   * Хроники всего аукциона участника (PER-769): агрегаты лотов того же чтения, что у хроник дня, но без окна суток — от
   * начала времён до часов сервиса, поэтому в них входит каждая ставка от открытия торгов и счётчики равны сумме хроник
   * по дням. Право и скрытый аукцион — как у хроник дня. Участники — разные люди по всему реестру, а не сумма по лотам:
   * читаются после агрегатов, и человек, пришедший между чтениями, только добавится к числу.
   */
  def getAuctionChronicle(in: wire.GetAuctionChronicleRequest): Future[wire.GetAuctionChronicleResponse] =
    RequestMapping.getAuctionChronicle(in) match {
      case Left(error) => invalid(error)
      case Right(query) if !query.acting.viewer.isParticipant =>
        refuse(Status.PERMISSION_DENIED.withDescription("viewer has no auction right"))
      case Right(query) =>
        val auctionId = query.auctionId.value
        concealed(auctionId, query.acting.viewer).flatMap {
          case true => refuse(Status.NOT_FOUND.withDescription("auction not found"))
          case false =>
            auctions.current(query.auctionId).recoverWith(awaited).flatMap {
              case None => refuse(Status.NOT_FOUND.withDescription("auction not found"))
              case Some(_) =>
                val until = clock.instant()
                for {
                  lots <- views.dayStatistics(auctionId, Instant.EPOCH, until)
                  participants <- views.participantCount(auctionId)
                } yield DaySummaryMapping.auctionChronicle(until, lots, participants)
            }
        }
    }

  /**
   * Ручная отметка итогов (ADR-067, п. 8): только администратор сходки аукциона, право у Meetups — тем же путём, что у
   * пульта. Подсчёт этим подавляется; повтор на посчитанном или уже отмеченном принят без второго факта.
   */
  def settlePredictionResultsManually(
      in: wire.SettlePredictionResultsManuallyRequest
  ): Future[wire.SettlePredictionResultsManuallyResponse] =
    RequestMapping.settlePredictionResults(in) match {
      case Left(error) => invalid(error)
      case Right(query) =>
        // Ручная отметка — команда администратора: у отменённой сходки она закрыта воротами (ADR-047, дополнение
        // 2026-10-12).
        administered(query, ResponseMapping.settleResultsDenied, MeetupGate.NotCancelled) { _ =>
          results
            .recordManually(query.auctionId)
            .recoverWith(awaited)
            .map(_ => ResponseMapping.settleResultsAccepted)
        }
    }

  /**
   * Прошёл ли общий дедлайн, закрывающий раунд каталога: по часам у аукциона в онлайн-торгах, по фазе — после них.
   * Отменённый отвечает отказом прогнозов, а не дедлайна.
   */
  private def catalogDeadlinePassed(auction: Auction, round: PredictionRound): Boolean =
    round == PredictionRound.Catalog && (auction.state match {
      case AuctionState.Prebidding(config, _) => config.lotDeadline.exists(!clock.instant().isBefore(_))
      case AuctionState.Settling(_, _) | AuctionState.Break(_, _) | AuctionState.LineupFrozen(_, _, _) |
          AuctionState.Final(_, _, _, _, _) | AuctionState.Finished(_, _) =>
        true
      case AuctionState.Initial | AuctionState.Draft | AuctionState.Scheduled(_) | AuctionState.Cancelled(_, _, _) =>
        false
    })

  /**
   * Лоты раунда, пока он может быть открыт: каталог — реестр запланированного аукциона и аукциона в онлайн-торгах до
   * общего дедлайна, финал — замороженный состав (ADR-067, п. 4). В остальных фазах `None`: раунд закрыт или не открыт,
   * и это скажет игра.
   */
  private def roundLots(auction: Auction, round: PredictionRound): Option[Set[LotId]] =
    (round, auction.state) match {
      case (PredictionRound.Catalog, AuctionState.Scheduled(_) | AuctionState.Prebidding(_, _)) => Some(auction.lots)
      case (PredictionRound.Final, AuctionState.LineupFrozen(_, _, order)) => Some(order.toSet)
      case _ => None
    }

  private def viewed[R](
      auction: AuctionId,
      participant: ParticipantId,
      outcome: Either[R, Raffle]
  ): Future[Either[R, wire.Raffle]] =
    outcome match {
      case Left(rejected) => Future.successful(Left(rejected))
      case Right(raffle) =>
        view(auction, participant, raffle).flatMap {
          case Some(found) => Future.successful(Right(found))
          case None => refuse(Status.INTERNAL.withDescription("raffle answered a command without a raffle"))
        }
    }

  /**
   * Имена снимка читаются только у зафиксированного пула: до него списка билетов нет. Имя билета — украшение, и билет
   * без имени снимок уже знает (имя стёрто), поэтому сбой чтения имён отдаёт билеты без имён и пишется событием, а не
   * роняет ответ — и чтение, и ответ на принятую команду.
   */
  private def view(auction: AuctionId, participant: ParticipantId, raffle: Raffle): Future[Option[wire.Raffle]] = {
    val names = raffle.state match {
      case RaffleState.Fixed(_, _) | RaffleState.AwaitingWinner(_, _) | RaffleState.Drawn(_, _, _, _) |
          RaffleState.Assigned(_, _, _, _) =>
        Future.delegate(raffleNames(auction)).recover { case NonFatal(cause) =>
          AuctionGrpcService.logger.warn(
            "raffle ticket names unavailable",
            StructuredArguments.entries(
              (Map[String, Any](
                "operation" -> AuctionGrpcService.RaffleNamesOperation,
                "result" -> "error",
                "error_category" -> "dependency_unavailable",
                "error" -> cause.getClass.getName,
                "auction_id" -> auction.value.toString
              ) ++ correlation.requestId.filter(_.nonEmpty).map("request_id" -> _) ++
                correlation.useCase.filter(_.nonEmpty).map("use_case" -> _)).asJava
            )
          )
          Map.empty[Int, String]
        }
      case _ => Future.successful(Map.empty[Int, String])
    }
    names.map(known =>
      RaffleView
        .of(raffle, participant, clock.instant(), known, raffleByHand)
        .map(RaffleMapping.raffle(auction.value, _))
    )
  }

  /**
   * Заморозка состава финала (RFC-011): право у Meetups, фазу и удержанных решает аукцион по ответам лотов, а не по
   * read model.
   */
  def freezeFinalLineup(in: wire.FreezeFinalLineupRequest): Future[wire.FreezeFinalLineupResponse] =
    RequestMapping.freezeFinalLineup(in) match {
      case Left(error) => invalid(error)
      case Right(command) =>
        auctions
          .freezeFinalLineup(command.auctionId, command.order, command.opId, command.acting.participant)
          .recoverWith(awaited)
          .flatMap(outcome => ResponseMapping.freezeFinalLineup(outcome).fold(refuse, Future.successful))
    }

  /** Старт финала ведущим — только после заморозки состава (И-19). */
  def startFinal(in: wire.StartFinalRequest): Future[wire.StartFinalResponse] =
    RequestMapping.startFinal(in) match {
      case Left(error) => invalid(error)
      case Right(command) =>
        auctions
          .startFinal(command.auctionId, command.opId, command.acting.participant)
          .recoverWith(awaited)
          .flatMap(outcome => ResponseMapping.startFinal(outcome).fold(refuse, Future.successful))
    }

  /**
   * Следующий лот финала. Ответ приходит после того, как лот вернулся в торги и аукцион записал его активацию (И-14),
   * поэтому один срок ожидания накрывает оба перехода, как у `scheduleLot`.
   */
  def startNextLot(in: wire.StartNextLotRequest): Future[wire.StartNextLotResponse] =
    RequestMapping.startNextLot(in) match {
      case Left(error) => invalid(error)
      case Right(command) =>
        auctions
          .startNextLot(command.auctionId, command.opId, command.acting.participant)
          .recoverWith(awaited)
          .flatMap(outcome => ResponseMapping.startNextLot(outcome).fold(refuse, Future.successful))
    }

  /**
   * Ask ведущего (RFC-011, П-08): право у Meetups, реестр — у аукциона, цену и фазу судит лот. В живом финале лот той
   * же транзакцией пересчитывает прокси, поэтому ответ приходит после записи и ask, и производной ставки.
   */
  def advanceAsk(in: wire.AdvanceAskRequest): Future[wire.AdvanceAskResponse] =
    RequestMapping.advanceAsk(in) match {
      case Left(error) => invalid(error)
      case Right(AskCommand(command, newAsk)) =>
        auctions
          .advanceAsk(command.auctionId, command.lotId, newAsk, command.opId, command.acting.participant)
          .recoverWith(awaited)
          .flatMap(outcome => ResponseMapping.advanceAsk(outcome).fold(refuse, Future.successful))
    }

  /**
   * Закрытие лота ведущим (PER-607): право у Meetups, фаза и реестр — у аукциона, исход — у лота. У активного лота
   * финала ответ приходит после записи его завершения, поэтому один срок ожидания накрывает оба перехода.
   */
  def closeLot(in: wire.CloseLotRequest): Future[wire.CloseLotResponse] =
    RequestMapping.closeLot(in) match {
      case Left(error) => invalid(error)
      case Right(command) =>
        auctions
          .closeLot(command.auctionId, command.lotId, command.opId, command.acting.participant)
          .recoverWith(awaited)
          .flatMap(outcome => ResponseMapping.closeLot(outcome).fold(refuse, Future.successful))
    }

  /**
   * Поток аукциона (PER-335): каждое сообщение — состояние целиком из read model, первое — при подписке, следующие —
   * после коммита проекции, тронувшего аукцион или лот в нём. Право — то же, что у чтения лота: поток несёт снимки
   * лотов. Аукциона нет в read model — `NOT_FOUND`, и сразу, и когда его удалили посреди потока. После сообщения, где
   * аукцион завершён или отменён и ни один лот состава не торгуется и не удержан, поток закрывается: изменений у него
   * больше не будет, а состав завершённого несёт исходы лотов (PER-712).
   *
   * Чтение идёт по одному на подписчика и только по его спросу: медленный клиент получает свежее состояние, а не
   * очередь, и ставки не ждут ни его, ни поток. Повод, после которого состояние не изменилось, сообщения не даёт.
   */
  def watchAuction(in: wire.WatchAuctionRequest): Source[wire.AuctionWatch, NotUsed] =
    RequestMapping.watchAuction(in) match {
      case Left(error) => Source.failed(new GrpcServiceException(invalidStatus(error)))
      case Right(query) if !query.acting.viewer.isParticipant =>
        Source.failed(new GrpcServiceException(Status.PERMISSION_DENIED.withDescription("viewer has no auction right")))
      case Right(query) =>
        val auctionId = query.auctionId.value
        changes
          .subscribe(auctionId)
          .mapAsync(1)(_ =>
            watchViews.read(auctionId).flatMap {
              case Some(view) =>
                collectorNames(auctionId, view.activeLot ++ view.lineup).map(names => Some(view -> names))
              case None => Future.successful(None)
            }
          )
          .map {
            // Скрытый аукцион — то же, что отсутствующий (ADR-047, дополнение 2026-10-20): его `auction_id` выводится
            // из `meetup_id`, и без проверки поток отдал бы конфигурацию и реестр.
            case Some((view, names)) if shown(query.acting.viewer)(view.auction) =>
              WatchMapping.watch(view, clock.instant(), names)
            case Some(_) | None => throw new GrpcServiceException(Status.NOT_FOUND.withDescription("auction not found"))
          }
          .via(AuctionGrpcService.changed)
          .takeWhile(message => !AuctionGrpcService.terminal(message), inclusive = true)
    }

  /**
   * Отметка оплаты счёта организатором (PER-338, integration.md, «Счета»): счёт — у entity, а не из read model, иначе
   * только что выставленный не нашёлся бы; повтор принятого `op_id` — исходный ответ до права; затем право
   * администратора сходки аукциона у Meetups без ворот: проданный лот остаётся проданным и у отменённой сходки.
   */
  def markInvoicePaid(in: wire.MarkInvoicePaidRequest): Future[wire.MarkInvoicePaidResponse] =
    InvoiceMapping.markPaid(in) match {
      case Left(error) => invalid(error)
      case Right(mark) =>
        marked(mark, InvoiceAction.MarkPaid, InvoiceMapping.paymentAccepted, InvoiceMapping.paidDenied)(
          invoices.markPaid(mark.invoice, mark.opId).map(answer => InvoiceMapping.paid(answer.map(_ => ())))
        )
    }

  /** Отметка выдачи — тем же путём, что оплата; выдача неоплаченного счёта — отказ `InvoiceNotPaid`. */
  def markInvoiceHandedOver(in: wire.MarkInvoiceHandedOverRequest): Future[wire.MarkInvoiceHandedOverResponse] =
    InvoiceMapping.markHandedOver(in) match {
      case Left(error) => invalid(error)
      case Right(mark) =>
        marked(mark, InvoiceAction.MarkHandedOver, InvoiceMapping.handoverAccepted, InvoiceMapping.handedOverDenied)(
          invoices.markHandedOver(mark.invoice, mark.opId).map(answer => InvoiceMapping.handedOver(answer.map(_ => ())))
        )
    }

  /**
   * Выбор способа получения победителем: право — сам адресат счёта, чужой счёт неотличим от несуществующего, и это
   * решает entity счёта.
   */
  def chooseFulfillment(in: wire.ChooseFulfillmentRequest): Future[wire.ChooseFulfillmentResponse] =
    InvoiceMapping.chooseFulfillment(in) match {
      case Left(error) => invalid(error)
      case Right(choice) =>
        invoices
          .chooseFulfillment(choice.invoice, choice.acting.participant, choice.method, choice.opId)
          .recoverWith(awaited)
          .flatMap(answer => InvoiceMapping.fulfillment(answer.map(_ => ())).fold(refuse, Future.successful))
    }

  /**
   * Счета смотрящего в аукционе из read model; пустой список — смотрящий ничего не выиграл. Текст оплаты — из строки
   * аукциона (PER-322): у тестового аукциона из настройки бота строки нет, и текста тоже.
   */
  def listMyInvoices(in: wire.ListMyInvoicesRequest): Future[wire.ListMyInvoicesResponse] =
    InvoiceMapping.mine(in) match {
      case Left(error) => invalid(error)
      case Right(query) =>
        invoiceViews
          .mine(query.auctionId, query.acting.participant)
          .zip(instructionsOf(query.auctionId))
          .map((invoices, instructions) => InvoiceMapping.mine(invoices, instructions))
    }

  /** Сводка организатора — все счета аукциона из read model; право и отказы — те же, что у пульта. */
  def listAuctionInvoices(in: wire.ListAuctionInvoicesRequest): Future[wire.ListAuctionInvoicesResponse] =
    InvoiceMapping.ofAuction(in) match {
      case Left(error) => invalid(error)
      case Right(query) =>
        // Текст — у entity, а не в read model: организатор видит свою правку сразу.
        administered(query, InvoiceMapping.auctionInvoicesDenied) { auction =>
          invoiceViews.ofAuction(query.auctionId).map(InvoiceMapping.ofAuction(_, auction.paymentInstructions))
        }
    }

  /** Текст оплаты аукциона из read model; аукциона без строки — тестового из настройки бота — текста нет. */
  private def instructionsOf(auctionId: AuctionId): Future[Option[PaymentInstructions]] =
    auctionViews.byId(auctionId.value).map(_.flatMap(_.auction.paymentInstructions))

  /** Общий путь отметок организатора: счёт у entity, повтор своего `op_id` до права, затем право и команда. */
  private def marked[R](mark: InvoiceMark, action: InvoiceAction, accepted: R, denied: Denial => Either[Status, R])(
      run: => Future[Either[Status, R]]
  ): Future[R] =
    invoices.get(mark.invoice).recoverWith(awaited).flatMap {
      case Invoice.Initial => refuse(InvoiceMapping.invoiceNotFound)
      case issued: Invoice.Issued if issued.seen.get(mark.opId).contains(action) => Future.successful(accepted)
      case issued: Invoice.Issued =>
        administered(ConsoleQuery(issued.terms.auction, mark.acting), denied) { _ =>
          run.recoverWith(awaited).flatMap(_.fold(refuse, Future.successful))
        }
    }

  /**
   * Ответа entity не дождались. Команда могла быть принята, поэтому это `DEADLINE_EXCEEDED`, а не `UNAVAILABLE`: повтор
   * с тем же `op_id` вернёт исходный ответ, а не запишет команду второй раз.
   */
  private def awaited[T]: PartialFunction[Throwable, Future[T]] = { case _: TimeoutException =>
    refuse(Status.DEADLINE_EXCEEDED.withDescription("entity did not answer in time"))
  }

  private def invalid[T](error: FormError): Future[T] = refuse(invalidStatus(error))

  private def invalidStatus(error: FormError): Status =
    Status.INVALID_ARGUMENT.withDescription(s"invalid ${error.field}")

  private def refuse[T](status: Status): Future[T] = Future.failed(new GrpcServiceException(status))
}

object AuctionGrpcService {

  /** Допуск просрочки по умолчанию; узел передаёт `auction.deadlines.overdue-grace` — тот же, что у метрики. */
  val DefaultOverdueGrace: Duration = Duration.ofMinutes(1)

  /** Окно хроник дня участника (PER-725): последние сутки до ответа. */
  val ChronicleWindow: Duration = Duration.ofHours(24)

  /** Розыгрыша в узле нет: тесты границы, которым он не нужен. Любой вызов — ответа нет. */
  val NoRaffles: RaffleGateway = new RaffleGateway {
    private def none[T]: Future[T] = Future.failed(new IllegalStateException("raffles are not wired in this node"))
    def register(auction: AuctionId, command: Register) = none
    def cancel(auction: AuctionId, command: CancelRegistration) = none
    def assign(auction: AuctionId, command: AssignWinner) = none
    def changePrize(auction: AuctionId, command: ChangePrize) = none
    def setPrizePhoto(auction: AuctionId, command: SetPrizePhoto) = none
    def removePrizePhoto(auction: AuctionId, command: RemovePrizePhoto) = none
    def get(auction: AuctionId) = none
  }

  /** Потока в узле нет: тесты границы, которым он не нужен. Аукциона для потока не существует. */
  val NoWatch: AuctionWatchViews = _ => Future.successful(None)

  /** Узел без Identity: право человека зала не подтвердить, и ставка зала идёт, как при молчащем Identity. */
  val NoIdentity: ParticipantId => Future[Boolean] =
    _ => Future.failed(new IllegalStateException("identity is not wired in this node"))

  /** Узел без прогнозов: тесты границы, которым игра не нужна. */
  val NoPredictions: PredictionGateway = new PredictionGateway {
    private def none[T]: Future[T] = Future.failed(new IllegalStateException("predictions are not wired in this node"))
    def submit(auction: AuctionId, command: SubmitForecast) = none
    def mine(auction: AuctionId, participant: ParticipantId) = none
    def recall(auction: AuctionId, participant: ParticipantId, round: PredictionRound, opId: OpId) = none
    def tally(auction: AuctionId) = none
    def forecasters(auction: AuctionId) = none
  }

  /** Узел без итогов: тесты границы, которым подсчёт не нужен. */
  val NoResults: ResultsGateway = new ResultsGateway {
    private def none[T]: Future[T] = Future.failed(new IllegalStateException("results are not wired in this node"))
    def settle(auction: AuctionId) = none
    def recordManually(auction: AuctionId) = none
    def read(auction: AuctionId) = none
  }

  /** Изменений нет: поток читает состояние один раз, при подписке. */
  val NoChanges: AuctionChanges = _ => Source.single(())

  /**
   * Последнее сообщение потока: аукцион закончен или отменён, и ни один лот состава уже не торгуется и не удержан. Лоты
   * отменённого аукциона снимаются после `AuctionCancelled` своими событиями, а продажа последнего лота финала и
   * `AuctionFinished` идут разными проекциями (PER-712), и поток ждёт read model лотов, чтобы последнее сообщение несло
   * состав с исходами.
   */
  private[grpc] def terminal(message: wire.AuctionWatch): Boolean = {
    val status = message.getAuction.status
    (status.isFinished || status.isCancelled) && message.lineup.forall(lot =>
      !lot.status.isTrading && !lot.status.isHeld
    )
  }

  /** Сообщение потока проходит, только если отличается от предыдущего отправленного. */
  private def changed[T]: Flow[T, T, NotUsed] =
    Flow[T]
      .statefulMap(() => Option.empty[T])(
        (last, next) => if (last.contains(next)) (last, None) else (Some(next), Some(next)),
        _ => None
      )
      .collect { case Some(next) => next }

  /** Попыток заморозки имени после принятой ставки; подряд, без паузы: у сервиса нет планировщика. */
  val FreezeAttempts: Int = 3

  /** Имя события об исчерпанных попытках заморозки в логе. */
  val FreezeOperation: String = "auction.display_name.freeze"

  /** Событие ставки зала, принятой без ответа Identity о праве человека. */
  val FloorRightOperation: String = "auction.floor_bid.right_unconfirmed"

  /** Событие списка имён аукциона, собранного без ответа Identity о праве человека. */
  val AuctionNamesRightOperation: String = "auction.names.right_unconfirmed"

  /** Событие снимка лота, отданного без имени собравшего сет: хранилище имён не ответило. */
  val CollectorNamesOperation: String = "auction.lot_set.collector_names_unavailable"

  /** Событие пульта без числа регистраций розыгрыша или прогнозов (PER-734): entity или строки не ответили. */
  val ConsoleParticipationOperation: String = "auction.console.participation_unavailable"

  /** Событие снимка розыгрыша, отданного с билетами без имён: снимок имён не прочитался. */
  val RaffleNamesOperation: String = "auction.raffle.ticket_names_unavailable"

  private val logger = LoggerFactory.getLogger(classOf[AuctionGrpcService])

  /**
   * Аукцион сходки — UUIDv5, выведенный из `meetup_id` (ADR-047); тестовый аукцион из настройки бота — UUIDv7 без
   * журнала аукциона. Форму идентификатора граница уже проверила, поэтому версия здесь различает два вида аукциона.
   */
  def isMeetupAuction(auctionId: java.util.UUID): Boolean = auctionId.version == 5
}
