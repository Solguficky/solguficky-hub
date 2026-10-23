package auction.aggregate

import auction.catalog.LotId
import auction.lot.CurrencyCode
import auction.lot.LotConfig
import auction.lot.LotConfigInput
import auction.lot.Money
import auction.lot.StepPolicyInvalid
import auction.lot.StepWindow

import java.time.Duration
import java.time.Instant

/**
 * Онлайн-этап аукциона двумя моментами (RFC-011, «Формат как конфигурация»). `closesAt` — конец этапа и единственный
 * источник дедлайна лота; пуст, когда этап заканчивается командой, а не по времени. `raffleClosesAt` — момент закрытия
 * регистрации в розыгрыше среди участников (ADR-066, п. 5); пуст — аукцион без розыгрыша. `rafflePrize` — приз
 * розыгрыша одной строкой (ADR-066, дополнение 2026-10-21); пуст — розыгрыш без приза.
 */
final case class OnlinePhase(
    opensAt: Instant,
    closesAt: Option[Instant],
    closesLots: Boolean,
    raffleClosesAt: Option[Instant] = None,
    rafflePrize: Option[String] = None
)

/** Кто закрывает лоты. У `Mixed` параметр — только онлайн-сторона: финал закрывает ведущий. */
enum ClosingPolicy {
  case ByAuctioneer
  case ByDeadline
  case Mixed(onlineByDeadline: Boolean)
}

/**
 * Окно сниженного шага аукциона (ADR-047, дополнение 2026-10-08): полуинтервал `[from, until)` онлайн-этапа, сумма шага
 * в нём и лоты, на которые оно действует. Лоту при открытии уходит окно без множества — [[AuctionConfig.windowsOf]].
 */
final case class StepWindowConfig(from: Instant, until: Instant, step: Money, lots: Set[LotId])

/**
 * Конфигурация во входе `ScheduleAuction` до проверки: [[AuctionConfig.parse]] превращает её в [[AuctionConfig]].
 * `lotDefaults` необязательны (ADR-047, дополнение 2026-10-06): без них лоты получают умолчания платформы. Срок оплаты
 * счёта тоже необязателен (ADR-047, дополнение 2026-10-21): без него `parse` подставляет срок платформы.
 */
final case class AuctionConfigInput(
    onlinePhase: Option[OnlinePhase],
    finalBlocks: Int,
    closingPolicy: ClosingPolicy,
    lotDefaults: Option[LotConfigInput],
    stepWindows: List[StepWindowConfig] = Nil,
    paymentTerm: Option[Duration] = None
)

/**
 * Почему конфигурация противоречива (ADR-047, `ConfigInvalid`). `ClosesAtMissing` — одно правило на три входа: дедлайн
 * лотам нужен при `closesLots`, при `ByDeadline` и при `Mixed(onlineByDeadline = true)`, а `closesAt` не задан — в том
 * числе потому, что онлайн-этапа нет вовсе.
 *
 * Случаи окна сниженного шага (ADR-047, дополнение 2026-10-08) называют окно его индексом во входе — с нуля, — чтобы
 * край показал, какое окно неверно: окно без онлайн-этапа или без `closesAt`; окно вне `opensAt ≤ from < until ≤
 * closesAt`; два окна с общим лотом и пересекающимися интервалами; сумма не положительна или не в валюте лотов; пустой
 * набор лотов.
 *
 * Момент закрытия регистрации в розыгрыше (ADR-066, п. 5) строго позже начала онлайн-этапа и, если у этапа есть конец,
 * строго раньше него. День недели сервис не проверяет: это выбор организаторов.
 *
 * Приз розыгрыша (ADR-066, дополнение 2026-10-21) — одна непустая строка не длиннее [[AuctionConfig.MaxRafflePrize]] и
 * только у розыгрыша: приз без момента закрытия регистрации противоречив.
 *
 * Срок оплаты счёта (ADR-047, дополнение 2026-10-21) — от [[AuctionConfig.MinPaymentTerm]] до
 * [[AuctionConfig.MaxPaymentTerm]] включительно.
 */
enum ConfigInvalid {
  case ClosesAtMissing
  case ClosesAtNotAfterOpensAt
  case FinalBlocksOutOfRange
  case LotDefaults(reason: StepPolicyInvalid)
  case StepWindowWithoutClosesAt(window: Int)
  case StepWindowOutsideOnlinePhase(window: Int)
  case StepWindowsOverlap(first: Int, second: Int)
  case StepWindowStepInvalid(window: Int)
  case StepWindowLotsEmpty(window: Int)
  case RaffleClosesAtNotAfterOpensAt
  case RaffleClosesAtNotBeforeClosesAt
  case RafflePrizeWithoutRaffle
  case RafflePrizeBlank
  case RafflePrizeTooLong
  case PaymentTermOutOfRange
}

/**
 * Проверенная конфигурация аукциона — payload `AuctionScheduled`. Конструктор закрыт: противоречивая конфигурация
 * непредставима, и проверка живёт только в [[AuctionConfig.of]]. Выводится она из самого значения, без часов и без
 * обращения к лотам (ADR-047).
 *
 * `lotDefaults` — тот же [[LotConfig]], что у лота: поля совпадают, а И-15 и валюту держат его конструкторы. Пусто —
 * администратор их не задавал, и лоты получают умолчания платформы, как в `Draft`: шага по умолчанию нет ни там, ни
 * здесь, его всегда называет `ScheduleLot`.
 *
 * `stepWindows` — окна сниженного шага, пусто по умолчанию. Их проверка, как и остальная, выводится из самого значения:
 * лоты окна с реестром не сверяются, и окно действует на лот, если при старте торгов лот есть и в реестре, и в окне.
 *
 * `paymentTerm` — срок оплаты счёта от момента продажи (ADR-047, дополнение 2026-10-21). Он задан всегда: без него во
 * входе `parse` подставляет [[AuctionConfig.PlatformPaymentTerm]] и записывает его в журнал, поэтому смена срока
 * платформы не сдвигает уже запланированные аукционы. Счёт берёт срок из конфигурации в момент выставления, а
 * конфигурация заморожена с `PrebiddingStarted`.
 */
final case class AuctionConfig private (
    onlinePhase: Option[OnlinePhase],
    finalBlocks: Int,
    closingPolicy: ClosingPolicy,
    lotDefaults: Option[LotConfig],
    stepWindows: List[StepWindowConfig],
    paymentTerm: Duration
) {

  /** Дедлайн, который лот получает во входе `OpenLot`: `closesAt`, если конец онлайн-этапа закрывает лоты. */
  def lotDeadline: Option[Instant] = onlinePhase.filter(_.closesLots).flatMap(_.closesAt)

  /** Момент закрытия регистрации в розыгрыше; пусто — аукцион проводится без розыгрыша. */
  def raffleClosesAt: Option[Instant] = onlinePhase.flatMap(_.raffleClosesAt)

  /** Приз розыгрыша одной строкой; пусто — розыгрыш без приза. */
  def rafflePrize: Option[String] = onlinePhase.flatMap(_.rafflePrize)

  /**
   * Окна, которые лот получает во входе `OpenLot`: те, в чьих лотах он есть, без самого множества и по возрастанию
   * начала. Пусто, если организатор лот ни в одно окно не выбрал. Валюту лота аукцион не знает — окно в чужой валюте
   * отбрасывает сам лот.
   */
  def windowsOf(lot: LotId): List[StepWindow] =
    stepWindows
      .filter(_.lots.contains(lot))
      .sortBy(_.from)
      .map(window => StepWindow(window.from, window.until, window.step))
}

object AuctionConfig {

  /** Аукцион знает один финал: больше одного блока машина состояний не выражает (RFC-011). */
  val MaxFinalBlocks: Int = 1

  /**
   * Предел строки приза розыгрыша: он едет в сообщение бота, а не хранится описанием. Проверяет его [[parse]], а не
   * [[of]]: предел платформы — такой же, как валюта окон, и смена константы не должна сделать записанный журнал
   * нечитаемым.
   */
  val MaxRafflePrize: Int = 200

  /**
   * Срок оплаты счёта, когда организатор его не задал: семь дней от продажи (ADR-047, дополнение 2026-10-21). Его
   * подставляет [[parse]] и пишет в журнал; строка журнала, записанная до срока, читается с ним же.
   */
  val PlatformPaymentTerm: Duration = Duration.ofDays(7)

  /**
   * Границы срока оплаты — платформы, а не значения, поэтому их проверяет [[parse]], а не [[of]], как предел приза:
   * смена границ не делает записанный журнал нечитаемым.
   */
  val MinPaymentTerm: Duration = Duration.ofDays(1)

  val MaxPaymentTerm: Duration = Duration.ofDays(30)

  def of(
      onlinePhase: Option[OnlinePhase],
      finalBlocks: Int,
      closingPolicy: ClosingPolicy,
      lotDefaults: Option[LotConfig],
      stepWindows: List[StepWindowConfig],
      paymentTerm: Duration
  ): Either[ConfigInvalid, AuctionConfig] = {
    val closesAt = onlinePhase.flatMap(_.closesAt)
    val needsDeadline = onlinePhase.exists(_.closesLots) || (closingPolicy match {
      case ClosingPolicy.ByDeadline => true
      case ClosingPolicy.Mixed(onlineByDeadline) => onlineByDeadline
      case ClosingPolicy.ByAuctioneer => false
    })
    if (needsDeadline && closesAt.isEmpty) Left(ConfigInvalid.ClosesAtMissing)
    else if (onlinePhase.exists(phase => phase.closesAt.exists(!_.isAfter(phase.opensAt))))
      Left(ConfigInvalid.ClosesAtNotAfterOpensAt)
    else if (onlinePhase.exists(phase => phase.raffleClosesAt.exists(!_.isAfter(phase.opensAt))))
      Left(ConfigInvalid.RaffleClosesAtNotAfterOpensAt)
    else if (onlinePhase.exists(phase => phase.raffleClosesAt.exists(t => phase.closesAt.exists(!t.isBefore(_)))))
      Left(ConfigInvalid.RaffleClosesAtNotBeforeClosesAt)
    else if (onlinePhase.exists(phase => phase.rafflePrize.isDefined && phase.raffleClosesAt.isEmpty))
      Left(ConfigInvalid.RafflePrizeWithoutRaffle)
    else if (onlinePhase.exists(phase => phase.rafflePrize.exists(_.isBlank)))
      Left(ConfigInvalid.RafflePrizeBlank)
    else if (finalBlocks < 0 || finalBlocks > MaxFinalBlocks) Left(ConfigInvalid.FinalBlocksOutOfRange)
    else
      windowsInvalid(onlinePhase, lotDefaults.map(_.currency), stepWindows)
        .toLeft(AuctionConfig(onlinePhase, finalBlocks, closingPolicy, lotDefaults, stepWindows, paymentTerm))
  }

  /**
   * Первое нарушение окон в порядке входа: сначала каждое окно само по себе, затем пары с общим лотом. Окно без
   * `closesAt` не имеет верхней границы недели и отклоняется раньше проверки границ. Валюту окна `of` сверяет только с
   * `lotDefaults` из самого значения: без них сверка с умолчаниями платформы — дело [[parse]], иначе смена константы
   * платформы сделала бы записанный журнал нечитаемым.
   */
  private def windowsInvalid(
      onlinePhase: Option[OnlinePhase],
      currency: Option[CurrencyCode],
      windows: List[StepWindowConfig]
  ): Option[ConfigInvalid] = {
    val indexed = windows.zipWithIndex
    val single = indexed.iterator.flatMap { (window, index) =>
      onlinePhase.flatMap(phase => phase.closesAt.map(phase.opensAt -> _)) match {
        case None => Some(ConfigInvalid.StepWindowWithoutClosesAt(index))
        case Some((opensAt, closesAt)) =>
          if (window.from.isBefore(opensAt) || !window.from.isBefore(window.until) || window.until.isAfter(closesAt))
            Some(ConfigInvalid.StepWindowOutsideOnlinePhase(index))
          else if (window.step.minorUnits <= 0 || currency.exists(_ != window.step.currency))
            Some(ConfigInvalid.StepWindowStepInvalid(index))
          else if (window.lots.isEmpty) Some(ConfigInvalid.StepWindowLotsEmpty(index))
          else None
      }
    }
    val pairs = for {
      (first, i) <- indexed.iterator
      (second, j) <- indexed.iterator.drop(i + 1)
      if first.lots.exists(second.lots.contains)
      if first.from.isBefore(second.until) && second.from.isBefore(first.until)
    } yield ConfigInvalid.StepWindowsOverlap(i, j)
    single.nextOption().orElse(pairs.nextOption())
  }

  /**
   * Проверка на входе `ScheduleAuction`: шаг — теми же конструкторами, что у `ScheduleLot` (И-15). Без `lotDefaults`
   * окна сверяются по валюте с умолчаниями платформы, которые лоты тогда получат, — после проверок самого значения, и
   * там же предел строки приза и границы срока оплаты: они — платформы, а не значения, и журнал с записанным сверх них
   * читается. Срок оплаты, которого во входе нет, — [[PlatformPaymentTerm]].
   */
  def parse(input: AuctionConfigInput): Either[ConfigInvalid, AuctionConfig] = {
    val paymentTerm = input.paymentTerm.getOrElse(PlatformPaymentTerm)
    input.lotDefaults
      .fold(Right(None))(LotConfig.parse(_).left.map(ConfigInvalid.LotDefaults(_)).map(Some(_)))
      .flatMap(of(input.onlinePhase, input.finalBlocks, input.closingPolicy, _, input.stepWindows, paymentTerm))
      .flatMap { config =>
        val currency = LotTerms.platform.currency
        val prizeTooLong = config.onlinePhase.flatMap(_.rafflePrize).exists(_.length > MaxRafflePrize)
        if (prizeTooLong) Left(ConfigInvalid.RafflePrizeTooLong)
        else if (paymentTerm.compareTo(MinPaymentTerm) < 0 || paymentTerm.compareTo(MaxPaymentTerm) > 0)
          Left(ConfigInvalid.PaymentTermOutOfRange)
        else
          config.stepWindows.zipWithIndex
            .collectFirst {
              case (window, index) if config.lotDefaults.isEmpty && window.step.currency != currency =>
                ConfigInvalid.StepWindowStepInvalid(index)
            }
            .toLeft(config)
      }
  }
}
