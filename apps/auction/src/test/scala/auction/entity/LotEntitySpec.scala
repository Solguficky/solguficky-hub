package auction.entity

import auction.entity.JournalFixtures.*
import auction.lot.*
import auction.lot.LotFixtures.*
import org.apache.pekko.actor.testkit.typed.scaladsl.ActorTestKit
import org.apache.pekko.persistence.testkit.scaladsl.EventSourcedBehaviorTestKit
import org.apache.pekko.persistence.testkit.scaladsl.EventSourcedBehaviorTestKit.SerializationSettings
import org.scalatest.BeforeAndAfterAll
import org.scalatest.BeforeAndAfterEach
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

/**
 * Синхронная часть entity лота на in-memory журнале: команда → событие → состояние → ответ и `restart()`.
 *
 * Каждое записанное событие проходит настоящий `jackson-json` туда и обратно с проверкой равенства, так что тест заодно
 * доказывает, что строка журнала читается в то же значение. Команды несут `ActorRef` и узел не покидают — их
 * сериализация не проверяется; snapshot проверяет `LotJournalSpec` и L1.
 */
final class LotEntitySpec extends AnyWordSpec with Matchers with BeforeAndAfterAll with BeforeAndAfterEach {

  private val kit = ActorTestKit("lot-entity", EventSourcedBehaviorTestKit.config.withFallback(localConfig))

  private val serialization =
    SerializationSettings.enabled.withVerifyEquality(true).withVerifyCommands(false).withVerifyState(false)

  private var entity: EventSourcedBehaviorTestKit[LotEntity.Command, StoredLotEvent, LotEntity.State] =
    scala.compiletime.uninitialized

  override protected def beforeEach(): Unit =
    entity = EventSourcedBehaviorTestKit(
      kit.system,
      LotEntity("lot-1", clock, sequentialIds()),
      serialization
    )

  override protected def afterAll(): Unit = kit.shutdownTestKit()

  private val bidder: Initiator = Initiator.Participant(participant(1))

  private def open(opN: Int = 1) =
    entity.runCommand[Either[OpenLotRejected, Envelope]](LotEntity.Open(openLot(opN), Initiator.Scheduler, _))

  private def bidOf(who: Int, amount: Long, opN: Int) =
    entity.runCommand[Either[PlaceBidRejected, Envelope]](
      LotEntity.Bid(placeBid(who, amount, opN), Initiator.Participant(participant(who)), _)
    )

  "lot entity" should {

    "number the events of the lot by their position in the journal" in {
      val opened = open()
      val placed = bidOf(who = 1, amount = 110, opN = 2)

      opened.reply.map(_.sequence) shouldBe Right(1L)
      placed.reply.map(_.sequence) shouldBe Right(2L)
      placed.state.sequence shouldBe 2L
      placed.state.lot.seen.values.map(envelope => envelope.opId -> envelope.sequence).toMap shouldBe
        Map(op(1) -> 1L, op(2) -> 2L)
    }

    "write one event per accepted command with the op id, the decision time and the initiator of the command" in {
      open()
      val placed = bidOf(who = 1, amount = 110, opN = 2)

      placed.events.map(event => (event.opId, event.occurredAt, event.actor, event.event.kind)) shouldBe
        List((op(2).value, decidedAt, LotJournal.storeInitiator(bidder), "BidPlaced"))
      placed.events.map(_.eventId) should not contain placed.events.head.transactionId
    }

    "restore price, leader and deadline after a restart from the journal alone (Т-16)" in {
      open()
      bidOf(who = 1, amount = 110, opN = 2)
      val beforeRestart = bidOf(who = 2, amount = 120, opN = 3).state

      val restarted = entity.restart().state

      restarted shouldBe beforeRestart
      val trading = tradingOf(restarted.lot)
      (trading.currentPrice, trading.leader, trading.deadline) shouldBe (
        money(120),
        Some(participant(2)),
        Some(deadline)
      )
    }

    "answer a repeated command with the original response and write nothing, even after a restart (Т-14)" in {
      open()
      val first = bidOf(who = 1, amount = 110, opN = 2)

      val repeated = bidOf(who = 1, amount = 110, opN = 2)
      entity.restart()
      val repeatedAfterRestart = bidOf(who = 1, amount = 110, opN = 2)

      repeated.events shouldBe Nil
      repeatedAfterRestart.events shouldBe Nil
      repeated.reply shouldBe first.reply
      repeatedAfterRestart.reply shouldBe first.reply
    }

    "answer a refused command with its refusal and write nothing" in {
      val beforeOpen = bidOf(who = 1, amount = 110, opN = 1)
      open(opN = 2)
      val secondOpen = open(opN = 3)

      beforeOpen.reply shouldBe Left(PlaceBidRejected.LotNotOpen)
      beforeOpen.events shouldBe Nil
      secondOpen.reply shouldBe Left(OpenLotRejected.LotNotScheduled)
      secondOpen.events shouldBe Nil
    }

    "reply to a read with the state of the lot" in {
      open()

      val read = entity.runCommand[Lot](LotEntity.Get(_))

      read.reply shouldBe read.state.lot
      tradingOf(read.reply).currentPrice shouldBe money(100)
    }
  }
}
