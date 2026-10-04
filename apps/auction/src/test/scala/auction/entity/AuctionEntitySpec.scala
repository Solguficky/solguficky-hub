package auction.entity

import auction.aggregate.*
import auction.catalog.LotId
import auction.entity.JournalFixtures.*
import auction.lot.LotFixtures.*
import org.apache.pekko.actor.testkit.typed.scaladsl.ActorTestKit
import org.apache.pekko.persistence.testkit.scaladsl.EventSourcedBehaviorTestKit
import org.apache.pekko.persistence.testkit.scaladsl.EventSourcedBehaviorTestKit.SerializationSettings
import org.scalatest.BeforeAndAfterAll
import org.scalatest.BeforeAndAfterEach
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

/**
 * Синхронная часть entity аукциона на in-memory журнале. Каждое записанное событие проходит настоящий `jackson-json`
 * туда и обратно; рестарт на настоящей базе — L1 gRPC-границы.
 */
final class AuctionEntitySpec extends AnyWordSpec with Matchers with BeforeAndAfterAll with BeforeAndAfterEach {

  private val kit = ActorTestKit("auction-entity", EventSourcedBehaviorTestKit.config.withFallback(localConfig))

  private val serialization =
    SerializationSettings.enabled.withVerifyEquality(true).withVerifyCommands(false).withVerifyState(false)

  private var entity: EventSourcedBehaviorTestKit[AuctionEntity.Command, StoredAuctionEvent, AuctionEntity.State] =
    scala.compiletime.uninitialized

  override protected def beforeEach(): Unit =
    entity = EventSourcedBehaviorTestKit(kit.system, AuctionEntity("auction-1", clock, sequentialIds()), serialization)

  override protected def afterAll(): Unit = kit.shutdownTestKit()

  private val meetup = MeetupId(uuid(10))
  private val lot = LotId(uuid(11))
  private val administrator: Initiator = Initiator.Operator(participant(1))

  private def draft(opN: Int) =
    entity.runCommand[AuctionAnswer](AuctionEntity.Draft(DraftAuction(meetup, op(opN)), administrator, _))

  private def add(opN: Int) =
    entity.runCommand[Either[AddLotRejected, AuctionAnswer]](AuctionEntity.Add(AddLot(lot, op(opN)), administrator, _))

  "auction entity" should {

    "records the birth once and answers a repeated op_id with the original envelope" in {
      val born = draft(1)
      born.events should have size 1
      born.reply shouldBe AuctionAnswer.Written(AuctionEnvelope(1, op(1), AuctionEvent.AuctionDrafted(meetup)))
      draft(1).events shouldBe empty
      draft(1).reply shouldBe born.reply
      draft(2).reply shouldBe AuctionAnswer.Unchanged
      draft(2).events shouldBe empty
    }

    "keeps the meetup and the registry over a restart and numbers events by their journal position" in {
      draft(1)
      add(2).reply shouldBe Right(AuctionAnswer.Written(AuctionEnvelope(2, op(2), AuctionEvent.LotAdded(lot))))
      val restarted = entity.restart().state
      restarted.sequence shouldBe 2
      restarted.auction.meetup shouldBe Some(meetup)
      restarted.auction.lots shouldBe Set(lot)
      add(2).events shouldBe empty
    }

    "inspects without writing: absent before the birth, the meetup after it and a repeat by its op_id" in {
      entity.runCommand[Inspection](AuctionEntity.Inspect(op(1), _)).reply shouldBe Inspection.Absent
      draft(1)
      entity.runCommand[Inspection](AuctionEntity.Inspect(op(2), _)).reply shouldBe Inspection.Present(meetup)
      entity.runCommand[Inspection](AuctionEntity.Inspect(op(1), _)).reply shouldBe
        Inspection.Repeated(AuctionEnvelope(1, op(1), AuctionEvent.AuctionDrafted(meetup)))
    }

    "refuses a registry command before the birth without writing" in {
      val refused = add(1)
      refused.reply shouldBe Left(AddLotRejected.AuctionNotFound)
      refused.events shouldBe empty
    }
  }
}
