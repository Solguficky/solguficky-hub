package auction.raffle

import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.security.SecureRandom
import java.time.Duration
import java.time.Instant
import java.util.HexFormat

/** SHA-256 от строки в UTF-8, строчным hex: каждый шаг пересчитывается любым калькулятором хэшей (ADR-066, п. 6). */
object Sha256 {
  def hex(text: String): String =
    HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8)))
}

/** Строчный hex ровно из 64 знаков — запись 32 байт. Seed и значение раунда drand имеют эту форму. */
private object Hex64 {
  private val Form = "^[0-9a-f]{64}$".r

  def matches(raw: String): Boolean = Form.matches(raw)
}

/**
 * Seed розыгрыша (ADR-066, п. 6): 32 байта криптографического генератора строчным hex. Отпечаток `commitment`
 * публикуется при открытии регистрации, сам seed — только после жеребьёвки.
 */
final case class Seed private (hex: String) {
  def commitment: String = Sha256.hex(hex)

  override def toString: String = "Seed(<hidden>)"
}

object Seed {
  def fromHex(raw: String): Option[Seed] = Option.when(Hex64.matches(raw))(new Seed(raw))

  def random(generator: SecureRandom): Seed = {
    val bytes = new Array[Byte](32)
    generator.nextBytes(bytes)
    new Seed(HexFormat.of().formatHex(bytes))
  }
}

/** Значение раунда drand — поле `randomness` ответа, строчный hex из 64 знаков. */
final case class Randomness private (hex: String)

object Randomness {
  def fromHex(raw: String): Option[Randomness] = Option.when(Hex64.matches(raw))(new Randomness(raw))
}

/**
 * Сеть drand `quicknet` (ADR-066, п. 7): параметры цепочки и арифметика раундов. Время раунда r — `genesis + (r − 1) ·
 * period`; раунд жеребьёвки — первый, чьё время не раньше закрытия регистрации плюс минута.
 */
object Quicknet {

  val ChainHash: String = "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971"

  val Genesis: Instant = Instant.ofEpochSecond(1692803367L)

  val Period: Duration = Duration.ofSeconds(3)

  /** Запас после закрытия: значение раунда не существует в момент закрытия пула, и расхождение часов покрыто. */
  val Margin: Duration = Duration.ofMinutes(1)

  def roundAt(round: Long): Instant = Genesis.plus(Period.multipliedBy(round - 1))

  /** Первый раунд, время которого не раньше `closesAt + Margin`. */
  def roundFor(closesAt: Instant): Long = {
    val target = closesAt.plus(Margin)
    if (!target.isAfter(Genesis)) 1L
    else {
      val elapsed = Duration.between(Genesis, target).toNanos
      val period = Period.toNanos
      Math.floorDiv(elapsed + period - 1, period) + 1
    }
  }

  /**
   * Значение, о котором договорились зеркала: принимается, когда два любых вернули одно и то же. Нет такого значения
   * или их два — ждём: расхождение зеркал — то же ожидание, что недоступность.
   */
  def agreed(readings: Seq[Option[Randomness]]): Option[Randomness] =
    readings.flatten.groupBy(identity).collect { case (value, same) if same.sizeIs >= 2 => value }.toList match {
      case single :: Nil => Some(single)
      case _ => None
    }
}

/** Жеребьёвка (ADR-066, п. 9): детерминированна от seed, числа билетов и значения раунда. */
object Draw {

  /** `V = SHA-256("<seed>:<N>:<randomness>")`, N — десятичное число без ведущих нулей. */
  def value(seed: Seed, tickets: Int, randomness: Randomness): String =
    Sha256.hex(s"${seed.hex}:$tickets:${randomness.hex}")

  /** Номер выигравшего билета: `(V mod N) + 1`, где V — 256-битное беззнаковое число, старший байт первым. */
  def winner(seed: Seed, tickets: Int, randomness: Randomness): Int = {
    require(tickets > 0, "a draw needs at least one ticket")
    (BigInt(value(seed, tickets, randomness), 16).mod(BigInt(tickets))).toInt + 1
  }
}
