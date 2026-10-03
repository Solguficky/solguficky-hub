package auction.projection

import auction.catalog.LotCard
import auction.lot.Lot

import java.util.UUID
import scala.concurrent.Future

/**
 * Лот из read model вместе с карточкой каталога: карточку торги не знают (ADR-057), и она присоединяется при чтении.
 */
final case class LotSnapshotView(lotId: UUID, auctionId: UUID, version: Long, lot: Lot, card: Option[LotCard])

/**
 * Чтение read model лота. Его пишет проекция, поэтому ответ отстаёт от entity на время её обработки: сразу после
 * команды прочитанное может ещё не содержать её события.
 */
trait LotViews {
  def find(lotId: UUID): Future[Option[LotSnapshotView]]

  /** Лоты аукциона по возрастанию `lot_id`, строго после `after`, не больше `limit`. */
  def page(auctionId: UUID, after: Option[UUID], limit: Int): Future[List[LotSnapshotView]]
}
