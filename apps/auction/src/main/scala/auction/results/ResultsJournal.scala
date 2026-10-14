package auction.results

import auction.entity.JournalCorrupted
import auction.entity.JournalSerializable
import auction.prediction.Nomination

import java.time.Instant
import java.util.UUID

/*
 * Модель хранения итогов прогнозов (ADR-058) — та же форма, что у прогнозов и розыгрыша: доменные типы в базу не
 * пишутся, имя класса — manifest строки, имена полей — ключи JSON, вариант — поле `kind` и не больше одной заполненной
 * секции. Участников и имён в журнале нет по построению (ADR-067, п. 10): их не несёт ни одна секция, и стирание по
 * запросу субъекта — удаление строк ([[ResultsStore]]), которое восстановление по журналу вернуть не может. Snapshot у
 * итогов нет — журнал короткий, поэтому восстановление идёт только по этим строкам.
 */

/** Значение номинации в строке: `lots` или `number`, ровно одно из двух. `number` — всегда число: ноль у `lots`. */
final case class StoredNominationValue(kind: String, lots: List[UUID], number: Long)

/** Итог одной номинации в строке: имя номинации, значение и число угадавших. */
final case class StoredNominationOutcome(nomination: String, value: Option[StoredNominationValue], winners: Int)

final case class StoredResultsSettled(outcomes: List[StoredNominationOutcome])

final case class StoredResultsEventBody(kind: String, resultsSettled: Option[StoredResultsSettled])

/** Строка журнала итогов. Аукцион строки — её `persistence_id`. */
final case class StoredResultsEvent(eventId: UUID, occurredAt: Instant, event: StoredResultsEventBody)
    extends JournalSerializable

object ResultsJournal {

  def store(eventId: UUID, occurredAt: Instant)(event: ResultsEvent): StoredResultsEvent =
    StoredResultsEvent(eventId, occurredAt, storeEvent(event))

  def storeEvent(event: ResultsEvent): StoredResultsEventBody =
    event match {
      case ResultsEvent.ResultsSettled(outcomes) =>
        StoredResultsEventBody("ResultsSettled", Some(StoredResultsSettled(outcomes.map(storeOutcome))))
      case ResultsEvent.ResultsRecordedManually => StoredResultsEventBody("ResultsRecordedManually", None)
      case ResultsEvent.ResultsDiscarded => StoredResultsEventBody("ResultsDiscarded", None)
    }

  /** Ровно та секция, что названа `kind`, или ни одной у событий без payload. Иначе строка испорчена. */
  def restoreEvent(stored: StoredResultsEventBody): ResultsEvent =
    stored match {
      case StoredResultsEventBody("ResultsSettled", Some(settled)) =>
        ResultsEvent.ResultsSettled(settled.outcomes.map(restoreOutcome))
      case StoredResultsEventBody("ResultsRecordedManually", None) => ResultsEvent.ResultsRecordedManually
      case StoredResultsEventBody("ResultsDiscarded", None) => ResultsEvent.ResultsDiscarded
      case other =>
        throw new JournalCorrupted(s"results event of kind ${other.kind} with sections that do not match it")
    }

  /**
   * Имена номинаций в строках журнала и таблицы — формат хранения: их переименование делает строки нечитаемыми, поэтому
   * они перечислены здесь, а не выводятся из имён доменных типов. Тот же формат, что у прогнозов ([[PredictionStore]]).
   */
  val nominationNames: Map[Nomination, String] = Map(
    Nomination.MostExpensiveLot -> "most_expensive_lot",
    Nomination.TotalSales -> "total_sales",
    Nomination.MostBidsLot -> "most_bids_lot",
    Nomination.BiggestGrowthLot -> "biggest_growth_lot",
    Nomination.MostBiddersLot -> "most_bidders_lot",
    Nomination.TotalBids -> "total_bids",
    Nomination.FinalMostExpensiveLot -> "final_most_expensive_lot",
    Nomination.FinalTotalSales -> "final_total_sales",
    Nomination.FinalBiggestGrowthLot -> "final_biggest_growth_lot",
    Nomination.FinalTotalBids -> "final_total_bids"
  )

  private val nominationsByName: Map[String, Nomination] = nominationNames.map(_.swap)

  def nominationName(nomination: Nomination): String = nominationNames(nomination)

  def restoreNomination(name: String): Nomination =
    nominationsByName.getOrElse(name, throw new JournalCorrupted("results row names an unknown nomination"))

  private def storeOutcome(outcome: NominationOutcome): StoredNominationOutcome =
    StoredNominationOutcome(nominationName(outcome.nomination), outcome.value.map(storeValue), outcome.winners)

  private def storeValue(value: NominationValue): StoredNominationValue =
    value match {
      case NominationValue.Lots(lots) =>
        StoredNominationValue("lots", lots.toList.map(_.value).sortBy(_.toString), 0L)
      case NominationValue.Number(number) => StoredNominationValue("number", Nil, number)
    }

  private def restoreOutcome(stored: StoredNominationOutcome): NominationOutcome =
    NominationOutcome(restoreNomination(stored.nomination), stored.value.map(restoreValue), stored.winners)

  private def restoreValue(stored: StoredNominationValue): NominationValue =
    stored match {
      case StoredNominationValue("lots", lots, _) =>
        NominationValue.Lots(lots.map(auction.catalog.LotId(_)).toSet)
      case StoredNominationValue("number", Nil, number) => NominationValue.Number(number)
      case other => throw new JournalCorrupted(s"results nomination value of kind ${other.kind} is not readable")
    }
}
