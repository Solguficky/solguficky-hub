package auction.results

import auction.lot.AuctionId
import auction.lot.ParticipantId
import auction.prediction.Forecast
import auction.prediction.PredictionRound
import auction.prediction.PredictionStore

import scala.concurrent.Future

/**
 * Снимок исходов лотов реестра аукциона для подсчёта (ADR-067, п. 1): источник снимка — read model торгов. `None` —
 * снимок неполон, и подсчёт не начинается: в нём нет конечного состояния хотя бы одного лота реестра (п. 8).
 */
trait ResultsOutcomes {
  def outcomes(auction: AuctionId): Future[Option[List[LotOutcome]]]
}

/** Снимок прогнозов обоих раундов аукциона — всех участников и номинаций: вход подсчёта (ADR-067, п. 8). */
trait ResultsForecasts {
  def forecasts(auction: AuctionId): Future[Map[PredictionRound, Map[ParticipantId, Forecast]]]
}

object ResultsForecasts {

  /** Прогнозы аукциона берутся у их хранилища целиком: подсчёт читает обе стороны — и ответы, и их авторов. */
  def of(store: PredictionStore): ResultsForecasts = new ResultsForecasts {
    def forecasts(auction: AuctionId): Future[Map[PredictionRound, Map[ParticipantId, Forecast]]] = store.all(auction)
  }
}

/**
 * Имена участников аукциона на момент подсчёта (ADR-059, ADR-067, п. 3): имя угадавшего записывается строкой итога в
 * том виде, в каком его показывает хронология ставок. Участника без имени в ответе нет — имя подставит его отсутствие.
 */
trait ResultNames {
  def names(auction: AuctionId, participants: Set[ParticipantId]): Future[Map[ParticipantId, String]]
}
