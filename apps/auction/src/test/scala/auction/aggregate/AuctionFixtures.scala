package auction.aggregate

import auction.lot.LotConfigInput

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
      lotDefaults: LotConfigInput = auction.lot.LotFixtures.configInput()
  ): AuctionConfigInput =
    AuctionConfigInput(onlinePhase, finalBlocks, closingPolicy, lotDefaults)

  def config(input: AuctionConfigInput = configInput()): AuctionConfig =
    AuctionConfig
      .parse(input)
      .fold(invalid => throw new AssertionError(s"образец конфигурации: $invalid"), parsed => parsed)

  /** Аукцион, с которым торги ведёт человек: онлайн-этап без конца и без закрытия лотов. */
  val byAuctioneer: AuctionConfigInput =
    configInput(Some(OnlinePhase(opensAt, None, closesLots = false)), closingPolicy = ClosingPolicy.ByAuctioneer)
}
