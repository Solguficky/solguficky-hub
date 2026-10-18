package auction.entity

import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

final class LotTagsSpec extends AnyWordSpec with Matchers {

  "lot tags" should {

    "puts every slice of Pekko into one of four tags" in {
      (0 until 1024).map(LotTags.of).toSet shouldBe LotTags.all.toSet
      LotTags.all shouldBe Vector("lot-0", "lot-1", "lot-2", "lot-3")
    }

    "keeps the slice remainder as the tag number" in {
      List(0, 1, 6, 1023).map(LotTags.of) shouldBe List("lot-0", "lot-1", "lot-2", "lot-3")
    }
  }
}
