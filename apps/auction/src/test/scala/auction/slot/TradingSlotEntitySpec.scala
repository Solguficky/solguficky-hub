package auction.slot

import auction.entity.JournalFixtures.*
import auction.lot.AuctionId
import org.apache.pekko.Done
import org.apache.pekko.actor.testkit.typed.scaladsl.ActorTestKit
import org.apache.pekko.persistence.testkit.scaladsl.EventSourcedBehaviorTestKit
import org.apache.pekko.persistence.testkit.scaladsl.PersistenceTestKit
import org.apache.pekko.persistence.testkit.scaladsl.EventSourcedBehaviorTestKit.SerializationSettings
import org.scalatest.BeforeAndAfterAll
import org.scalatest.BeforeAndAfterEach
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

import java.util.concurrent.TimeoutException
import scala.concurrent.Future
import scala.concurrent.Promise
import scala.concurrent.duration.*

/**
 * Entity слота на журнале в памяти: каждое событие проходит настоящий `jackson-json` туда и обратно. Держатели —
 * подмена порта, у которой тест задаёт ответ каждого аукциона; вопрос держателю, которого тест не задал, падает.
 */
final class TradingSlotEntitySpec extends AnyWordSpec with Matchers with BeforeAndAfterAll with BeforeAndAfterEach {

  private val kit = ActorTestKit("trading-slot-entity", EventSourcedBehaviorTestKit.config.withFallback(localConfig))

  override protected def afterAll(): Unit = kit.shutdownTestKit()

  private val serialization =
    SerializationSettings.enabled.withVerifyEquality(true).withVerifyCommands(false).withVerifyState(false)

  private type Kit = EventSourcedBehaviorTestKit[TradingSlotEntity.Command, StoredSlotEvent, TradingSlot]

  /** Ответы держателей: аукцион — его ответ; вопросы записываются по порядку. */
  private final class Holders extends SlotHolders {
    @volatile var answers: Map[AuctionId, Future[Boolean]] = Map.empty
    @volatile var asked: Vector[AuctionId] = Vector.empty
    def busy(auction: AuctionId): Future[Boolean] = synchronized {
      asked :+= auction
      answers.getOrElse(auction, Future.failed(new AssertionError(s"the slot asked a holder the test did not set up")))
    }
  }

  private val first = AuctionId(uuid(21))
  private val second = AuctionId(uuid(22))
  private val third = AuctionId(uuid(23))

  private var holders: Holders = scala.compiletime.uninitialized
  private var slot: Kit = scala.compiletime.uninitialized

  override protected def beforeEach(): Unit = {
    holders = Holders()
    slot = EventSourcedBehaviorTestKit(kit.system, TradingSlotEntity(clock, sequentialIds(), holders), serialization)
  }

  private def claim(auction: AuctionId) =
    slot.runCommand[TradingSlotEntity.Claimed](TradingSlotEntity.Claim(auction, _))

  private def release(auction: AuctionId) = slot.runCommand[Done](TradingSlotEntity.Release(auction, _))

  private def events(stored: Seq[StoredSlotEvent]) = stored.map(TradingSlotJournal.restore)

  "trading slot entity" should {

    "gives a free slot to the first claim and answers its repeat without a write" in {
      val taken = claim(first)
      taken.reply shouldBe TradingSlotEntity.Claimed.Granted
      events(taken.events) shouldBe Seq(SlotEvent.SlotTaken(first))
      val repeated = claim(first)
      repeated.reply shouldBe TradingSlotEntity.Claimed.Granted
      repeated.events shouldBe empty
      holders.asked shouldBe empty
    }

    "refuses another auction with the holder while the holder is trading" in {
      claim(first)
      holders.answers = Map(first -> Future.successful(true))
      val refused = claim(second)
      refused.reply shouldBe TradingSlotEntity.Claimed.Taken(first)
      refused.events shouldBe empty
      slot.getState().state shouldBe SlotState.Held(first)
    }

    "passes the slot to another auction when the holder is not trading" in {
      claim(first)
      holders.answers = Map(first -> Future.successful(false))
      claim(second).reply shouldBe TradingSlotEntity.Claimed.Granted
      holders.asked shouldBe Vector(first)
      // Переход записан в журнал, а не только в память: recovery приходит к тому же держателю.
      slot.restart().state.state shouldBe SlotState.Held(second)
      // Пара «освобождение — занятие» — две строки журнала со своими идентификаторами.
      val rows = PersistenceTestKit(kit.system).persistedInStorage("trading-slot|community").collect {
        case stored: StoredSlotEvent => stored
      }
      events(rows) shouldBe Seq(SlotEvent.SlotTaken(first), SlotEvent.SlotReleased(first), SlotEvent.SlotTaken(second))
      rows.map(_.eventId).distinct should have size 3
    }

    "keeps the slot with a silent holder and answers the claimant unavailable" in {
      claim(first)
      holders.answers = Map(first -> Future.failed(new TimeoutException("the holder did not answer")))
      claim(second).reply shouldBe TradingSlotEntity.Claimed.Unavailable
      slot.getState().state shouldBe SlotState.Held(first)
    }

    "holds back a claim that comes while the holder is asked and decides it after the answer" in {
      claim(first)
      val answer = Promise[Boolean]()
      holders.answers = Map(first -> answer.future, second -> Future.successful(true))
      val secondProbe = kit.createTestProbe[TradingSlotEntity.Claimed]()
      val thirdProbe = kit.createTestProbe[TradingSlotEntity.Claimed]()
      slot.runCommand(TradingSlotEntity.Claim(second, secondProbe.ref))
      slot.runCommand(TradingSlotEntity.Claim(third, thirdProbe.ref))
      thirdProbe.expectNoMessage(200.millis)
      holders.asked shouldBe Vector(first)
      answer.success(false)
      secondProbe.expectMessage(TradingSlotEntity.Claimed.Granted)
      thirdProbe.expectMessage(TradingSlotEntity.Claimed.Taken(second))
      holders.asked shouldBe Vector(first, second)
      slot.getState().state shouldBe SlotState.Held(second)
    }

    "frees the slot on a release of its holder and ignores a release of another auction" in {
      claim(first)
      val foreign = release(second)
      foreign.reply shouldBe Done
      foreign.events shouldBe empty
      val own = release(first)
      own.reply shouldBe Done
      events(own.events) shouldBe Seq(SlotEvent.SlotReleased(first))
      claim(second).reply shouldBe TradingSlotEntity.Claimed.Granted
      holders.asked shouldBe empty
    }

    "keeps its holder over a restart" in {
      claim(first)
      slot.restart().state.state shouldBe SlotState.Held(first)
    }
  }
}
