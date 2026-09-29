package auction.entity

import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

import java.time.Clock
import java.time.Instant
import java.time.ZoneOffset
import java.util.SplittableRandom

final class UuidV7Spec extends AnyWordSpec with Matchers {

  private def at(instant: String): Clock = Clock.fixed(Instant.parse(instant), ZoneOffset.UTC)

  "uuid v7 generator" should {

    "mark every identifier as version 7 of the RFC 9562 variant" in {
      val next = UuidV7.generator(at("2026-10-01T09:00:00Z"), new SplittableRandom(1))

      List.fill(100)(next()).map(id => (id.version, id.variant)).distinct shouldBe List((7, 2))
    }

    "carry the milliseconds of its clock in the leading 48 bits" in {
      val instant = Instant.parse("2026-10-01T09:00:00.123Z")

      val id = UuidV7.generator(at(instant.toString), new SplittableRandom(1))()

      id.getMostSignificantBits >>> 16 shouldBe instant.toEpochMilli
    }

    "order identifiers born in later milliseconds after earlier ones" in {
      val earlier = UuidV7.generator(at("2026-10-01T09:00:00.001Z"), new SplittableRandom(1))()
      val later = UuidV7.generator(at("2026-10-01T09:00:00.002Z"), new SplittableRandom(2))()

      earlier.toString should be < later.toString
    }

    "give distinct identifiers within one millisecond" in {
      val next = UuidV7.generator(at("2026-10-01T09:00:00Z"), new SplittableRandom(1))

      List.fill(1000)(next()).distinct should have size 1000
    }
  }
}
