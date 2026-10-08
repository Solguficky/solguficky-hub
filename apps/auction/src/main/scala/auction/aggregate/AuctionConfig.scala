package auction.aggregate

import auction.catalog.LotId
import auction.lot.CurrencyCode
import auction.lot.LotConfig
import auction.lot.LotConfigInput
import auction.lot.Money
import auction.lot.StepPolicyInvalid
import auction.lot.StepWindow

import java.time.Instant

/**
 * Онлайн-этап аукциона двумя моментами (RFC-011, «Формат как конфигурация»). `closesAt` — конец этапа и единственный
 * источник дедлайна лота; пуст, когда этап заканчивается командой, а не по времени.
 */
final case class OnlinePhase(opensAt: Instant, closesAt: Option[Instant], closesLots: Boolean)

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
 * `lotDefaults` необязательны (ADR-047, дополнение 2026-10-06): без них лоты получают умолчания платформы.
 */
final case class AuctionConfigInput(
    onlinePhase: Option[OnlinePhase],
    finalBlocks: Int,
    closingPolicy: ClosingPolicy,
    lotDefaults: Option[LotConfigInput],
    stepWindows: List[StepWindowConfig] = Nil
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
 */
final case class AuctionConfig private (
    onlinePhase: Option[OnlinePhase],
    finalBlocks: Int,
    closingPolicy: ClosingPolicy,
    lotDefaults: Option[LotConfig],
    stepWindows: List[StepWindowConfig]
) {

  /** Дедлайн, который лот получает во входе `OpenLot`: `closesAt`, если конец онлайн-этапа закрывает лоты. */
  def lotDeadline: Option[Instant] = onlinePhase.filter(_.closesLots).flatMap(_.closesAt)

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

  def of(
      onlinePhase: Option[OnlinePhase],
      finalBlocks: Int,
      closingPolicy: ClosingPolicy,
      lotDefaults: Option[LotConfig],
      stepWindows: List[StepWindowConfig]
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
    else if (finalBlocks < 0 || finalBlocks > MaxFinalBlocks) Left(ConfigInvalid.FinalBlocksOutOfRange)
    else {
      val currency = lotDefaults.fold(LotTerms.platform.currency)(_.currency)
      windowsInvalid(onlinePhase, currency, stepWindows)
        .toLeft(AuctionConfig(onlinePhase, finalBlocks, closingPolicy, lotDefaults, stepWindows))
    }
  }

  /**
   * Первое нарушение окон в порядке входа: сначала каждое окно само по себе, затем пары с общим лотом. Окно без
   * `closesAt` не имеет верхней границы недели и отклоняется раньше проверки границ.
   */
  private def windowsInvalid(
      onlinePhase: Option[OnlinePhase],
      currency: CurrencyCode,
      windows: List[StepWindowConfig]
  ): Option[ConfigInvalid] = {
    val indexed = windows.zipWithIndex
    val single = indexed.iterator.flatMap { (window, index) =>
      onlinePhase.flatMap(phase => phase.closesAt.map(phase.opensAt -> _)) match {
        case None => Some(ConfigInvalid.StepWindowWithoutClosesAt(index))
        case Some((opensAt, closesAt)) =>
          if (window.from.isBefore(opensAt) || !window.from.isBefore(window.until) || window.until.isAfter(closesAt))
            Some(ConfigInvalid.StepWindowOutsideOnlinePhase(index))
          else if (window.step.minorUnits <= 0 || window.step.currency != currency)
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

  /** Проверка на входе `ScheduleAuction`: шаг — теми же конструкторами, что у `ScheduleLot` (И-15). */
  def parse(input: AuctionConfigInput): Either[ConfigInvalid, AuctionConfig] =
    input.lotDefaults
      .fold(Right(None))(LotConfig.parse(_).left.map(ConfigInvalid.LotDefaults(_)).map(Some(_)))
      .flatMap(of(input.onlinePhase, input.finalBlocks, input.closingPolicy, _, input.stepWindows))
}
