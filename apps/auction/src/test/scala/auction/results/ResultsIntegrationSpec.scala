package auction.results

import auction.AuctionNode
import auction.entity.UuidV7
import auction.lot.AuctionId
import auction.lot.ParticipantId
import auction.persistence.DatabaseSettings
import auction.persistence.JournalSchema
import auction.persistence.SlickResultsStore
import auction.prediction.Answer
import auction.prediction.Forecast
import auction.prediction.Nomination
import auction.prediction.PredictionRound
import auction.publication.PublicationSettings
import auction.telemetry.ProjectionMetrics
import auction.telemetry.PublicationMetrics
import auction.testkit.PostgresFixture
import auction.v1.auction as model
import auction.v1.auction_events as bus
import io.opentelemetry.sdk.metrics.SdkMeterProvider
import io.opentelemetry.sdk.testing.exporter.InMemoryMetricReader
import org.apache.pekko.Done
import org.apache.pekko.actor.testkit.typed.scaladsl.ActorTestKit
import org.apache.pekko.cluster.sharding.typed.scaladsl.ClusterSharding
import org.apache.pekko.util.Timeout
import org.scalatest.concurrent.Eventually
import org.scalatest.concurrent.ScalaFutures
import org.scalatest.matchers.should.Matchers
import org.scalatest.time.Millis
import org.scalatest.time.Seconds
import org.scalatest.time.Span
import org.scalatest.wordspec.AnyWordSpec

import java.time.Clock
import java.util.UUID
import scala.concurrent.Future
import scala.concurrent.duration.*
import scala.util.Using

/**
 * Публикация итогов прогнозов на настоящем PostgreSQL (PER-490): узел собран так же, как в `Main`, подсчёт идёт
 * настоящей entity и строками `auction_result`, а факт читается из `lot_outbox` — релей без адреса шины не стартует, и
 * строка остаётся. Снимок исходов лотов, прогнозы и имена — подмены портов: их источники (read model торгов и строки
 * прогнозов) проверяются своими сьютами.
 */
final class ResultsIntegrationSpec
    extends AnyWordSpec
    with Matchers
    with PostgresFixture
    with ScalaFutures
    with Eventually {

  implicit override val patienceConfig: PatienceConfig =
    PatienceConfig(timeout = Span(30, Seconds), interval = Span(100, Millis))

  private given Timeout = Timeout(20.seconds)

  private val lotA = auction.catalog.LotId(UUID.fromString("0190f2a0-0000-7000-8000-000000000011"))

  private val sold =
    LotOutcome(
      lotA,
      Some(5000),
      Some(1000),
      bids = 3,
      participants = 2,
      Some(4000),
      None,
      None,
      inLineup = false,
      terminal = true
    )

  private def person(n: Int): ParticipantId =
    ParticipantId(new UUID(0x0190f2a000007000L, 0x8000000000000000L | n.toLong))

  private val forecast =
    Forecast.parse(PredictionRound.Catalog, List(Nomination.MostExpensiveLot -> Answer.Lot(lotA))).toOption.get

  private final class Outcomes(snapshot: Option[List[LotOutcome]]) extends ResultsOutcomes {
    def outcomes(auction: AuctionId): Future[Option[List[LotOutcome]]] = Future.successful(snapshot)
  }

  private val forecasts: ResultsForecasts = new ResultsForecasts {
    def forecasts(auction: AuctionId): Future[Map[PredictionRound, Map[ParticipantId, Forecast]]] =
      Future.successful(Map(PredictionRound.Catalog -> Map(person(1) -> forecast)))
  }

  private val names: ResultNames = new ResultNames {
    def names(auction: AuctionId, participants: Set[ParticipantId]): Future[Map[ParticipantId, String]] =
      Future.successful(
        participants.map(participant => participant -> s"@${participant.value.toString.takeRight(4)}").toMap
      )
  }

  private def withNode[A](database: DatabaseSettings, outcomes: ResultsOutcomes)(use: ClusterSharding => A): A = {
    val kit = ActorTestKit(s"results-${UUID.randomUUID()}", nodeConfig(database))
    try {
      val clock = Clock.systemUTC()
      val sharding = AuctionNode.join(kit.system)
      AuctionNode.registerResults(
        sharding,
        clock,
        UuidV7.generator(clock),
        outcomes,
        forecasts,
        names,
        SlickResultsStore(kit.system),
        askTimeout = 20.seconds
      )
      val meter = SdkMeterProvider.builder().registerMetricReader(InMemoryMetricReader.create()).build().get("t")
      AuctionNode.startPublication(
        kit.system,
        ProjectionMetrics(meter, Clock.systemUTC()),
        PublicationMetrics(meter),
        PublicationSettings(None, interval = 100.millis, batch = 100, ackTimeout = 1.second),
        5.seconds
      )
      use(sharding)
    } finally kit.shutdownTestKit()
  }

  private def migrated(): DatabaseSettings = {
    val database = freshDatabase()
    JournalSchema.migrate(database)
    database
  }

  private def entity(sharding: ClusterSharding, auction: UUID) =
    sharding.entityRefFor(ResultsEntity.TypeKey, auction.toString)

  private def settle(sharding: ClusterSharding, auction: UUID): Either[SettleRefused, Done] =
    entity(sharding, auction).ask[Either[SettleRefused, Done]](ResultsEntity.Settle(_)).futureValue

  private def manual(sharding: ClusterSharding, auction: UUID): Done =
    entity(sharding, auction).ask[Done](ResultsEntity.RecordManually(_)).futureValue

  /** Факты итогов в outbox: тело, разобранное как `auction.v1.PredictionResultsEvent`. */
  private def published(database: DatabaseSettings): List[bus.PredictionResultsEvent] =
    withConnection(database) { connection =>
      Using.resource(
        connection.prepareStatement("SELECT subject, payload FROM lot_outbox ORDER BY position")
      ) { statement =>
        Using.resource(statement.executeQuery()) { rows =>
          Iterator
            .continually(rows)
            .takeWhile(_.next())
            .map(row => row.getString(1) -> row.getBytes(2))
            .toList
            .collect { case ("events.auction.prediction_results_settled", payload) =>
              bus.PredictionResultsEvent.parseFrom(payload)
            }
        }
      }
    }

  "the results publication" should {

    "publish one prediction_results_settled after the count, and no second one after a repeat or a restart" in {
      val database = migrated()
      val auction = UUID.randomUUID()
      withNode(database, Outcomes(Some(List(sold)))) { sharding =>
        settle(sharding, auction) shouldBe Right(Done)
        eventually(published(database) should have size 1)
        settle(sharding, auction) shouldBe Right(Done)
        Thread.sleep(1000)
        published(database) should have size 1
      }
      withNode(database, Outcomes(Some(List(sold)))) { sharding =>
        settle(sharding, auction) shouldBe Right(Done)
        Thread.sleep(1000)
        published(database) should have size 1
      }
      val fact = published(database).head
      fact.predictionResultsId shouldBe auction.toString
      fact.occasion.isPredictionResultsSettled shouldBe true
      val state = fact.state.getOrElse(fail("expected a state"))
      state.manual shouldBe false
      val expensive = state.nominations
        .find(_.nomination == model.PredictionNomination.PREDICTION_NOMINATION_MOST_EXPENSIVE_LOT)
        .getOrElse(fail("expected the most expensive lot nomination"))
      expensive.winners shouldBe 1
      expensive.winnerNames.map(_.name) shouldBe List(s"@${person(1).value.toString.takeRight(4)}")
    }

    "publish nothing while the snapshot of lot outcomes is incomplete" in {
      val database = migrated()
      val auction = UUID.randomUUID()
      withNode(database, Outcomes(None)) { sharding =>
        settle(sharding, auction) shouldBe Left(SettleRefused.NotComplete)
        Thread.sleep(1500)
        published(database) shouldBe empty
      }
    }

    "publish a by-hand marker with manual set and no counted values" in {
      val database = migrated()
      val auction = UUID.randomUUID()
      withNode(database, Outcomes(Some(List(sold)))) { sharding =>
        manual(sharding, auction) shouldBe Done
        eventually(published(database) should have size 1)
      }
      val state = published(database).head.state.getOrElse(fail("expected a state"))
      state.manual shouldBe true
      state.nominations shouldBe empty
      state.participants shouldBe empty
    }
  }
}
