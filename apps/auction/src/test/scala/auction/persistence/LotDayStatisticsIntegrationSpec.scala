package auction.persistence

import auction.lot.CurrencyCode
import auction.lot.Money
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
 * Статистика лота за окно (PER-492). Строки кладутся мимо проекции: чтение `state` не разбирает, а окно считает
 * `occurred_at`, поэтому проверяется сам срез, а не то, что в него попало от проекции.
 */
final class LotDayStatisticsIntegrationSpec extends AnyWordSpec with Matchers with ScalaFutures with PostgresFixture {

  implicit override val patienceConfig: PatienceConfig = PatienceConfig(timeout = Span(20, Seconds))

  private val auctionId = UUID.fromString("01926f3c-8b7a-7cde-8f00-00000000aaaa")
  private val before = Instant.parse("2026-10-17T21:00:00Z")
  private val windowFrom = Instant.parse("2026-10-18T00:00:00Z")
  private val windowUntil = Instant.parse("2026-10-19T00:00:00Z")
  private val pastWindow = Instant.parse("2026-10-19T03:00:00Z")

  /**
   * Лот реестра с одной строкой снимка: `LotViews.dayStatistics` читает реестр, а не все рождённые лоты. Строка
   * аукциона вставляется первой и повтор не переписывает её: реестр ссылается на неё внешним ключом, а состояние строки
   * чтение реестра не разбирает.
   */
  private def lot(connection: java.sql.Connection, registered: Boolean): UUID = {
    val lotId = UUID.randomUUID()
    connection
      .createStatement()
      .executeUpdate(
        s"""INSERT INTO auction_view (auction_id, meetup_id, version, status, state)
            VALUES ('$auctionId', '${UUID.randomUUID()}', 20, 'prebidding', '{}')
            ON CONFLICT (auction_id) DO NOTHING"""
      )
    connection
      .createStatement()
      .executeUpdate(
        s"INSERT INTO lot_view (lot_id, auction_id, version, state) VALUES ('$lotId', '$auctionId', 20, '{}')"
      )
    if (registered) {
      connection
        .createStatement()
        .executeUpdate(s"INSERT INTO auction_lot (auction_id, lot_id) VALUES ('$auctionId', '$lotId')")
    }
    lotId
  }

  /** Ставка лота: сумма в минорных единицах и момент. Номер события — порядок вставки. */
  private def bid(
      connection: java.sql.Connection,
      lotId: UUID,
      minorUnits: Long,
      at: Instant,
      by: UUID = UUID.randomUUID(),
      windowStart: Option[Long] = None
  ): Unit = {
    connection
      .createStatement()
      .executeUpdate(
        s"""INSERT INTO lot_bid (lot_id, sequence, bid_id, participant_id, minor_units, currency, origin, source,
                                 occurred_at, window_start_minor_units)
            SELECT '$lotId', COALESCE(MAX(sequence), 0) + 1, '${UUID.randomUUID()}', '$by',
                   $minorUnits, 'RUB', 'Manual', 'Bot', '${at.toString}'::timestamptz,
                   ${windowStart.fold("NULL")(_.toString)}
            FROM lot_bid WHERE lot_id = '$lotId'"""
      )
    ()
  }

  private def startingPrice(connection: java.sql.Connection, lotId: UUID, minorUnits: Long): Unit = {
    connection
      .createStatement()
      .executeUpdate(
        s"INSERT INTO lot_starting_price (lot_id, minor_units, currency) VALUES ('$lotId', $minorUnits, 'RUB')"
      )
    ()
  }

  private def withViews[A](database: DatabaseSettings)(use: SlickLotViews => A): A = {
    val kit = ActorTestKit(s"auction-${UUID.randomUUID()}", nodeConfig(database))
    try use(SlickLotViews(kit.system))
    finally kit.shutdownTestKit()
  }

  "lot day statistics" should {

    "counts a bid at the window start and not a bid at its end" in {
      val database = freshDatabase()
      JournalSchema.migrate(database)
      val (counted, edged) = withConnection(database) { connection =>
        val first = lot(connection, registered = true)
        bid(connection, first, 100, windowFrom)
        val second = lot(connection, registered = true)
        bid(connection, second, 700, windowFrom.minusSeconds(1))
        bid(connection, second, 500, windowUntil)
        (first, second)
      }
      withViews(database) { views =>
        val byLot = views
          .dayStatistics(auctionId, windowFrom, windowUntil)
          .futureValue
          .map(each => each.lotId -> each)
          .toMap
        byLot(counted).bidCount shouldBe 1
        byLot(counted).maxPrice shouldBe Some(Money(100, CurrencyCode("RUB")))
        byLot(edged).bidCount shouldBe 0
        byLot(edged).maxPrice shouldBe None
        // Цена к открытию окна — ставка до него, а не та, что легла ровно на конец.
        byLot(edged).priceBefore shouldBe Some(Money(700, CurrencyCode("RUB")))
      }
    }

    "takes the window maximum and the growth from the price the lot had when it opened" in {
      val database = freshDatabase()
      JournalSchema.migrate(database)
      val lotId = withConnection(database) { connection =>
        val id = lot(connection, registered = true)
        startingPrice(connection, id, 100)
        bid(connection, id, 300, before)
        bid(connection, id, 900, windowFrom.plusSeconds(60))
        bid(connection, id, 1_500, windowFrom.plusSeconds(120))
        bid(connection, id, 700, pastWindow)
        id
      }
      withViews(database) { views =>
        val single = views.dayStatistics(auctionId, windowFrom, windowUntil).futureValue
        single.map(_.lotId) shouldBe List(lotId)
        single.head.bidCount shouldBe 2
        single.head.maxPrice shouldBe Some(Money(1_500, CurrencyCode("RUB")))
        single.head.priceBefore shouldBe Some(Money(300, CurrencyCode("RUB")))
        single.head.growth shouldBe Some(Money(1_200, CurrencyCode("RUB")))
      }
    }

    // PER-658: снятая ставка не считается, а снятие до окна — цена, с которой лот вошёл в окно.
    "leaves the bids of a removed participant out and opens the window at the price a removal left" in {
      val database = freshDatabase()
      JournalSchema.migrate(database)
      val lotId = withConnection(database) { connection =>
        val id = lot(connection, registered = true)
        startingPrice(connection, id, 100)
        bid(connection, id, 300, before)
        bid(connection, id, 800, before.plusSeconds(60))
        connection
          .createStatement()
          .executeUpdate(
            s"""INSERT INTO lot_removal (lot_id, sequence, minor_units, currency, leader_id, occurred_at)
                VALUES ('$id', 3, 300, 'RUB', NULL, '${before.plusSeconds(120)}'::timestamptz)"""
          )
        bid(connection, id, 400, windowFrom.plusSeconds(60))
        bid(connection, id, 2_000, windowFrom.plusSeconds(120))
        connection
          .createStatement()
          .executeUpdate(s"UPDATE lot_bid SET removed = true WHERE lot_id = '$id' AND minor_units IN (800, 2000)")
        id
      }
      withViews(database) { views =>
        val single = views.dayStatistics(auctionId, windowFrom, windowUntil).futureValue
        single.map(each => (each.lotId, each.bidCount, each.maxPrice, each.priceBefore)) shouldBe List(
          (lotId, 1L, Some(Money(400, CurrencyCode("RUB"))), Some(Money(300, CurrencyCode("RUB"))))
        )
      }
    }

    "falls back to the starting price when the window is the lot's first trading" in {
      val database = freshDatabase()
      JournalSchema.migrate(database)
      val lotId = withConnection(database) { connection =>
        val id = lot(connection, registered = true)
        startingPrice(connection, id, 500)
        bid(connection, id, 500, windowFrom.plusSeconds(1))
        id
      }
      withViews(database) { views =>
        val single = views.dayStatistics(auctionId, windowFrom, windowUntil).futureValue.head
        single.priceBefore shouldBe Some(Money(500, CurrencyCode("RUB")))
        single.growth shouldBe Some(Money(0, CurrencyCode("RUB")))
      }
    }

    // PER-810: первая ставка легла по стартовой окна ниже обычной — окно открылось по ней, и рост от неё, а не
    // отрицательный от обычной стартовой.
    "opens the window at the starting price of the window the first bid took" in {
      val database = freshDatabase()
      JournalSchema.migrate(database)
      val lotId = withConnection(database) { connection =>
        val id = lot(connection, registered = true)
        startingPrice(connection, id, 300)
        bid(connection, id, 150, windowFrom.plusSeconds(1), windowStart = Some(150))
        bid(connection, id, 155, windowFrom.plusSeconds(2), windowStart = Some(150))
        id
      }
      withViews(database) { views =>
        val single = views.dayStatistics(auctionId, windowFrom, windowUntil).futureValue.head
        single.lotId shouldBe lotId
        single.priceBefore shouldBe Some(Money(150, CurrencyCode("RUB")))
        single.growth shouldBe Some(Money(5, CurrencyCode("RUB")))
      }
    }

    // PER-810: сняли автора первой ставки, а вторая легла уже за окном ниже обычной стартовой — стартовая роста не выше
    // суммы первой оставшейся ставки, и рост не уходит ниже нуля.
    "opens the window no higher than the first bid that remains after a removal" in {
      val database = freshDatabase()
      JournalSchema.migrate(database)
      val removed = UUID.randomUUID()
      val lotId = withConnection(database) { connection =>
        val id = lot(connection, registered = true)
        startingPrice(connection, id, 300)
        bid(connection, id, 150, windowFrom.plusSeconds(1), removed, windowStart = Some(150))
        bid(connection, id, 170, windowFrom.plusSeconds(2))
        connection
          .createStatement()
          .executeUpdate(s"UPDATE lot_bid SET removed = true WHERE lot_id = '$id' AND participant_id = '$removed'")
        id
      }
      withViews(database) { views =>
        val single = views.dayStatistics(auctionId, windowFrom, windowUntil).futureValue.head
        single.lotId shouldBe lotId
        single.priceBefore shouldBe Some(Money(170, CurrencyCode("RUB")))
        single.growth shouldBe Some(Money(0, CurrencyCode("RUB")))
      }
    }

    // PER-511: смены лидера и дуэль окна; лидер к открытию окна — автор последней ставки до него.
    "counts the leader changes and the longest duel inside the window from the chronology of the lot" in {
      val database = freshDatabase()
      JournalSchema.migrate(database)
      val (a, b, c) = (UUID.randomUUID(), UUID.randomUUID(), UUID.randomUUID())
      val lotId = withConnection(database) { connection =>
        val id = lot(connection, registered = true)
        bid(connection, id, 100, before, a)
        bid(connection, id, 200, before.plusSeconds(60), b)
        bid(connection, id, 300, windowFrom.plusSeconds(60), a)
        bid(connection, id, 400, windowFrom.plusSeconds(120), b)
        bid(connection, id, 500, windowFrom.plusSeconds(180), a)
        bid(connection, id, 600, windowFrom.plusSeconds(240), c)
        bid(connection, id, 700, pastWindow, a)
        id
      }
      withViews(database) { views =>
        val single = views.dayStatistics(auctionId, windowFrom, windowUntil).futureValue
        single.map(each => (each.lotId, each.contest)) shouldBe List(
          (lotId, auction.projection.LotContest(leaderChanges = 4, longestDuel = 3))
        )
      }
    }

    "answers every lot of the registry, and none outside it" in {
      val database = freshDatabase()
      JournalSchema.migrate(database)
      val (quiet, born) = withConnection(database) { connection =>
        (lot(connection, registered = true), lot(connection, registered = false))
      }
      withViews(database) { views =>
        val lots = views.dayStatistics(auctionId, windowFrom, windowUntil).futureValue
        // Лот без ставок приходит нулём, а не пропускается: «ставок не было» читается по всему реестру.
        lots.map(_.lotId) shouldBe List(quiet)
        lots.head.bidCount shouldBe 0
        lots.head.maxPrice shouldBe None
        lots.head.growth shouldBe None
        lots.map(_.lotId) should not contain born
      }
    }

    // PER-769: хроники всего аукциона — то же чтение без окна суток; ставки разных дней складываются в итог.
    "sums the bids of separate days into the statistics of the whole trading" in {
      val database = freshDatabase()
      JournalSchema.migrate(database)
      val lotId = withConnection(database) { connection =>
        val id = lot(connection, registered = true)
        startingPrice(connection, id, 100)
        bid(connection, id, 300, before)
        bid(connection, id, 900, windowFrom.plusSeconds(60))
        bid(connection, id, 1_500, windowFrom.plusSeconds(120))
        bid(connection, id, 1_700, pastWindow)
        id
      }
      val now = pastWindow.plusSeconds(3600)
      withViews(database) { views =>
        val days = List(before.minusSeconds(3 * 3600) -> windowFrom, windowFrom -> windowUntil, windowUntil -> now)
          .map((from, until) => views.dayStatistics(auctionId, from, until).futureValue.head)
        val whole = views.dayStatistics(auctionId, Instant.EPOCH, now).futureValue.head
        whole.lotId shouldBe lotId
        whole.bidCount shouldBe days.map(_.bidCount).sum
        whole.bidCount shouldBe 4
        whole.maxPrice shouldBe Some(Money(1_700, CurrencyCode("RUB")))
        // Цена к открытию «окна от начала времён» — стартовая, поэтому рост — от старта.
        whole.growth shouldBe Some(Money(1_600, CurrencyCode("RUB")))
      }
    }

    "counts every participant of the registry once and leaves a removed one out" in {
      val database = freshDatabase()
      JournalSchema.migrate(database)
      val (a, b, removed) = (UUID.randomUUID(), UUID.randomUUID(), UUID.randomUUID())
      withConnection(database) { connection =>
        def participant(lotId: UUID, person: UUID, gone: Boolean = false): Unit = {
          connection
            .createStatement()
            .executeUpdate(
              s"""INSERT INTO lot_participant (lot_id, participant_id, removed)
                  VALUES ('$lotId', '$person', $gone)"""
            )
          ()
        }
        val (first, second, outside) =
          (lot(connection, registered = true), lot(connection, registered = true), lot(connection, registered = false))
        participant(first, a)
        participant(second, a)
        participant(second, b)
        participant(first, removed, gone = true)
        participant(outside, UUID.randomUUID())
      }
      withViews(database)(_.participantCount(auctionId).futureValue shouldBe 2)
    }
  }
}
