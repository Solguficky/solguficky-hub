package auction.catalog

import auction.access.Viewer

import scala.concurrent.ExecutionContext
import scala.concurrent.Future

/**
 * Хранилище карточек. Реализация живёт в `persistence`; здесь только то, что нужно командам и чтению карточки.
 *
 * Строка карточки — состояние, а не журнал (ADR-057): последняя правка побеждает, истории нет.
 */
trait LotCatalogStore {

  /** Вставляет карточку, если строки с её `lot_id` нет. `None` — вставлена, `Some` — уже была, и какая. */
  def insertIfAbsent(card: NewCard): Future[Option[LotCard]]

  /**
   * Заменяет текст и меняет изображение по правке. `None` — карточки с этим `lot_id` нет, иначе карточка после правки.
   */
  def update(edit: CardEdit): Future[Option[LotCard]]

  def find(lotId: LotId): Future[Option[LotCard]]
}

/** Решение команды каталога без хранилища: права смотрящего, затем название, затем изображение. */
object LotCatalogRules {

  def create(
      viewer: Viewer,
      lotId: LotId,
      title: String,
      description: String,
      image: Option[IArray[Byte]]
  ): Either[CatalogRefusal, NewCard] =
    for {
      _ <- admin(viewer)
      checked <- LotTitle(title)
      accepted <- image match {
        case None => Right(None)
        case Some(bytes) => LotImage(bytes).map(Some(_))
      }
    } yield NewCard(lotId, checked, description, accepted)

  def edit(
      viewer: Viewer,
      lotId: LotId,
      title: String,
      description: String,
      image: ImageChange[IArray[Byte]]
  ): Either[CatalogRefusal, CardEdit] =
    for {
      _ <- admin(viewer)
      checked <- LotTitle(title)
      change <- image match {
        case ImageChange.Keep => Right(ImageChange.Keep)
        case ImageChange.Remove => Right(ImageChange.Remove)
        case ImageChange.Replace(bytes) => LotImage(bytes).map(ImageChange.Replace(_))
      }
    } yield CardEdit(lotId, checked, description, change)

  private def admin(viewer: Viewer): Either[CatalogRefusal, Unit] =
    Either.cond(viewer.isMeetupAdministrator, (), CatalogRefusal.NotAdmin)
}

/**
 * Команды каталога. К хранилищу они идут только после того, как решение вернуло `Right`: отказ по правам и по полям
 * наступает до обращения к базе по построению, а не по порядку строк.
 */
final class LotCatalogCommands(store: LotCatalogStore)(using ExecutionContext) {

  def create(
      viewer: Viewer,
      lotId: LotId,
      title: String,
      description: String,
      image: Option[IArray[Byte]]
  ): Future[Either[CatalogRefusal, LotCard]] =
    LotCatalogRules.create(viewer, lotId, title, description, image) match {
      case Left(refusal) => Future.successful(Left(refusal))
      case Right(created) =>
        store.insertIfAbsent(created).map {
          case None => Right(created.card)
          case Some(existing) if existing == created.card => Right(existing)
          case Some(_) => Left(CatalogRefusal.CardConflict)
        }
    }

  def edit(
      viewer: Viewer,
      lotId: LotId,
      title: String,
      description: String,
      image: ImageChange[IArray[Byte]]
  ): Future[Either[CatalogRefusal, LotCard]] =
    LotCatalogRules.edit(viewer, lotId, title, description, image) match {
      case Left(refusal) => Future.successful(Left(refusal))
      case Right(change) => store.update(change).map(_.toRight(CatalogRefusal.CardNotFound))
    }
}
