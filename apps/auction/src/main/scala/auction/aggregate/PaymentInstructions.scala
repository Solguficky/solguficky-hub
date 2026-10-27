package auction.aggregate

/**
 * Как оплатить и получить лоты аукциона — свободный текст администратора для каждого победителя (PER-322,
 * integration.md, «Счета»). Это не реквизиты и не условие торгов: деньги идут мимо продукта, и сервис текст не читает.
 * Конструктор закрыт: вход команды идёт через [[parse]], журнал восстанавливает текст через [[of]] без проверки —
 * предел мог смениться после записи.
 */
final case class PaymentInstructions private (value: String)

object PaymentInstructions {

  /** Предел в знаках Unicode, а не в единицах UTF-16: эмодзи считается одним знаком, как его видит администратор. */
  val MaxLength: Int = 1000

  /**
   * Текст с обрезанными краями; переводы строк внутри остаются. Пустой после обрезки или длиннее [[MaxLength]] —
   * `None`: снятие текста — отсутствие поля, а не пустая строка.
   */
  def parse(raw: String): Option[PaymentInstructions] = {
    val text = raw.strip()
    Option.when(!text.isEmpty && text.codePointCount(0, text.length) <= MaxLength)(new PaymentInstructions(text))
  }

  def of(stored: String): PaymentInstructions = new PaymentInstructions(stored)
}
