package auction.testkit

import io.grpc.Status
import meetups.v1.meetups_service as wire
import org.apache.pekko.actor.typed.ActorSystem
import org.apache.pekko.grpc.GrpcServiceException
import org.apache.pekko.http.scaladsl.Http

import scala.concurrent.Await
import scala.concurrent.Future
import scala.concurrent.duration.*

/**
 * Meetups для сервиса, запущенного отдельным процессом: настоящий gRPC-сервер в JVM теста, который на
 * `CheckMeetupAuthority` подтверждает администратором одного человека, а остальным отвечает `PERMISSION_DENIED`, как
 * Meetups. Токен Auction он не сверяет: провод Auction → Meetups держат L0 адаптера и контур, а здесь нужен только
 * ответ о праве. Остальные методы отвечают `UNIMPLEMENTED`: сервис их не зовёт.
 */
final class MeetupsStub private (binding: Http.ServerBinding) {

  def url: String = s"http://127.0.0.1:${binding.localAddress.getPort}"

  def stop(): Unit = Await.result(binding.unbind(), 10.seconds)
}

object MeetupsStub {

  def start(administrator: String)(using system: ActorSystem[?]): MeetupsStub = {
    val handler = wire.MeetupsServiceHandler(Service(administrator))
    MeetupsStub(Await.result(Http().newServerAt("127.0.0.1", 0).bind(handler), 10.seconds))
  }

  private final class Service(administrator: String) extends wire.MeetupsService {
    private def unused[T]: Future[T] = Future.failed(new GrpcServiceException(Status.UNIMPLEMENTED))

    def checkMeetupAuthority(in: wire.CheckMeetupAuthorityRequest): Future[wire.MeetupAuthority] =
      if (in.identityId == administrator) Future.successful(wire.MeetupAuthority())
      else Future.failed(new GrpcServiceException(Status.PERMISSION_DENIED))

    def createMeetupDraft(in: wire.CreateMeetupDraftRequest) = unused
    def changeMeetupAttributes(in: wire.ChangeMeetupAttributesRequest) = unused
    def setMeetupSchedule(in: wire.SetMeetupScheduleRequest) = unused
    def publishMeetup(in: wire.PublishMeetupRequest) = unused
    def scheduleMeetupPublication(in: wire.ScheduleMeetupPublicationRequest) = unused
    def cancelMeetupPublication(in: wire.CancelMeetupPublicationRequest) = unused
    def unpublishMeetup(in: wire.UnpublishMeetupRequest) = unused
    def cancelMeetup(in: wire.CancelMeetupRequest) = unused
    def attachMaterial(in: wire.AttachMaterialRequest) = unused
    def removeMaterial(in: wire.RemoveMaterialRequest) = unused
    def markMeetupHeld(in: wire.MarkMeetupHeldRequest) = unused
    def listVisibleMeetups(in: wire.ListVisibleMeetupsRequest) = unused
    def listArchivedMeetups(in: wire.ListArchivedMeetupsRequest) = unused
    def getMeetup(in: wire.GetMeetupRequest) = unused
    def listMeetupStates(in: wire.ListMeetupStatesRequest) = unused
  }
}
