package auction.catalog

import auction.access.Viewer

import java.util.UUID
import scala.concurrent.ExecutionContext
import scala.concurrent.Future

/**
 * Хранилище карточек. Реализация живёт в `persistence`; здесь только то, что нужно командам и чтению карточки.
 *
 * Строка карточки — состояние, а не журнал (ADR-057): последняя правка побеждает, истории нет.
 */
trait LotCatalogStore {

  /** Вставляет карточку, если строки с её `lot_id` нет, и её изображение первым фото. */
  def insertIfAbsent(card: NewCard): Future[CardInsertion]

  /**
   * Заменяет текст и меняет обложку по правке. `None` — карточки с этим `lot_id` нет, иначе карточка после правки.
   */
  def update(edit: CardEdit): Future[Option[LotCard]]

  /**
   * Добавляет фото в конец списка одной транзакцией со сверкой предела `maxPhotos` под блокировкой строки карточки.
   * Отказы — `CardNotFound`, `PhotoConflict` и `PhotoLimitReached`; повтор того же id с теми же байтами — карточка как
   * есть. Изображение карточки после команды равно обложке.
   */
  def addPhoto(addition: PhotoAddition, maxPhotos: Int): Future[Either[CatalogRefusal, LotCard]]

  /** Убирает фото, если оно есть. Отказ — только `CardNotFound`; изображение карточки после команды равно обложке. */
  def removePhoto(removal: PhotoRemoval): Future[Either[CatalogRefusal, LotCard]]

  def find(lotId: LotId): Future[Option[LotCard]]
}

/** Решение команды каталога без хранилища: права смотрящего, затем название, затем изображение. */
object LotCatalogRules {

  def create(
      viewer: Viewer,
      lotId: LotId,
      title: String,
      description: String,
      image: Option[IArray[Byte]],
      photoId: PhotoId
  ): Either[CatalogRefusal, NewCard] =
    for {
      _ <- admin(viewer)
      checked <- LotTitle(title)
      accepted <- image match {
        case None => Right(None)
        case Some(bytes) => LotImage(bytes).map(Some(_))
      }
    } yield NewCard(lotId, checked, description, accepted, photoId)

  def edit(
      viewer: Viewer,
      lotId: LotId,
      title: String,
      description: String,
      image: ImageChange[IArray[Byte]],
      photoId: PhotoId
  ): Either[CatalogRefusal, CardEdit] =
    for {
      _ <- admin(viewer)
      checked <- LotTitle(title)
      change <- image match {
        case ImageChange.Keep => Right(ImageChange.Keep)
        case ImageChange.Remove => Right(ImageChange.Remove)
        case ImageChange.Replace(bytes) => LotImage(bytes).map(ImageChange.Replace(_))
      }
    } yield CardEdit(lotId, checked, description, change, photoId)

  def addPhoto(
      viewer: Viewer,
      lotId: LotId,
      photoId: PhotoId,
      bytes: IArray[Byte]
  ): Either[CatalogRefusal, PhotoAddition] =
    for {
      _ <- admin(viewer)
      image <- LotImage(bytes)
    } yield PhotoAddition(lotId, photoId, image)

  def removePhoto(viewer: Viewer, lotId: LotId, photoId: PhotoId): Either[CatalogRefusal, PhotoRemoval] =
    admin(viewer).map(_ => PhotoRemoval(lotId, photoId))

  private def admin(viewer: Viewer): Either[CatalogRefusal, Unit] =
    Either.cond(viewer.managesLotCatalog, (), CatalogRefusal.NotAdmin)
}

/**
 * Команды каталога. К хранилищу они идут только после `Right` и открытой карточки: отказ по правам, по полям и по
 * закрытой карточке наступает до обращения к базе по построению, а не по порядку строк.
 */
final class LotCatalogCommands(
    store: LotCatalogStore,
    standing: LotId => Future[CardStanding],
    newPhotoId: () => PhotoId = () => PhotoId(UUID.randomUUID())
)(using ExecutionContext) {

  def create(
      viewer: Viewer,
      lotId: LotId,
      title: String,
      description: String,
      image: Option[IArray[Byte]]
  ): Future[Either[CatalogRefusal, LotCard]] =
    LotCatalogRules.create(viewer, lotId, title, description, image, newPhotoId()) match {
      case Left(refusal) => Future.successful(Left(refusal))
      case Right(created) =>
        store.insertIfAbsent(created).map {
          case CardInsertion.Inserted(card) => Right(card)
          case CardInsertion.Existing(existing) if existing.sameContent(created.card) => Right(existing)
          case CardInsertion.Existing(_) => Left(CatalogRefusal.CardConflict)
        }
    }

  def edit(
      viewer: Viewer,
      lotId: LotId,
      title: String,
      description: String,
      image: ImageChange[IArray[Byte]]
  ): Future[Either[CatalogRefusal, LotCard]] =
    LotCatalogRules.edit(viewer, lotId, title, description, image, newPhotoId()) match {
      case Left(refusal) => Future.successful(Left(refusal))
      case Right(change) =>
        whenOpen(change.lotId)(store.update(change).map(_.toRight(CatalogRefusal.CardNotFound)))
    }

  /** Фото в конец списка (ADR-057, дополнение 2026-10-24): правка закрыта тем же правилом, что правка карточки. */
  def addPhoto(
      viewer: Viewer,
      lotId: LotId,
      photoId: PhotoId,
      bytes: IArray[Byte]
  ): Future[Either[CatalogRefusal, LotCard]] =
    LotCatalogRules.addPhoto(viewer, lotId, photoId, bytes) match {
      case Left(refusal) => Future.successful(Left(refusal))
      case Right(addition) => whenOpen(lotId)(store.addPhoto(addition, LotImage.MaxPhotos))
    }

  def removePhoto(viewer: Viewer, lotId: LotId, photoId: PhotoId): Future[Either[CatalogRefusal, LotCard]] =
    LotCatalogRules.removePhoto(viewer, lotId, photoId) match {
      case Left(refusal) => Future.successful(Left(refusal))
      case Right(removal) => whenOpen(lotId)(store.removePhoto(removal))
    }

  private def whenOpen(lotId: LotId)(
      write: => Future[Either[CatalogRefusal, LotCard]]
  ): Future[Either[CatalogRefusal, LotCard]] =
    standing(lotId).flatMap {
      case CardStanding.Closed => Future.successful(Left(CatalogRefusal.CardClosed))
      case CardStanding.Open => write
    }
}
