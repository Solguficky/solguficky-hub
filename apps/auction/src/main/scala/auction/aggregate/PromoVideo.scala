package auction.aggregate

/**
 * Промо-видео аукциона (PER-781): номер поста в чате медиа ботов (PER-775, временное решение владельца 27.10.2026). Сам
 * пост и чат Auction не знает и не проверяет: номер — данные ботов, которые сервис хранит, потому что у ботов базы нет.
 * Показ, а не условие торгов. Конструктор закрыт: вход команды идёт через [[parse]], журнал восстанавливает номер через
 * [[of]] без проверки.
 */
final case class PromoVideo private (messageId: Long)

object PromoVideo {

  /** `message_id` Telegram положителен; ноль и отрицательный — `None`: снятие видео — отсутствие поля, а не ноль. */
  def parse(messageId: Long): Option[PromoVideo] = Option.when(messageId > 0)(new PromoVideo(messageId))

  def of(stored: Long): PromoVideo = new PromoVideo(stored)
}
