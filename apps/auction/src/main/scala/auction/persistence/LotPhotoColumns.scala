package auction.persistence

import auction.catalog.ImageVersion
import auction.catalog.LotPhotoRef
import auction.catalog.PhotoId

import java.util.UUID

/**
 * Фото лота одной колонкой выборки: id и версии из `lot_photo` в порядке `position` строкой `id:версия,…`. Так карточка
 * читается тем же запросом, что строка каталога, без второго чтения на каждый лот. Разделители не встречаются ни в
 * UUID, ни в hex-версии.
 */
private[persistence] object LotPhotoColumns {

  /** Подзапрос по лоту, чей `lot_id` — выражение `lotColumn` внешнего запроса. Нет фото — NULL. */
  def sql(lotColumn: String): String =
    s"""(SELECT string_agg(p.photo_id::text || ':' || p.version, ',' ORDER BY p.position)
       |  FROM lot_photo p WHERE p.lot_id = $lotColumn)""".stripMargin

  def parse(column: Option[String]): Vector[LotPhotoRef] =
    column.toVector.flatMap(_.split(',').toVector).map { entry =>
      entry.split(':') match {
        case Array(id, version) => LotPhotoRef(PhotoId(UUID.fromString(id)), ImageVersion(version))
        case _ => throw IllegalStateException(s"lot_photo aggregate holds a malformed entry: $entry")
      }
    }
}
