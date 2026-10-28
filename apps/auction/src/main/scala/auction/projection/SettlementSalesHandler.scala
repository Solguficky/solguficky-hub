package auction.projection

import auction.entity.LotJournal
import auction.entity.StoredLotEvent
import auction.invoice.InvoiceGateway
import auction.lot.AuctionId
import auction.settlement.*
import org.apache.pekko.Done
import org.apache.pekko.actor.typed.ActorSystem
import org.apache.pekko.persistence.jdbc.db.SlickExtension
import org.apache.pekko.projection.scaladsl.Handler
import org.apache.pekko.serialization.SerializationExtension
import slick.jdbc.PostgresProfile.api.*

import java.time.Duration
import scala.concurrent.ExecutionContext
import scala.concurrent.Future

/**
 * Собственный offset backfill'ит продажи, уже обработанные lot-invoicing. Старый счёт всегда выставляется до открытия
 * расчётов. При повторе ни его закрытие, ни ход предложений не откатываются.
 */
final class SettlementSalesHandler(
    paymentTerm: AuctionId => Future[Duration],
    invoices: InvoiceGateway,
    settlements: SettlementGateway,
    history: InvoicingProjection.Envelope => Future[List[auction.lot.Written]]
)(using ExecutionContext)
    extends Handler[InvoicingProjection.Envelope] {

  override def process(envelope: InvoicingProjection.Envelope): Future[Done] =
    InvoicingHandler.sale(envelope) match {
      case None => Future.successful(Done)
      case Some(sale) =>
        val term =
          if (sale.auction.value.version == 5) paymentTerm(sale.auction)
          else Future.successful(auction.aggregate.AuctionConfig.PlatformPaymentTerm)
        for {
          duration <- term
          terms = sale.terms(duration)
          _ <- invoices.issue(sale.invoice, terms)
          events <- history(envelope)
          _ <- settlements.open(
            terms.lot,
            SettlementSale(sale.invoice, terms, duration),
            Settlement.candidates(events, terms.winner)
          )
        } yield Done
    }
}

object SettlementSalesHandler {
  val Name = "settlement-sales"

  def history(system: ActorSystem[?]): InvoicingProjection.Envelope => Future[List[auction.lot.Written]] = {
    val database = SlickExtension(system).database(system.settings.config.getConfig("jdbc-journal")).database
    val serialization = SerializationExtension(system.classicSystem)
    envelope =>
      database.run(SimpleDBIO { context =>
        val rows =
          JournalGap.missing(context.connection, serialization, envelope.persistenceId, 0L, envelope.sequenceNr + 1) {
            case event: StoredLotEvent => event
          }
        if (rows.map(_._1) != (1L to envelope.sequenceNr))
          throw new IllegalStateException("settlement requires the complete lot history through its sale")
        rows
          .map((sequence, stored) => auction.lot.Written(LotJournal.envelope(sequence, stored), stored.occurredAt))
          .toList
      })
  }
}
