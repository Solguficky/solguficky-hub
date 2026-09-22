package auction.boundary

import org.apache.pekko.http.scaladsl.model.ContentTypes
import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.testkit.ScalatestRouteTest
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

final class HealthRoutesSpec extends AnyWordSpec with Matchers with ScalatestRouteTest {

  "health route" should {

    "answer 200 with an ok status as json" in {
      Get("/health") ~> HealthRoutes.route ~> check {
        status shouldBe StatusCodes.OK
        contentType shouldBe ContentTypes.`application/json`
        responseAs[String] shouldBe """{"status":"ok"}"""
      }
    }

    "leave a path it does not serve unhandled" in {
      Get("/lots") ~> HealthRoutes.route ~> check {
        handled shouldBe false
      }
    }

    "leave a write method on its own path unhandled" in {
      Post("/health") ~> HealthRoutes.route ~> check {
        handled shouldBe false
      }
    }
  }
}
