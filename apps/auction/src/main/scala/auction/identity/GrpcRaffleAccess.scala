package auction.identity

import auction.lot.ParticipantId
import auction.raffle.RaffleAccess
import com.typesafe.config.Config
import identity.v1.access.AccessRight
import identity.v1.identity_service.CheckAccessRightRequest
import identity.v1.identity_service.IdentityServiceClient
import org.apache.pekko.actor.typed.ActorSystem
import org.apache.pekko.grpc.GrpcClientSettings

import java.net.URI
import scala.concurrent.ExecutionContext
import scala.concurrent.Future
import scala.concurrent.duration.FiniteDuration
import scala.jdk.DurationConverters.*
import scala.util.Try

/**
 * Куда и с чем Auction ходит в Identity (ADR-056): адрес gRPC и собственный токен — тот же `AUCTION_SERVICE_TOKEN`, что
 * у Meetups. Адрес необязателен, как у Meetups: без него закрытие регистрации в розыгрыше не может проверить право и
 * оставляет пул как есть (решение владельца в PER-499).
 */
final case class IdentitySettings(url: Option[URI], serviceToken: Option[String], deadline: FiniteDuration)

object IdentitySettings {

  /** Адрес без токена — дефект развёртывания: сервис не стартует. Причина называет переменную, но не значение. */
  def fromConfig(config: Config): Either[String, IdentitySettings] = {
    val section = "auction.identity"
    def optional(key: String): Option[String] =
      Option.when(config.hasPath(s"$section.$key"))(config.getString(s"$section.$key").trim).filter(_.nonEmpty)
    val deadline = config.getDuration(s"$section.deadline").toScala
    val token = optional("service-token")
    optional("url") match {
      case None => Right(IdentitySettings(None, token, deadline))
      case Some(raw) =>
        Try(URI.create(raw)).toOption.filter(uri => uri.getHost != null && uri.getPort > 0) match {
          case None => Left("auction identity address is not a host:port URL: AUCTION_IDENTITY_GRPC_URL")
          case Some(url) =>
            token match {
              case None => Left("auction service token is not set: AUCTION_SERVICE_TOKEN")
              case Some(_) => Right(IdentitySettings(Some(url), token, deadline))
            }
        }
    }
  }
}

/**
 * Право `place_bids` кандидата розыгрыша у Identity — `CheckAccessRight` (ADR-066, п. 4): заблокированный права не
 * держит. Без кэша: устаревшее разрешение равносильно пропущенной проверке (ADR-026). Любой отказ вызова — неудачное
 * `Future`, то есть «нет ответа»; повторы ведёт опрос кандидатов, а не клиент.
 */
final class GrpcRaffleAccess(client: IdentityServiceClient, token: String)(using ExecutionContext)
    extends RaffleAccess {

  def holdsRight(participant: ParticipantId): Future[Boolean] =
    client
      .checkAccessRight()
      .addHeader("authorization", s"Bearer $token")
      .invoke(CheckAccessRightRequest(participant.value.toString, AccessRight.ACCESS_RIGHT_PLACE_BIDS))
      .map(_.granted)
}

object GrpcRaffleAccess {

  def apply(settings: IdentitySettings)(using system: ActorSystem[?]): RaffleAccess =
    (settings.url, settings.serviceToken) match {
      case (Some(url), Some(token)) =>
        val client = IdentityServiceClient(
          GrpcClientSettings
            .connectToServiceAt(url.getHost, url.getPort)
            .withTls(url.getScheme == "https")
            .withDeadline(settings.deadline)
        )
        new GrpcRaffleAccess(client, token)(using system.executionContext)
      case _ => RaffleAccess.absent
    }
}
