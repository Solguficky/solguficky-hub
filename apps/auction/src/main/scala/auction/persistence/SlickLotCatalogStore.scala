package auction.persistence

import auction.catalog.CardEdit
import auction.catalog.ImageChange
import auction.catalog.ImageVersion
import auction.catalog.LotCard
import auction.catalog.LotCatalogStore
import auction.catalog.LotId
import auction.catalog.LotTitle
import auction.catalog.NewCard
import org.apache.pekko.actor.typed.ActorSystem
import org.apache.pekko.persistence.jdbc.db.SlickExtension
import slick.jdbc.JdbcBackend.Database
import slick.jdbc.PostgresProfile.api.*
import slick.jdbc.SetParameter

import scala.concurrent.ExecutionContext
import scala.concurrent.Future

/**
 * Карточки лотов в таблице `lot_catalog` через пул плагина журнала.
 *
 * Отдельного пула нет намеренно: команды каталога редки, а общий пул уже покрыт таймаутами подключения и пробой
 * готовности. Схему ведёт Flyway, поэтому запросы — plain SQL, а не lifted-модель, второй раз описывающая таблицу.
 *
 * Байты изображения читает только [[SlickLotViews]] для `GetLotImage`: карточке нужна версия, и запросы здесь колонку
 * `image` не выбирают.
 */
final class SlickLotCatalogStore(database: Database)(using ExecutionContext) extends LotCatalogStore {

  // `setBytesOption(None)` шлёт NULL с типом BLOB, и PostgreSQL читает его как `oid`, а не `bytea`: вставка падает.
  private given SetParameter[Option[Array[Byte]]] =
    SetParameter((value, params) => value.fold(params.setNull(java.sql.Types.BINARY))(params.setBytes))

  private def select(lotId: LotId) =
    sql"SELECT title, description, image_version FROM lot_catalog WHERE lot_id = ${lotId.value.toString}::uuid"
      .as[(String, String, Option[String])]
      .headOption
      .map(_.map((title, description, version) => card(lotId, title, description, version)))

  def insertIfAbsent(created: NewCard): Future[Option[LotCard]] = {
    val image = created.image
    database.run(
      sqlu"""INSERT INTO lot_catalog (lot_id, title, description, image, image_media_type, image_version)
             VALUES (${created.lotId.value.toString}::uuid, ${created.title.value}, ${created.description},
                     ${image.map(stored => IArray.genericWrapArray(stored.content).toArray)}, ${image.map(
          _.mediaType.value
        )}, ${image.map(_.version.value)})
             ON CONFLICT (lot_id) DO NOTHING""".flatMap {
        case 1 => DBIO.successful(None)
        // Конфликт вставки значит, что строка есть. Если её уже нет, ответ «вставлено» соврал бы: ничего не записано.
        case _ =>
          select(created.lotId).flatMap {
            case Some(existing) => DBIO.successful(Some(existing))
            case None =>
              DBIO.failed(
                IllegalStateException(s"lot_catalog row for lot ${created.lotId.value} vanished after a conflict")
              )
          }
      }
    )
  }

  // Версия в ответе — из строки после записи, а не из команды: при `Keep` команда её не знает.
  def update(edit: CardEdit): Future[Option[LotCard]] = {
    val lotId = edit.lotId.value.toString
    val updated = edit.image match {
      case ImageChange.Keep =>
        sql"""UPDATE lot_catalog SET title = ${edit.title.value}, description = ${edit.description}
              WHERE lot_id = $lotId::uuid RETURNING image_version"""
      case ImageChange.Replace(image) =>
        sql"""UPDATE lot_catalog SET title = ${edit.title.value}, description = ${edit.description},
                image = ${Option(
            IArray.genericWrapArray(image.content).toArray
          )}, image_media_type = ${image.mediaType.value},
                image_version = ${image.version.value}
              WHERE lot_id = $lotId::uuid RETURNING image_version"""
      case ImageChange.Remove =>
        sql"""UPDATE lot_catalog SET title = ${edit.title.value}, description = ${edit.description},
                image = NULL, image_media_type = NULL, image_version = NULL
              WHERE lot_id = $lotId::uuid RETURNING image_version"""
    }
    database
      .run(updated.as[Option[String]].headOption)
      .map(_.map(version => LotCard(edit.lotId, edit.title, edit.description, version.map(ImageVersion(_)))))
  }

  def find(lotId: LotId): Future[Option[LotCard]] = database.run(select(lotId))

  private def card(lotId: LotId, title: String, description: String, version: Option[String]): LotCard =
    LotCard(lotId, restored(lotId, title), description, version.map(ImageVersion(_)))

  // Строка прошла CHECK таблицы, а он слабее типа: пробельный символ вне ASCII-пробела btrim не срезает. Такая строка —
  // запись в обход сервиса, и молча выдать её за корректную карточку нельзя.
  private def restored(lotId: LotId, title: String): LotTitle =
    LotTitle(title).getOrElse(
      throw IllegalStateException(s"lot_catalog holds a blank title for lot ${lotId.value}")
    )
}

object SlickLotCatalogStore {

  def apply(system: ActorSystem[?]): SlickLotCatalogStore = {
    val database = SlickExtension(system).database(system.settings.config.getConfig("jdbc-journal")).database
    new SlickLotCatalogStore(database)(using system.executionContext)
  }
}
