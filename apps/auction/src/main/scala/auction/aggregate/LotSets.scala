package auction.aggregate

import auction.catalog.LotId
import auction.lot.OpId
import auction.lot.ParticipantId

import java.util.UUID

/** Коллекционный сет лотов аукциона (ADR-073). Идентификатор выбирает вызывающий: тот же идентификатор правит сет. */
final case class LotSetId(value: UUID)

/** Название сета: непустое, без одних пробелов — то же правило, что у названия лота в каталоге. */
final case class LotSetName private (value: String)

object LotSetName {

  def apply(raw: String): Either[SaveLotSetRejected, LotSetName] =
    if (raw.forall(blank)) Left(SaveLotSetRejected.NameEmpty) else Right(new LotSetName(raw))

  // `isBlank` неразрывные пробелы (U+00A0, U+2007, U+202F) пробелом не считает, а на экране они пусты так же.
  private def blank(c: Char): Boolean = Character.isWhitespace(c) || Character.isSpaceChar(c)
}

/**
 * Итог сета (ADR-073, пп. 4–6): собран одним участником или не собран никем. Записывается один раз, когда каждый лот
 * полного сета пришёл к конечному исходу, и больше не меняется.
 */
enum LotSetSettlement {
  case Collected(by: ParticipantId)
  case NotCollected
}

/**
 * Сет: название, лоты в порядке организатора и итог, если он уже записан. Сет меньше чем из двух лотов команда
 * принимает — организатор собирает его постепенно, — но сетом он не считается: такой сет неполный (ADR-073, п. 1), и
 * итога у него не бывает.
 */
final case class LotSet(name: LotSetName, lots: List[LotId], settlement: Option[LotSetSettlement] = None) {
  def complete: Boolean = lots.sizeIs >= 2
}

/**
 * Конечный исход лота для правила «собрал»: аукцион узнаёт его из read model торгов, а не из своего журнала.
 * `NotOpened` — аукцион кончился, а лот так и не открывался: он не продан, как `Unsold`.
 */
enum LotOutcome {
  case Sold(winner: ParticipantId)
  case Unsold
  case Withdrawn
  case NotOpened
}

/**
 * Определение сета организатором: название и лоты целиком. Повторы лота — один лот: сет держит первое вхождение. Тот же
 * `set` заменяет прежнее определение.
 */
final case class SaveLotSet(set: LotSetId, name: LotSetName, lots: List[LotId], opId: OpId)

final case class DeleteLotSet(set: LotSetId, opId: OpId)

/**
 * Итог сета (ADR-073, п. 4): отдаёт его entity аукциона, когда снимок исходов лотов сета прочитан. `outcomes` — только
 * лоты в конечном исходе: лот, которого в них нет, ещё торгуется или read model о нём не знает. `op_id` выводится от
 * `op_id` открытия и сета ([[LotSets.settlementOf]]), поэтому повтор после рестарта упирается в окно `seen`.
 */
final case class SettleLotSet(set: LotSetId, outcomes: Map[LotId, LotOutcome], opId: OpId)

/**
 * Отказы определения сета: аукциона нет, реестр заморожен стартом торгов — сет замерзает вместе с ним (ADR-073, п. 2),
 * название пустое, лота нет в реестре или лот уже в другом сете — оба называют первый такой лот в порядке запроса.
 */
enum SaveLotSetRejected {
  case AuctionNotFound
  case LotsFrozen
  case NameEmpty
  case LotNotInAuction(lot: LotId)
  case LotInAnotherSet(lot: LotId, set: LotSetId)
}

/** Отказы удаления сета: аукциона нет, сеты заморожены стартом торгов или сета нет. */
enum DeleteLotSetRejected {
  case AuctionNotFound
  case LotsFrozen
  case LotSetNotFound
}

/**
 * Отказ итога сета: торги не начались, сета нет или он неполный, итог уже записан, не каждый лот сета пришёл к
 * конечному исходу. Это не отказ человеку, а «записывать нечего»: entity его не передаёт никому.
 */
enum SettleLotSetRejected {
  case NotStarted
  case LotSetNotFound
  case AlreadySettled
  case NotTerminal
}

object LotSets {

  /**
   * Правило «собрал» (ADR-073, пп. 4–6) — функция от состава сета и исходов его лотов. Пока хоть один лот сета без
   * конечного исхода, итога нет. Каждый лот продан одному участнику — собран им; сравнение по идентификатору, а не по
   * имени. Хоть один лот не продан, снят или продан другому — сет не собран никем.
   */
  def verdict(set: LotSet, outcomes: Map[LotId, LotOutcome]): Option[LotSetSettlement] = {
    val known = set.lots.flatMap(outcomes.get)
    if (known.sizeIs < set.lots.size) None
    else
      known match {
        case LotOutcome.Sold(first) :: rest if rest.forall(_ == LotOutcome.Sold(first)) =>
          Some(LotSetSettlement.Collected(first))
        case _ => Some(LotSetSettlement.NotCollected)
      }
  }

  /** Полные сеты без записанного итога: их итог аукцион ещё должен записать. */
  def awaiting(auction: Auction): Map[LotSetId, LotSet] =
    auction.sets.filter((_, set) => set.complete && set.settlement.isEmpty)

  /**
   * Следующий итог, который можно записать по снимку исходов: первый по идентификатору полный сет без итога, у которого
   * каждый лот пришёл к конечному исходу. Только принятое решение: повтор `op_id` ничего не пишет, и сет, на котором он
   * случился бы, дальше не выбирается.
   */
  def next(auction: Auction, outcomes: Map[LotId, LotOutcome]): Option[(OpId, AuctionEvent)] =
    auction.state.started.flatMap { (_, startedBy) =>
      awaiting(auction).keys.toList
        .sortBy(_.value)
        .iterator
        .flatMap { set =>
          val settle = SettleLotSet(set, outcomes, settlementOf(startedBy, set))
          Auction.decide(auction, settle).toOption.collect { case AuctionDecision.Accepted(event) =>
            settle.opId -> event
          }
        }
        .nextOption()
    }

  /**
   * Лоты полных сетов без итога, исхода которых в снимке нет: они ещё торгуются, отстали в read model или не
   * открывались.
   */
  def unknown(auction: Auction, outcomes: Map[LotId, LotOutcome]): Set[LotId] =
    awaiting(auction).values.flatMap(_.lots).filterNot(outcomes.contains).toSet

  /**
   * `op_id` итога сета — шаг аукциона без человека от `op_id` открытия и сета, как завершение лота финала. Один и тот
   * же после любого рестарта: второй подсчёт упирается в окно `seen`.
   */
  def settlementOf(startedBy: OpId, set: LotSetId): OpId =
    LotRoster.stepOpId(startedBy, s"lot-set-settled/${set.value}")
}
