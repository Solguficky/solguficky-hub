package auction.projection

import auction.catalog.LotCard
import auction.lot.Lot
import auction.lot.LotState
import auction.lot.Money

import java.time.Instant
import java.util.UUID
import scala.concurrent.Future

/**
 * Лот из read model вместе с карточкой каталога: карточку торги не знают (ADR-057), и она присоединяется при чтении.
 * `bidCount` — число строк `lot_bid` лота, ручных и прокси вместе (PER-320).
 */
final case class LotSnapshotView(
    lotId: UUID,
    auctionId: UUID,
    version: Long,
    lot: Lot,
    card: Option[LotCard],
    bidCount: Long = 0
)

/**
 * Статистика лота реестра для ручного отбора финалистов (PER-481): только агрегаты, без участников и лимитов.
 * `bidCount` считается тем же выражением по `lot_bid`, что `LotSnapshotView.bidCount`, `participantCount` — по
 * `lot_participant`, `lastBidAt` — время последней строки `lot_bid` по номеру события. `startingPrice` — из
 * `LotOpened`: строки нет, пока лот не открывался.
 */
final case class LotStatisticsView(
    lotId: UUID,
    lot: Lot,
    startingPrice: Option[Money],
    bidCount: Long,
    participantCount: Long,
    lastBidAt: Option[Instant]
) {

  /**
   * Текущая цена минус стартовая — абсолютная сумма в валюте лота. До открытия стартовая цена — из условий торгов, и
   * рост нулевой; лот без условий роста не имеет. Лот без продажи закрылся без ставок, и его цена осталась стартовой.
   */
  def priceGrowth: Option[Money] =
    lot.state match {
      case LotState.Initial | LotState.Draft => None
      case LotState.Scheduled(schedule) => Some(schedule.startingPrice.copy(minorUnits = 0))
      case LotState.Trading(state) => startingPrice.map(growth(state.currentPrice, _))
      case LotState.Held(state) => startingPrice.map(growth(state.currentPrice, _))
      case LotState.Sold(sale) => startingPrice.map(growth(sale.price, _))
      case LotState.Unsold(_) => startingPrice.map(_.copy(minorUnits = 0))
    }

  private def growth(current: Money, start: Money): Money =
    if (current.currency != start.currency)
      throw IllegalStateException(s"lot $lotId trades in ${current.currency.value}, opened in ${start.currency.value}")
    else Money(current.minorUnits - start.minorUnits, start.currency)
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

  /**
   * Ставки лота по возрастанию номера события в журнале, строго после `after`, не больше `limit`. Порядок — журнала, а
   * не часов: события одной команды делят время. `None` — read model лота не знает; лот без ставок — пустой список.
   */
  def history(lotId: UUID, after: Option[Long], limit: Int): Future[Option[List[BidRecord]]]

  /**
   * Статистика каждого лота реестра аукциона сходки по возрастанию `lot_id`, без страниц. Лот реестра, которого read
   * model ещё не знает, в выдачу не попадает, как у `registryPage`.
   */
  def statistics(auctionId: UUID): Future[List[LotStatisticsView]]
}
