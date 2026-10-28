package auction.projection

import auction.catalog.LotCard
import auction.lot.Lot
import auction.lot.LotState
import auction.lot.Money

import java.time.Instant
import java.util.UUID
import scala.concurrent.Future

/**
 * Сет лота (ADR-073) в read model: название, лоты в порядке организатора и собравший — после итога и только у
 * собранного сета.
 */
final case class LotSetView(lotSetId: UUID, name: String, lots: List[UUID], collector: Option[UUID])

/**
 * Лот из read model вместе с карточкой каталога: карточку торги не знают (ADR-057), и она присоединяется при чтении.
 * `bidCount` — число строк `lot_bid` лота, ручных и прокси вместе (PER-320), без ставок снятых участников (PER-658).
 * `lotSet` — сет лота, только полный: сет меньше чем из двух лотов участнику не показывается (ADR-073, п. 3).
 */
final case class LotSnapshotView(
    lotId: UUID,
    auctionId: UUID,
    version: Long,
    lot: Lot,
    card: Option[LotCard],
    bidCount: Long = 0,
    lotSet: Option[LotSetView] = None
)

/**
 * Статистика лота реестра для ручного отбора финалистов (PER-481) и метрики финала для прогнозов (PER-608, ADR-067 п.
 * 6): только агрегаты, без участников и лимитов. `bidCount` считается тем же выражением по `lot_bid`, что
 * `LotSnapshotView.bidCount`, `participantCount` — по `lot_participant`, `lastBidAt` — время последней строки `lot_bid`
 * по номеру события; снятые участники и их ставки не считаются нигде (PER-658). `startingPrice` — стартовая роста
 * (ADR-067, дополнение 2026-10-28, PER-810): обычная стартовая `LotOpened`, а если первая неснятая ставка пришлась на
 * окно со стартовой ниже — стартовая окна, и не выше ни суммы этой ставки, ни цены последнего снятия участника; строки
 * нет, пока лот не открывался.
 *
 * `heldPrice` — цена, с которой лот удержан в D 00:00 (`HeldState.currentPrice` на `LotHeldForFinal`), а
 * `finalBidCount` — принятые ставки лота состава после его возврата в торги: строки `lot_bid` с номером события больше
 * `LotResumed`. Состав — заморозка `FinalLineupFrozen` (`auction_lineup`), а не признак удержания: удержанный лот,
 * проданный или снятый до заморозки, в состав не входит. У лота вне состава обеих метрик нет — `None`, а не ноль.
 *
 * `contest` — смены лидера и самая длинная дуэль за всю жизнь лота (PER-511), по его хронологии ядром [[LotContest]].
 */
final case class LotStatisticsView(
    lotId: UUID,
    lot: Lot,
    startingPrice: Option[Money],
    bidCount: Long,
    participantCount: Long,
    lastBidAt: Option[Instant],
    heldPrice: Option[Money] = None,
    finalBidCount: Option[Long] = None,
    contest: LotContest = LotContest.none
) {

  /**
   * Текущая цена минус стартовая — абсолютная сумма в валюте лота. До открытия стартовая цена — из условий торгов, и
   * рост нулевой; лот без условий роста не имеет. Лот без продажи закрылся без ставок, и его цена осталась стартовой.
   * Снятый лот цены не несёт: ставки на нём потеряли силу, и роста у него нет.
   */
  def priceGrowth: Option[Money] =
    lot.state match {
      case LotState.Initial | LotState.Draft | LotState.Withdrawn(_) => None
      case LotState.Scheduled(schedule) => Some(schedule.startingPrice.copy(minorUnits = 0))
      case LotState.Trading(state) => startingPrice.map(growth(state.currentPrice, _))
      case LotState.Held(state) => startingPrice.map(growth(state.currentPrice, _))
      case LotState.Sold(sale) => startingPrice.map(growth(sale.price, _))
      case LotState.Unsold(_) => startingPrice.map(_.copy(minorUnits = 0))
    }

  /**
   * Рост лота состава в финале — от цены удержания, а не от стартовой: у лота без ставок в финале ведущий продаёт его
   * по цене удержания, и рост нулевой. На момент подсчёта прогнозов (переход в `Finished`) лот состава продан или
   * закрыт без продажи, поэтому промежуточные состояния для итога нерелевантны, но считаются так же, как `priceGrowth`.
   * У лота вне состава цены удержания нет, и роста в финале у него нет.
   */
  def finalGrowth: Option[Money] =
    heldPrice.flatMap { held =>
      lot.state match {
        case LotState.Trading(state) => Some(growth(state.currentPrice, held))
        case LotState.Held(state) => Some(growth(state.currentPrice, held))
        case LotState.Sold(sale) => Some(growth(sale.price, held))
        case LotState.Unsold(_) => Some(held.copy(minorUnits = 0))
        case _ => None
      }
    }

  private def growth(current: Money, start: Money): Money =
    if (current.currency != start.currency)
      throw IllegalStateException(s"lot $lotId trades in ${current.currency.value}, opened in ${start.currency.value}")
    else Money(current.minorUnits - start.minorUnits, start.currency)
}

/**
 * Статистика лота за окно (PER-492): сколько принятых ставок лот получил в окне, до какой цены он в нём дошёл и какова
 * была его цена к открытию окна. Число ставок и максимум считаются по строкам `lot_bid` окна без ставок снятых
 * участников, `priceBefore` — цена последней до окна ставки или снятия участника (PER-658), с которой лот пошёл дальше,
 * а без них — стартовая цена `LotOpened`. Полей участников здесь нет намеренно: сводка дня зовёт лот по цене и
 * оспоренности, а не по людям. `contest` — смены лидера и самая длинная дуэль внутри окна (PER-511): лидер к открытию
 * окна берётся из хронологии до него.
 */
final case class DayLotStatisticsView(
    lotId: UUID,
    bidCount: Long,
    maxPrice: Option[Money],
    priceBefore: Option[Money],
    contest: LotContest = LotContest.none
) {

  /**
   * Рост за окно — максимум окна минус цена, с которой окно открылось, абсолютная сумма в валюте лота. Ставок в окне не
   * было — роста нет; цены к открытию окна не было — тоже. Расхождение валют — испорченный read model, а не нулевой
   * рост.
   */
  def growth: Option[Money] =
    maxPrice.flatMap(top => priceBefore.map(before => difference(top, before)))

  private def difference(top: Money, before: Money): Money =
    if (top.currency != before.currency)
      throw IllegalStateException(
        s"lot $lotId trades in ${top.currency.value}, opened in ${before.currency.value}"
      )
    else Money(top.minorUnits - before.minorUnits, before.currency)
}

/** Изображение лота так, как оно лежит в строке каталога: байты, тип и версия этих байтов. */
final case class LotImageView(content: IArray[Byte], mediaType: String, version: String)

/**
 * Чтение read model лота. Его пишет проекция, поэтому ответ отстаёт от entity на время её обработки: сразу после
 * команды прочитанное может ещё не содержать её события.
 */
trait LotViews {
  def find(lotId: UUID): Future[Option[LotSnapshotView]]

  /** Лоты, рождённые в аукционе, по возрастанию `lot_id`, строго после `after`, не больше `limit`. */
  def page(auctionId: UUID, after: Option[UUID], limit: Int): Future[List[LotSnapshotView]]

  /**
   * Лоты реестра аукциона сходки (`auction_lot`) в том же порядке. Снятый лот остаётся рождённым в аукционе, но в
   * реестре его нет. Лот реестра без журнала лота в выдачу не попадает: снимка торгов у него ещё нет.
   */
  def registryPage(auctionId: UUID, after: Option[UUID], limit: Int): Future[List[LotSnapshotView]]

  /**
   * Изображение лота, который виден в read model. Лота нет в read model или у него нет изображения — `None`: виден лот
   * ровно тогда, когда его отдаёт `find`.
   */
  def image(lotId: UUID): Future[Option[LotImageView]]

  /** Фото лота, который виден в read model, по id фото; лота или фото нет — `None`, как у `image`. */
  def photo(lotId: UUID, photoId: UUID): Future[Option[LotImageView]]

  /**
   * Ставки и снятия участников лота по возрастанию номера события в журнале, строго после `after`, не больше `limit`.
   * Порядок — журнала, а не часов: события одной команды делят время. Ставка снятого участника приходит с пометкой
   * (PER-658). `None` — read model лота не знает; лот без ставок — пустой список.
   */
  def history(lotId: UUID, after: Option[Long], limit: Int): Future[Option[List[HistoryRecord]]]

  /**
   * Статистика каждого лота реестра аукциона сходки по возрастанию `lot_id`, без страниц. Лот реестра, которого read
   * model ещё не знает, в выдачу не попадает, как у `registryPage`.
   */
  def statistics(auctionId: UUID): Future[List[LotStatisticsView]]

  /**
   * Статистика каждого лота реестра аукциона сходки за окно `[from, until)` по возрастанию `lot_id`, без страниц. Лот
   * реестра, которого read model ещё не знает, в выдачу не попадает, как у `registryPage`; лот без ставок в окне
   * приходит с нулём ставок и без цены, а не пропускается — «ставок не было» читается потребителем по всем лотам.
   */
  def dayStatistics(auctionId: UUID, from: Instant, until: Instant): Future[List[DayLotStatisticsView]]

  /**
   * Число разных людей среди участников лотов реестра аукциона сходки (PER-769): строки `lot_participant` без снятых,
   * каждый человек один раз на аукцион, сколько бы лотов он ни вёл.
   */
  def participantCount(auctionId: UUID): Future[Long]
}
