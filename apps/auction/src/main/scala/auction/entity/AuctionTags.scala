package auction.entity

/**
 * Схема тегов журнала аукциона (ADR-061, п. 4): своё семейство тегов, отдельное от лота, по той же формуле — номер
 * среза Pekko по persistence id по модулю числа срезов. Формула — формат хранения: её смена переписывает `event_tag`.
 */
object AuctionTags {

  val Count: Int = 4

  def of(slice: Int): String = s"auction-${Math.floorMod(slice, Count)}"

  val all: Vector[String] = Vector.tabulate(Count)(of)
}
