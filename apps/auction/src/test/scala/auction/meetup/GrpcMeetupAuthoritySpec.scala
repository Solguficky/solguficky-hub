package auction.meetup

import auction.aggregate.Authority
import auction.aggregate.MeetupId
import auction.lot.ParticipantId
import com.typesafe.config.ConfigFactory
import io.grpc.Status
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

import java.util.UUID

final class GrpcMeetupAuthoritySpec extends AnyWordSpec with Matchers {

  private def settings(lines: String*) =
    MeetupsSettings.fromConfig(
      ConfigFactory.parseString(("auction.meetups.deadline = 2s" +: lines).mkString("\n")),
      _ == "caller-token"
    )

  "meetup authority" should {

    "reads the answer of meetups from the status and treats every other status as a failed check" in {
      GrpcMeetupAuthority.authority(Status.Code.OK) shouldBe Some(Authority.Granted)
      GrpcMeetupAuthority.authority(Status.Code.PERMISSION_DENIED) shouldBe Some(Authority.NotAdministrator)
      GrpcMeetupAuthority.authority(Status.Code.NOT_FOUND) shouldBe Some(Authority.MeetupNotFound)
      GrpcMeetupAuthority.authority(Status.Code.UNAVAILABLE) shouldBe Some(Authority.Unavailable)
      GrpcMeetupAuthority.authority(Status.Code.DEADLINE_EXCEEDED) shouldBe Some(Authority.Unavailable)
      // Meetups не узнал Auction: это дефект развёртывания, а не ответ о человеке.
      GrpcMeetupAuthority.authority(Status.Code.UNAUTHENTICATED) shouldBe None
      GrpcMeetupAuthority.authority(Status.Code.INVALID_ARGUMENT) shouldBe None
      GrpcMeetupAuthority.authority(Status.Code.INTERNAL) shouldBe None
    }

    "answers every check as unavailable without an address of meetups" in {
      GrpcMeetupAuthority.absent
        .check(MeetupId(new UUID(1L, 1L)), ParticipantId(new UUID(1L, 2L)))
        .value
        .flatMap(_.toOption) shouldBe Some(Authority.Unavailable)
    }
  }

  "meetups settings" should {

    "starts without meetups when no address is set" in {
      settings().map(_.url) shouldBe Right(None)
    }

    "accepts an address together with an own token" in {
      val read =
        settings("""auction.meetups.url = "http://127.0.0.1:5101"""", """auction.meetups.service-token = "own"""")
      read.map(_.url.map(_.getPort)) shouldBe Right(Some(5101))
    }

    "refuses to start with an address but without an own token, naming the variable" in {
      settings("""auction.meetups.url = "http://127.0.0.1:5101"""", """auction.meetups.service-token = " """") shouldBe
        Left("auction service token is not set: AUCTION_SERVICE_TOKEN")
    }

    "refuses to start with an own token equal to a caller token without naming the value" in {
      val read =
        settings(
          """auction.meetups.url = "http://127.0.0.1:5101"""",
          """auction.meetups.service-token = "caller-token""""
        )
      read shouldBe Left("auction service token equals a caller token: AUCTION_SERVICE_TOKEN")
    }

    "refuses an own token equal to a caller token even without an address of meetups" in {
      settings("""auction.meetups.service-token = "caller-token"""") shouldBe
        Left("auction service token equals a caller token: AUCTION_SERVICE_TOKEN")
    }

    "refuses an address that is not a host and port" in {
      settings("""auction.meetups.url = "meetups"""", """auction.meetups.service-token = "own"""").isLeft shouldBe true
    }
  }
}
