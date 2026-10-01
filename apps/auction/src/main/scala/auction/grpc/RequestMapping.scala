package auction.grpc

import auction.access.GlobalRole
import auction.access.Viewer
import auction.catalog.LotId
import auction.lot.BidSource
import auction.lot.CurrencyCode
import auction.lot.Money
import auction.lot.OpId
import auction.lot.ParticipantId
import auction.lot.PlaceBid
import auction.lot.SetProxyLimit
import auction.lot.WithdrawProxyLimit
import auction.v1.auction.Money as MoneyMessage
import auction.v1.auction_service.PlaceBidRequest
import auction.v1.auction_service.SetProxyLimitRequest
import auction.v1.auction_service.WithdrawProxyLimitRequest
import auction.v1.auction_service.Viewer as ViewerMessage
import identity.v1.roles.GlobalRole as GlobalRoleMessage

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

/** Команда каталога в домене: создание и правка несут одно и то же. */
final case class CardCommand(lotId: LotId, title: String, description: String, viewer: Viewer)

/**
 * Отображение сгенерированных сообщений в доменные типы — trusted boundary.
 *
 * Всё недоверенное проверяется здесь и только здесь: после `Right` сценарий форму заново не проверяет.
 */
object RequestMapping {

  private val CanonicalUuidV7 = "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$".r

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

  def card(
      viewer: Option[ViewerMessage],
      lotId: String,
      title: String,
      description: String
  ): Either[FormError, CardCommand] =
    for {
      acting <- acting(viewer)
      id <- uuidV7("lot_id", lotId)
    } yield CardCommand(LotId(id), title, description, acting.viewer)

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
    if (CanonicalUuidV7.matches(value)) Right(UUID.fromString(value)) else Left(FormError(field))

  private def money(field: String, value: Option[MoneyMessage]): Either[FormError, Money] =
    value match {
      case Some(message) if CurrencyAlpha.matches(message.currency) =>
        Right(Money(message.minorUnits, CurrencyCode(message.currency)))
      case _ => Left(FormError(field))
    }
}
