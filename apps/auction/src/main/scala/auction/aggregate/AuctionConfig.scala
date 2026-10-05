package auction.aggregate

import auction.lot.LotConfig
import auction.lot.LotConfigInput
import auction.lot.StepPolicyInvalid

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

/** Конфигурация во входе `ScheduleAuction` до проверки: [[AuctionConfig.parse]] превращает её в [[AuctionConfig]]. */
final case class AuctionConfigInput(
    onlinePhase: Option[OnlinePhase],
    finalBlocks: Int,
    closingPolicy: ClosingPolicy,
    lotDefaults: LotConfigInput
)

/**
 * Почему конфигурация противоречива (ADR-047, `ConfigInvalid`). `ClosesAtMissing` — одно правило на три входа: дедлайн
 * лотам нужен при `closesLots`, при `ByDeadline` и при `Mixed(onlineByDeadline = true)`, а `closesAt` не задан — в том
 * числе потому, что онлайн-этапа нет вовсе.
 */
enum ConfigInvalid {
  case ClosesAtMissing
  case ClosesAtNotAfterOpensAt
  case FinalBlocksOutOfRange
  case LotDefaults(reason: StepPolicyInvalid)
}

/**
 * Проверенная конфигурация аукциона — payload `AuctionScheduled`. Конструктор закрыт: противоречивая конфигурация
 * непредставима, и проверка живёт только в [[AuctionConfig.of]]. Выводится она из самого значения, без часов и без
 * обращения к лотам (ADR-047).
 *
 * `lotDefaults` — тот же [[LotConfig]], что у лота: поля совпадают, а И-15 и валюту держат его конструкторы.
 */
final case class AuctionConfig private (
    onlinePhase: Option[OnlinePhase],
    finalBlocks: Int,
    closingPolicy: ClosingPolicy,
    lotDefaults: LotConfig
) {

  /** Дедлайн, который лот получает во входе `OpenLot`: `closesAt`, если конец онлайн-этапа закрывает лоты. */
  def lotDeadline: Option[Instant] = onlinePhase.filter(_.closesLots).flatMap(_.closesAt)
}

object AuctionConfig {

  /** Аукцион знает один финал: больше одного блока машина состояний не выражает (RFC-011). */
  val MaxFinalBlocks: Int = 1

  def of(
      onlinePhase: Option[OnlinePhase],
      finalBlocks: Int,
      closingPolicy: ClosingPolicy,
      lotDefaults: LotConfig
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
    else Right(AuctionConfig(onlinePhase, finalBlocks, closingPolicy, lotDefaults))
  }

  /** Проверка на входе `ScheduleAuction`: шаг — теми же конструкторами, что у `ScheduleLot` (И-15). */
  def parse(input: AuctionConfigInput): Either[ConfigInvalid, AuctionConfig] =
    LotConfig
      .parse(input.lotDefaults)
      .left
      .map(ConfigInvalid.LotDefaults(_))
      .flatMap(of(input.onlinePhase, input.finalBlocks, input.closingPolicy, _))
}
