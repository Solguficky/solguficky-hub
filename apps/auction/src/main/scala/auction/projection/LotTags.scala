package auction.projection

/**
 * Схема тегов журнала лота (ADR-061).
 *
 * Глобальное чтение журнала у Pekko Persistence JDBC строится только на тегах, а тег пишется в строку `event_tag` в
 * момент append (ADR-045). Поэтому формула ниже — формат хранения, а не настройка: её смена — переписывание строк.
 *
 * Лот попадает ровно в один срез, и все его события лежат под одним тегом: порядок событий одного лота проекция видит
 * таким, каким его записал журнал. Срез — `slice % Count`, где `slice` — номер, который Pekko сама считает по
 * persistence id (`Persistence.sliceForPersistenceId`, 1024 среза), а не своя хеш-функция.
 */
object LotTags {

  /** Число срезов. Уменьшить его нельзя без переписывания `event_tag`; это значение входит в формат журнала. */
  val Count: Int = 4

  /** Тег лота по номеру среза Pekko. */
  def of(slice: Int): String = s"lot-${Math.floorMod(slice, Count)}"

  /** Все теги лота по порядку: по экземпляру проекции на тег. */
  val all: Vector[String] = Vector.tabulate(Count)(index => s"lot-$index")
}
