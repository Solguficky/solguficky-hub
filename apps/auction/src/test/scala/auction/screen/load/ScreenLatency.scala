package auction.screen.load

/**
 * Принятая ставка прогона: сумма в минорных единицах и два момента часов машины прогона — отправка `PlaceBid` и его
 * ответ. Фиксация ставки лежит между ними, поэтому задержка до зрителя считается от обоих: от отправки — сверху, от
 * ответа — снизу (PER-486, решение владельца на чекпоинте).
 */
final case class BidMark(amount: Long, sentAt: Long, answeredAt: Long)

/** Цена лота, которую зритель применил в момент `at` по тем же часам. */
final case class Seen(at: Long, price: Long)

/** Задержка одной пары «ставка — зритель» в миллисекундах. */
final case class Delay(fromSent: Long, fromAnswer: Long)

/**
 * Чистая часть замера экрана зала: сопоставление ставок с тем, что применил зритель, и порядковые статистики.
 *
 * Метка ставки — её сумма: суммы залпа растут, поэтому первая цена зрителя не ниже суммы ставки после её отправки и
 * есть момент, когда состояние со ставкой применено. Экран склеивает поводы, и зритель может не увидеть промежуточную
 * цену вовсе — тогда ставку закрывает следующая, более высокая, и задержка не занижается.
 */
object ScreenLatency {

  /** Момент, когда зритель впервые показал цену не ниже ставки, не раньше её отправки. `seen` — по возрастанию `at`. */
  def applied(bid: BidMark, seen: Seq[Seen]): Option[Long] =
    seen.find(s => s.at >= bid.sentAt && s.price >= bid.amount).map(_.at)

  /** Задержки всех ставок у одного зрителя; ставки, которых он так и не показал, — в `missed`. */
  def delays(bids: Seq[BidMark], seen: Seq[Seen]): (Vector[Delay], Int) = {
    val ordered = seen.sortBy(_.at)
    val found = bids.map(bid => applied(bid, ordered).map(at => Delay(at - bid.sentAt, at - bid.answeredAt)))
    (found.flatten.toVector, found.count(_.isEmpty))
  }

  /** Перцентиль методом ближайшего ранга: значение, не меньше которого `q` долей выборки. Пустая выборка — `None`. */
  def percentile(values: Seq[Long], q: Double): Option[Long] =
    if (values.isEmpty) None
    else {
      val sorted = values.sorted
      val rank = math.ceil(q * sorted.size).toInt.max(1)
      Some(sorted(rank - 1))
    }

  /**
   * Цена со страницы в минорных единицах. Страница пишет копейки, только когда они есть (`money` в `screen.js`), а
   * разделители разрядов и знак валюты зависят от локали: запятая значит копейки, её нет — целые рубли.
   */
  def pagePrice(text: String): Option[Long] = {
    val digits = text.filter(_.isDigit)
    if (digits.isEmpty) None
    else if (text.contains(',')) digits.toLongOption
    else digits.toLongOption.map(_ * 100)
  }

  /**
   * Пауза перед повтором — то же правило, что `retryDelay` в `connection.js`: вдвое больше на каждой попытке до 30
   * секунд и случайная добавка до половины паузы. Лёгкие зрители повторяют им, чтобы рестарт и занятый предел нагружали
   * сервис так же, как страницы.
   */
  def retryDelay(attempt: Int, random: Double): Long = {
    val base = math.min(1000L * (1L << math.min(attempt, 15)), MaxRetryMs)
    base + math.floor(random * base / 2).toLong
  }

  val MaxRetryMs: Long = 30000

  /** Промежутки между соседними моментами — у повторов подключения они показывают растущую паузу. */
  def gaps(moments: Seq[Long]): Vector[Long] =
    moments.sorted.sliding(2).collect { case Seq(a, b) => b - a }.toVector
}
