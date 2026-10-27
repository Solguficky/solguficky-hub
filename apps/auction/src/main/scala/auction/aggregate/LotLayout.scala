package auction.aggregate

import auction.catalog.LotId
import auction.lot.OpId

/**
 * Раздел ленты (PER-719). Идентификатор выбирает вызывающий: тот же номер называет тот же раздел от правки к правке.
 */
final case class LotSectionId private (value: Int)

object LotSectionId {

  /** Номер раздела — положительный: ноль у Protobuf — отсутствие значения, а не раздел. */
  def apply(value: Int): Option[LotSectionId] = Option.when(value > 0)(new LotSectionId(value))
}

/** Название раздела: непустое, без одних пробелов — то же правило, что у названия сета. */
final case class LotSectionName private (value: String)

object LotSectionName {

  def apply(raw: String): Option[LotSectionName] = Option.unless(raw.forall(blank))(new LotSectionName(raw))

  // `isBlank` неразрывные пробелы (U+00A0, U+2007, U+202F) пробелом не считает, а на экране они пусты так же.
  private def blank(c: Char): Boolean = Character.isWhitespace(c) || Character.isSpaceChar(c)
}

/** Раздел ленты: название и лоты в порядке администратора. Пустой раздел — настоящее значение: его ещё наполняют. */
final case class LotSection(id: LotSectionId, name: LotSectionName, lots: List[LotId])

/**
 * Порядок и разделы ленты (PER-719): показ, а не условие торгов. `lots` — лоты вне разделов в порядке администратора,
 * `sections` — разделы в его порядке. Лот стоит не больше чем в одном месте, номер раздела не повторяется; лот реестра,
 * которого раскладка не называет, лента ставит после упорядоченных в порядке создания. Конструктор закрыт: вход команды
 * идёт через [[LotLayout.of]], пустая раскладка — [[LotLayout.empty]].
 */
final case class LotLayout private (lots: List[LotId], sections: List[LotSection]) {

  /**
   * Каждый лот раскладки: сначала разделы, затем лоты вне разделов — порядок, в котором отказ называет первый лишний.
   */
  def members: List[LotId] = sections.flatMap(_.lots) ++ lots

  def isEmpty: Boolean = lots.isEmpty && sections.isEmpty

  /** Раскладка без лота: убранный из реестра лот уходит и из своего места, разделы остаются. */
  def without(lot: LotId): LotLayout = {
    def kept(lots: List[LotId]) = lots.filterNot(_ == lot)
    new LotLayout(kept(lots), sections.map(section => section.copy(lots = kept(section.lots))))
  }
}

/**
 * Форма раскладки нарушена: лот назван дважды или номер раздела повторён. Это дефект вызывающего, а не отказ человеку.
 */
enum LotLayoutInvalid {
  case LotRepeated(lot: LotId)
  case SectionRepeated(section: LotSectionId)
}

object LotLayout {

  val empty: LotLayout = new LotLayout(Nil, Nil)

  def of(lots: List[LotId], sections: List[LotSection]): Either[LotLayoutInvalid, LotLayout] = {
    val layout = new LotLayout(lots, sections)
    repeated(sections.map(_.id))
      .map(LotLayoutInvalid.SectionRepeated(_))
      .orElse(repeated(layout.members).map(LotLayoutInvalid.LotRepeated(_)))
      .toLeft(layout)
  }

  private def repeated[A](values: List[A]): Option[A] =
    values.zipWithIndex.collectFirst { case (value, index) if values.indexOf(value) != index => value }
}

/** Раскладка ленты целиком (PER-719): команда заменяет прежнюю, пустая возвращает порядок создания. */
final case class SetLotLayout(layout: LotLayout, opId: OpId)

/**
 * Отказы раскладки: аукциона нет, финал уже идёт, аукцион закончился или отменён — в живом финале лента идёт порядком
 * зала (PER-639), — лота нет в реестре: первый такой лот в порядке [[LotLayout.members]].
 */
enum LotLayoutRejected {
  case AuctionNotFound
  case FinalAlreadyStarted
  case AuctionAlreadyFinished
  case AuctionAlreadyCancelled
  case LotNotInAuction(lot: LotId)
}
