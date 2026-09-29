package auction.lot

/**
 * Политика шага (П-03): шаг вычисляется от цены, а не хранится одним числом.
 *
 * Конструкторы закрыты, и значение получается только через [[StepPolicy.fixed]] и [[StepPolicy.tiered]]. Так И-15
 * выполняется по построению: противоречивая политика непредставима, и `step` тотальна на любой цене без `head` и без
 * пустого случая. Отказ [[StepPolicyInvalid]] станет ответом `ScheduleLot`, когда команда появится (RFC-011, И-15).
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
    if (step.minorUnits <= 0) Left(StepPolicyInvalid.StepNotPositive)
    else Right(Fixed(step))

  /** Список пар (нижняя граница, шаг): непуст, первая граница ноль, границы строго растут, шаги положительны (И-15). */
  def tiered(pairs: List[(Money, Money)]): Either[StepPolicyInvalid, StepPolicy] =
    pairs match {
      case Nil => Left(StepPolicyInvalid.Empty)
      case (firstBound, firstStep) :: rest =>
        val tiers = rest.map((bound, step) => Tier(bound, step))
        val bounds = firstBound :: tiers.map(_.bound)
        val amounts = pairs.flatMap((bound, step) => List(bound, step))
        if (amounts.exists(_.currency != firstBound.currency)) Left(StepPolicyInvalid.MixedCurrency)
        else if (firstBound.minorUnits != 0) Left(StepPolicyInvalid.FirstBoundNotZero)
        else if (bounds.zip(bounds.drop(1)).exists((lower, upper) => upper <= lower))
          Left(StepPolicyInvalid.BoundsNotAscending)
        else if (pairs.exists((_, step) => step.minorUnits <= 0)) Left(StepPolicyInvalid.StepNotPositive)
        else Right(Tiered(firstStep, tiers))
    }

  /** Шаг от цены: для `Tiered` — шаг последнего порога, чья нижняя граница не выше цены. */
  def step(policy: StepPolicy, price: Money): Money =
    policy match {
      case Fixed(step) => step
      case Tiered(base, tiers) =>
        tiers.foldLeft(base)((current, tier) => if (tier.bound <= price) tier.step else current)
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
