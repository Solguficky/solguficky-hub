package auction.results

import auction.catalog.LotId
import auction.entity.JournalCorrupted
import auction.entity.JournalFixtures.*
import auction.prediction.Nomination
import org.apache.pekko.actor.testkit.typed.scaladsl.ActorTestKit
import org.scalatest.BeforeAndAfterAll
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

/**
 * Строка журнала итогов переживает модель хранения в обе стороны: числа номинаций читаются как `Long`, а не `Int`
 * (иначе проекция публикации падает на разборе события). Здесь же — отказ строке, у которой секция не та, что `kind`.
 */
final class ResultsJournalSpec extends AnyWordSpec with Matchers with BeforeAndAfterAll {

  private val kit = ActorTestKit("results-journal", localConfig)

  override protected def afterAll(): Unit = kit.shutdownTestKit()

  private val outcomes = List(
    NominationOutcome(Nomination.MostExpensiveLot, Some(NominationValue.Lots(Set(LotId(uuid(11))))), 1),
    NominationOutcome(Nomination.TotalSales, Some(NominationValue.Number(30000)), 2)
  )

  private def roundTrip(event: ResultsEvent): ResultsEvent = {
    val row = write(kit.system, ResultsJournal.store(uuid(1), decidedAt)(event))
    ResultsJournal.restoreEvent(read(kit.system, row).asInstanceOf[StoredResultsEvent].event)
  }

  "results journal" should {

    "reads back every results event through the storage form" in {
      roundTrip(ResultsEvent.ResultsSettled(outcomes)) shouldBe ResultsEvent.ResultsSettled(outcomes)
      roundTrip(ResultsEvent.ResultsRecordedManually) shouldBe ResultsEvent.ResultsRecordedManually
      roundTrip(ResultsEvent.ResultsDiscarded) shouldBe ResultsEvent.ResultsDiscarded
    }

    "refuses a row whose section does not match its kind" in {
      val broken = ResultsJournal
        .store(uuid(1), decidedAt)(ResultsEvent.ResultsRecordedManually)
        .event
        .copy(kind = "ResultsSettled")
      an[JournalCorrupted] should be thrownBy ResultsJournal.restoreEvent(broken)
    }
  }
}
