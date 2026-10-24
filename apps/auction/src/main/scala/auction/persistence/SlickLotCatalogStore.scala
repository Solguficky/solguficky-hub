package auction.persistence

import auction.catalog.CardEdit
import auction.catalog.CardInsertion
import auction.catalog.CatalogRefusal
import auction.catalog.ImageChange
import auction.catalog.ImageVersion
import auction.catalog.LotCard
import auction.catalog.LotCatalogStore
import auction.catalog.LotId
import auction.catalog.LotImage
import auction.catalog.LotTitle
import auction.catalog.NewCard
import auction.catalog.PhotoAddition
import auction.catalog.PhotoId
import auction.catalog.PhotoRemoval
import auction.entity.UuidV7
import auction.watch.AuctionChanges
import org.apache.pekko.actor.typed.ActorSystem
import org.apache.pekko.persistence.jdbc.db.SlickExtension
import slick.jdbc.JdbcBackend.Database
import slick.jdbc.PostgresProfile.api.*
import slick.jdbc.SetParameter

import java.time.Clock
import java.util.UUID
import scala.concurrent.ExecutionContext
import scala.concurrent.Future

/**
 * Карточки лотов в таблице `lot_catalog` и их фото в `lot_photo` через пул плагина журнала.
 *
 * Отдельного пула нет намеренно: команды каталога редки, а общий пул уже покрыт таймаутами подключения и пробой
 * готовности. Схему ведёт Flyway, поэтому запросы — plain SQL, а не lifted-модель, второй раз описывающая таблицу.
 *
 * Колонки изображения `lot_catalog` — обложка, первое фото `lot_photo` (ADR-057, дополнение 2026-10-24): каждая запись
 * фото переписывает их в той же транзакции, поэтому образ Auction без `lot_photo` после отката видит обложку. Байты
 * читает только [[SlickLotViews]] для `GetLotImage` и `GetLotPhoto`: карточке нужны версии.
 */
final class SlickLotCatalogStore(database: Database)(using ExecutionContext) extends LotCatalogStore {

  // Id фото, которое команда фото подхватывает из колонок обложки (`adopt`): вызывающего у него нет, и id — UUIDv7 по
  // ADR-020, как у фото, пришедшего с карточкой.
  private val nextPhotoId: () => UUID = UuidV7.generator(Clock.systemUTC())

  private def newPhotoId(): PhotoId = PhotoId(nextPhotoId())

  // `setBytesOption(None)` шлёт NULL с типом BLOB, и PostgreSQL читает его как `oid`, а не `bytea`: вставка падает.
  private given SetParameter[Option[Array[Byte]]] =
    SetParameter((value, params) => value.fold(params.setNull(java.sql.Types.BINARY))(params.setBytes))

  private val PhotosSql = LotPhotoColumns.sql("c.lot_id")

  private def select(lotId: LotId): DBIO[Option[LotCard]] =
    sql"""SELECT c.title, c.description, c.image_version, #$PhotosSql FROM lot_catalog c
          WHERE c.lot_id = ${lotId.value.toString}::uuid"""
      .as[(String, String, Option[String], Option[String])]
      .headOption
      .map(_.map((title, description, version, photos) => card(lotId, title, description, version, photos)))

  /**
   * Карточка входит в снимки потока `WatchAuction`, а проекции read model её не пишут: аукцион лота, которого read
   * model уже знает, объявляется сигналом той же транзакции, что запись карточки. Лот без строки `lot_view` в поток ещё
   * не попал, и объявлять нечего.
   */
  private def announce(lotId: LotId): DBIO[Unit] =
    sql"""SELECT pg_notify(${AuctionChanges.Channel}, auction_id::text) FROM lot_view
          WHERE lot_id = ${lotId.value.toString}::uuid""".as[String].map(_ => ())

  private def bytes(image: LotImage): Array[Byte] = IArray.genericWrapArray(image.content).toArray

  private def insertPhoto(lotId: LotId, photoId: PhotoId, image: LotImage): DBIO[Int] = {
    val lot = lotId.value.toString
    sqlu"""INSERT INTO lot_photo (lot_id, photo_id, position, content, media_type, version)
           SELECT $lot::uuid, ${photoId.value.toString}::uuid,
                  COALESCE((SELECT MAX(position) FROM lot_photo WHERE lot_id = $lot::uuid), 0) + 1,
                  ${Option(bytes(image))}, ${image.mediaType.value}, ${image.version.value}"""
  }

  /**
   * Строка карточки под блокировкой до конца транзакции: команды фото одного лота идут по очереди, и предел числа и
   * позиция в конце считаются без гонки. `false` — карточки нет.
   */
  private def lock(lotId: LotId): DBIO[Boolean] =
    sql"SELECT 1 FROM lot_catalog WHERE lot_id = ${lotId.value.toString}::uuid FOR UPDATE"
      .as[Int]
      .headOption
      .map(_.isDefined)

  /**
   * Обложка, которую записал образ Auction без `lot_photo`, например после отката: её колонки разошлись с первым фото.
   * Изображение без строки фото становится первым фото, а другое изображение заменяет байты первого фото, прежде чем
   * команда фото тронет список, — иначе синхронизация обложки его бы стёрла. Снятое таким образом изображение (колонки
   * пусты при строках фото) не подхватывается: прежний образ знал одно фото, и какое из списка снимать, не сказал.
   */
  private def adopt(lotId: LotId, photoId: PhotoId): DBIO[Unit] = {
    val lot = lotId.value.toString
    val orphan =
      sqlu"""INSERT INTO lot_photo (lot_id, photo_id, position, content, media_type, version)
             SELECT c.lot_id, ${photoId.value.toString}::uuid, 1, c.image, c.image_media_type, c.image_version
             FROM lot_catalog c
             WHERE c.lot_id = $lot::uuid AND c.image IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM lot_photo p WHERE p.lot_id = c.lot_id)"""
    val replaced =
      sqlu"""UPDATE lot_photo p SET content = c.image, media_type = c.image_media_type, version = c.image_version
             FROM lot_catalog c
             WHERE c.lot_id = $lot::uuid AND p.lot_id = c.lot_id AND c.image IS NOT NULL
               AND p.version <> c.image_version
               AND p.position = (SELECT MIN(position) FROM lot_photo WHERE lot_id = $lot::uuid)"""
    orphan.andThen(replaced).map(_ => ())
  }

  /** Колонки изображения строки карточки — по первому фото, а без фото пусты. */
  private def syncCover(lotId: LotId): DBIO[Unit] = {
    val lot = lotId.value.toString
    for {
      _ <- sqlu"""UPDATE lot_catalog c SET image = p.content, image_media_type = p.media_type, image_version = p.version
                  FROM (SELECT content, media_type, version FROM lot_photo WHERE lot_id = $lot::uuid
                        ORDER BY position LIMIT 1) p
                  WHERE c.lot_id = $lot::uuid AND c.image_version IS DISTINCT FROM p.version"""
      _ <- sqlu"""UPDATE lot_catalog SET image = NULL, image_media_type = NULL, image_version = NULL
                  WHERE lot_id = $lot::uuid AND image IS NOT NULL
                    AND NOT EXISTS (SELECT 1 FROM lot_photo WHERE lot_id = $lot::uuid)"""
    } yield ()
  }

  // Карточка после записи в той же транзакции: её строка под блокировкой или только что записана, поэтому есть.
  private def written(lotId: LotId): DBIO[LotCard] =
    select(lotId).flatMap {
      case Some(card) => DBIO.successful(card)
      case None => DBIO.failed(IllegalStateException(s"lot_catalog row for lot ${lotId.value} vanished in a write"))
    }

  def insertIfAbsent(created: NewCard): Future[CardInsertion] = {
    val image = created.image
    val inserted =
      sqlu"""INSERT INTO lot_catalog (lot_id, title, description, image, image_media_type, image_version)
             VALUES (${created.lotId.value.toString}::uuid, ${created.title.value}, ${created.description},
                     ${image.map(bytes)}, ${image.map(_.mediaType.value)}, ${image.map(_.version.value)})
             ON CONFLICT (lot_id) DO NOTHING"""
    database.run(
      inserted.flatMap {
        case 1 =>
          for {
            _ <- image.fold[DBIO[Int]](DBIO.successful(0))(insertPhoto(created.lotId, created.photoId, _))
            _ <- announce(created.lotId)
            card <- written(created.lotId)
          } yield CardInsertion.Inserted(card)
        // Конфликт вставки значит, что строка есть. Если её уже нет, ответ «вставлено» соврал бы: ничего не записано.
        case _ =>
          select(created.lotId).flatMap {
            case Some(existing) => DBIO.successful(CardInsertion.Existing(existing))
            case None =>
              DBIO.failed(
                IllegalStateException(s"lot_catalog row for lot ${created.lotId.value} vanished after a conflict")
              )
          }
      }.transactionally
    )
  }

  // Обложка правится в `lot_photo`, а колонки строки переписывает `syncCover`: правило «колонки равны обложке» у них
  // одно с командами фото.
  def update(edit: CardEdit): Future[Option[LotCard]] = {
    val lot = edit.lotId.value.toString
    val photos: DBIO[Unit] = edit.image match {
      case ImageChange.Keep => DBIO.successful(())
      case ImageChange.Replace(image) =>
        for {
          _ <- adopt(edit.lotId, edit.photoId)
          replaced <- sqlu"""UPDATE lot_photo SET content = ${Option(bytes(image))},
                               media_type = ${image.mediaType.value}, version = ${image.version.value}
                             WHERE lot_id = $lot::uuid
                               AND position = (SELECT MIN(position) FROM lot_photo WHERE lot_id = $lot::uuid)"""
          _ <- if (replaced == 0) insertPhoto(edit.lotId, edit.photoId, image) else DBIO.successful(0): DBIO[Int]
          _ <- syncCover(edit.lotId)
        } yield ()
      case ImageChange.Remove =>
        for {
          _ <- adopt(edit.lotId, edit.photoId)
          _ <- sqlu"""DELETE FROM lot_photo WHERE lot_id = $lot::uuid
                       AND position = (SELECT MIN(position) FROM lot_photo WHERE lot_id = $lot::uuid)"""
          _ <- syncCover(edit.lotId)
        } yield ()
    }
    database.run(
      (for {
        found <- lock(edit.lotId)
        card <-
          if (!found) DBIO.successful(Option.empty[LotCard])
          else
            for {
              _ <- sqlu"""UPDATE lot_catalog SET title = ${edit.title.value}, description = ${edit.description}
                          WHERE lot_id = $lot::uuid"""
              _ <- photos
              _ <- announce(edit.lotId)
              card <- written(edit.lotId)
            } yield Option(card)
      } yield card).transactionally
    )
  }

  private type Outcome = Either[CatalogRefusal, LotCard]

  private def refused(refusal: CatalogRefusal): DBIO[Outcome] = DBIO.successful(Left(refusal))

  private def accepted(lotId: LotId): DBIO[Outcome] = written(lotId).map(card => Right(card))

  /** Команда фото над строкой карточки под блокировкой; карточки нет — `CardNotFound`. */
  private def underLock(lotId: LotId)(write: DBIO[Outcome]): Future[Outcome] =
    database.run(
      lock(lotId).flatMap(found => if (found) write else refused(CatalogRefusal.CardNotFound)).transactionally
    )

  def addPhoto(addition: PhotoAddition, maxPhotos: Int): Future[Either[CatalogRefusal, LotCard]] = {
    val lot = addition.lotId.value.toString
    val photo = addition.photoId.value.toString
    def decide(stored: Option[String], count: Int): DBIO[Outcome] =
      stored match {
        case Some(version) if version == addition.image.version.value => accepted(addition.lotId)
        case Some(_) => refused(CatalogRefusal.PhotoConflict)
        case None if count >= maxPhotos => refused(CatalogRefusal.PhotoLimitReached(maxPhotos))
        case None =>
          insertPhoto(addition.lotId, addition.photoId, addition.image)
            .andThen(syncCover(addition.lotId))
            .andThen(announce(addition.lotId))
            .andThen(accepted(addition.lotId))
      }
    underLock(addition.lotId)(
      for {
        _ <- adopt(addition.lotId, newPhotoId())
        stored <- sql"SELECT version FROM lot_photo WHERE lot_id = $lot::uuid AND photo_id = $photo::uuid"
          .as[String]
          .headOption
        count <- sql"SELECT COUNT(*) FROM lot_photo WHERE lot_id = $lot::uuid".as[Int].head
        outcome <- decide(stored, count)
      } yield outcome
    )
  }

  def removePhoto(removal: PhotoRemoval): Future[Either[CatalogRefusal, LotCard]] = {
    val lot = removal.lotId.value.toString
    val changed: DBIO[Unit] = syncCover(removal.lotId).andThen(announce(removal.lotId))
    underLock(removal.lotId)(
      for {
        _ <- adopt(removal.lotId, newPhotoId())
        deleted <- sqlu"""DELETE FROM lot_photo
                          WHERE lot_id = $lot::uuid AND photo_id = ${removal.photoId.value.toString}::uuid"""
        _ <- if (deleted == 0) DBIO.successful(()) else changed
        outcome <- accepted(removal.lotId)
      } yield outcome
    )
  }

  def find(lotId: LotId): Future[Option[LotCard]] = database.run(select(lotId))

  private def card(
      lotId: LotId,
      title: String,
      description: String,
      version: Option[String],
      photos: Option[String]
  ): LotCard =
    LotCard(lotId, restored(lotId, title), description, version.map(ImageVersion(_)), LotPhotoColumns.parse(photos))

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
