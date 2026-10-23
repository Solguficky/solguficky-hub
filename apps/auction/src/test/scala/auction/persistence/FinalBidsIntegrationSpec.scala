package auction.persistence

import auction.lot.AuctionId
import auction.lot.ParticipantId
import auction.testkit.PostgresFixture
import org.apache.pekko.actor.testkit.typed.scaladsl.ActorTestKit
import org.scalatest.concurrent.ScalaFutures
import org.scalatest.matchers.should.Matchers
import org.scalatest.time.Seconds
import org.scalatest.time.Span
import org.scalatest.wordspec.AnyWordSpec

import java.time.Instant
import java.util.UUID

/**
 * Ставки финала аукциона по участникам (PER-653). Строки кладутся мимо проекции: чтение берёт момент ставки и границу
 * `LotResumed` из read model, поэтому проверяется сам срез, а не то, что в него положила проекция.
 */
final class FinalBidsIntegrationSpec extends AnyWordSpec with Matchers with ScalaFutures with PostgresFixture {

  implicit override val patienceConfig: PatienceConfig = PatienceConfig(timeout = Span(20, Seconds))

  private val auctionId = AuctionId(UUID.fromString("01926f3c-8b7a-7cde-8f00-00000000bbbb"))
  private val otherAuctionId = AuctionId(UUID.fromString("01926f3c-8b7a-7cde-8f00-00000000cccc"))

  /** Строка аукциона: на неё ссылается состав финала внешним ключом. */
  private def auction(connection: java.sql.Connection, id: AuctionId): Unit = {
    connection
      .createStatement()
      .executeUpdate(
        s"""INSERT INTO auction_view (auction_id, meetup_id, version, status, state)
            VALUES ('${id.value}', '${UUID.randomUUID()}', 20, 'in_final', '{}')
            ON CONFLICT (auction_id) DO NOTHING"""
      )
    ()
  }

  /** Лот состава: строка состава и номер возврата в торги — граница финала. */
  private def finalLot(connection: java.sql.Connection, auction: AuctionId, resumedAt: Long): UUID = {
    val lotId = UUID.randomUUID()
    connection
      .createStatement()
      .executeUpdate(s"INSERT INTO auction_lineup (auction_id, lot_id) VALUES ('${auction.value}', '$lotId')")
    connection
      .createStatement()
      .executeUpdate(s"INSERT INTO lot_resume (lot_id, sequence) VALUES ('$lotId', $resumedAt)")
    lotId
  }

  /** Ставка лота: участник, номер события и момент. */
  private def bid(
      connection: java.sql.Connection,
      lotId: UUID,
      sequence: Long,
      participant: ParticipantId,
      at: Instant
  ): Unit = {
    connection
      .createStatement()
      .executeUpdate(
        s"""INSERT INTO lot_bid (lot_id, sequence, bid_id, participant_id, minor_units, currency, origin, source,
                                 occurred_at)
            VALUES ('$lotId', $sequence, '${UUID.randomUUID()}', '${participant.value}', 100, 'RUB', 'Manual', 'Bot',
                    '${at.toString}'::timestamptz)"""
      )
    ()
  }

  private def withBids[A](database: DatabaseSettings)(use: SlickFinalBids => A): A = {
    val kit = ActorTestKit(s"auction-${UUID.randomUUID()}", nodeConfig(database))
    try use(SlickFinalBids(kit.system))
    finally kit.shutdownTestKit()
  }

  "final bids" should {

    "takes only bids accepted after the lot returned to the final" in {
      val database = freshDatabase()
      JournalSchema.migrate(database)
      val (before, after) = (ParticipantId(UUID.randomUUID()), ParticipantId(UUID.randomUUID()))
      val first = Instant.parse("2026-10-18T18:00:00Z")
      val second = Instant.parse("2026-10-18T18:05:00Z")
      withConnection(database) { connection =>
        auction(connection, auctionId)
        val lot = finalLot(connection, auctionId, resumedAt = 2)
        bid(connection, lot, 2, before, first)
        bid(connection, lot, 3, after, second)
      }
      withBids(database)(bids => bids.lastBids(auctionId).futureValue) shouldBe Map(after -> second)
    }

    "keeps the moment of the last final bid of each participant across the lineup" in {
      val database = freshDatabase()
      JournalSchema.migrate(database)
      val (first, second, third) =
        (ParticipantId(UUID.randomUUID()), ParticipantId(UUID.randomUUID()), ParticipantId(UUID.randomUUID()))
      val one = Instant.parse("2026-10-18T19:00:00Z")
      val two = Instant.parse("2026-10-18T19:10:00Z")
      val three = Instant.parse("2026-10-18T19:20:00Z")
      withConnection(database) { connection =>
        auction(connection, auctionId)
        val opener = finalLot(connection, auctionId, resumedAt = 1)
        val closer = finalLot(connection, auctionId, resumedAt = 5)
        bid(connection, opener, 2, first, one)
        bid(connection, opener, 3, second, two)
        bid(connection, closer, 6, first, three)
      }
      withBids(database)(bids => bids.lastBids(auctionId).futureValue) shouldBe
        Map(first -> three, second -> two)
    }

    "answers nothing for an auction without a lineup and keeps another auction out" in {
      val database = freshDatabase()
      JournalSchema.migrate(database)
      val stranger = ParticipantId(UUID.randomUUID())
      withConnection(database) { connection =>
        auction(connection, otherAuctionId)
        val lot = finalLot(connection, otherAuctionId, resumedAt = 1)
        bid(connection, lot, 2, stranger, Instant.parse("2026-10-18T20:00:00Z"))
      }
      withBids(database)(bids => bids.lastBids(auctionId).futureValue) shouldBe empty
    }
  }
}
