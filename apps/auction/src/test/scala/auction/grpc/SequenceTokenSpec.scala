package auction.grpc

import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

import java.nio.charset.StandardCharsets
import java.util.Base64

final class SequenceTokenSpec extends AnyWordSpec with Matchers {

  private def encoded(text: String) =
    Base64.getUrlEncoder.withoutPadding.encodeToString(text.getBytes(StandardCharsets.US_ASCII))

  "sequence token" should {

    "decodes the journal position it encoded" in {
      SequenceToken.decode(SequenceToken.encode(37)) shouldBe Some(Some(37L))
      SequenceToken.decode(SequenceToken.encode(Long.MaxValue)) shouldBe Some(Some(Long.MaxValue))
    }

    "reads an empty token as the start of the enumeration" in {
      SequenceToken.decode("") shouldBe Some(None)
    }

    "refuses a token the service did not issue" in {
      SequenceToken.decode("not base64 !") shouldBe None
      SequenceToken.decode(encoded("0")) shouldBe None
      SequenceToken.decode(encoded("-3")) shouldBe None
      SequenceToken.decode(encoded("037")) shouldBe None
      SequenceToken.decode(encoded("9223372036854775808")) shouldBe None
      SequenceToken.decode(encoded("37") + "=") shouldBe None
    }
  }
}
