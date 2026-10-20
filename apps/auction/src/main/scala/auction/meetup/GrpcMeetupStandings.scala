package auction.meetup

import auction.screen.MeetupStandings
import auction.screen.StandingAnswer
import io.grpc.Status
import io.grpc.StatusRuntimeException
import meetups.v1.meetups_service.GetMeetupStandingRequest
import meetups.v1.meetups_service.MeetupsServiceClient
import org.apache.pekko.actor.typed.ActorSystem
import org.apache.pekko.grpc.GrpcClientSettings

import java.util.UUID
import scala.concurrent.ExecutionContext
import scala.concurrent.Future

/**
 * Состояние сходки для ворот экрана зала — `GetMeetupStanding` (ADR-040, дополнение 2026-10-19). Без кэша и повторов,
 * со сроком `auction.meetups.deadline`, тем же токеном, что у проверки права. `NOT_FOUND` — сходки нет; `UNAVAILABLE` и
 * истёкший срок — состояние сейчас не подтвердить; остальное, в том числе `UNAUTHENTICATED`, — неудачное `Future`:
 * Meetups не узнал Auction, и это дефект развёртывания, а не ответ о сходке.
 */
final class GrpcMeetupStandings(client: MeetupsServiceClient, token: String)(using ExecutionContext)
    extends MeetupStandings {

  def standing(meetup: UUID): Future[StandingAnswer] =
    client
      .getMeetupStanding()
      .addHeader("authorization", s"Bearer $token")
      .invoke(GetMeetupStandingRequest(id = meetup.toString))
      .map { answer =>
        GrpcMeetupAuthority
          .standing(answer.lifecycle, answer.visibility)
          .fold(StandingAnswer.Unavailable)(StandingAnswer.Found(_))
      }
      .recoverWith { case failure: StatusRuntimeException =>
        failure.getStatus.getCode match {
          case Status.Code.NOT_FOUND => Future.successful(StandingAnswer.Missing)
          case Status.Code.UNAVAILABLE | Status.Code.DEADLINE_EXCEEDED => Future.successful(StandingAnswer.Unavailable)
          case _ => Future.failed(failure)
        }
      }
}

object GrpcMeetupStandings {

  /** Без адреса Meetups состояние подтвердить нечем: экран отвечает «недоступно», а не «открыто». */
  val absent: MeetupStandings = _ => Future.successful(StandingAnswer.Unavailable)

  def apply(settings: MeetupsSettings)(using system: ActorSystem[?]): MeetupStandings =
    (settings.url, settings.serviceToken) match {
      case (Some(url), Some(token)) =>
        val client = MeetupsServiceClient(
          GrpcClientSettings
            .connectToServiceAt(url.getHost, url.getPort)
            .withTls(url.getScheme == "https")
            .withDeadline(settings.deadline)
        )
        new GrpcMeetupStandings(client, token)(using system.executionContext)
      case _ => absent
    }
}
