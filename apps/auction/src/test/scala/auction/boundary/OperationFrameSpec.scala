package auction.boundary

import io.grpc.Status
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

    "reports a served request as ok and carries no error category" in {
      val frame = OperationFrame.of("GET /health", StatusCodes.OK, durationUs = 1234, requestId = None)

      frame("result") shouldBe "ok"
      frame("operation") shouldBe "GET /health"
      frame("duration_us") shouldBe "1234"
      frame.keySet should not contain "error_category"
    }

    "omits request_id when the caller did not send one" in {
      val frame = OperationFrame.of("GET /health", StatusCodes.OK, durationUs = 1, requestId = None)

      frame.keySet should not contain "request_id"
    }

    "omits request_id when the caller sent an empty header" in {
      val frame = OperationFrame.of("GET /health", StatusCodes.OK, durationUs = 1, requestId = Some(""))

      frame.keySet should not contain "request_id"
    }

    "carries the request_id the caller sent through" in {
      val frame =
        OperationFrame.of("GET /health", StatusCodes.OK, durationUs = 1, requestId = Some("01930000-request"))

      frame("request_id") shouldBe "01930000-request"
    }

    "classifies an unavailable dependency apart from an unexpected failure" in {
      val unavailable = OperationFrame.of("GET /health", StatusCodes.ServiceUnavailable, 1, None)
      val unexpected = OperationFrame.of("GET /health", StatusCodes.InternalServerError, 1, None)

      unavailable("error_category") shouldBe "dependency_unavailable"
      unexpected("error_category") shouldBe "unexpected"
    }

    "classifies an unserved path as a broken input rather than a hidden resource" in {
      val frame = OperationFrame.of("GET /lots", StatusCodes.NotFound, 1, None)

      frame("error_category") shouldBe "invariant"
    }

    "names the rejected input by the status reason when nothing was thrown" in {
      val frame = OperationFrame.of("GET /lots", StatusCodes.NotFound, 1, None)

      frame("error") shouldBe StatusCodes.NotFound.reason
      frame.keySet should not contain "stack"
    }

    "names only the class of the caught failure and keeps its frames without messages" in {
      val cause = new IllegalStateException("Failing row contains (Кот)", new IllegalArgumentException("(Пёс)"))
      val frame =
        OperationFrame.of("GET /lots", StatusCodes.InternalServerError, 1, None, Some(cause))

      frame("error") shouldBe "java.lang.IllegalStateException"
      frame("stack") should include("OperationFrameSpec")
      frame("stack") should include("Caused by: java.lang.IllegalArgumentException")
      frame("stack") should not include "Кот"
      frame("stack") should not include "Пёс"
    }

    "carries an error category and an error text exactly when the result is an error" in {
      forAll(statuses, Gen.chooseNum(0L, 10000000L)) { (status: StatusCode, durationUs: Long) =>
        val frame = OperationFrame.of("GET /health", status, durationUs, None)

        val failed = frame("result") == "error"
        frame.contains("error_category") shouldBe failed
        frame.contains("error") shouldBe failed
        frame.get("error_category").foreach(errorCategories should contain(_))
        frame("duration_us") shouldBe durationUs.toString
      }
    }

    "keeps the stack out of a record that no exception produced" in {
      forAll(statuses, Gen.chooseNum(0L, 10000000L)) { (status: StatusCode, durationUs: Long) =>
        OperationFrame.of("GET /health", status, durationUs, None).keySet should not contain "stack"
      }
    }
  }

  private val operation = "auction.v1.AuctionService/PlaceBid"

  private def grpc(code: Status.Code, failure: Option[Throwable] = None) =
    OperationFrame.grpc(operation, code, Some("described"), 42, Some("req-1"), Some("place_bid"), failure)

  "grpc operation frame" should {

    "reports an OK call as ok with its code in grpc_code, not in result" in {
      val frame = grpc(Status.Code.OK)
      frame("result") shouldBe "ok"
      frame("grpc_code") shouldBe "OK"
      frame("operation") shouldBe operation
      frame("request_id") shouldBe "req-1"
      frame("use_case") shouldBe "place_bid"
      frame.keySet should not contain "error_category"
    }

    "classifies a refused caller and a refused viewer as authorization" in {
      grpc(Status.Code.UNAUTHENTICATED)("error_category") shouldBe "authorization"
      grpc(Status.Code.PERMISSION_DENIED)("error_category") shouldBe "authorization"
    }

    "classifies an unanswered lot as a timeout and a malformed request as an invariant" in {
      grpc(Status.Code.DEADLINE_EXCEEDED)("error_category") shouldBe "timeout"
      grpc(Status.Code.INVALID_ARGUMENT)("error_category") shouldBe "invariant"
      grpc(Status.Code.UNIMPLEMENTED)("error_category") shouldBe "invariant"
    }

    "writes the code with the service's own description as the error of an expected refusal" in {
      grpc(Status.Code.INVALID_ARGUMENT)("error") shouldBe "INVALID_ARGUMENT: described"
    }

    "writes only the exception class of an unexpected failure, never its message" in {
      val cause = new IllegalArgumentException("value (Описание)")
      val frame = grpc(Status.Code.INTERNAL, Some(new IllegalStateException("Failing row contains (Лот)", cause)))
      frame("error_category") shouldBe "unexpected"
      frame("error") shouldBe "java.lang.IllegalStateException"
      frame("stack") should include("java.lang.IllegalStateException")
      frame("stack") should include("Caused by: java.lang.IllegalArgumentException")
      frame("stack") should not include "Лот"
      frame("stack") should not include "Описание"
    }

    "omits request_id and use_case when the caller did not send them" in {
      val frame = OperationFrame.grpc(operation, Status.Code.OK, None, 1, None, Some(""))
      frame.keySet should contain noneOf ("request_id", "use_case")
    }

    "carries an error category exactly when the code is not OK" in {
      forAll(Gen.oneOf(Status.Code.values.toSeq)) { (code: Status.Code) =>
        val frame = OperationFrame.grpc(operation, code, None, 1, None, None)
        frame.contains("error_category") shouldBe (code != Status.Code.OK)
        frame.get("error_category").foreach(errorCategories should contain(_))
      }
    }
  }
}
