package auction.screen

import auction.catalog.LotId
import auction.lot.AuctionId
import auction.lot.ParticipantId
import auction.prediction.Nomination
import auction.results.NominationOutcome
import auction.results.NominationValue
import auction.results.ResultRow
import auction.results.ResultsGateway
import auction.results.ResultsView
import auction.results.SettleRefused
import org.apache.pekko.Done
import org.scalatest.concurrent.ScalaFutures
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

import java.util.UUID
import scala.concurrent.ExecutionContext
import scala.concurrent.Future

final class ScreenPredictionsSpec extends AnyWordSpec with Matchers with ScalaFutures {

  private given ExecutionContext = ExecutionContext.parasitic

  private val auction = UUID.fromString("01890a5d-ac97-7c2b-9f3a-0d1b2c3d4e00")
  private val lot = LotId(UUID.fromString("01890a5d-ac97-7c2b-9f3a-0d1b2c3d4e01"))
  private def person(n: Int) = ParticipantId(UUID.fromString(f"01890a5d-ac97-7c2b-9f3a-0d1b2c3d4f$n%02d"))

  private def gateway(answer: => Future[ResultsView]): ResultsGateway =
    new ResultsGateway {
      def settle(auction: AuctionId): Future[Either[SettleRefused, Done]] =
        Future.failed(UnsupportedOperationException())
      def recordManually(auction: AuctionId): Future[Done] = Future.failed(UnsupportedOperationException())
      def read(auction: AuctionId): Future[ResultsView] = answer
    }

  "the prediction results of the hall screen" should {

    "name who guessed each played nomination and leave out a nomination without sales" in {
      val counted = ResultsView.Counted(
        List(
          NominationOutcome(Nomination.MostExpensiveLot, Some(NominationValue.Lots(Set(lot))), 2),
          NominationOutcome(Nomination.FinalTotalBids, None, 0),
          NominationOutcome(Nomination.TotalSales, Some(NominationValue.Number(4830000)), 0)
        ),
        List(
          ResultRow(person(1), Nomination.MostExpensiveLot, guessed = true, None, "*Сова"),
          ResultRow(person(2), Nomination.MostExpensiveLot, guessed = true, None, "@a"),
          ResultRow(person(3), Nomination.MostExpensiveLot, guessed = false, None, "@b"),
          ResultRow(person(1), Nomination.TotalSales, guessed = false, Some(1000), "*Сова")
        )
      )

      ScreenPredictions.of(gateway(Future.successful(counted))).read(auction).futureValue shouldBe List(
        ScreenNomination(Nomination.MostExpensiveLot, NominationValue.Lots(Set(lot)), 2, List("*Сова", "@a")),
        ScreenNomination(Nomination.TotalSales, NominationValue.Number(4830000), 0, Nil)
      )
    }

    "show no section while the game is not counted, was settled by hand or does not answer" in {
      for (view <- List(ResultsView.Unsettled, ResultsView.ByHand, ResultsView.Cancelled))
        ScreenPredictions.of(gateway(Future.successful(view))).read(auction).futureValue shouldBe Nil
      ScreenPredictions
        .of(gateway(Future.failed(RuntimeException("ask timed out"))))
        .read(auction)
        .futureValue shouldBe Nil
      ScreenPredictions.of(gateway(throw IllegalStateException("not started"))).read(auction).futureValue shouldBe Nil
    }
  }
}
