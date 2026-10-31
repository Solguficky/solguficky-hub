package auction.screen

import auction.lot.AuctionId
import auction.prediction.Nomination
import auction.results.NominationValue
import auction.results.ResultsGateway
import auction.results.ResultsView

import java.util.UUID
import scala.concurrent.ExecutionContext
import scala.concurrent.Future

/**
 * Номинация прогнозов на итоге экрана (PER-839): итоговое значение, число угадавших и их имена — то же, что ADR-067, п.
 * 9, показывает каждому в ботах. Чужих прогнозов и результатов участников здесь нет.
 */
final case class ScreenNomination(nomination: Nomination, value: NominationValue, winners: Int, names: List[String])

/**
 * Итоги прогнозов для итога экрана. Это украшение снимка: пока игра не подсчитана, подведена вручную или чтение не
 * ответило, раздела просто нет, а итог аукциона рисуется как раньше.
 */
trait ScreenPredictions {
  def read(auctionId: UUID): Future[List[ScreenNomination]]
}

object ScreenPredictions {

  val none: ScreenPredictions = _ => Future.successful(Nil)

  /** Номинации в порядке ADR-067; номинация без итогового значения не разыгрывалась и на экран не идёт. */
  def of(results: ResultsGateway)(using ExecutionContext): ScreenPredictions =
    auctionId =>
      Future
        .delegate(results.read(AuctionId(auctionId)))
        .map {
          case ResultsView.Counted(outcomes, rows) =>
            outcomes.flatMap { outcome =>
              outcome.value.map { value =>
                val names = rows.filter(row => row.guessed && row.nomination == outcome.nomination).map(_.name).sorted
                ScreenNomination(outcome.nomination, value, outcome.winners, names)
              }
            }
          case _ => Nil
        }
        .recover { case _ => Nil }
}
