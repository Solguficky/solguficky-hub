package auction.meetup

import auction.aggregate.Authority
import auction.aggregate.Correlation
import auction.aggregate.MeetupAuthority
import auction.aggregate.MeetupId
import auction.aggregate.MeetupLifecycle
import auction.aggregate.MeetupStanding
import auction.aggregate.MeetupVisibility
import auction.lot.ParticipantId
import com.typesafe.config.Config
import io.grpc.Status
import io.grpc.StatusRuntimeException
import meetups.v1.meetups.MeetupLifecycle as WireLifecycle
import meetups.v1.meetups.MeetupVisibility as WireVisibility
import meetups.v1.meetups_service.CheckMeetupAuthorityRequest
import meetups.v1.meetups_service.MeetupAuthority as WireAuthority
import meetups.v1.meetups_service.MeetupRelation
import meetups.v1.meetups_service.MeetupsServiceClient
import org.apache.pekko.actor.typed.ActorSystem
import org.apache.pekko.grpc.GrpcClientSettings

import java.net.URI
import scala.concurrent.ExecutionContext
import scala.concurrent.Future
import scala.concurrent.duration.FiniteDuration
import scala.jdk.DurationConverters.*
import scala.util.Try

/**
 * Куда и с чем Auction ходит в Meetups (ADR-056): адрес gRPC и собственный токен вызывающего. Адрес необязателен — как
 * у шины: профиль без Meetups оставляет сервис живым, а команды администратора отвечают `UNAVAILABLE`.
 */
final case class MeetupsSettings(url: Option[URI], serviceToken: Option[String], deadline: FiniteDuration)

object MeetupsSettings {

  /**
   * Адрес без токена и токен, совпавший с токеном вызывающего Auction, — дефект развёртывания: сервис не стартует, а не
   * отказывает на каждой команде. Причина называет переменную, но не значение.
   */
  def fromConfig(config: Config, isCallerToken: String => Boolean): Either[String, MeetupsSettings] = {
    val section = "auction.meetups"
    def optional(key: String): Option[String] =
      Option.when(config.hasPath(s"$section.$key"))(config.getString(s"$section.$key").trim).filter(_.nonEmpty)
    val deadline = config.getDuration(s"$section.deadline").toScala
    val token = optional("service-token")
    // Совпадение с токеном вызывающего проверяется и без адреса: иначе дефект
    // конфигурации проявился бы только в профиле, где Meetups появится.
    optional("url") match {
      case _ if token.exists(isCallerToken) =>
        Left("auction service token equals a caller token: AUCTION_SERVICE_TOKEN")
      case None => Right(MeetupsSettings(None, token, deadline))
      case Some(raw) =>
        Try(URI.create(raw)).toOption.filter(uri => uri.getHost != null && uri.getPort > 0) match {
          case None => Left("auction meetups address is not a host:port URL: AUCTION_MEETUPS_GRPC_URL")
          case Some(url) =>
            token match {
              case None => Left("auction service token is not set: AUCTION_SERVICE_TOKEN")
              case Some(_) => Right(MeetupsSettings(Some(url), token, deadline))
            }
        }
    }
  }
}

/**
 * Право человека на сходку у Meetups — `CheckMeetupAuthority` с отношением «администратор сообщества» (ADR-051). Без
 * кэша и без повторов: устаревшее разрешение равносильно пропущенной проверке (ADR-026).
 */
final class GrpcMeetupAuthority(client: MeetupsServiceClient, token: String)(using ExecutionContext)
    extends MeetupAuthority {

  def check(meetup: MeetupId, person: ParticipantId, correlation: Correlation): Future[Authority] = {
    val authorized = client.checkMeetupAuthority().addHeader("authorization", s"Bearer $token")
    val withRequest = correlation.requestId.fold(authorized)(authorized.addHeader("x-request-id", _))
    correlation.useCase
      .fold(withRequest)(withRequest.addHeader("x-use-case", _))
      .invoke(
        CheckMeetupAuthorityRequest(
          id = meetup.value.toString,
          identityId = person.value.toString,
          acceptedRelations = Seq(MeetupRelation.MEETUP_RELATION_COMMUNITY_ADMINISTRATOR)
        )
      )
      .map(answer => Authority.Granted(GrpcMeetupAuthority.standing(answer)))
      .recoverWith { case failure: StatusRuntimeException =>
        GrpcMeetupAuthority.authority(failure.getStatus.getCode) match {
          case Some(authority) => Future.successful(authority)
          case None => Future.failed(failure)
        }
      }
  }
}

object GrpcMeetupAuthority {

  /**
   * Ответ Meetups статусом. `PERMISSION_DENIED` и `NOT_FOUND` — ответы о праве; `UNAVAILABLE` и истёкший срок — право
   * сейчас не подтвердить. Остальное — сбой проверки, а не ответ о человеке: `UNAUTHENTICATED` значит, что Meetups не
   * узнал Auction, и это дефект развёртывания; граница отдаст его `INTERNAL`.
   */
  def authority(code: Status.Code): Option[Authority] =
    code match {
      case Status.Code.PERMISSION_DENIED => Some(Authority.NotAdministrator)
      case Status.Code.NOT_FOUND => Some(Authority.MeetupNotFound)
      case Status.Code.UNAVAILABLE | Status.Code.DEADLINE_EXCEEDED => Some(Authority.Unavailable)
      case _ => None
    }

  /**
   * Состояние сходки из тела ответа (ADR-047, дополнение 2026-10-12). `UNSPECIFIED` в любом из двух полей — Meetups его
   * не прислал, а неизвестное значение — схема новее Auction: в обоих случаях состояния нет, и решать по нему нечего.
   */
  def standing(answer: WireAuthority): Option[MeetupStanding] = {
    val lifecycle = answer.lifecycle match {
      case WireLifecycle.MEETUP_LIFECYCLE_PLANNED => Some(MeetupLifecycle.Planned)
      case WireLifecycle.MEETUP_LIFECYCLE_HELD => Some(MeetupLifecycle.Held)
      case WireLifecycle.MEETUP_LIFECYCLE_CANCELLED => Some(MeetupLifecycle.Cancelled)
      case WireLifecycle.MEETUP_LIFECYCLE_UNSPECIFIED | WireLifecycle.Unrecognized(_) => None
    }
    val visibility = answer.visibility match {
      case WireVisibility.MEETUP_VISIBILITY_HIDDEN => Some(MeetupVisibility.Hidden)
      case WireVisibility.MEETUP_VISIBILITY_VISIBLE => Some(MeetupVisibility.Visible)
      case WireVisibility.MEETUP_VISIBILITY_UNSPECIFIED | WireVisibility.Unrecognized(_) => None
    }
    lifecycle.zip(visibility).map(MeetupStanding(_, _))
  }

  /** Без адреса Meetups право подтвердить нечем: каждая проверка — `Unavailable`, и события команда не порождает. */
  val absent: MeetupAuthority = (_, _, _) => Future.successful(Authority.Unavailable)

  def apply(settings: MeetupsSettings)(using system: ActorSystem[?]): MeetupAuthority =
    (settings.url, settings.serviceToken) match {
      case (Some(url), Some(token)) =>
        // Срок задаётся на клиенте и действует на каждый вызов: повторов нет.
        val client = MeetupsServiceClient(
          GrpcClientSettings
            .connectToServiceAt(url.getHost, url.getPort)
            .withTls(url.getScheme == "https")
            .withDeadline(settings.deadline)
        )
        new GrpcMeetupAuthority(client, token)(using system.executionContext)
      case _ => absent
    }
}
