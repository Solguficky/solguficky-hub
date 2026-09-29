package auction.lot

/** Код валюты. Платформа одновалютна, но валюта входит в каждую сумму явно (ADR-047, И-04). */
final case class CurrencyCode(value: String)

/**
 * Сумма в целых минорных единицах с явной валютой (ПП-5).
 *
 * Плавающей точки нет ни на одном уровне: ни `Double`, ни `BigDecimal` сюда не попадают по типу поля. Арифметики между
 * валютами тип не даёт намеренно — сумма лота сравнивается с порогом только после того, как [[Lot.decide]] проверил
 * валюту команды. Одна валюта политики шага и лота гарантирована [[LotConfig]]; одну валюту цены и ask с конфигурацией
 * обеспечивает тот, кто строит состояние торгов, — вход в торги, которого в ядре пока нет.
 */
final case class Money(minorUnits: Long, currency: CurrencyCode) {

  /** Та же валюта, другое число минорных единиц: сдвиг цены на шаг внутри одного лота. */
  private[lot] def plus(other: Money): Money = copy(minorUnits = minorUnits + other.minorUnits)

  private[lot] def <(other: Money): Boolean = minorUnits < other.minorUnits

  private[lot] def <=(other: Money): Boolean = minorUnits <= other.minorUnits

  private[lot] def >(other: Money): Boolean = minorUnits > other.minorUnits
}
