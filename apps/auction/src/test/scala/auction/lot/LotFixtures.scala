package auction.lot

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

  def op(n: Int): OpId = OpId(new UUID(3L, n.toLong))

  val fixedTen: StepPolicy = StepPolicy.fixed(money(10)).toOption.get

  val fixedHundred: StepPolicy = StepPolicy.fixed(money(100)).toOption.get

  def tiers(pairs: (Long, Long)*): List[StepPolicy.Tier] =
    pairs.toList.map((bound, step) => StepPolicy.Tier(money(bound), money(step)))

  def tiered(pairs: (Long, Long)*): StepPolicy = StepPolicy.tiered(tiers(pairs*)).toOption.get

  def trading(
      price: Long,
      policy: StepPolicy = fixedTen,
      phase: Phase = Phase.Online,
      leader: Option[ParticipantId] = None,
      ask: Option[Long] = None
  ): Lot =
    Lot.of(
      LotState.Trading(
        TradingState(
          config = LotConfig.of(rub, policy).toOption.get,
          currentPrice = money(price),
          ask = ask.map(money),
          leader = leader,
          leadingBidId = leader.map(_ => bid(0)),
          phase = phase
        )
      )
    )

  def held(price: Long, leader: ParticipantId): Lot =
    Lot.of(LotState.Held(HeldState(LotConfig.of(rub, fixedTen).toOption.get, money(price), Some(leader), Some(bid(0)))))

  def sold(price: Long, winner: ParticipantId): Lot =
    Lot.of(LotState.Sold(Sale(winner, money(price), bid(0), Instant.EPOCH)))

  def placeBid(who: Int, amount: Long, opN: Int, currency: CurrencyCode = rub): PlaceBid =
    PlaceBid(participant(who), Money(amount, currency), op(opN), BidSource.Bot)

  def tradingOf(lot: Lot): TradingState =
    lot.state match {
      case LotState.Trading(state) => state
      case other => throw new AssertionError(s"лот не в торгах: $other")
    }

  final case class Journal(lot: Lot, entries: Vector[Envelope]) {

    /** Решение по команде и журнал после него: принятое событие получает следующий `sequence` и применяется. */
    def submit(command: PlaceBid, bidId: BidId): (Either[PlaceBidRejected, Decision], Journal) = {
      val result = Lot.decide(lot, command, bidId)
      result match {
        case Right(Decision.Accepted(event)) =>
          val envelope = Envelope(entries.size.toLong + 1, command.opId, event)
          (result, Journal(Lot.apply(lot, envelope), entries :+ envelope))
        case _ => (result, this)
      }
    }

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
