package auction.prediction

import auction.entity.JournalCorrupted
import auction.entity.JournalSerializable

import java.time.Instant
import java.util.UUID

/*
 * Модель хранения прогнозов (ADR-058) — та же форма, что у розыгрыша: доменные типы в базу не пишутся, имя класса —
 * manifest строки, имена полей — ключи JSON, вариант — поле `kind` и не больше одной заполненной секции. Участников и
 * ответов в журнале нет по построению (ADR-067, п. 10): ни одна секция их не несёт. Snapshot у прогнозов нет — журнал
 * игры короткий, — поэтому восстановление идёт только по этим строкам.
 */

final case class StoredPredictionRound(round: String)

final case class StoredPredictionEventBody(
    kind: String,
    roundOpened: Option[StoredPredictionRound],
    roundClosed: Option[StoredPredictionRound]
)

/** Строка журнала прогнозов. Аукцион строки — её `persistence_id`. */
final case class StoredPredictionEvent(eventId: UUID, occurredAt: Instant, event: StoredPredictionEventBody)
    extends JournalSerializable

object PredictionJournal {

  def store(eventId: UUID, occurredAt: Instant)(event: PredictionEvent): StoredPredictionEvent =
    StoredPredictionEvent(eventId, occurredAt, storeEvent(event))

  def storeEvent(event: PredictionEvent): StoredPredictionEventBody =
    event match {
      case PredictionEvent.RoundOpened(round) =>
        StoredPredictionEventBody("RoundOpened", Some(StoredPredictionRound(storeRound(round))), None)
      case PredictionEvent.RoundClosed(round) =>
        StoredPredictionEventBody("RoundClosed", None, Some(StoredPredictionRound(storeRound(round))))
      case PredictionEvent.PredictionsCancelled => StoredPredictionEventBody("PredictionsCancelled", None, None)
      case PredictionEvent.PredictionsDiscarded => StoredPredictionEventBody("PredictionsDiscarded", None, None)
    }

  /** Ровно та секция, что названа `kind`, или ни одной у событий без payload. Иначе строка испорчена. */
  def restoreEvent(stored: StoredPredictionEventBody): PredictionEvent =
    stored match {
      case StoredPredictionEventBody("RoundOpened", Some(opened), None) =>
        PredictionEvent.RoundOpened(restoreRound(opened.round))
      case StoredPredictionEventBody("RoundClosed", None, Some(closed)) =>
        PredictionEvent.RoundClosed(restoreRound(closed.round))
      case StoredPredictionEventBody("PredictionsCancelled", None, None) => PredictionEvent.PredictionsCancelled
      case StoredPredictionEventBody("PredictionsDiscarded", None, None) => PredictionEvent.PredictionsDiscarded
      case other =>
        throw new JournalCorrupted(s"prediction event of kind ${other.kind} with sections that do not match it")
    }

  private def storeRound(round: PredictionRound): String =
    round match {
      case PredictionRound.Catalog => "catalog"
      case PredictionRound.Final => "final"
    }

  private def restoreRound(value: String): PredictionRound =
    value match {
      case "catalog" => PredictionRound.Catalog
      case "final" => PredictionRound.Final
      case _ => throw new JournalCorrupted("prediction round is neither catalog nor final")
    }
}
