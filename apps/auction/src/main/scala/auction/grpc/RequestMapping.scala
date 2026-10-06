package auction.grpc

import auction.access.GlobalRole
import auction.aggregate.AuctionConfigInput
import auction.aggregate.ClosingPolicy
import auction.aggregate.MeetupId
import auction.aggregate.OnlinePhase
import auction.lot.AuctionId
import auction.projection.AuctionListing
import auction.access.Viewer
import auction.catalog.ImageChange
import auction.catalog.LotId
import auction.lot.AntiSnipe
import auction.lot.BidSource
import auction.lot.CurrencyCode
import auction.lot.LotConfigInput
import auction.lot.Money
import auction.lot.OpId
import auction.lot.ParticipantId
import auction.lot.PlaceBid
import auction.lot.SetProxyLimit
import auction.lot.StepPolicy
import auction.lot.StepPolicyInput
import auction.lot.WithdrawProxyLimit
import auction.naming.NameChoice
import auction.naming.TelegramUsername
import auction.v1.auction.AuctionConfig as AuctionConfigMessage
import auction.v1.auction.ClosingPolicy as ClosingPolicyMessage
import auction.v1.auction.LotDefaults as LotDefaultsMessage
import auction.v1.auction.Money as MoneyMessage
import auction.v1.auction.StepPolicy as StepPolicyMessage
import auction.v1.auction_service.AddLotRequest
import auction.v1.auction_service.AuctionListing as AuctionListingMessage
import auction.v1.auction_service.ChooseDisplayNameRequest
import auction.v1.auction_service.CreateLotCardRequest
import auction.v1.auction_service.DeselectForFinalRequest
import auction.v1.auction_service.DraftAuctionRequest
import auction.v1.auction_service.EditLotCardRequest
import auction.v1.auction_service.GetAuctionConsoleRequest
import auction.v1.auction_service.GetDisplayNamesRequest
import auction.v1.auction_service.GetLotImageRequest
import auction.v1.auction_service.GetLotRequest
import auction.v1.auction_service.LotImageUpload
import auction.v1.auction_service.GetMeetupAuctionRequest
import auction.v1.auction_service.ListAuctionLotsRequest
import auction.v1.auction_service.ListAuctionsRequest
import auction.v1.auction_service.ListLotHistoryRequest
import auction.v1.auction_service.RemoveLotRequest
import auction.v1.auction_service.PlaceBidRequest
import auction.v1.auction_service.ScheduleAuctionRequest
import auction.v1.auction_service.SelectForFinalRequest
import auction.v1.auction_service.ScheduleLotRequest
import auction.v1.auction_service.SetProxyLimitRequest
import auction.v1.auction_service.StartPrebiddingRequest
import auction.v1.auction_service.WithdrawProxyLimitRequest
import auction.v1.auction_service.Viewer as ViewerMessage
import identity.v1.roles.GlobalRole as GlobalRoleMessage

import java.nio.charset.StandardCharsets
import java.time.Duration
import java.time.Instant
import java.time.format.DateTimeParseException
import java.util.Base64
import java.util.UUID

/**
 * Нарушение формы запроса — `INVALID_ARGUMENT` (integration.md, «Auction gRPC»). Называет поле, но не значение:
 * значение пришло от вызывающего и в запись границы не попадает.
 */
final case class FormError(field: String)

/** Смотрящий вместе с тем, от чьего имени он действует: участник команды — `viewer.identity_id`. */
final case class Acting(participant: ParticipantId, viewer: Viewer)

/** Ставка, отображённая в домен: лот, которому она адресована, и сама команда. */
final case class BidCommand(lotId: UUID, bid: PlaceBid, acting: Acting)

/** Прокси-лимит, отображённый в домен; участник лимита — тот, от чьего имени действует смотрящий. */
final case class LimitCommand(lotId: UUID, limit: SetProxyLimit, acting: Acting)

/** Снятие прокси-лимита, отображённое в домен. */
final case class WithdrawalCommand(lotId: UUID, withdrawal: WithdrawProxyLimit, acting: Acting)

/** Чтение одного лота. */
final case class LotQuery(lotId: UUID, acting: Acting)

/** Страница лотов аукциона: после `after` по возрастанию `lot_id`, не больше `limit`. */
final case class LotsQuery(auctionId: UUID, after: Option[UUID], limit: Int, acting: Acting)

/** Страница хронологии лота: события после номера `after` по возрастанию, не больше `limit`. */
final case class LotHistoryQuery(lotId: UUID, after: Option[Long], limit: Int, acting: Acting)

/** Рождение аукциона у сходки. Роли смотрящего права не дают: право спрашивается у Meetups (ADR-047). */
final case class DraftCommand(meetup: MeetupId, opId: OpId, acting: Acting)

/** Правка реестра — `AddLot` и `RemoveLot` несут одно и то же. */
final case class RegistryCommand(auctionId: AuctionId, lotId: LotId, opId: OpId, acting: Acting)

/**
 * Условия торгов лоту реестра. Политика шага здесь ещё не проверена: И-15 — решение домена, а не форма запроса.
 */
final case class LotScheduleCommand(
    auctionId: AuctionId,
    lotId: LotId,
    startingPrice: Money,
    stepPolicy: StepPolicyInput,
    opId: OpId,
    acting: Acting
)

/**
 * Планирование аукциона. Конфигурация здесь ещё не проверена: `ConfigInvalid` — решение домена, а не форма запроса.
 */
final case class AuctionScheduleCommand(auctionId: AuctionId, config: AuctionConfigInput, opId: OpId, acting: Acting)

/** Открытие онлайн-торгов аукциона. */
final case class PrebiddingCommand(auctionId: AuctionId, opId: OpId, acting: Acting)

/** Чтение аукциона сходки. */
final case class MeetupAuctionQuery(meetup: MeetupId, acting: Acting)

/** Чтение пульта администратора: аукцион сходки и тот, кто смотрит. */
final case class ConsoleQuery(auctionId: AuctionId, acting: Acting)

/** Страница аукционов выборки: после `after` по возрастанию `auction_id`, не больше `limit`. */
final case class AuctionsQuery(listing: AuctionListing, after: Option[UUID], limit: Int, acting: Acting)

/**
 * Команда каталога в домене. Создание и правка различаются только изображением: создание несёт файл или ничего, правка
 * — что сделать с хранимым. Байты здесь ещё не проверены: предел и тип — решение домена, а не форма запроса.
 */
final case class CardCommand[I](lotId: LotId, title: String, description: String, image: I, viewer: Viewer)

/** Выбор имени участника в аукционе; участник — тот, от чьего имени действует смотрящий. */
final case class ChooseCommand(auctionId: AuctionId, choice: NameChoice, acting: Acting)

/** Имена названных участников аукциона. */
final case class NamesQuery(auctionId: AuctionId, participants: Set[ParticipantId], acting: Acting)

/**
 * Отображение сгенерированных сообщений в доменные типы — trusted boundary.
 *
 * Всё недоверенное проверяется здесь и только здесь: после `Right` сценарий форму заново не проверяет.
 */
object RequestMapping {

  private val CanonicalUuidV7 = "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$".r

  /**
   * Аукцион сходки — UUIDv5, выведенный из `meetup_id` (ADR-047, исключение из ADR-020); тестовый аукцион из настройки
   * бота остаётся UUIDv7. Поэтому поле, которое называет аукцион лота, принимает обе версии, а поле, которое называет
   * аукцион сходки, — только пятую (integration.md, «Аукцион у сходки»).
   */
  private val CanonicalUuidV5 = "^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$".r

  private val CurrencyAlpha = "^[A-Z]{3}$".r

  def placeBid(request: PlaceBidRequest): Either[FormError, BidCommand] =
    for {
      acting <- acting(request.viewer)
      lotId <- uuidV7("lot_id", request.lotId)
      amount <- money("amount", request.amount)
      opId <- uuidV7("op_id", request.opId)
    } yield BidCommand(lotId, PlaceBid(acting.participant, amount, OpId(opId), BidSource.Bot), acting)

  def setProxyLimit(request: SetProxyLimitRequest): Either[FormError, LimitCommand] =
    for {
      acting <- acting(request.viewer)
      lotId <- uuidV7("lot_id", request.lotId)
      max <- money("max", request.max)
      opId <- uuidV7("op_id", request.opId)
    } yield LimitCommand(lotId, SetProxyLimit(acting.participant, max, OpId(opId)), acting)

  def withdrawProxyLimit(request: WithdrawProxyLimitRequest): Either[FormError, WithdrawalCommand] =
    for {
      acting <- acting(request.viewer)
      lotId <- uuidV7("lot_id", request.lotId)
      opId <- uuidV7("op_id", request.opId)
    } yield WithdrawalCommand(lotId, WithdrawProxyLimit(acting.participant, OpId(opId)), acting)

  def createCard(request: CreateLotCardRequest): Either[FormError, CardCommand[Option[IArray[Byte]]]] =
    card(request.viewer, request.lotId, request.title, request.description, request.image.map(bytes))

  def editCard(request: EditLotCardRequest): Either[FormError, CardCommand[ImageChange[IArray[Byte]]]] = {
    val change = request.imageChange match {
      case EditLotCardRequest.ImageChange.ReplaceImage(upload) => ImageChange.Replace(bytes(upload))
      case EditLotCardRequest.ImageChange.RemoveImage(_) => ImageChange.Remove
      case EditLotCardRequest.ImageChange.Empty => ImageChange.Keep
    }
    card(request.viewer, request.lotId, request.title, request.description, change)
  }

  private def card[I](
      viewer: Option[ViewerMessage],
      lotId: String,
      title: String,
      description: String,
      image: I
  ): Either[FormError, CardCommand[I]] =
    for {
      acting <- acting(viewer)
      id <- uuidV7("lot_id", lotId)
    } yield CardCommand(LotId(id), title, description, image, acting.viewer)

  // `toByteArray` отдаёт свежую копию, поэтому обернуть её без второй копии безопасно: другой ссылки на массив нет.
  private def bytes(upload: LotImageUpload): IArray[Byte] = IArray.unsafeFromArray(upload.content.toByteArray)

  def getLotImage(request: GetLotImageRequest): Either[FormError, LotQuery] =
    for {
      acting <- acting(request.viewer)
      lotId <- uuidV7("lot_id", request.lotId)
    } yield LotQuery(lotId, acting)

  def getLot(request: GetLotRequest): Either[FormError, LotQuery] =
    for {
      acting <- acting(request.viewer)
      lotId <- uuidV7("lot_id", request.lotId)
    } yield LotQuery(lotId, acting)

  def listAuctionLots(request: ListAuctionLotsRequest): Either[FormError, LotsQuery] =
    for {
      acting <- acting(request.viewer)
      auctionId <- lotAuction(request.auctionId)
      after <- PageToken.decode(request.pageToken).toRight(FormError("page_token"))
      limit <- pageSize(request.pageSize)
    } yield LotsQuery(auctionId, after, limit, acting)

  def listLotHistory(request: ListLotHistoryRequest): Either[FormError, LotHistoryQuery] =
    for {
      acting <- acting(request.viewer)
      lotId <- uuidV7("lot_id", request.lotId)
      after <- SequenceToken.decode(request.pageToken).toRight(FormError("page_token"))
      limit <- pageSize(request.pageSize)
    } yield LotHistoryQuery(lotId, after, limit, acting)

  def chooseDisplayName(request: ChooseDisplayNameRequest): Either[FormError, ChooseCommand] =
    for {
      acting <- acting(request.viewer)
      auctionId <- lotAuction(request.auctionId)
      choice <- nameChoice(request.choice)
    } yield ChooseCommand(AuctionId(auctionId), choice, acting)

  def getDisplayNames(request: GetDisplayNamesRequest): Either[FormError, NamesQuery] =
    for {
      acting <- acting(request.viewer)
      auctionId <- lotAuction(request.auctionId)
      participants <- request.participantIds.foldLeft[Either[FormError, Set[ParticipantId]]](Right(Set.empty)) {
        (acc, id) => acc.flatMap(set => uuidV7("participant_ids", id).map(uuid => set + ParticipantId(uuid)))
      }
    } yield NamesQuery(AuctionId(auctionId), participants, acting)

  /**
   * Пустой ник — выставленный выбор «ника нет», и отвечает на него отказ выбора, а не форма (integration.md, «Имя
   * участника»). Непустая строка, какой Telegram ником не присылает, — нарушение формы.
   */
  private def nameChoice(choice: ChooseDisplayNameRequest.Choice): Either[FormError, NameChoice] =
    choice match {
      case ChooseDisplayNameRequest.Choice.TelegramUsername("") => Right(NameChoice.Username(None))
      case ChooseDisplayNameRequest.Choice.TelegramUsername(raw) =>
        TelegramUsername.from(raw).map(name => NameChoice.Username(Some(name))).toRight(FormError("telegram_username"))
      case ChooseDisplayNameRequest.Choice.Alias(raw) => Right(NameChoice.Pseudonym(raw))
      case ChooseDisplayNameRequest.Choice.Empty => Left(FormError("choice"))
    }

  /** Аукцион, которому принадлежит лот: сходки (UUIDv5) или тестовый из настройки бота (UUIDv7). */
  private def lotAuction(value: String): Either[FormError, UUID] =
    canonicalUuidV5(value).orElse(canonicalUuidV7(value)).toRight(FormError("auction_id"))

  def draftAuction(request: DraftAuctionRequest): Either[FormError, DraftCommand] =
    for {
      acting <- acting(request.viewer)
      meetup <- uuidV7("meetup_id", request.meetupId)
      opId <- uuidV7("op_id", request.opId)
    } yield DraftCommand(MeetupId(meetup), OpId(opId), acting)

  def addLot(request: AddLotRequest): Either[FormError, RegistryCommand] =
    registry(request.viewer, request.auctionId, request.lotId, request.opId)

  def removeLot(request: RemoveLotRequest): Either[FormError, RegistryCommand] =
    registry(request.viewer, request.auctionId, request.lotId, request.opId)

  /** Отметка и снятие отметки несут то же, что команды реестра: аукцион сходки, лот и `op_id`. */
  def selectForFinal(request: SelectForFinalRequest): Either[FormError, RegistryCommand] =
    registry(request.viewer, request.auctionId, request.lotId, request.opId)

  def deselectForFinal(request: DeselectForFinalRequest): Either[FormError, RegistryCommand] =
    registry(request.viewer, request.auctionId, request.lotId, request.opId)

  def getAuctionConsole(request: GetAuctionConsoleRequest): Either[FormError, ConsoleQuery] =
    for {
      acting <- acting(request.viewer)
      auction <- meetupAuction(request.auctionId)
    } yield ConsoleQuery(auction, acting)

  def scheduleLot(request: ScheduleLotRequest): Either[FormError, LotScheduleCommand] =
    for {
      command <- registry(request.viewer, request.auctionId, request.lotId, request.opId)
      startingPrice <- money("starting_price", request.startingPrice)
      policy <- stepPolicy(request.stepPolicy)
    } yield LotScheduleCommand(command.auctionId, command.lotId, startingPrice, policy, command.opId, command.acting)

  /**
   * Политика шага без проверки И-15: форма требует только, чтобы `oneof` был задан, а суммы были суммами. Пустые,
   * неотсортированные или неположительные пороги — отказ домена `StepPolicyInvalid`, а не нарушение формы.
   */
  private def stepPolicy(value: Option[StepPolicyMessage]): Either[FormError, StepPolicyInput] =
    value.map(_.policy) match {
      case Some(StepPolicyMessage.Policy.Fixed(step)) =>
        money("step_policy.fixed", Some(step)).map(StepPolicyInput.Fixed(_))
      case Some(StepPolicyMessage.Policy.Tiered(steps)) =>
        steps.tiers
          .foldLeft[Either[FormError, List[StepPolicy.Tier]]](Right(Nil)) { (acc, tier) =>
            for {
              tiers <- acc
              bound <- money("step_policy.tiered.lower_bound", tier.lowerBound)
              step <- money("step_policy.tiered.step", tier.step)
            } yield StepPolicy.Tier(bound, step) :: tiers
          }
          .map(tiers => StepPolicyInput.Tiered(tiers.reverse))
      case Some(StepPolicyMessage.Policy.Empty) | None => Left(FormError("step_policy"))
    }

  def scheduleAuction(request: ScheduleAuctionRequest): Either[FormError, AuctionScheduleCommand] =
    for {
      acting <- acting(request.viewer)
      auction <- meetupAuction(request.auctionId)
      opId <- uuidV7("op_id", request.opId)
      config <- request.config.toRight(FormError("config")).flatMap(auctionConfig)
    } yield AuctionScheduleCommand(auction, config, OpId(opId), acting)

  def startPrebidding(request: StartPrebiddingRequest): Either[FormError, PrebiddingCommand] =
    for {
      acting <- acting(request.viewer)
      auction <- meetupAuction(request.auctionId)
      opId <- uuidV7("op_id", request.opId)
    } yield PrebiddingCommand(auction, OpId(opId), acting)

  /**
   * Конфигурация без проверки ADR-047: форма требует заданных `oneof` и сообщений, моментов в RFC 3339 и
   * неотрицательных секунд анти-снайпа. Противоречие значений между собой — `closesAt` не после `opensAt`, дедлайн без
   * `closesAt`, число блоков финала — отказ домена `ConfigInvalid`, а не нарушение формы.
   */
  private def auctionConfig(config: AuctionConfigMessage): Either[FormError, AuctionConfigInput] =
    for {
      phase <- config.onlinePhase match {
        case None => Right(None)
        case Some(phase) =>
          for {
            opensAt <- instant("config.online_phase.opens_at", phase.opensAt)
            closesAt <- phase.closesAt match {
              case None => Right(None)
              case Some(raw) => instant("config.online_phase.closes_at", raw).map(Some(_))
            }
          } yield Some(OnlinePhase(opensAt, closesAt, phase.closesLots))
      }
      closing <- config.closingPolicy.map(_.policy) match {
        case Some(ClosingPolicyMessage.Policy.ByAuctioneer(_)) => Right(ClosingPolicy.ByAuctioneer)
        case Some(ClosingPolicyMessage.Policy.ByDeadline(_)) => Right(ClosingPolicy.ByDeadline)
        case Some(ClosingPolicyMessage.Policy.Mixed(mixed)) => Right(ClosingPolicy.Mixed(mixed.onlineByDeadline))
        case Some(ClosingPolicyMessage.Policy.Empty) | None => Left(FormError("config.closing_policy"))
      }
      defaults <- config.lotDefaults match {
        case None => Right(None)
        case Some(set) => lotDefaults(set).map(Some(_))
      }
    } yield AuctionConfigInput(phase, config.finalBlocks, closing, defaults)

  private def lotDefaults(defaults: LotDefaultsMessage): Either[FormError, LotConfigInput] =
    for {
      currency <- Option
        .when(CurrencyAlpha.matches(defaults.currency))(CurrencyCode(defaults.currency))
        .toRight(FormError("config.lot_defaults.currency"))
      policy <- stepPolicy(defaults.stepPolicy)
      antiSnipe <- defaults.antiSnipe match {
        case Some(value)
            if seconds(value.windowSeconds) && seconds(value.extensionSeconds) && value.maxExtensions >= 0 =>
          Right(
            AntiSnipe(
              Duration.ofSeconds(value.windowSeconds),
              Duration.ofSeconds(value.extensionSeconds),
              value.maxExtensions
            )
          )
        case _ => Left(FormError("config.lot_defaults.anti_snipe"))
      }
    } yield LotConfigInput(currency, policy, antiSnipe, defaults.proxyEnabled)

  /**
   * Секунды анти-снайпа — от нуля до года. Верхний предел — не правило торгов, а защита дедлайна: лот сдвигает его на
   * эти длительности, и `int64` секунд у `Instant` переполнился бы на каждой ставке, заклинив лот.
   */
  val MaxAntiSnipeSeconds: Long = 366L * 24 * 60 * 60

  private def seconds(value: Long): Boolean = value >= 0 && value <= MaxAntiSnipeSeconds

  private def instant(field: String, value: String): Either[FormError, Instant] =
    try Right(Instant.parse(value))
    catch { case _: DateTimeParseException => Left(FormError(field)) }

  /** Аукцион сходки — только UUIDv5: у тестового аукциона из настройки бота журнала аукциона нет. */
  private def meetupAuction(value: String): Either[FormError, AuctionId] =
    canonicalUuidV5(value).map(AuctionId(_)).toRight(FormError("auction_id"))

  def getMeetupAuction(request: GetMeetupAuctionRequest): Either[FormError, MeetupAuctionQuery] =
    for {
      acting <- acting(request.viewer)
      meetup <- uuidV7("meetup_id", request.meetupId)
    } yield MeetupAuctionQuery(MeetupId(meetup), acting)

  def listAuctions(request: ListAuctionsRequest): Either[FormError, AuctionsQuery] =
    for {
      acting <- acting(request.viewer)
      listing <- listing(request.listing)
      after <- PageToken.decode(request.pageToken, canonicalUuidV5).toRight(FormError("page_token"))
      limit <- pageSize(request.pageSize)
    } yield AuctionsQuery(listing, after, limit, acting)

  private def registry(
      viewer: Option[ViewerMessage],
      auctionId: String,
      lotId: String,
      opId: String
  ): Either[FormError, RegistryCommand] =
    for {
      acting <- acting(viewer)
      auction <- canonicalUuidV5(auctionId).toRight(FormError("auction_id"))
      lot <- uuidV7("lot_id", lotId)
      op <- uuidV7("op_id", opId)
    } yield RegistryCommand(AuctionId(auction), LotId(lot), OpId(op), acting)

  private def listing(value: AuctionListingMessage): Either[FormError, AuctionListing] =
    value match {
      case AuctionListingMessage.AUCTION_LISTING_ACTIVE => Right(AuctionListing.Active)
      case AuctionListingMessage.AUCTION_LISTING_FINISHED => Right(AuctionListing.Finished)
      case AuctionListingMessage.AUCTION_LISTING_UNSPECIFIED | AuctionListingMessage.Unrecognized(_) =>
        Left(FormError("listing"))
    }

  /** Размер страницы по умолчанию и предел: больший запрошенный размер сужается, а не отвергается. */
  val DefaultPageSize: Int = 50
  val MaxPageSize: Int = 100

  private def pageSize(requested: Int): Either[FormError, Int] =
    if (requested < 0) Left(FormError("page_size"))
    else if (requested == 0) Right(DefaultPageSize)
    else Right(math.min(requested, MaxPageSize))

  /**
   * Смотрящий. Роль, которой сервис не знает, — `UNSPECIFIED` или значение из чужой версии схемы, — нарушение формы, а
   * не «обычный пользователь»: молча отброшенная роль спрятала бы ошибку вызывающего.
   */
  def acting(viewer: Option[ViewerMessage]): Either[FormError, Acting] =
    viewer match {
      case None => Left(FormError("viewer"))
      case Some(message) =>
        for {
          identity <- uuidV7("viewer.identity_id", message.identityId)
          roles <- roles(message.globalRoles)
        } yield Acting(ParticipantId(identity), Viewer(roles))
    }

  private def roles(values: Seq[GlobalRoleMessage]): Either[FormError, Set[GlobalRole]] =
    values.foldLeft[Either[FormError, Set[GlobalRole]]](Right(Set.empty)) { (acc, value) =>
      acc.flatMap(set => role(value).map(set + _))
    }

  private def role(value: GlobalRoleMessage): Either[FormError, GlobalRole] =
    value match {
      case GlobalRoleMessage.GLOBAL_ROLE_ADMIN => Right(GlobalRole.Admin)
      case GlobalRoleMessage.GLOBAL_ROLE_MAINTAINER => Right(GlobalRole.Maintainer)
      case GlobalRoleMessage.GLOBAL_ROLE_MEMBER => Right(GlobalRole.Member)
      case GlobalRoleMessage.GLOBAL_ROLE_PUBLIC => Right(GlobalRole.Public)
      case GlobalRoleMessage.GLOBAL_ROLE_UNSPECIFIED | GlobalRoleMessage.Unrecognized(_) =>
        Left(FormError("viewer.global_roles"))
    }

  private def uuidV7(field: String, value: String): Either[FormError, UUID] =
    canonicalUuidV7(value).toRight(FormError(field))

  private[grpc] def canonicalUuidV7(value: String): Option[UUID] =
    Option.when(CanonicalUuidV7.matches(value))(UUID.fromString(value))

  private[grpc] def canonicalUuidV5(value: String): Option[UUID] =
    Option.when(CanonicalUuidV5.matches(value))(UUID.fromString(value))

  private def money(field: String, value: Option[MoneyMessage]): Either[FormError, Money] =
    value match {
      case Some(message) if CurrencyAlpha.matches(message.currency) =>
        Right(Money(message.minorUnits, CurrencyCode(message.currency)))
      case _ => Left(FormError(field))
    }
}

/**
 * Токен продолжения `ListAuctionLots` и `ListAuctions`: последний отданный `lot_id` или `auction_id` в base64url.
 * Непрозрачен для вызывающего по контракту, но не секрет: подделанный токен даёт ту же выборку, что и честный с тем же
 * `lot_id`, — лоты аукциона после него, которые смотрящий и так вправе читать.
 */
object PageToken {

  def encode(id: UUID): String =
    Base64.getUrlEncoder.withoutPadding.encodeToString(id.toString.getBytes(StandardCharsets.US_ASCII))

  /**
   * Пустой токен — начало перечисления, `Some(None)`; токен, который не выдавал сервис, — `None`. `canonical` — форма
   * идентификатора перечисления: лоты — UUIDv7, аукционы сходок — UUIDv5.
   */
  def decode(token: String, canonical: String => Option[UUID] = RequestMapping.canonicalUuidV7): Option[Option[UUID]] =
    if (token.isEmpty) Some(None)
    else
      try
        canonical(new String(Base64.getUrlDecoder.decode(token), StandardCharsets.US_ASCII))
          .map(Some(_))
      catch { case _: IllegalArgumentException => None }
}

/**
 * Токен продолжения `ListLotHistory`: номер последнего отданного события журнала лота десятичной строкой в base64url.
 * Непрозрачен по контракту, но не секрет: подделанный токен даёт хронологию того же лота с другого места, а читать её
 * смотрящий и так вправе.
 */
object SequenceToken {

  private val Canonical = "^[1-9][0-9]{0,18}$".r

  def encode(sequence: Long): String =
    Base64.getUrlEncoder.withoutPadding.encodeToString(sequence.toString.getBytes(StandardCharsets.US_ASCII))

  /** Пустой токен — начало перечисления, `Some(None)`; токен, который не выдавал сервис, — `None`. */
  def decode(token: String): Option[Option[Long]] =
    if (token.isEmpty) Some(None)
    else
      try {
        val text = new String(Base64.getUrlDecoder.decode(token), StandardCharsets.US_ASCII)
        Option.when(Canonical.matches(text) && encode(text.toLong) == token)(Some(text.toLong))
      } catch { case _: IllegalArgumentException => None }
}
