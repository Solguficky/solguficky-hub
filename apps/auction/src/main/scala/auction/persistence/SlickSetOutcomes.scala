package auction.persistence

import auction.aggregate.LotOutcome
import auction.catalog.LotId
import auction.entity.AuctionSetOutcomes
import auction.lot.LotState
import auction.projection.LotSnapshotView
import auction.projection.LotViewJson
import org.apache.pekko.actor.typed.ActorSystem
import org.apache.pekko.persistence.jdbc.db.SlickExtension
import slick.jdbc.JdbcBackend.Database

import scala.concurrent.ExecutionContext
import scala.concurrent.Future

/**
 * Исходы лотов сета для правила «собрал» (ADR-073, п. 4) поверх read model торгов — как исходы итогов прогнозов: журнал
 * аукциона победителей не хранит, а исходы лота уже собраны проекцией. Проданный лот победителя после продажи не
 * меняет: снятие участника с проданного лота не принимается (ADR-072), поэтому отставший снимок не врёт, а только
 * опаздывает. Лот без конечного исхода в ответ не попадает.
 */
final class SlickSetOutcomes(database: Database, views: SlickLotViews)(using ExecutionContext)
    extends AuctionSetOutcomes {

  def outcomes(lots: Set[LotId]): Future[Map[LotId, LotOutcome]] =
    if (lots.isEmpty) Future.successful(Map.empty)
    else database.run(views.lotsAction(lots.toList.map(_.value))).map(_.flatMap(outcome).toMap)

  private def outcome(view: LotSnapshotView): Option[(LotId, LotOutcome)] =
    (view.lot.state match {
      case LotState.Sold(sale) => Some(LotOutcome.Sold(sale.winner))
      case LotState.Unsold(_) => Some(LotOutcome.Unsold)
      case LotState.Withdrawn(_) => Some(LotOutcome.Withdrawn)
      case LotState.Initial | LotState.Draft | LotState.Scheduled(_) | LotState.Trading(_) | LotState.Held(_) => None
    }).map(LotId(view.lotId) -> _)
}

object SlickSetOutcomes {

  def apply(system: ActorSystem[?]): SlickSetOutcomes = {
    val database = SlickExtension(system).database(system.settings.config.getConfig("jdbc-journal")).database
    given ExecutionContext = system.executionContext
    new SlickSetOutcomes(database, new SlickLotViews(database, LotViewJson(system)))
  }
}
