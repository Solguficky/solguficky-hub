package auction.persistence

import auction.catalog.LotId
import auction.lot.AuctionId
import auction.lot.LotState
import auction.projection.LotStatisticsView
import auction.projection.LotViews
import auction.results.LotOutcome
import auction.results.ResultsOutcomes
import org.apache.pekko.actor.typed.ActorSystem

import scala.concurrent.ExecutionContext
import scala.concurrent.Future

/**
 * Снимок исходов лотов реестра для подсчёта итогов (ADR-067, п. 1) поверх read model торгов — по той же причине, что
 * статистика пульта: entity итогов торгов не знает, а исходы лота уже собраны проекцией. Деньги переводятся в минорные
 * единицы (`Money` в пакет `results` не заходит).
 *
 * Снимок полон, только когда у каждого лота реестра конечное состояние (п. 8): иначе `None`, и подсчёт не начинается.
 * Отставшая от продаж проекция даёт именно это, поэтому подсчёт сам дожидается полноты на тике переспроса.
 */
final class SlickResultsOutcomes(views: LotViews)(using ExecutionContext) extends ResultsOutcomes {

  def outcomes(auction: AuctionId): Future[Option[List[LotOutcome]]] =
    views.statistics(auction.value).map { statistics =>
      if (statistics.forall(terminal)) Some(statistics.map(outcome)) else None
    }

  private def terminal(view: LotStatisticsView): Boolean =
    view.lot.state match {
      case LotState.Sold(_) | LotState.Unsold(_) | LotState.Withdrawn(_) => true
      case LotState.Initial | LotState.Draft | LotState.Scheduled(_) | LotState.Trading(_) | LotState.Held(_) => false
    }

  private def outcome(view: LotStatisticsView): LotOutcome = {
    val sold = view.lot.state match {
      case LotState.Sold(sale) => Some(sale.price.minorUnits)
      case _ => None
    }
    LotOutcome(
      lot = LotId(view.lotId),
      sold = sold,
      startingPrice = view.startingPrice.map(_.minorUnits),
      bids = view.bidCount,
      participants = view.participantCount,
      priceGrowth = view.priceGrowth.map(_.minorUnits),
      finalGrowth = view.finalGrowth.map(_.minorUnits),
      finalBids = view.finalBidCount,
      // Обеих метрик финала у лота вне состава нет (`None`), поэтому наличие любой из них и есть признак состава.
      inLineup = view.finalBidCount.isDefined,
      terminal = terminal(view)
    )
  }
}

object SlickResultsOutcomes {

  def apply(system: ActorSystem[?]): SlickResultsOutcomes =
    new SlickResultsOutcomes(SlickLotViews(system))(using system.executionContext)
}
