package auction.results

import auction.catalog.LotId
import auction.lot.ParticipantId
import auction.prediction.Answer
import auction.prediction.Forecast
import auction.prediction.Nomination
import auction.prediction.PredictionRound
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

import java.util.UUID

/**
 * Ядро итогов на десяти примерах равенства таблицы ADR-067 (п. 7): ответ «лот» — двоичный, ответ «число» — минимальное
 * `|прогноз − итог|`. Здесь же — правила «номинация без продаж не разыгрывается» и «итог считается один раз».
 */
final class ResultsSpec extends AnyWordSpec with Matchers {

  private def uuid(n: Int): UUID = new UUID(0x0190f2a000007000L, 0x8000000000000000L | n.toLong)

  private def person(n: Int): ParticipantId = ParticipantId(uuid(100 + n))

  private def lot(
      n: Int,
      sold: Option[Long] = None,
      starting: Option[Long] = None,
      bids: Long = 0,
      participants: Long = 0,
      growth: Option[Long] = None,
      finalGrowth: Option[Long] = None,
      finalBids: Option[Long] = None,
      lineup: Boolean = false
  ): LotOutcome =
    LotOutcome(
      LotId(uuid(n)),
      sold,
      starting,
      bids,
      participants,
      growth,
      finalGrowth,
      finalBids,
      lineup,
      terminal = true
    )

  private def forecast(round: PredictionRound, answers: (Nomination, Answer)*): Forecast =
    Forecast.parse(round, answers.toList).toOption.get

  private def forecasts(entries: (ParticipantId, Forecast)*): Map[PredictionRound, Map[ParticipantId, Forecast]] =
    entries
      .groupBy(_._2.round)
      .map((round, of) => round -> of.map((participant, forecast) => participant -> forecast).toMap)

  private def count(lots: List[LotOutcome], entries: (ParticipantId, Forecast)*): Settlement =
    Results.count(lots, forecasts(entries*))

  private def outcome(settlement: Settlement, nomination: Nomination): NominationOutcome =
    settlement.outcomes
      .find(_.nomination == nomination)
      .getOrElse(fail(s"nomination $nomination is not played"))

  private def result(settlement: Settlement, participant: ParticipantId): Map[Nomination, Participation] =
    settlement.participants
      .find(_.participant == participant)
      .getOrElse(fail(s"participant $participant did not answer"))
      .perNomination
      .toMap

  "the results core" should {

    "count 1.1 by sale price, so everyone who named a first-place lot guessed" in {
      val a = lot(1, sold = Some(5000))
      val b = lot(2, sold = Some(5000))
      val c = lot(3, sold = Some(3000))
      val settlement = count(
        List(a, b, c),
        person(1) -> forecast(PredictionRound.Catalog, Nomination.MostExpensiveLot -> Answer.Lot(a.lot)),
        person(2) -> forecast(PredictionRound.Catalog, Nomination.MostExpensiveLot -> Answer.Lot(b.lot)),
        person(3) -> forecast(PredictionRound.Catalog, Nomination.MostExpensiveLot -> Answer.Lot(c.lot))
      )
      outcome(settlement, Nomination.MostExpensiveLot).value shouldBe
        Some(NominationValue.Lots(Set(a.lot, b.lot)))
      result(settlement, person(1))(Nomination.MostExpensiveLot) shouldBe Participation.Guessed
      result(settlement, person(2))(Nomination.MostExpensiveLot) shouldBe Participation.Guessed
      result(settlement, person(3))(Nomination.MostExpensiveLot) shouldBe Participation.Missed(None)
    }

    "count 1.2 by the sum of sales, so equal deviations both win" in {
      val a = lot(1, sold = Some(30000))
      val settlement = count(
        List(a),
        person(1) -> forecast(PredictionRound.Catalog, Nomination.TotalSales -> Answer.Number(29000)),
        person(2) -> forecast(PredictionRound.Catalog, Nomination.TotalSales -> Answer.Number(31000))
      )
      outcome(settlement, Nomination.TotalSales).value shouldBe Some(NominationValue.Number(30000))
      outcome(settlement, Nomination.TotalSales).winners shouldBe 2
      result(settlement, person(1))(Nomination.TotalSales) shouldBe Participation.Guessed
      result(settlement, person(2))(Nomination.TotalSales) shouldBe Participation.Guessed
    }

    "count 1.3 by the number of bids of the lot" in {
      val a = lot(1, sold = Some(1000), bids = 14)
      val b = lot(2, sold = Some(1000), bids = 14)
      val c = lot(3, sold = Some(1000), bids = 9)
      val settlement = count(
        List(a, b, c),
        person(1) -> forecast(PredictionRound.Catalog, Nomination.MostBidsLot -> Answer.Lot(a.lot)),
        person(2) -> forecast(PredictionRound.Catalog, Nomination.MostBidsLot -> Answer.Lot(b.lot)),
        person(3) -> forecast(PredictionRound.Catalog, Nomination.MostBidsLot -> Answer.Lot(c.lot))
      )
      outcome(settlement, Nomination.MostBidsLot).value shouldBe Some(NominationValue.Lots(Set(a.lot, b.lot)))
      result(settlement, person(1))(Nomination.MostBidsLot) shouldBe Participation.Guessed
      result(settlement, person(2))(Nomination.MostBidsLot) shouldBe Participation.Guessed
      result(settlement, person(3))(Nomination.MostBidsLot) shouldBe Participation.Missed(None)
    }

    "count 1.4 by the growth from the starting price" in {
      val a = lot(1, sold = Some(600), starting = Some(100), growth = Some(500))
      val b = lot(2, sold = Some(1500), starting = Some(1000), growth = Some(500))
      val c = lot(3, sold = Some(1100), starting = Some(1000), growth = Some(100))
      val settlement = count(
        List(a, b, c),
        person(1) -> forecast(PredictionRound.Catalog, Nomination.BiggestGrowthLot -> Answer.Lot(a.lot)),
        person(2) -> forecast(PredictionRound.Catalog, Nomination.BiggestGrowthLot -> Answer.Lot(b.lot)),
        person(3) -> forecast(PredictionRound.Catalog, Nomination.BiggestGrowthLot -> Answer.Lot(c.lot))
      )
      outcome(settlement, Nomination.BiggestGrowthLot).value shouldBe Some(NominationValue.Lots(Set(a.lot, b.lot)))
      result(settlement, person(3))(Nomination.BiggestGrowthLot) shouldBe Participation.Missed(None)
    }

    "count 1.5 by the number of people who fought for the lot" in {
      val a = lot(1, sold = Some(1000), participants = 6)
      val b = lot(2, sold = Some(1000), participants = 6)
      val c = lot(3, sold = Some(1000), participants = 2)
      val settlement = count(
        List(a, b, c),
        person(1) -> forecast(PredictionRound.Catalog, Nomination.MostBiddersLot -> Answer.Lot(a.lot)),
        person(2) -> forecast(PredictionRound.Catalog, Nomination.MostBiddersLot -> Answer.Lot(b.lot)),
        person(3) -> forecast(PredictionRound.Catalog, Nomination.MostBiddersLot -> Answer.Lot(c.lot))
      )
      outcome(settlement, Nomination.MostBiddersLot).value shouldBe Some(NominationValue.Lots(Set(a.lot, b.lot)))
      result(settlement, person(3))(Nomination.MostBiddersLot) shouldBe Participation.Missed(None)
    }

    "count 1.6 by the sum of bids over every lot, with equal deviations both winning" in {
      val a = lot(1, sold = Some(1000), bids = 70)
      val b = lot(2, sold = Some(1000), bids = 50)
      val settlement = count(
        List(a, b),
        person(1) -> forecast(PredictionRound.Catalog, Nomination.TotalBids -> Answer.Number(110)),
        person(2) -> forecast(PredictionRound.Catalog, Nomination.TotalBids -> Answer.Number(130))
      )
      outcome(settlement, Nomination.TotalBids).value shouldBe Some(NominationValue.Number(120))
      result(settlement, person(1))(Nomination.TotalBids) shouldBe Participation.Guessed
      result(settlement, person(2))(Nomination.TotalBids) shouldBe Participation.Guessed
    }

    "count 2.1 by the sale price of the lineup" in {
      val a = lot(1, sold = Some(12000), lineup = true)
      val b = lot(2, sold = Some(12000), lineup = true)
      val settlement = count(
        List(a, b),
        person(1) -> forecast(PredictionRound.Final, Nomination.FinalMostExpensiveLot -> Answer.Lot(a.lot)),
        person(2) -> forecast(PredictionRound.Final, Nomination.FinalMostExpensiveLot -> Answer.Lot(b.lot))
      )
      outcome(settlement, Nomination.FinalMostExpensiveLot).value shouldBe
        Some(NominationValue.Lots(Set(a.lot, b.lot)))
      result(settlement, person(1))(Nomination.FinalMostExpensiveLot) shouldBe Participation.Guessed
      result(settlement, person(2))(Nomination.FinalMostExpensiveLot) shouldBe Participation.Guessed
    }

    "count 2.2 by the sum of the final sales, with equal deviations both winning" in {
      val a = lot(1, sold = Some(60000), lineup = true)
      val settlement = count(
        List(a),
        person(1) -> forecast(PredictionRound.Final, Nomination.FinalTotalSales -> Answer.Number(58000)),
        person(2) -> forecast(PredictionRound.Final, Nomination.FinalTotalSales -> Answer.Number(62000))
      )
      outcome(settlement, Nomination.FinalTotalSales).value shouldBe Some(NominationValue.Number(60000))
      result(settlement, person(1))(Nomination.FinalTotalSales) shouldBe Participation.Guessed
      result(settlement, person(2))(Nomination.FinalTotalSales) shouldBe Participation.Guessed
    }

    "count 2.3 by the growth from the held price" in {
      val a = lot(1, sold = Some(20000), lineup = true, finalGrowth = Some(3000))
      val b = lot(2, sold = Some(20000), lineup = true, finalGrowth = Some(3000))
      val settlement = count(
        List(a, b),
        person(1) -> forecast(PredictionRound.Final, Nomination.FinalBiggestGrowthLot -> Answer.Lot(a.lot)),
        person(2) -> forecast(PredictionRound.Final, Nomination.FinalBiggestGrowthLot -> Answer.Lot(b.lot))
      )
      outcome(settlement, Nomination.FinalBiggestGrowthLot).value shouldBe
        Some(NominationValue.Lots(Set(a.lot, b.lot)))
      result(settlement, person(1))(Nomination.FinalBiggestGrowthLot) shouldBe Participation.Guessed
      result(settlement, person(2))(Nomination.FinalBiggestGrowthLot) shouldBe Participation.Guessed
    }

    "count 2.4 by the sum of the final bids of the lineup, with equal deviations both winning" in {
      val a = lot(1, sold = Some(1000), lineup = true, finalBids = Some(25))
      val b = lot(2, sold = Some(1000), lineup = true, finalBids = Some(15))
      val settlement = count(
        List(a, b),
        person(1) -> forecast(PredictionRound.Final, Nomination.FinalTotalBids -> Answer.Number(35)),
        person(2) -> forecast(PredictionRound.Final, Nomination.FinalTotalBids -> Answer.Number(45))
      )
      outcome(settlement, Nomination.FinalTotalBids).value shouldBe Some(NominationValue.Number(40))
      result(settlement, person(1))(Nomination.FinalTotalBids) shouldBe Participation.Guessed
      result(settlement, person(2))(Nomination.FinalTotalBids) shouldBe Participation.Guessed
    }

    "not play a nomination in whose area nothing was sold, and count nobody as a winner" in {
      val a = lot(1, bids = 7)
      val settlement = count(
        List(a),
        person(1) -> forecast(PredictionRound.Catalog, Nomination.MostExpensiveLot -> Answer.Lot(a.lot))
      )
      settlement.outcomes shouldBe empty
      result(settlement, person(1))(Nomination.MostExpensiveLot) shouldBe Participation.Missed(None)
    }

    "keep a deviation on a missed number and none on a missed lot" in {
      val a = lot(1, sold = Some(1000))
      val settlement = count(
        List(a),
        person(1) -> forecast(PredictionRound.Catalog, Nomination.TotalSales -> Answer.Number(900)),
        person(2) -> forecast(PredictionRound.Catalog, Nomination.TotalSales -> Answer.Number(1000)),
        person(3) -> forecast(PredictionRound.Catalog, Nomination.MostExpensiveLot -> Answer.Lot(lot(2).lot))
      )
      result(settlement, person(1))(Nomination.TotalSales) shouldBe Participation.Missed(Some(100))
      result(settlement, person(2))(Nomination.TotalSales) shouldBe Participation.Guessed
      result(settlement, person(3))(Nomination.MostExpensiveLot) shouldBe Participation.Missed(None)
    }

    "leave out a nomination the participant did not answer" in {
      val a = lot(1, sold = Some(1000))
      val settlement = count(
        List(a),
        person(1) -> forecast(PredictionRound.Catalog, Nomination.MostExpensiveLot -> Answer.Lot(a.lot))
      )
      result(settlement, person(1)).keySet shouldBe Set(Nomination.MostExpensiveLot)
    }

    "settle once and never change a counted or a by-hand result" in {
      val a = lot(1, sold = Some(1000))
      val settlement = count(
        List(a),
        person(1) -> forecast(PredictionRound.Catalog, Nomination.MostExpensiveLot -> Answer.Lot(a.lot))
      )
      Results.settle(Results.Unsettled, settlement.outcomes) shouldBe
        Some(ResultsEvent.ResultsSettled(settlement.outcomes))
      Results.settle(Results.Counted(settlement.outcomes), Nil) shouldBe None
      Results.settle(Results.ByHand, settlement.outcomes) shouldBe None
    }

    "suppress the automatic count with a by-hand marker, and keep it accepted afterwards" in {
      Results.recordByHand(Results.Unsettled) shouldBe Some(ResultsEvent.ResultsRecordedManually)
      Results.recordByHand(Results.ByHand) shouldBe None
      Results.recordByHand(Results.Counted(Nil)) shouldBe None
      Results.settle(Results.apply(Results.Unsettled, ResultsEvent.ResultsRecordedManually), Nil) shouldBe None
    }

    "reset to an empty sheet on a discard, and do nothing on a discard of the empty sheet" in {
      Results.discard(Results.Unsettled) shouldBe None
      Results.discard(Results.ByHand) shouldBe Some(ResultsEvent.ResultsDiscarded)
      Results.apply(Results.Counted(Nil), ResultsEvent.ResultsDiscarded) shouldBe Results.Unsettled
    }
  }
}
