package auction.prediction

import auction.entity.JournalFixtures.*
import org.apache.pekko.actor.testkit.typed.scaladsl.ActorTestKit
import org.scalatest.BeforeAndAfterAll
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

import scala.jdk.CollectionConverters.*
import scala.util.Using

final class PredictionJournalSpec extends AnyWordSpec with Matchers with BeforeAndAfterAll {

  private val kit = ActorTestKit("prediction-journal", localConfig)

  override protected def afterAll(): Unit = kit.shutdownTestKit()

  private def golden(name: String): Array[Byte] =
    Using.resource(getClass.getResourceAsStream(s"/journal/$name.json"))(_.readAllBytes())

  private def stored(event: PredictionEvent): StoredPredictionEvent =
    PredictionJournal.store(uuid(1), decidedAt)(event)

  private def keepsGolden(name: String, value: StoredPredictionEvent) = {
    val row = write(kit.system, value)
    row.json shouldBe mapper.readTree(golden(name))
    read(kit.system, row.copy(bytes = golden(name))) shouldBe value
  }

  "prediction journal" should {

    "keeps the stored form of every prediction event equal to its golden file and reads it back" in {
      keepsGolden("prediction-round-opened", stored(PredictionEvent.RoundOpened(PredictionRound.Catalog)))
      keepsGolden("prediction-round-closed", stored(PredictionEvent.RoundClosed(PredictionRound.Final)))
      keepsGolden("prediction-cancelled", stored(PredictionEvent.PredictionsCancelled))
      keepsGolden("prediction-discarded", stored(PredictionEvent.PredictionsDiscarded))
    }

    "carries no participant and no answer: a row holds only the eventId, the time and the round" in {
      val keys = List("prediction-round-opened", "prediction-round-closed").flatMap { name =>
        val event = mapper.readTree(golden(name))
        event.fieldNames.asScala.toList ++ event.get("event").fieldNames.asScala.toList
      }
      keys.toSet shouldBe Set("eventId", "occurredAt", "event", "kind", "roundOpened", "roundClosed")
    }

    "refuses a row whose sections do not match its kind" in {
      val broken = stored(PredictionEvent.RoundOpened(PredictionRound.Catalog)).event.copy(kind = "RoundClosed")
      an[auction.entity.JournalCorrupted] should be thrownBy PredictionJournal.restoreEvent(broken)
    }
  }
}
