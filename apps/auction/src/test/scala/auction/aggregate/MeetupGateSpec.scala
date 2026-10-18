package auction.aggregate

import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

final class MeetupGateSpec extends AnyWordSpec with Matchers {

  private val held = Some(MeetupStanding(MeetupLifecycle.Held, MeetupVisibility.Visible))

  "meetup gate" should {

    "lets every command through a planned or held meetup that is visible" in {
      for (gate <- MeetupGate.values; standing <- List(Standings.published, held))
        MeetupGate.admit(gate, standing) shouldBe None
    }

    "refuses every gated command of a cancelled meetup, hidden or not" in {
      val hiddenCancelled = Some(MeetupStanding(MeetupLifecycle.Cancelled, MeetupVisibility.Hidden))
      for (
        gate <- List(MeetupGate.NotCancelled, MeetupGate.Published);
        standing <- List(Standings.cancelled, hiddenCancelled)
      )
        MeetupGate.admit(gate, standing) shouldBe Some(Denial.MeetupCancelled)
    }

    "refuses only the opening of prebidding at a hidden meetup" in {
      MeetupGate.admit(MeetupGate.Published, Standings.hidden) shouldBe Some(Denial.MeetupHidden)
      MeetupGate.admit(MeetupGate.NotCancelled, Standings.hidden) shouldBe None
    }

    "reads a missing state as unavailable for a gated command and does not look at it otherwise" in {
      MeetupGate.admit(MeetupGate.NotCancelled, None) shouldBe Some(Denial.Unavailable)
      MeetupGate.admit(MeetupGate.Published, None) shouldBe Some(Denial.Unavailable)
      for (standing <- List(None, Standings.cancelled, Standings.hidden))
        MeetupGate.admit(MeetupGate.Unconditional, standing) shouldBe None
    }
  }
}
