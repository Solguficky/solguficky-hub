package auction.screen

import java.util.UUID
import scala.concurrent.Future

/**
 * Чтение для экрана зала. Аукцион, лоты состава, последние ставки активного лота и проданные лоты читаются одним
 * снимком базы: проекции аукциона и лота пишут независимо, и отдельные чтения сложили бы экран из разных моментов.
 */
trait ScreenViews {

  /** `None` — аукциона нет в read model: он не рождался или удалён до торгов. */
  def read(auctionId: UUID): Future[Option[ScreenReading]]

  /**
   * Изображение лота аукциона в версии `version`. `None` — лота нет в этом аукционе, изображения нет или версия не
   * текущая: адрес прежней версии не отдаёт текущих байтов, иначе кэш под старым адресом запомнил бы чужое фото.
   */
  def image(auctionId: UUID, lotId: UUID, version: String): Future[Option[ScreenImage]]
}

final case class ScreenImage(content: IArray[Byte], mediaType: String)
