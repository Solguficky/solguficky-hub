package auction.boundary

import auction.Readiness
import org.apache.pekko.http.scaladsl.model.ContentTypes
import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.testkit.ScalatestRouteTest
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

import scala.concurrent.Future

final class HealthRoutesSpec extends AnyWordSpec with Matchers with ScalatestRouteTest {

  private def routeWhen(readiness: Readiness) = HealthRoutes.route(() => Future.successful(readiness))

  "health route" should {

    "answer 200 with an ok status as json when the node is ready" in {
      Get("/health") ~> routeWhen(Readiness.Ready) ~> check {
        status shouldBe StatusCodes.OK
        contentType shouldBe ContentTypes.`application/json`
        responseAs[String] shouldBe """{"status":"ok"}"""
      }
    }

    "answer 503 naming the cluster while the node has not joined it" in {
      Get("/health") ~> routeWhen(Readiness.ClusterNotUp) ~> check {
        status shouldBe StatusCodes.ServiceUnavailable
        contentType shouldBe ContentTypes.`application/json`
        responseAs[String] shouldBe """{"status":"not ready","reason":"cluster"}"""
      }
    }

    "answer 503 naming the journal while its database does not answer" in {
      Get("/health") ~> routeWhen(Readiness.JournalUnavailable) ~> check {
        status shouldBe StatusCodes.ServiceUnavailable
        responseAs[String] shouldBe """{"status":"not ready","reason":"journal"}"""
      }
    }

    "leave a path it does not serve unhandled" in {
      Get("/lots") ~> routeWhen(Readiness.Ready) ~> check {
        handled shouldBe false
      }
    }

    "leave a write method on its own path unhandled" in {
      Post("/health") ~> routeWhen(Readiness.Ready) ~> check {
        handled shouldBe false
      }
    }
  }
}
