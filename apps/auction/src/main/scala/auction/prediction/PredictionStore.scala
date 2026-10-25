package auction.prediction

import auction.lot.AuctionId
import auction.lot.OpId
import auction.lot.ParticipantId

import scala.concurrent.Future

/** Прогнозы аукциона числами: участники с хотя бы одним ответом и ответы всех раундов. */
final case class PredictionTally(participants: Long, answers: Long)

/**
 * Прогнозы участников и окно их отправок — строки состояния рядом с журналом, как имя участника (ADR-059) и снимок
 * билетов розыгрыша (ADR-066): журнал не усекается, а прогнозы стираются по запросу субъекта (ADR-067, п. 10). Пишет
 * строки только entity прогнозов: она решает, открыт ли раунд, и не пускает запись мимо закрытия.
 */
trait PredictionStore {

  /**
   * Записывает прогноз раунда целиком — прежний заменяется, пустой очищает — и `op_id` отправки одной транзакцией.
   * `op_id`, уже записанный той же отправкой (тот же участник и раунд), не пишет ничего и отдаёт исходный прогноз этой
   * отправки, даже если его с тех пор поправили; чужой — `OpIdTaken`.
   */
  def submit(auction: AuctionId, command: SubmitForecast): Future[Either[SubmitRejected.OpIdTaken.type, Forecast]]

  /**
   * Повтор отправки в раунд, который больше не принимает: `None` — такой отправки не было, иначе исходный прогноз
   * своему повтору и `OpIdTaken` — чужому.
   */
  def recall(
      auction: AuctionId,
      participant: ParticipantId,
      round: PredictionRound,
      opId: OpId
  ): Future[Option[Either[SubmitRejected.OpIdTaken.type, Forecast]]]

  /** Прогнозы участника по раундам; раунда без прогноза в ответе нет. Чужих прогнозов этот порт не читает. */
  def mine(auction: AuctionId, participant: ParticipantId): Future[Map[PredictionRound, Forecast]]

  /**
   * Прогнозы всех участников аукциона по раундам — снимок, по которому считается точность (ADR-067, п. 8). Читает его
   * только подсчёт итогов: чужие прогнозы ни одному смотрящему не отдаются (п. 9).
   */
  def all(auction: AuctionId): Future[Map[PredictionRound, Map[ParticipantId, Forecast]]]

  /**
   * Сколько участников с непустым прогнозом и сколько у них ответов во всех раундах — для пульта администратора
   * (PER-734). Только числа: ни участника, ни ответа порт здесь не отдаёт.
   */
  def tally(auction: AuctionId): Future[PredictionTally]

  /** Удаляет прогнозы и окно отправок аукциона: аукцион удалён до торгов (ADR-067, п. 4). */
  def discard(auction: AuctionId): Future[Unit]

  /** Удаляет прогнозы и отправки участника во всех аукционах: запрос субъекта на удаление (ADR-067, п. 10). */
  def erase(participant: ParticipantId): Future[Unit]
}
