package auction.prediction

import auction.AuctionNode
import auction.aggregate.*
import auction.aggregate.AuctionFixtures.configInput
import auction.catalog.LotId
import auction.entity.AuctionGateway
import auction.entity.AuctionPredictions
import auction.entity.Initiator
import auction.entity.LotEntity
import auction.entity.LotGateway
import auction.entity.UuidV7
import auction.lot.AuctionId
import auction.lot.Envelope
import auction.lot.LotFixtures.participant
import auction.lot.LotFixtures.placeBid
import auction.lot.LotFixtures.scheduleLot
import auction.lot.OpId
import auction.lot.ParticipantId
import auction.lot.PlaceBidRejected
import auction.lot.ScheduleLotRejected
import auction.persistence.DatabaseSettings
import auction.persistence.JournalSchema
import auction.persistence.SlickPredictionStore
import auction.testkit.PostgresFixture
import org.apache.pekko.Done
import org.apache.pekko.actor.testkit.typed.scaladsl.ActorTestKit
import org.apache.pekko.cluster.sharding.typed.scaladsl.ClusterSharding
import org.apache.pekko.util.Timeout
import org.scalatest.concurrent.Eventually
import org.scalatest.concurrent.ScalaFutures
import org.scalatest.matchers.should.Matchers
import org.scalatest.time.Seconds
import org.scalatest.time.Span
import org.scalatest.wordspec.AnyWordSpec

import java.time.Clock
import java.time.Instant
import java.time.temporal.ChronoUnit
import java.util.UUID
import scala.concurrent.ExecutionContext
import scala.concurrent.Future
import scala.concurrent.Promise
import scala.concurrent.duration.*
import scala.util.Using

/**
 * Прогнозы на узле, собранном так же, как в `Main`: настоящие entity аукциона, лотов и прогнозов под шардингом, журнал
 * и строки на PostgreSQL. Рестарт — рестарт `ActorSystem` на той же базе.
 */
final class PredictionsIntegrationSpec
    extends AnyWordSpec
    with Matchers
    with PostgresFixture
    with ScalaFutures
    with Eventually {

  implicit override val patienceConfig: PatienceConfig = PatienceConfig(timeout = Span(30, Seconds))

  private given Timeout = Timeout(20.seconds)

  private val person: ParticipantId = participant(1)

  private val closesAt: Instant = Instant.now().plus(30, ChronoUnit.DAYS).truncatedTo(ChronoUnit.SECONDS)

  private val week: OnlinePhase = OnlinePhase(Instant.now().minusSeconds(3600), Some(closesAt), closesLots = true)

  private object Granted extends MeetupAuthority {
    def check(meetup: MeetupId, person: ParticipantId, correlation: Correlation): Future[Authority] =
      Future.successful(Authority.Granted)
  }

  private final case class Node(
      sharding: ClusterSharding,
      commands: AuctionCommands,
      lots: LotGateway,
      predictions: PredictionGateway,
      store: SlickPredictionStore
  )

  /**
   * Узел на уже размеченной базе. `deaf` — прогнозы, чьё закрытие раунда записывается, а ответ аукциону теряется:
   * рестарт между закрытием раунда и открытием лотов.
   */
  private def onDatabase[A](database: DatabaseSettings, deaf: Boolean = false)(use: Node => A): A = {
    val kit = ActorTestKit(s"auction-predictions-${UUID.randomUUID()}", nodeConfig(database))
    try {
      given ExecutionContext = kit.system.executionContext
      val clock = Clock.systemUTC()
      val sharding = AuctionNode.join(kit.system)
      val store = SlickPredictionStore(kit.system)
      AuctionNode.registerLots(sharding, clock, UuidV7.generator(clock))
      val real = AuctionNode.registerPredictions(sharding, clock, UuidV7.generator(clock), store, 10.seconds)
      val predictions =
        if (!deaf) real
        else
          new AuctionPredictions {
            export real.{cancel, discard, open}
            def close(auctionId: String, round: PredictionRound): Future[Done] =
              real.close(auctionId, round).flatMap(_ => Promise[Done]().future)
          }
      AuctionNode.registerAuctions(
        kit.system,
        sharding,
        clock,
        UuidV7.generator(clock),
        10.seconds,
        predictions = predictions
      )
      val lots = LotGateway.sharded(sharding, 10.seconds)
      val commands = AuctionCommands(AuctionGateway.sharded(sharding, 10.seconds), lots, Granted)
      use(Node(sharding, commands, lots, PredictionGateway.sharded(sharding, store, 10.seconds), store))
    } finally kit.shutdownTestKit()
  }

  private def newOp(): OpId = OpId(UuidV7.generator(Clock.systemUTC())())

  /** Запланированный аукцион сходки с лотом в реестре, у которого есть условия торгов. */
  private def scheduled(node: Node): (AuctionId, LotId) = {
    val auction = node.commands
      .draft(MeetupId(UUID.randomUUID()), newOp(), person)
      .futureValue
      .fold(denial => fail(s"the auction was not drafted: $denial"), _.auctionId)
    val lot = LotId(UUID.randomUUID())
    node.commands.addLot(auction, lot, newOp(), person).futureValue shouldBe Right(())
    node.sharding
      .entityRefFor(LotEntity.TypeKey, lot.value.toString)
      .ask[Either[ScheduleLotRejected, Envelope]](LotEntity.Plan(scheduleLot(opN = 2), Initiator.Operator(person), _))
      .futureValue
      .isRight shouldBe true
    node.commands.schedule(auction, configInput(Some(week)), newOp(), person).futureValue shouldBe Right(())
    (auction, lot)
  }

  private def bid(node: Node, lot: LotId, opN: Int) =
    node.lots.placeBid(lot.value, placeBid(who = 2, amount = 110, opN = opN), Initiator.Participant(participant(2)))

  private val guess =
    Forecast.parse(PredictionRound.Catalog, List(Nomination.TotalBids -> Answer.Number(120))).toOption.get

  private def journalMentions(database: DatabaseSettings, auction: AuctionId, text: String): Int =
    withConnection(database) { connection =>
      Using.resource(
        connection.prepareStatement(
          "SELECT count(*) FROM event_journal WHERE persistence_id = ? AND convert_from(event_payload, 'UTF8') LIKE ?"
        )
      ) { statement =>
        statement.setString(1, s"predictions|${auction.value}")
        statement.setString(2, s"%$text%")
        Using.resource(statement.executeQuery()) { rows =>
          rows.next()
          rows.getInt(1)
        }
      }
    }

  "predictions" should {

    "keep the lots closed while the catalog round is open, also across a restart between its closing and the lots" in {
      val database = freshDatabase()
      JournalSchema.migrate(database)
      val (auction, lot) = onDatabase(database, deaf = true) { node =>
        val (auction, lot) = scheduled(node)
        eventually(node.predictions.mine(auction, person).futureValue.game.catalog shouldBe RoundStatus.Open)
        node.commands.startPrebidding(auction, newOp(), person).futureValue shouldBe Right(())
        eventually(node.predictions.mine(auction, person).futureValue.game.catalog shouldBe RoundStatus.Closed)
        Thread.sleep(500)
        bid(node, lot, opN = 70).futureValue shouldBe Left(PlaceBidRejected.LotNotOpen)
        (auction, lot)
      }
      onDatabase(database) { node =>
        eventually(bid(node, lot, opN = 71).futureValue shouldBe a[Right[?, ?]])
        node.predictions.submit(auction, SubmitForecast(person, guess, newOp())).futureValue shouldBe
          Left(SubmitRejected.RoundClosed)
      }
    }

    "keep a prediction through a restart and do not bring back an erased one, with no participant in the journal" in {
      val database = freshDatabase()
      JournalSchema.migrate(database)
      val sent = newOp()
      val auction = onDatabase(database) { node =>
        val (auction, _) = scheduled(node)
        eventually(node.predictions.mine(auction, person).futureValue.game.catalog shouldBe RoundStatus.Open)
        node.predictions.submit(auction, SubmitForecast(person, guess, sent)).futureValue shouldBe Right(guess)
        auction
      }
      onDatabase(database) { node =>
        node.predictions.mine(auction, person).futureValue.forecasts shouldBe Map(PredictionRound.Catalog -> guess)
        node.store.erase(person).futureValue
      }
      onDatabase(database) { node =>
        node.predictions.mine(auction, person).futureValue.forecasts shouldBe empty
        node.predictions.submit(auction, SubmitForecast(person, guess, sent)).futureValue shouldBe Right(guess)
      }
      journalMentions(database, auction, person.value.toString) shouldBe 0
      journalMentions(database, auction, "RoundOpened") shouldBe 1
    }

    "start a reborn auction with a clean sheet after a discard" in {
      val database = freshDatabase()
      JournalSchema.migrate(database)
      onDatabase(database) { node =>
        val (auction, _) = scheduled(node)
        eventually(node.predictions.mine(auction, person).futureValue.game.catalog shouldBe RoundStatus.Open)
        node.predictions.submit(auction, SubmitForecast(person, guess, newOp())).futureValue shouldBe Right(guess)
        node.commands.discard(auction, newOp(), person).futureValue shouldBe Right(())
        node.predictions.mine(auction, person).futureValue shouldBe MyPredictions(Predictions.initial, Map.empty)
      }
    }
  }
}
