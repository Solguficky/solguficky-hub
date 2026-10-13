package auction.persistence

import auction.catalog.LotId
import auction.lot.AuctionId
import auction.lot.OpId
import auction.lot.ParticipantId
import auction.prediction.Answer
import auction.prediction.Forecast
import auction.prediction.Nomination
import auction.prediction.PredictionRound
import auction.prediction.SubmitForecast
import auction.prediction.SubmitRejected
import auction.testkit.PostgresFixture
import org.apache.pekko.actor.testkit.typed.scaladsl.ActorTestKit
import org.scalatest.concurrent.ScalaFutures
import org.scalatest.matchers.should.Matchers
import org.scalatest.time.Seconds
import org.scalatest.time.Span
import org.scalatest.wordspec.AnyWordSpec

import java.util.UUID

/**
 * Прогнозы на настоящей базе (ADR-067, пп. 5, 9, 10): прогноз раунда заменяется целиком, повтор `op_id` получает
 * текущий прогноз, чужой — отказ, чтение отдаёт только свои строки, удаление аукциона и стирание субъекта убирают
 * строки и окно отправок.
 */
final class PredictionStoreIntegrationSpec extends AnyWordSpec with Matchers with ScalaFutures with PostgresFixture {

  implicit override val patienceConfig: PatienceConfig = PatienceConfig(timeout = Span(20, Seconds))

  private def withStore[A](use: SlickPredictionStore => A): A = {
    val database = freshDatabase()
    JournalSchema.migrate(database)
    val kit = ActorTestKit(s"auction-${UUID.randomUUID()}", nodeConfig(database))
    try use(SlickPredictionStore(kit.system))
    finally kit.shutdownTestKit()
  }

  private def forecast(round: PredictionRound, answers: (Nomination, Answer)*): Forecast =
    Forecast.parse(round, answers.toList).toOption.get

  private def op() = OpId(UUID.randomUUID())

  "prediction store" should {

    "replaces the prediction of a round, answers a repeat with what it sent and refuses another's op_id" in {
      withStore { store =>
        val auction = AuctionId(UUID.randomUUID())
        val person = ParticipantId(UUID.randomUUID())
        val lot = LotId(UUID.randomUUID())
        val first = forecast(PredictionRound.Catalog, Nomination.MostExpensiveLot -> Answer.Lot(lot))
        val second = forecast(PredictionRound.Catalog, Nomination.TotalSales -> Answer.Number(30000))
        val sent = op()

        store.submit(auction, SubmitForecast(person, first, sent)).futureValue shouldBe Right(first)
        store.submit(auction, SubmitForecast(person, second, op())).futureValue shouldBe Right(second)
        store.submit(auction, SubmitForecast(person, second, sent)).futureValue shouldBe Right(first)
        store.recall(auction, person, PredictionRound.Catalog, sent).futureValue shouldBe Some(Right(first))
        store.recall(auction, person, PredictionRound.Catalog, op()).futureValue shouldBe None

        val stranger = ParticipantId(UUID.randomUUID())
        store.submit(auction, SubmitForecast(stranger, first, sent)).futureValue shouldBe
          Left(SubmitRejected.OpIdTaken)
        store.mine(auction, person).futureValue shouldBe Map(PredictionRound.Catalog -> second)
      }
    }

    "clears a prediction with an empty one and reads back only the viewer's own rows" in {
      withStore { store =>
        val auction = AuctionId(UUID.randomUUID())
        val person = ParticipantId(UUID.randomUUID())
        val neighbour = ParticipantId(UUID.randomUUID())
        val guess = forecast(PredictionRound.Final, Nomination.FinalTotalBids -> Answer.Number(40))
        store.submit(auction, SubmitForecast(person, guess, op())).futureValue
        store.submit(auction, SubmitForecast(neighbour, guess, op())).futureValue
        store.submit(auction, SubmitForecast(person, Forecast.empty(PredictionRound.Final), op())).futureValue

        store.mine(auction, person).futureValue shouldBe empty
        store.mine(auction, neighbour).futureValue shouldBe Map(PredictionRound.Final -> guess)
      }
    }

    "erases a subject's predictions and sent op_ids in every auction and leaves everyone else's" in {
      withStore { store =>
        val auctions = List(AuctionId(UUID.randomUUID()), AuctionId(UUID.randomUUID()))
        val subject = ParticipantId(UUID.randomUUID())
        val neighbour = ParticipantId(UUID.randomUUID())
        val guess = forecast(PredictionRound.Catalog, Nomination.TotalBids -> Answer.Number(120))
        val sent = op()
        for (auction <- auctions) {
          store
            .submit(auction, SubmitForecast(subject, guess, if (auction == auctions.head) sent else op()))
            .futureValue
          store.submit(auction, SubmitForecast(neighbour, guess, op())).futureValue
        }

        store.erase(subject).futureValue

        auctions.foreach(auction => store.mine(auction, subject).futureValue shouldBe empty)
        auctions.foreach(auction =>
          store.mine(auction, neighbour).futureValue shouldBe Map(PredictionRound.Catalog -> guess)
        )
        store.recall(auctions.head, subject, PredictionRound.Catalog, sent).futureValue shouldBe None
      }
    }

    "discards every prediction of an auction and keeps other auctions" in {
      withStore { store =>
        val discarded = AuctionId(UUID.randomUUID())
        val kept = AuctionId(UUID.randomUUID())
        val person = ParticipantId(UUID.randomUUID())
        val guess = forecast(PredictionRound.Catalog, Nomination.TotalBids -> Answer.Number(1))
        store.submit(discarded, SubmitForecast(person, guess, op())).futureValue
        store.submit(kept, SubmitForecast(person, guess, op())).futureValue

        store.discard(discarded).futureValue

        store.mine(discarded, person).futureValue shouldBe empty
        store.mine(kept, person).futureValue shouldBe Map(PredictionRound.Catalog -> guess)
      }
    }
  }
}
