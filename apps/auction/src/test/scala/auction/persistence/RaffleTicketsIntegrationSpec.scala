package auction.persistence

import auction.lot.AuctionId
import auction.lot.ParticipantId
import auction.naming.DisplayNameCommands
import auction.naming.NameChoice
import auction.testkit.PostgresFixture
import org.apache.pekko.actor.testkit.typed.scaladsl.ActorTestKit
import org.scalatest.concurrent.ScalaFutures
import org.scalatest.matchers.should.Matchers
import org.scalatest.time.Seconds
import org.scalatest.time.Span
import org.scalatest.wordspec.AnyWordSpec

import java.time.Instant
import java.util.UUID
import scala.concurrent.ExecutionContext

/**
 * Снимок «номер — имя» розыгрыша (ADR-066, п. 12) на настоящей базе: имя берётся рендером хронологии, повтор записи
 * снимок не перезаписывает, а стирание по сроку оставляет номер и убирает только имя.
 */
final class RaffleTicketsIntegrationSpec extends AnyWordSpec with Matchers with ScalaFutures with PostgresFixture {

  implicit override val patienceConfig: PatienceConfig = PatienceConfig(timeout = Span(20, Seconds))

  private given ExecutionContext = ExecutionContext.global

  private def withTickets[A](use: (DisplayNameCommands, SlickRaffleTickets) => A): A = {
    val database = freshDatabase()
    JournalSchema.migrate(database)
    val kit = ActorTestKit(s"auction-${UUID.randomUUID()}", nodeConfig(database))
    try {
      val names = DisplayNameCommands(SlickDisplayNameStore(kit.system))(using kit.system.executionContext)
      use(names, SlickRaffleTickets(kit.system, names))
    } finally kit.shutdownTestKit()
  }

  private def alias(raw: String) = NameChoice.Pseudonym(raw)

  "raffle tickets" should {

    "records the names of the pool as the history shows them and keeps the first snapshot on a repeat" in {
      withTickets { (names, tickets) =>
        val auction = AuctionId(UUID.randomUUID())
        val first = ParticipantId(UUID.randomUUID())
        val second = ParticipantId(UUID.randomUUID())
        names.choose(auction, first, alias("Ёжик")).futureValue.isRight shouldBe true
        names.choose(auction, second, alias("Lynx")).futureValue.isRight shouldBe true

        tickets.record(auction, Vector(first, second)).futureValue
        tickets.names(auction).futureValue shouldBe Map(1 -> "Ёжик*", 2 -> "Lynx*")

        names.choose(auction, first, alias("Barsuk")).futureValue.isRight shouldBe true
        tickets.record(auction, Vector(first, second)).futureValue
        tickets.names(auction).futureValue shouldBe Map(1 -> "Ёжик*", 2 -> "Lynx*")
      }
    }

    "erases names after their retention and leaves the names of a raffle not yet due" in {
      withTickets { (names, tickets) =>
        val due = AuctionId(UUID.randomUUID())
        val later = AuctionId(UUID.randomUUID())
        val person = ParticipantId(UUID.randomUUID())
        for (auction <- List(due, later)) {
          names.choose(auction, person, alias("Lynx")).futureValue.isRight shouldBe true
          tickets.record(auction, Vector(person)).futureValue
        }
        val now = Instant.parse("2026-11-28T18:00:00Z")
        tickets.expireAt(due, now.minusSeconds(1)).futureValue
        tickets.expireAt(due, now.plusSeconds(3600)).futureValue
        tickets.expireAt(later, now.plusSeconds(3600)).futureValue

        tickets.eraseExpired(now).futureValue shouldBe 1
        tickets.names(due).futureValue shouldBe empty
        tickets.names(later).futureValue shouldBe Map(1 -> "Lynx*")
        tickets.record(due, Vector(person)).futureValue
        tickets.names(due).futureValue shouldBe empty
      }
    }
  }
}
