package auction.projection

import auction.aggregate.*
import auction.aggregate.AuctionFixtures.*
import auction.entity.AuctionJournal
import auction.entity.Initiator
import auction.entity.JournalFixtures.*
import auction.invoice.InvoiceId
import auction.lot.LotFixtures.op
import auction.persistence.JournalSchema
import auction.testkit.PostgresFixture
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec
import slick.jdbc.JdbcBackend.Database

import java.time.Duration
import scala.concurrent.Await
import scala.concurrent.duration.*

final class InvoicePaymentClockIntegrationSpec extends AnyWordSpec with Matchers with PostgresFixture {
  "the payment clock store" should {
    "defers old invoices and gives early and late sales one persisted deadline while leaving paid invoices alone" in {
      val settings = freshDatabase()
      JournalSchema.migrate(settings)
      val auctionId = uuid(20)
      val oldDue = closesAt.plus(Duration.ofDays(1))
      def invoiceSql(n: Int, due: String, status: String) =
        "INSERT INTO auction_invoice VALUES ('" + uuid(n) + "', '" + auctionId + "', '" + uuid(n + 20) + "', '" +
          uuid(1) + "', 100, 'RUB', " + due + ", '" + status + "', NULL, 1)"
      withConnection(settings) { connection =>
        val statement = connection.createStatement()
        try {
          statement.execute(s"INSERT INTO auction_view VALUES ('$auctionId', '" + uuid(30) + "', 1, 'on_break', '{}')")
          statement.execute(invoiceSql(2, s"'$oldDue'", "AwaitingPayment"))
          statement.execute(invoiceSql(3, s"'$oldDue'", "Paid"))
        } finally statement.close()
      }
      val database = Database.forURL(
        settings.url,
        user = settings.user,
        password = settings.password,
        driver = "org.postgresql.Driver"
      )
      try {
        def changes = Await.result(InvoicePaymentClock.changes(database), 5.seconds)
        changes shouldBe Vector(InvoicePaymentClock.Change(InvoiceId(uuid(2)), Some(oldDue), None))
        val auction = Auction.initial.copy(state =
          AuctionState.Finished(config(configInput().copy(paymentTerm = Some(Duration.ofDays(1)))), op(1))
        )
        val end = closesAt.plus(Duration.ofDays(2))
        val event =
          AuctionJournal.store(uuid(4), uuid(5), op(2), end, Initiator.Scheduler)(AuctionEvent.AuctionFinished)
        withConnection(settings) { connection =>
          InvoicePaymentClock.record(connection, auctionId, auction, List(event))
          InvoicePaymentClock.record(connection, auctionId, auction, List(event.copy(occurredAt = end.plusSeconds(10))))
          val statement = connection.createStatement()
          try {
            statement.execute(s"UPDATE auction_view SET status = 'finished' WHERE auction_id = '$auctionId'")
            statement.execute(invoiceSql(6, "NULL", "AwaitingPayment"))
          } finally statement.close()
        }
        val requested = changes
        requested.map(_.invoice).toSet shouldBe Set(InvoiceId(uuid(2)), InvoiceId(uuid(6)))
        requested.flatMap(_.dueAt).toSet shouldBe Set(end.plus(Duration.ofDays(1)))
      } finally database.close()
    }
  }
}
