package auction.entity

import auction.aggregate.LotOutcome
import auction.catalog.LotId

import scala.concurrent.Future

/**
 * Исходы лотов сета, какими их видит entity аукциона для правила «собрал» (ADR-073, п. 4). Журнал аукциона победителей
 * не хранит, а знание о лотах в памяти теряет его после рестарта, поэтому исходы берутся снимком read model торгов —
 * той же, по которой считаются итоги прогнозов. Лот без конечного исхода и лот, которого read model ещё не знает, в
 * ответе отсутствуют: отставание проекции — штатное ожидание, и следующий тик спросит снова. Неудачное `Future` —
 * ответа нет.
 */
trait AuctionSetOutcomes {
  def outcomes(lots: Set[LotId]): Future[Map[LotId, LotOutcome]]
}

object AuctionSetOutcomes {

  /** Узел без read model исходов: тесты аукциона, которым итог сета не нужен. Ни один лот не кончился. */
  val none: AuctionSetOutcomes = new AuctionSetOutcomes {
    def outcomes(lots: Set[LotId]): Future[Map[LotId, LotOutcome]] = Future.successful(Map.empty)
  }
}
