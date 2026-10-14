package auction.results

import auction.lot.AuctionId
import auction.lot.ParticipantId
import auction.prediction.Nomination

import scala.concurrent.Future

/** Строка итога участника по одной номинации: угадал или нет, у числа — отклонение, и имя на момент подсчёта. */
final case class ResultRow(
    participant: ParticipantId,
    nomination: Nomination,
    guessed: Boolean,
    deviation: Option[Long],
    name: String
)

/**
 * Итоги участников и имена угадавших — строки состояния рядом с журналом, как имя участника (ADR-059) и прогнозы
 * (ADR-067, п. 10): журнал не усекается, а имя стирается по запросу субъекта, и восстановление по журналу вернуть его
 * не может. Пишет строки только entity итогов: она решает, что подсчёт состоялся, и не пускает запись мимо него.
 */
trait ResultsStore {

  /**
   * Записывает строки подсчёта одной транзакцией. Повтор не перезаписывает записанное: снимок имён сделан один раз, при
   * подсчёте, и повторный подсчёт его не сдвигает.
   */
  def record(auction: AuctionId, rows: List[ResultRow]): Future[Unit]

  /** Строки итогов аукциона; до подсчёта их нет. */
  def read(auction: AuctionId): Future[List[ResultRow]]

  /** Удаляет строки участника во всех аукционах: запрос субъекта на удаление (ADR-067, п. 10). */
  def erase(participant: ParticipantId): Future[Unit]

  /** Удаляет строки аукциона: аукцион удалён до торгов. */
  def discard(auction: AuctionId): Future[Unit]
}
