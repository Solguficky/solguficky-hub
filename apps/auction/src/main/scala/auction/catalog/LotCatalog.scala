package auction.catalog

import auction.access.Viewer

import scala.concurrent.ExecutionContext
import scala.concurrent.Future

/**
 * Хранилище карточек. Реализация живёт в `persistence`; здесь только то, что нужно командам и чтению карточки.
 *
 * Строка карточки — состояние, а не журнал (ADR каталога лота): последняя правка побеждает, истории нет.
 */
trait LotCatalogStore {

  /** Вставляет карточку, если строки с её `lot_id` нет. `None` — вставлена, `Some` — уже была, и какая. */
  def insertIfAbsent(card: LotCard): Future[Option[LotCard]]

  /** Заменяет название и описание. `false` — карточки с этим `lot_id` нет. */
  def update(card: LotCard): Future[Boolean]

  def find(lotId: LotId): Future[Option[LotCard]]
}

/** Решение команды каталога без хранилища: права смотрящего, затем проверка полей. */
object LotCatalogRules {

  def decide(viewer: Viewer, lotId: LotId, title: String, description: String): Either[CatalogRefusal, LotCard] =
    for {
      _ <- Either.cond(viewer.isMeetupAdministrator, (), CatalogRefusal.NotAdmin)
      checked <- LotTitle(title)
    } yield LotCard(lotId, checked, description)
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
      description: String
  ): Future[Either[CatalogRefusal, LotCard]] =
    LotCatalogRules.decide(viewer, lotId, title, description) match {
      case Left(refusal) => Future.successful(Left(refusal))
      case Right(card) =>
        store.insertIfAbsent(card).map {
          case None => Right(card)
          case Some(existing) if existing == card => Right(existing)
          case Some(_) => Left(CatalogRefusal.CardConflict)
        }
    }

  def edit(viewer: Viewer, lotId: LotId, title: String, description: String): Future[Either[CatalogRefusal, LotCard]] =
    LotCatalogRules.decide(viewer, lotId, title, description) match {
      case Left(refusal) => Future.successful(Left(refusal))
      case Right(card) =>
        store.update(card).map(updated => if (updated) Right(card) else Left(CatalogRefusal.CardNotFound))
    }
}
