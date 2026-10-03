package auction.telemetry

import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

final class ProjectionBacklogSpec extends AnyWordSpec with Matchers {

  "projection backlog" should {

    "reports the counted events of every tag" in {
      ProjectionBacklog.behind(Seq("lot-0", "lot-1"), Map("lot-0" -> 6L, "lot-1" -> 7L)) shouldBe
        Map("lot-0" -> 6L, "lot-1" -> 7L)
    }

    "reports zero for a tag with nothing past its offset instead of dropping it" in {
      ProjectionBacklog.behind(Seq("lot-0", "lot-1", "lot-2"), Map("lot-0" -> 3L)) shouldBe
        Map("lot-0" -> 3L, "lot-1" -> 0L, "lot-2" -> 0L)
    }

    "ignores counts of tags that do not belong to the projection" in {
      ProjectionBacklog.behind(Seq("lot-0"), Map("lot-0" -> 1L, "auction-0" -> 9L)) shouldBe Map("lot-0" -> 1L)
    }
  }
}
