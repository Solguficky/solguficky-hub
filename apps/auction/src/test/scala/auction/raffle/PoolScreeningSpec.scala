package auction.raffle

import auction.lot.ParticipantId
import org.scalatest.concurrent.ScalaFutures
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

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

    "keeps the answer of Identity for each candidate and retries a failed question within the window" in {
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

    "does not ask Identity at all once the window is over" in {
      val calls = new AtomicInteger(0)
      val access: RaffleAccess = _ => { calls.incrementAndGet(); Future.successful(false) }
      val answers = PoolScreening.screen(Vector(person(1)), access, now, clock, 3.seconds, noPause)
      answers.futureValue shouldBe Map(person(1) -> None)
      calls.get shouldBe 0
    }

    "gives up on a silent Identity at the end of the window and leaves the candidate unanswered" in {
      val access: RaffleAccess = _ => Future.failed(new RuntimeException("down"))
      val answers = PoolScreening.screen(Vector(person(1)), access, now.plusSeconds(2), clock, 3.seconds, noPause)
      answers.futureValue shouldBe Map(person(1) -> None)
      Raffle.excluded(answers.futureValue) shouldBe empty
    }
  }
}
