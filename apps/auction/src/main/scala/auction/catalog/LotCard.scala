package auction.catalog

import java.util.UUID

/** Идентификатор лота. Каталог и журнал лота делят его: строка каталога создаётся с тем же `lot_id`, что и лот. */
final case class LotId(value: UUID)

/** Название лота: не пустое и не из одних пробелов. Текст хранится как ввёл администратор, без обрезки. */
final case class LotTitle private (value: String)

object LotTitle {

  def apply(raw: String): Either[CatalogRefusal, LotTitle] =
    if (raw.isBlank) Left(CatalogRefusal.EmptyTitle) else Right(new LotTitle(raw))
}

/**
 * Каталожная карточка лота — название и описание.
 *
 * Карточка не входит в домен торгов (ADR-047): её правка разрешена в любом состоянии лота, а условия торгов после
 * `LotOpened` заморожены и живут только в журнале лота. Описание может быть пустым.
 */
final case class LotCard(lotId: LotId, title: LotTitle, description: String)

/** Ожидаемые отказы команд каталога. Транспортного кода они не несут: отображение — работа границы. */
enum CatalogRefusal {

  /** Смотрящий не администратор сходки. */
  case NotAdmin

  /** Название пустое или состоит из одних пробелов. */
  case EmptyTitle

  /** Правится карточка, которой нет. */
  case CardNotFound

  /**
   * Карточка с этим `lot_id` уже есть и с другими полями. Повтор с теми же полями — успех: это повтор той же команды.
   * Молча вернуть прежнюю карточку на повтор с другими полями нельзя — вызывающий решил бы, что записал новое.
   */
  case CardConflict
}
