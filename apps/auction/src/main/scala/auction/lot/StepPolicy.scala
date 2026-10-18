package auction.lot

/**
 * Политика шага (П-03): шаг вычисляется от цены, а не хранится одним числом.
 *
 * Конструкторы закрыты, и значение получается только через [[StepPolicy.fixed]] и [[StepPolicy.tiered]]. Так И-15
 * выполняется по построению: противоречивая политика непредставима, и `step` тотальна на любой цене без `head` и без
 * пустого случая. Отказ [[StepPolicyInvalid]] — ответ `ScheduleLot` через [[LotConfig.parse]] (RFC-011, И-15).
 */
sealed trait StepPolicy {
  def currency: CurrencyCode
}

object StepPolicy {

  final case class Fixed private[StepPolicy] (step: Money) extends StepPolicy {
    def currency: CurrencyCode = step.currency
  }

  /**
   * Пороги в форме «нижняя граница и шаг от неё». Первый порог с границей ноль хранится отдельно как `base`, поэтому
   * последний порог открыт сверху, а первый существует всегда.
   */
  final case class Tiered private[StepPolicy] (base: Money, tiers: List[Tier]) extends StepPolicy {
    def currency: CurrencyCode = base.currency
  }

  final case class Tier(bound: Money, step: Money)

  /**
   * Шаг политики `Fixed` положителен, хотя И-15 говорит только о `Tiered`: нулевой шаг сделал бы `minRequired` равным
   * текущей цене, и равная ставка уводила бы лидерство — «при равных суммах побеждает записанная первой» (П-07)
   * перестало бы выполняться.
   */
  def fixed(step: Money): Either[StepPolicyInvalid, StepPolicy] =
    if (!isPositive(step)) Left(StepPolicyInvalid.StepNotPositive)
    else Right(Fixed(step))

  /** Пороги (нижняя граница, шаг): непуст, первая граница ноль, границы строго растут, шаги положительны (И-15). */
  def tiered(tiers: List[Tier]): Either[StepPolicyInvalid, StepPolicy] =
    tiers match {
      case Nil => Left(StepPolicyInvalid.Empty)
      case first :: rest =>
        val bounds = tiers.map(_.bound)
        val amounts = tiers.flatMap(tier => List(tier.bound, tier.step))
        if (amounts.exists(_.currency != first.bound.currency)) Left(StepPolicyInvalid.MixedCurrency)
        else if (first.bound.minorUnits != 0) Left(StepPolicyInvalid.FirstBoundNotZero)
        else if (bounds.zip(bounds.drop(1)).exists((lower, upper) => upper <= lower))
          Left(StepPolicyInvalid.BoundsNotAscending)
        else if (tiers.exists(tier => !isPositive(tier.step))) Left(StepPolicyInvalid.StepNotPositive)
        else Right(Tiered(first.step, rest))
    }

  private def isPositive(step: Money): Boolean = step.minorUnits > 0

  /** Шаг от цены: для `Tiered` — шаг последнего порога, чья нижняя граница не выше цены. */
  def step(policy: StepPolicy, price: Money): Money =
    policy match {
      case Fixed(step) => step
      case Tiered(base, tiers) =>
        tiers.foldLeft(base)((current, tier) => if (tier.bound <= price) tier.step else current)
    }

  /**
   * Наибольшая точка сетки `origin, origin + step(origin), …`, не превосходящая `target`; пусто, если `target` ниже
   * `origin` (ADR-049, «прокси по сетке»). Каждая следующая точка — от предыдущей шагом её цены, как в П-03.
   *
   * Внутри порога шаг постоянен, поэтому точки до следующей границы берутся одним делением, а не перебором: лимит
   * участника — его ввод, и перебор шагов до суммы около `Long.MaxValue` подвесил бы лот. Проходов не больше, чем
   * порогов. Арифметика — в `BigInt`: промежуточная сумма с шагом у лимита около `Long.MaxValue` выходит за `Long`, а
   * ответ не выходит, потому что он не выше `target`.
   */
  def gridFloor(policy: StepPolicy, origin: Money, target: Money): Option[Money] =
    Option.when(origin <= target) {
      val bounds = policy match {
        case Fixed(_) => Nil
        case Tiered(_, tiers) => tiers.map(tier => BigInt(tier.bound.minorUnits))
      }
      val limit = BigInt(target.minorUnits)
      def from(point: BigInt): BigInt = {
        val step = BigInt(StepPolicy.step(policy, origin.copy(minorUnits = point.toLong)).minorUnits)
        val reachable = point + (limit - point) / step * step
        bounds.find(_ > point) match {
          case Some(bound) if reachable >= bound =>
            // Первая точка на новом пороге или за ним; она не выше `reachable`, а значит и `target`. Следующий проход
            // считает от неё уже её шагом.
            from(point + ((bound - point) + step - 1) / step * step)
          case _ => reachable
        }
      }
      origin.copy(minorUnits = from(BigInt(origin.minorUnits)).toLong)
    }
}

/** Почему политика шага противоречива. Каждое нарушение И-15 названо отдельно, а не строкой сообщения. */
enum StepPolicyInvalid {
  case Empty
  case FirstBoundNotZero
  case BoundsNotAscending
  case StepNotPositive
  case MixedCurrency
}
