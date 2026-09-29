package auction.entity

import java.security.SecureRandom
import java.time.Clock
import java.util.UUID
import java.util.random.RandomGenerator

/**
 * Генератор UUIDv7 (RFC 9562): 48 бит миллисекунд Unix-времени, версия 7, затем случайные биты — канонический формат
 * идентификаторов платформы (ADR-020). Идентификаторы событий, транзакций и ставок растут со временем их рождения.
 *
 * Часы и источник случайности приходят снаружи: в тесте идентификатор воспроизводим, а entity получает генератор
 * функцией и сама часов не читает.
 */
object UuidV7 {

  def generator(clock: Clock, random: RandomGenerator = new SecureRandom()): () => UUID =
    () => {
      val millis = clock.millis() & 0xffffffffffffL
      val high = (millis << 16) | (0x7L << 12) | (random.nextInt() & 0xfffL)
      val low = (random.nextLong() & 0x3fffffffffffffffL) | Long.MinValue
      new UUID(high, low)
    }
}
