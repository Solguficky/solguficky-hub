package auction.projection

import java.time.Instant
import java.util.UUID

/**
 * Борьба за лот (PER-511, P-15 RFC-007): сколько раз сменился лидер и сколько смен подряд заняла самая длинная дуэль —
 * лидерство, которое переходило только между одними и теми же двумя людьми. Только агрегаты, без участников: кто
 * дрался, сводка не называет.
 */
final case class LotContest(leaderChanges: Long, longestDuel: Long)

/**
 * Чистое ядро метрик борьбы. Считает их по хронологии лота из read model — строкам `lot_bid` и `lot_removal` в порядке
 * журнала, — а не счётчиками проекции: снятие участника (ADR-072, PER-658) задним числом помечает его ставки, и счётчик
 * пришлось бы пересчитывать по всей истории лота. Хронология сама перестраивается из журнала тождественно, поэтому и
 * метрики после перестройки те же.
 *
 * Правило лидера: автор принятой ставки становится лидером — лидер сам себя не перебивает (`BidderIsLeader`), а прокси
 * ставит от имени владельца лимита. Ставка снятого участника не считается. Снятие ставит лидером того, с кем лот пошёл
 * дальше; сменой оно не считается, а дуэль, лидера которой оно сменило, прерывает. Подряд идущие ставки одного лидера —
 * остаток производных ставок после снятия — одна позиция, а не смена. Первая ставка лидера не сменяет: его не было.
 */
object LotContest {

  val none: LotContest = LotContest(0, 0)

  /**
   * Метрики по хронологии одного лота в порядке номера события. `window` — полуоткрытое окно `[from, until)`: в счёт
   * идут только смены внутри него, а лидер к открытию окна берётся из записей до него. Дуэль, начатая до окна, в окне
   * считается с первой смены окна.
   */
  def of(history: Seq[HistoryRecord], window: Option[(Instant, Instant)] = None): LotContest = {
    def inside(at: Instant): Boolean = window.forall((from, until) => !at.isBefore(from) && at.isBefore(until))

    final case class Duel(pair: Set[UUID], length: Long)
    final case class Course(leader: Option[UUID], changes: Long, duel: Option[Duel], longest: Long)

    val course = history.foldLeft(Course(None, 0, None, 0)) {
      case (course, HistoryRecord.Bid(bid)) if bid.removed => course
      case (course, HistoryRecord.Bid(bid)) =>
        course.leader match {
          case Some(leader) if leader == bid.participant => course
          case Some(leader) if inside(bid.occurredAt) =>
            val pair = Set(leader, bid.participant)
            val duel =
              course.duel.filter(_.pair == pair).fold(Duel(pair, 1))(duel => duel.copy(length = duel.length + 1))
            Course(Some(bid.participant), course.changes + 1, Some(duel), course.longest.max(duel.length))
          case _ => course.copy(leader = Some(bid.participant), duel = None)
        }
      case (course, removal: HistoryRecord.Removal) =>
        if (removal.leader == course.leader) course else course.copy(leader = removal.leader, duel = None)
    }
    LotContest(course.changes, course.longest)
  }
}
