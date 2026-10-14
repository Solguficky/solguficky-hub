package auction.results

/**
 * Схема тегов журнала итогов — своё семейство, отдельное от лота, аукциона, розыгрыша и прогнозов, по той же формуле:
 * номер среза Pekko по persistence id по модулю числа срезов. Формула — формат хранения: её смена переписывает
 * `event_tag`. Тег нужен публикации факта итогов: проекция читает журнал итогов по тегу, а не по persistence id.
 */
object ResultsTags {

  val Count: Int = 4

  def of(slice: Int): String = s"results-${Math.floorMod(slice, Count)}"

  val all: Vector[String] = Vector.tabulate(Count)(of)
}
