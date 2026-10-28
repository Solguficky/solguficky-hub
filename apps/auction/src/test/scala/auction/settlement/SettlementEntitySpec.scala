package auction.settlement

import auction.catalog.LotId
import auction.entity.JournalFixtures.*
import auction.invoice.*
import auction.lot.*
import auction.lot.LotFixtures.*
import org.apache.pekko.actor.testkit.typed.scaladsl.ActorTestKit
import org.apache.pekko.actor.testkit.typed.scaladsl.ManualTime
import org.apache.pekko.persistence.testkit.scaladsl.EventSourcedBehaviorTestKit
import org.apache.pekko.persistence.testkit.scaladsl.EventSourcedBehaviorTestKit.SerializationSettings
import org.scalatest.BeforeAndAfterAll
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

import java.time.Clock
import java.time.ZoneId
import java.time.ZoneOffset
import scala.concurrent.duration.*

final class SettlementEntitySpec extends AnyWordSpec with Matchers with BeforeAndAfterAll {
  private val kit = ActorTestKit(
    "settlement-entity",
    ManualTime.config.withFallback(EventSourcedBehaviorTestKit.config).withFallback(localConfig)
  )
  override protected def afterAll(): Unit = kit.shutdownTestKit()

  "settlement entity" should {
    "does not close an overdue invoice or offer it to another participant after time passes without a manual command" in {
      final class MovableClock extends Clock {
        @volatile var now = calm
        def instant() = now
        def getZone: ZoneId = ZoneOffset.UTC
        def withZone(zone: ZoneId): Clock = this
      }
      val clock = new MovableClock
      val invoices = new InvoiceGateway {
        private def unexpected: Nothing = throw new AssertionError("overdue invoice must not cause an invoice command")
        def issue(id: InvoiceId, terms: InvoiceTerms) = unexpected
        def get(id: InvoiceId) = unexpected
        def markPaid(id: InvoiceId, op: OpId) = unexpected
        def markHandedOver(id: InvoiceId, op: OpId) = unexpected
        def chooseFulfillment(id: InvoiceId, who: ParticipantId, method: FulfillmentMethod, op: OpId) = unexpected
        override def markUnredeemed(id: InvoiceId, op: OpId) = unexpected
      }
      val entity = EventSourcedBehaviorTestKit[SettlementEntity.Command, StoredSettlementEvent, Settlement](
        kit.system,
        SettlementEntity(
          "overdue-lot",
          invoices,
          clock,
          sequentialIds(),
          1.second,
          _ => throw new AssertionError("no invoice effect should run")
        ),
        SerializationSettings.enabled.withVerifyEquality(true).withVerifyCommands(false).withVerifyState(false)
      )
      val terms = InvoiceTerms.ofSale(
        auctionId(1),
        LotId(uuid(10)),
        participant(1),
        money(1000),
        calm,
        java.time.Duration.ofDays(7)
      )
      entity.runCommand[org.apache.pekko.Done](
        SettlementEntity.Open(
          SettlementSale(InvoiceId.of(bid(1)), terms, java.time.Duration.ofDays(7)),
          List(SettlementCandidate(bid(2), participant(2), money(800))),
          _
        )
      )
      clock.now = terms.paymentDueAt.plusSeconds(1)
      ManualTime()(using kit.system).timePasses(8.days)
      val after = entity.runCommand[Settlement](SettlementEntity.Get(_)).reply.asInstanceOf[Settlement.Open]
      after.stage shouldBe SettlementStage.AwaitingPayment
      after.offers shouldBe Nil
      after.closures shouldBe empty
      after.invoices.map(_.id) shouldBe List(InvoiceId.of(bid(1)))
    }
  }
}
