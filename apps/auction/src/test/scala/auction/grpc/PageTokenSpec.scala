package auction.grpc

import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

import java.util.UUID

final class PageTokenSpec extends AnyWordSpec with Matchers {

  private val lotId = UUID.fromString("01926f3c-8b7a-7cde-8f00-000000000001")

  "page token" should {

    "decodes the lot id it encoded" in {
      PageToken.decode(PageToken.encode(lotId)) shouldBe Some(Some(lotId))
    }

    "reads an empty token as the start of the enumeration" in {
      PageToken.decode("") shouldBe Some(None)
    }

    "refuses a token the service did not issue" in {
      PageToken.decode("not base64 !") shouldBe None
      PageToken.decode(PageToken.encode(lotId).reverse) shouldBe None
      PageToken.decode(java.util.Base64.getUrlEncoder.encodeToString("lot-1".getBytes)) shouldBe None
    }
  }
}
