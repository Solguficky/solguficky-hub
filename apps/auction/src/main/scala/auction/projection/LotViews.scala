package auction.projection

import auction.catalog.LotCard
import auction.lot.Lot

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
}
