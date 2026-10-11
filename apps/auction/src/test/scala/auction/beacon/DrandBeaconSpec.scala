package auction.beacon

import auction.raffle.Quicknet
import com.typesafe.config.ConfigFactory
import org.scalatest.concurrent.ScalaFutures
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

import java.net.URI
import scala.concurrent.ExecutionContext
import scala.concurrent.Future
import scala.concurrent.duration.*

final class DrandBeaconSpec extends AnyWordSpec with Matchers with ScalaFutures {

  private given ExecutionContext = ExecutionContext.global

  private def mirrors(value: String) =
    BeaconSettings.fromConfig(
      ConfigFactory.parseString(s"""auction.raffle.beacon { mirrors = "$value", request-timeout = 5s }""")
    )

  "the drand beacon" should {

    val round = 2398899L
    val value = "d7941e7b5bcaf8742bfc7136d38c5ab8274286629ffe43081dbda1f05d798300"
    def body(r: Long, randomness: String) = s"""{"round":$r,"randomness":"$randomness","signature":"00"}"""
    val settings = BeaconSettings(List("https://a", "https://b", "https://c").map(URI.create), 1.second)

    "reads the randomness only of the requested round" in {
      DrandBeacon.reading(body(round, value), round).map(_.hex) shouldBe Some(value)
      DrandBeacon.reading(body(round + 1, value), round) shouldBe None
      DrandBeacon.reading(body(round, "XYZ"), round) shouldBe None
      DrandBeacon.reading("not json", round) shouldBe None
    }

    "asks the round of the chain at every mirror and accepts the value two of them agree on" in {
      val asked = java.util.concurrent.ConcurrentLinkedQueue[String]()
      val beacon = new DrandBeacon(
        settings,
        uri => {
          asked.add(uri.toString)
          if (uri.getHost == "b") Future.failed(new RuntimeException("down"))
          else Future.successful(Some(body(round, value)))
        }
      )
      beacon.randomness(round).futureValue.map(_.hex) shouldBe Some(value)
      asked.toArray.toSet shouldBe Set("a", "b", "c").map(host => s"https://$host/${Quicknet.ChainHash}/public/$round")
    }

    "waits when only one mirror answers" in {
      val beacon =
        new DrandBeacon(settings, uri => Future.successful(Option.when(uri.getHost == "a")(body(round, value))))
      beacon.randomness(round).futureValue shouldBe None
    }

    "refuses fewer than two distinct mirrors, a repeated mirror included" in {
      mirrors("https://a.example,https://b.example").map(_.mirrors.size) shouldBe Right(2)
      mirrors("https://a.example,https://a.example/").isLeft shouldBe true
      mirrors("https://a.example").isLeft shouldBe true
      mirrors("https://a.example,ftp://b.example").isLeft shouldBe true
    }
  }
}
