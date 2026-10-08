package auction.lot

import java.time.Duration
import java.time.Instant
import java.util.UUID

/**
 * Образцы и журнал для L0-тестов лота.
 *
 * Данные строятся от одного валидного образца с переопределением отличия. `Journal` играет роль того, кто пишет журнал
 * на рабочем пути: назначает `sequence` принятому событию и применяет его. Отказ до журнала не доходит.
 */
object LotFixtures {

  val rub: CurrencyCode = CurrencyCode("RUB")
  val eur: CurrencyCode = CurrencyCode("EUR")

  def money(minorUnits: Long): Money = Money(minorUnits, rub)

  def participant(n: Int): ParticipantId = ParticipantId(new UUID(1L, n.toLong))

  def bid(n: Int): BidId = BidId(new UUID(2L, n.toLong))

  /** Идентификатор производной ставки прокси: отдельная серия, чтобы по нему было видно, чья это ставка. */
  def proxyBid(n: Int): BidId = BidId(new UUID(5L, n.toLong))

  def op(n: Int): OpId = OpId(new UUID(3L, n.toLong))

  def auctionId(n: Int): AuctionId = AuctionId(new UUID(4L, n.toLong))

  val fixedTen: StepPolicy = StepPolicy.fixed(money(10)).toOption.get

  val fixedHundred: StepPolicy = StepPolicy.fixed(money(100)).toOption.get

  def tiers(pairs: (Long, Long)*): List[StepPolicy.Tier] =
    pairs.toList.map((bound, step) => StepPolicy.Tier(money(bound), money(step)))

  def tiered(pairs: (Long, Long)*): StepPolicy = StepPolicy.tiered(tiers(pairs*)).toOption.get

  /** Умолчание аукциона из RFC-011: окно 2 минуты, продление на 2 минуты, не больше трёх раз. */
  val antiSnipe: AntiSnipe = AntiSnipe(Duration.ofMinutes(2), Duration.ofMinutes(2), 3)

  def config(policy: StepPolicy = fixedTen, proxyEnabled: Boolean = true): LotConfig =
    LotConfig.of(rub, policy, antiSnipe, proxyEnabled).toOption.get

  val deadline: Instant = Instant.parse("2026-10-07T18:00:00Z")

  /** Время команды за час до дедлайна: вне окна анти-снайпа, поэтому ставка дедлайн не трогает. */
  val calm: Instant = deadline.minus(Duration.ofHours(1))

  /**
   * Дедлайн для сьютов на системных часах: их ставка в окно анти-снайпа не попадает, когда бы тест ни шёл. С `deadline`
   * такой сьют начал бы продлевать лот, как только настоящее время подошло бы к нему.
   */
  val distantDeadline: Instant = Instant.parse("2126-01-01T00:00:00Z")

  /** Вход `ScheduleLot`, который даёт `config()`: тот же образец в непроверенной форме. */
  def configInput(
      policy: StepPolicyInput = StepPolicyInput.Fixed(money(10)),
      currency: CurrencyCode = rub
  ): LotConfigInput =
    LotConfigInput(currency, policy, antiSnipe, proxyEnabled = true)

  def schedule(startingPrice: Long = 100, policy: StepPolicy = fixedTen): Schedule =
    Schedule.of(money(startingPrice), config(policy)).toOption.get

  def draftLot(opN: Int, of: AuctionId = auctionId(1)): DraftLot = DraftLot(of, op(opN))

  def scheduleLot(opN: Int, startingPrice: Long = 100, input: LotConfigInput = configInput()): ScheduleLot =
    ScheduleLot(money(startingPrice), input, op(opN))

  def openLot(opN: Int, deadline: Option[Instant] = Some(deadline)): OpenLot = OpenLot(deadline, op(opN))

  /** Окно сниженного шага в день дедлайна: `from` и `until` — время UTC вида `12:00`. */
  def stepWindow(from: String, until: String, step: Long, currency: CurrencyCode = rub): StepWindow =
    StepWindow(at(from), at(until), Money(step, currency))

  /** Момент дня дедлайна по времени UTC вида `12:00` или `13:59:59`. */
  def at(time: String): Instant =
    Instant.parse(s"2026-10-07T${if (time.length == 5) s"$time:00" else time}Z")

  def closeLot(opN: Int, reason: CloseReason = CloseReason.DeadlineReached): CloseLot = CloseLot(reason, op(opN))

  def markForFinal(opN: Int): MarkForFinal = MarkForFinal(op(opN))

  def unmarkForFinal(opN: Int): UnmarkForFinal = UnmarkForFinal(op(opN))

  def resumeLot(opN: Int): ResumeLot = ResumeLot(op(opN))

  /** Лот аукциона `auctionId(1)` в данном состоянии с пустым окном дедупликации. */
  def lotIn(state: LotState): Lot = Lot(state, Some(auctionId(1)), Map.empty)

  val drafted: Lot = lotIn(LotState.Draft)

  def scheduled(startingPrice: Long = 100): Lot = lotIn(LotState.Scheduled(schedule(startingPrice)))

  def trading(
      price: Long,
      policy: StepPolicy = fixedTen,
      phase: Phase = Phase.Online,
      leader: Option[ParticipantId] = None,
      ask: Option[Long] = None,
      limits: Map[ParticipantId, ProxyLimit] = Map.empty,
      proxyEnabled: Boolean = true,
      closesAt: Option[Instant] = Some(deadline),
      extensionsUsed: Int = 0,
      markedForFinal: Boolean = false,
      stepWindows: List[StepWindow] = Nil
  ): Lot =
    lotIn(
      LotState.Trading(
        TradingState(
          config = config(policy, proxyEnabled),
          currentPrice = money(price),
          ask = ask.map(money),
          leader = leader,
          leadingBidId = leader.map(_ => bid(0)),
          phase = phase,
          deadline = closesAt,
          extensionsUsed = extensionsUsed,
          proxyLimits = limits,
          markedForFinal = markedForFinal,
          stepWindows = stepWindows
        )
      )
    )

  def held(price: Long, leader: ParticipantId, limits: Map[ParticipantId, ProxyLimit] = Map.empty): Lot =
    lotIn(LotState.Held(HeldState(config(), money(price), Some(leader), Some(bid(0)), limits, extensionsUsed = 0)))

  def sold(price: Long, winner: ParticipantId): Lot =
    lotIn(LotState.Sold(Sale(winner, money(price), bid(0), Instant.EPOCH)))

  def placeBid(who: Int, amount: Long, opN: Int, currency: CurrencyCode = rub): PlaceBid =
    PlaceBid(participant(who), Money(amount, currency), op(opN), BidSource.Bot)

  def setProxyLimit(who: Int, max: Long, opN: Int, currency: CurrencyCode = rub): SetProxyLimit =
    SetProxyLimit(participant(who), Money(max, currency), op(opN))

  def withdrawProxyLimit(who: Int, opN: Int): WithdrawProxyLimit = WithdrawProxyLimit(participant(who), op(opN))

  def limit(max: Long, setSeq: Long): ProxyLimit = ProxyLimit(money(max), setSeq)

  /** Ручная ставка из бота в событии. */
  def manual(bidId: BidId, who: Int, amount: Long, previous: Option[Int]): LotEvent.BidPlaced =
    LotEvent.BidPlaced(
      bidId,
      participant(who),
      money(amount),
      previous.map(participant),
      BidOrigin.Manual(BidSource.Bot)
    )

  /** Производная ставка прокси в событии. */
  def proxied(bidId: BidId, who: Int, amount: Long, previous: Option[Int]): LotEvent.BidPlaced =
    LotEvent.BidPlaced(bidId, participant(who), money(amount), previous.map(participant), BidOrigin.Proxy)

  def tradingOf(lot: Lot): TradingState =
    lot.state match {
      case LotState.Trading(state) => state
      case other => throw new AssertionError(s"лот не в торгах: $other")
    }

  def heldOf(lot: Lot): HeldState =
    lot.state match {
      case LotState.Held(state) => state
      case other => throw new AssertionError(s"лот не удержан: $other")
    }

  final case class Journal(lot: Lot, entries: Vector[Envelope]) {

    /**
     * Принятое решение ложится в журнал следующими номерами — событие команды, затем производные; отказ и повтор журнал
     * не меняют.
     */
    def record[R](opId: OpId, result: Either[R, Decision]): (Either[R, Decision], Journal) =
      result match {
        case Right(Decision.Accepted(event, derived)) =>
          val written = (event :: derived).zipWithIndex.map { (each, index) =>
            Envelope(entries.size.toLong + 1 + index, opId, each)
          }
          (result, Journal(written.foldLeft(lot)(Lot.apply), entries ++ written))
        case _ => (result, this)
      }

    def draft(command: DraftLot): (Either[DraftLotRejected, Decision], Journal) =
      record(command.opId, Lot.decide(lot, command))

    def schedule(command: ScheduleLot): (Either[ScheduleLotRejected, Decision], Journal) =
      record(command.opId, Lot.decide(lot, command))

    def open(command: OpenLot): (Either[OpenLotRejected, Decision], Journal) =
      record(command.opId, Lot.decide(lot, command))

    /**
     * Решение по команде и журнал после него: принятое событие получает следующий `sequence` и применяется. По
     * умолчанию команда приходит вне окна анти-снайпа.
     */
    def submit(command: PlaceBid, bidId: BidId, now: Instant = calm): (Either[PlaceBidRejected, Decision], Journal) =
      record(command.opId, Lot.decide(lot, command, bidId, proxyBid(entries.size + 1), now))

    /** Лимит; производная ставка, если она есть, получает `proxyBid` с номером первой строки транзакции. */
    def limit(command: SetProxyLimit, now: Instant = calm): (Either[SetProxyLimitRejected, Decision], Journal) =
      record(command.opId, Lot.decide(lot, command, entries.size.toLong + 1, proxyBid(entries.size + 1), now))

    def withdraw(command: WithdrawProxyLimit): (Either[WithdrawProxyLimitRejected, Decision], Journal) =
      record(command.opId, Lot.decide(lot, command))

    def close(command: CloseLot, now: Instant): (Either[CloseLotRejected, Decision], Journal) =
      record(command.opId, Lot.decide(lot, command, now))

    def mark(command: MarkForFinal, now: Instant = calm): (Either[MarkForFinalRejected, Decision], Journal) =
      record(command.opId, Lot.decide(lot, command, now))

    def unmark(command: UnmarkForFinal, now: Instant = calm): (Either[UnmarkForFinalRejected, Decision], Journal) =
      record(command.opId, Lot.decide(lot, command, now))

    def resume(command: ResumeLot): (Either[ResumeLotRejected, Decision], Journal) =
      record(command.opId, Lot.decide(lot, command))

    def submitAll(commands: Seq[PlaceBid]): (Vector[Either[PlaceBidRejected, Decision]], Journal) =
      commands.zipWithIndex.foldLeft((Vector.empty[Either[PlaceBidRejected, Decision]], this)) {
        case ((results, journal), (command, index)) =>
          val (result, next) = journal.submit(command, bid(index + 1))
          (results :+ result, next)
      }
  }

  object Journal {
    def of(lot: Lot): Journal = Journal(lot, Vector.empty)
  }
}
