package auction.persistence

import auction.catalog.LotId
import auction.invoice.InvoiceId
import auction.invoice.InvoiceJournal
import auction.invoice.InvoiceTerms
import auction.invoice.InvoiceView
import auction.invoice.InvoiceViews
import auction.lot.AuctionId
import auction.lot.CurrencyCode
import auction.lot.Money
import auction.lot.ParticipantId
import org.apache.pekko.actor.typed.ActorSystem
import org.apache.pekko.persistence.jdbc.db.SlickExtension
import slick.jdbc.GetResult
import slick.jdbc.JdbcBackend.Database
import slick.jdbc.PostgresProfile.api.*

import java.sql.Timestamp
import java.util.UUID
import scala.concurrent.ExecutionContext
import scala.concurrent.Future

/**
 * Чтения счетов из read model `auction_invoice` (PER-338) через пул плагина журнала и plain SQL — как итоги и каталог.
 * Строки пишет проекция `invoice-view`, поэтому чтение отстаёт от entity счёта на время проекции. Порядок строк смысла
 * не несёт: контракт его не обещает, и запрос держит его стабильным только ради повторяемых ответов.
 */
final class SlickInvoiceViews(database: Database)(using ExecutionContext) extends InvoiceViews {

  private given GetResult[InvoiceView] = GetResult { row =>
    val id = InvoiceId(UUID.fromString(row.<<))
    val terms = InvoiceTerms(
      AuctionId(UUID.fromString(row.<<)),
      LotId(UUID.fromString(row.<<)),
      ParticipantId(UUID.fromString(row.<<)),
      Money(row.<<, CurrencyCode(row.<<)),
      row.<<?[Timestamp].map(_.toInstant)
    )
    InvoiceView(id, terms, InvoiceJournal.restoreStatus(row.<<), row.<<?[String].map(InvoiceJournal.restoreMethod))
  }

  def mine(auction: AuctionId, winner: ParticipantId): Future[List[InvoiceView]] =
    database.run(
      sql"""SELECT invoice_id::text, auction_id::text, lot_id::text, winner_id::text, amount_minor, currency,
                   payment_due_at, status, fulfillment
            FROM auction_invoice
            WHERE auction_id = ${auction.value.toString}::uuid AND winner_id = ${winner.value.toString}::uuid
            ORDER BY invoice_id""".as[InvoiceView].map(_.toList)
    )

  def ofAuction(auction: AuctionId): Future[List[InvoiceView]] =
    database.run(
      sql"""SELECT invoice_id::text, auction_id::text, lot_id::text, winner_id::text, amount_minor, currency,
                   payment_due_at, status, fulfillment
            FROM auction_invoice
            WHERE auction_id = ${auction.value.toString}::uuid
            ORDER BY invoice_id""".as[InvoiceView].map(_.toList)
    )
}

object SlickInvoiceViews {

  def apply(system: ActorSystem[?]): SlickInvoiceViews = {
    val database = SlickExtension(system).database(system.settings.config.getConfig("jdbc-journal")).database
    new SlickInvoiceViews(database)(using system.executionContext)
  }
}
