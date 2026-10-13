package auction.raffle

/**
 * Схема тегов журнала розыгрыша — своё семейство, отдельное от лота и аукциона, по той же формуле: номер среза Pekko по
 * persistence id по модулю числа срезов. Формула — формат хранения: её смена переписывает `event_tag`. Тег появился с
 * публикацией итога (PER-620), поэтому строки журнала, записанные раньше, тега не несут, и глобальное чтение их не
 * видит; проекция публикации читает историю розыгрыша по persistence id.
 */
object RaffleTags {

  val Count: Int = 4

  def of(slice: Int): String = s"raffle-${Math.floorMod(slice, Count)}"

  val all: Vector[String] = Vector.tabulate(Count)(of)
}
