package auction.aggregate

import auction.catalog.LotId
import auction.lot.LotConfigInput
import auction.lot.LotFixtures.money

import java.time.Instant

/** Образцы конфигурации аукциона: один валидный формат Ф-4, отличие теста — переопределением. */
object AuctionFixtures {

  val opensAt: Instant = Instant.parse("2026-10-01T18:00:00Z")

  /** Конец недели онлайн-торгов — общий дедлайн лотов. */
  val closesAt: Instant = Instant.parse("2026-10-08T21:00:00Z")

  val week: OnlinePhase = OnlinePhase(opensAt, Some(closesAt), closesLots = true)

  /** Ф-4 (RFC-011): неделя с общим дедлайном, один блок финала, онлайн закрывается по дедлайну. */
  def configInput(
      onlinePhase: Option[OnlinePhase] = Some(week),
      finalBlocks: Int = 1,
      closingPolicy: ClosingPolicy = ClosingPolicy.Mixed(onlineByDeadline = true),
      lotDefaults: Option[LotConfigInput] = Some(auction.lot.LotFixtures.configInput()),
      stepWindows: List[StepWindowConfig] = Nil
  ): AuctionConfigInput =
    AuctionConfigInput(onlinePhase, finalBlocks, closingPolicy, lotDefaults, stepWindows)

  /** Окно сниженного шага внутри недели: часы от `opensAt`, сумма в рублях, как у умолчаний лотов. */
  def window(fromHour: Long, untilHour: Long, lots: Set[LotId], step: Long = 1): StepWindowConfig =
    StepWindowConfig(opensAt.plusSeconds(fromHour * 3600), opensAt.plusSeconds(untilHour * 3600), money(step), lots)

  def config(input: AuctionConfigInput = configInput()): AuctionConfig =
    AuctionConfig
      .parse(input)
      .fold(invalid => throw new AssertionError(s"образец конфигурации: $invalid"), parsed => parsed)

  /** Аукцион, с которым торги ведёт человек: онлайн-этап без конца и без закрытия лотов. */
  val byAuctioneer: AuctionConfigInput =
    configInput(Some(OnlinePhase(opensAt, None, closesLots = false)), closingPolicy = ClosingPolicy.ByAuctioneer)
}
