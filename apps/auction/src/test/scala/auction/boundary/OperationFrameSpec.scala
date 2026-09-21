package auction.boundary

import org.apache.pekko.http.scaladsl.model.StatusCode
import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.scalacheck.Gen
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec
import org.scalatestplus.scalacheck.ScalaCheckDrivenPropertyChecks

final class OperationFrameSpec extends AnyWordSpec with Matchers with ScalaCheckDrivenPropertyChecks {

  // Умолчание моста — десять проверок, а не сто по умолчанию ScalaCheck,
  // поэтому число задаётся явно.
  implicit override val generatorDrivenConfig: PropertyCheckConfiguration =
    PropertyCheckConfiguration(minSuccessful = 200)

  private val errorCategories =
    Set("authorization", "invariant", "dependency_unavailable", "timeout", "visibility", "unexpected")

  private val statuses: Gen[StatusCode] = Gen.oneOf(
    StatusCodes.OK,
    StatusCodes.Created,
    StatusCodes.NoContent,
    StatusCodes.MovedPermanently,
    StatusCodes.BadRequest,
    StatusCodes.Unauthorized,
    StatusCodes.Forbidden,
    StatusCodes.NotFound,
    StatusCodes.RequestTimeout,
    StatusCodes.InternalServerError,
    StatusCodes.ServiceUnavailable,
    StatusCodes.GatewayTimeout
  )

  "operation frame" should {

    "report a served request as ok and carry no error category" in {
      val frame = OperationFrame.of("GET /health", StatusCodes.OK, durationUs = 1234, requestId = None)

      frame("result") shouldBe "ok"
      frame("operation") shouldBe "GET /health"
      frame("duration_us") shouldBe "1234"
      frame.keySet should not contain "error_category"
    }

    "omit request_id when the caller did not send one" in {
      val frame = OperationFrame.of("GET /health", StatusCodes.OK, durationUs = 1, requestId = None)

      frame.keySet should not contain "request_id"
    }

    "omit request_id when the caller sent an empty header" in {
      val frame = OperationFrame.of("GET /health", StatusCodes.OK, durationUs = 1, requestId = Some(""))

      frame.keySet should not contain "request_id"
    }

    "carry the request_id the caller sent through" in {
      val frame =
        OperationFrame.of("GET /health", StatusCodes.OK, durationUs = 1, requestId = Some("01930000-request"))

      frame("request_id") shouldBe "01930000-request"
    }

    "classify an unavailable dependency apart from an unexpected failure" in {
      val unavailable = OperationFrame.of("GET /health", StatusCodes.ServiceUnavailable, 1, None)
      val unexpected = OperationFrame.of("GET /health", StatusCodes.InternalServerError, 1, None)

      unavailable("error_category") shouldBe "dependency_unavailable"
      unexpected("error_category") shouldBe "unexpected"
    }

    "classify an unserved path as a broken input rather than a hidden resource" in {
      val frame = OperationFrame.of("GET /lots", StatusCodes.NotFound, 1, None)

      frame("error_category") shouldBe "invariant"
    }

    "name the rejected input by the status reason when nothing was thrown" in {
      val frame = OperationFrame.of("GET /lots", StatusCodes.NotFound, 1, None)

      frame("error") shouldBe StatusCodes.NotFound.reason
      frame.keySet should not contain "stack"
    }

    "name the caught failure and keep its stack when something was thrown" in {
      val cause = new IllegalStateException("lot registry is not wired yet")
      val frame =
        OperationFrame.of("GET /lots", StatusCodes.InternalServerError, 1, None, Some(cause))

      frame("error") should include("java.lang.IllegalStateException")
      frame("error") should include("lot registry is not wired yet")
      frame("stack") should include("OperationFrameSpec")
    }

    "fall back to the failure class when the exception carries no message" in {
      val frame =
        OperationFrame.of("GET /lots", StatusCodes.InternalServerError, 1, None, Some(new RuntimeException))

      frame("error") shouldBe "java.lang.RuntimeException"
    }

    "carry an error category and an error text exactly when the result is an error" in {
      forAll(statuses, Gen.chooseNum(0L, 10000000L)) { (status: StatusCode, durationUs: Long) =>
        val frame = OperationFrame.of("GET /health", status, durationUs, None)

        val failed = frame("result") == "error"
        frame.contains("error_category") shouldBe failed
        frame.contains("error") shouldBe failed
        frame.get("error_category").foreach(errorCategories should contain(_))
        frame("duration_us") shouldBe durationUs.toString
      }
    }

    "keep the stack out of a record that no exception produced" in {
      forAll(statuses, Gen.chooseNum(0L, 10000000L)) { (status: StatusCode, durationUs: Long) =>
        OperationFrame.of("GET /health", status, durationUs, None).keySet should not contain "stack"
      }
    }
  }
}
