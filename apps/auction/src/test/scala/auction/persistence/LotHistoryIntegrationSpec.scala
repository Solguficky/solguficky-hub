package auction.persistence

import auction.testkit.PostgresFixture
import org.apache.pekko.actor.testkit.typed.scaladsl.ActorTestKit
import org.scalatest.concurrent.ScalaFutures
import org.scalatest.matchers.should.Matchers
import org.scalatest.time.Seconds
import org.scalatest.time.Span
import org.scalatest.wordspec.AnyWordSpec

import java.util.UUID

final class LotHistoryIntegrationSpec extends AnyWordSpec with Matchers with ScalaFutures with PostgresFixture {

  implicit override val patienceConfig: PatienceConfig = PatienceConfig(timeout = Span(20, Seconds))

  private val auctionId = UUID.fromString("01926f3c-8b7a-7cde-8f00-00000000aaaa")

  /** Узел и чтение read model поверх его пула; узел останавливается после теста. */
  private def withViews[A](database: DatabaseSettings)(use: SlickLotViews => A): A = {
    val kit = ActorTestKit(s"auction-${UUID.randomUUID()}", nodeConfig(database))
    try use(SlickLotViews(kit.system))
    finally kit.shutdownTestKit()
  }

  /**
   * Строки мимо проекции: чтение `state` не разбирает, поэтому снимок пустой. Время ставок идёт назад по журналу —
   * порядок, который чтение обязано не взять.
   */
  private def seeded(sequences: Seq[Long]): (DatabaseSettings, UUID) = {
    val database = freshDatabase()
    JournalSchema.migrate(database)
    val lotId = UUID.randomUUID()
    withConnection(database) { connection =>
      val statement = connection.createStatement()
      statement.executeUpdate(
        s"INSERT INTO lot_view (lot_id, auction_id, version, state) VALUES ('$lotId', '$auctionId', 20, '{}')"
      )
      sequences.foreach { sequence =>
        statement.executeUpdate(
          s"""INSERT INTO lot_bid (lot_id, sequence, bid_id, participant_id, minor_units, currency, origin, source,
                                   occurred_at)
              VALUES ('$lotId', $sequence, '${UUID.randomUUID()}', '${UUID.randomUUID()}', ${100 + sequence}, 'RUB',
                      'Manual', 'Bot', TIMESTAMPTZ '2026-10-04 12:00:00+00' - INTERVAL '$sequence seconds')"""
        )
      }
    }
    (database, lotId)
  }

  "lot history" should {

    "reads the bids of a lot by journal position, not by the time they carry, and continues after a position" in {
      val (database, lotId) = seeded(Seq(9L, 3L, 12L, 4L, 7L))
      withViews(database) { views =>
        views.history(lotId, None, 3).futureValue.map(_.map(_.sequence)) shouldBe Some(List(3L, 4L, 7L))
        views.history(lotId, Some(7L), 3).futureValue.map(_.map(_.sequence)) shouldBe Some(List(9L, 12L))
      }
    }

    "answers an empty history for a known lot without bids and none for a lot it does not know" in {
      val (database, lotId) = seeded(Nil)
      withViews(database) { views =>
        views.history(lotId, None, 10).futureValue shouldBe Some(Nil)
        views.history(UUID.randomUUID(), None, 10).futureValue shouldBe None
      }
    }
  }
}
