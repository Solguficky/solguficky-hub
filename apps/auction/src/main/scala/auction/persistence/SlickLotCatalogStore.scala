package auction.persistence

import auction.catalog.LotCard
import auction.catalog.LotCatalogStore
import auction.catalog.LotId
import auction.catalog.LotTitle
import org.apache.pekko.actor.typed.ActorSystem
import org.apache.pekko.persistence.jdbc.db.SlickExtension
import slick.jdbc.JdbcBackend.Database
import slick.jdbc.PostgresProfile.api.*

import scala.concurrent.ExecutionContext
import scala.concurrent.Future

/**
 * Карточки лотов в таблице `lot_catalog` через пул плагина журнала.
 *
 * Отдельного пула нет намеренно: команды каталога редки, а общий пул уже покрыт таймаутами подключения и пробой
 * готовности. Схему ведёт Flyway, поэтому запросы — plain SQL, а не lifted-модель, второй раз описывающая таблицу.
 */
final class SlickLotCatalogStore(database: Database)(using ExecutionContext) extends LotCatalogStore {

  private def select(lotId: LotId) =
    sql"SELECT title, description FROM lot_catalog WHERE lot_id = ${lotId.value.toString}::uuid"
      .as[(String, String)]
      .headOption
      .map(_.map((title, description) => LotCard(lotId, restored(lotId, title), description)))

  def insertIfAbsent(card: LotCard): Future[Option[LotCard]] =
    database.run(
      sqlu"""INSERT INTO lot_catalog (lot_id, title, description)
             VALUES (${card.lotId.value.toString}::uuid, ${card.title.value}, ${card.description})
             ON CONFLICT (lot_id) DO NOTHING""".flatMap {
        case 1 => DBIO.successful(None)
        // Конфликт вставки значит, что строка есть. Если её уже нет, ответ «вставлено» соврал бы: ничего не записано.
        case _ =>
          select(card.lotId).flatMap {
            case Some(existing) => DBIO.successful(Some(existing))
            case None =>
              DBIO.failed(
                IllegalStateException(s"lot_catalog row for lot ${card.lotId.value} vanished after a conflict")
              )
          }
      }
    )

  def update(card: LotCard): Future[Boolean] =
    database
      .run(
        sqlu"""UPDATE lot_catalog SET title = ${card.title.value}, description = ${card.description}
               WHERE lot_id = ${card.lotId.value.toString}::uuid"""
      )
      .map(_ == 1)

  def find(lotId: LotId): Future[Option[LotCard]] = database.run(select(lotId))

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
