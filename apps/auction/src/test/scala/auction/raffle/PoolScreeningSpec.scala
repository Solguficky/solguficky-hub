package auction.raffle

import auction.beacon.BeaconSettings
import auction.beacon.DrandBeacon
import auction.lot.ParticipantId
import org.scalatest.concurrent.ScalaFutures
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

import java.net.URI
import java.time.Clock
import java.time.Instant
import java.time.ZoneOffset
import java.util.UUID
import java.util.concurrent.atomic.AtomicInteger
import scala.concurrent.ExecutionContext
import scala.concurrent.Future
import scala.concurrent.duration.*

final class PoolScreeningSpec extends AnyWordSpec with Matchers with ScalaFutures {

  private given ExecutionContext = ExecutionContext.global

  private def person(n: Int) = ParticipantId(new UUID(0x0190f2a000007000L, 0x8000000000000000L | n.toLong))

  private val now = Instant.parse("2026-10-28T18:00:00Z")
  private val clock = Clock.fixed(now, ZoneOffset.UTC)
  private val noPause: FiniteDuration => Future[Unit] = _ => Future.unit

  "screening the pool at closing" should {

    "keep the answer of Identity for each candidate and retry a failed question within the window" in {
      val calls = new AtomicInteger(0)
      val access: RaffleAccess = participant =>
        if (participant == person(2) && calls.getAndIncrement() == 0) Future.failed(new RuntimeException("busy"))
        else Future.successful(participant != person(3))
      val answers =
        PoolScreening.screen(
          Vector(person(1), person(2), person(3)),
          access,
          now.plusSeconds(30),
          clock,
          3.seconds,
          noPause
        )
      answers.futureValue shouldBe Map(person(1) -> Some(true), person(2) -> Some(true), person(3) -> Some(false))
    }

    "give up on a silent Identity at the end of the window and leave the candidate unanswered" in {
      val access: RaffleAccess = _ => Future.failed(new RuntimeException("down"))
      val answers = PoolScreening.screen(Vector(person(1)), access, now.plusSeconds(2), clock, 3.seconds, noPause)
      answers.futureValue shouldBe Map(person(1) -> None)
      Raffle.excluded(answers.futureValue) shouldBe empty
    }
  }

  "the drand beacon" should {

    val round = 2398899L
    val value = "d7941e7b5bcaf8742bfc7136d38c5ab8274286629ffe43081dbda1f05d798300"
    def body(r: Long, randomness: String) = s"""{"round":$r,"randomness":"$randomness","signature":"00"}"""
    val settings = BeaconSettings(List("https://a", "https://b", "https://c").map(URI.create), 1.second)

    "read the randomness only of the requested round" in {
      DrandBeacon.reading(body(round, value), round).map(_.hex) shouldBe Some(value)
      DrandBeacon.reading(body(round + 1, value), round) shouldBe None
      DrandBeacon.reading(body(round, "XYZ"), round) shouldBe None
      DrandBeacon.reading("not json", round) shouldBe None
    }

    "ask the round of the chain at every mirror and accept the value two of them agree on" in {
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

    "wait when only one mirror answers" in {
      val beacon =
        new DrandBeacon(settings, uri => Future.successful(Option.when(uri.getHost == "a")(body(round, value))))
      beacon.randomness(round).futureValue shouldBe None
    }
  }
}
