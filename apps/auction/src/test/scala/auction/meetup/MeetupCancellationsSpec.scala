package auction.meetup

import auction.aggregate.ApplyMeetupCancelled
import auction.aggregate.Auction
import auction.aggregate.MeetupId
import meetups.v1.meetups_events.MeetupCancelled
import meetups.v1.meetups_events.MeetupEvent
import meetups.v1.meetups_events.MeetupHeld
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

import java.util.UUID

final class MeetupCancellationsSpec extends AnyWordSpec with Matchers {

  private val eventId = UUID.fromString("0190a0e0-0000-7000-8000-0000000000aa")
  private val meetupId = UUID.fromString("0190a0e0-0000-7000-8000-000000000001")

  private def fact(occasion: MeetupEvent.Occasion = MeetupEvent.Occasion.MeetupCancelled(MeetupCancelled())) =
    MeetupEvent(eventId = eventId.toString, meetupId = meetupId.toString, version = 3, occasion = occasion)

  "meetup cancellations" should {

    "turn a cancellation into one command to the auction of the meetup with an op_id derived from the event" in {
      MeetupCancellations.inheritance(fact().withRequestId("req-1").toByteArray) shouldBe Right(
        Inheritance(
          Auction.idOf(MeetupId(meetupId)),
          ApplyMeetupCancelled(Auction.meetupCancellationOf(eventId)),
          Some("req-1")
        )
      )
    }

    "give the same command for a redelivery of the same fact" in {
      MeetupCancellations.inheritance(fact().toByteArray) shouldBe MeetupCancellations.inheritance(fact().toByteArray)
    }

    "refuse a body that is not a meetup cancellation without naming its values" in {
      MeetupCancellations.inheritance(Array[Byte](1, 2, 3)) shouldBe Left("meetup event is not a MeetupEvent")
      MeetupCancellations.inheritance(fact(MeetupEvent.Occasion.MeetupHeld(MeetupHeld())).toByteArray) shouldBe
        Left("meetup event is not meetup_cancelled")
      MeetupCancellations.inheritance(fact().withEventId("not-a-uuid").toByteArray) shouldBe
        Left("meetup event has no valid event_id")
      MeetupCancellations.inheritance(fact().withMeetupId("").toByteArray) shouldBe
        Left("meetup event has no valid meetup_id")
    }
  }
}
