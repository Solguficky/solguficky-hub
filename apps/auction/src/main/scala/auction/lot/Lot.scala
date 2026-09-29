package auction.lot

/**
 * Агрегат лота: состояние и окно дедупликации, свёрнутые из журнала.
 *
 * `seen` — это П-06 в форме значения: `seen(op_id) ⟺ в журнале агрегата есть событие с этим op_id`. Пишет в него только
 * [[Lot.apply]], поэтому окно восстанавливается реплеем журнала, а не живёт кэшем процесса, и отказ, который событий не
 * пишет, в него не попадает. Для транзакции из нескольких событий окно держит первый конверт — по нему
 * восстанавливается ответ на повтор.
 */
final case class Lot(state: LotState, seen: Map[OpId, Envelope])

/** Исход принятой команды: новое событие либо исходный ответ на повтор того же `op_id`. */
enum Decision {
  case Accepted(event: LotEvent)
  case Repeated(original: Envelope)
}

object Lot {

  def of(state: LotState): Lot = Lot(state, Map.empty)

  /**
   * Приём ставки (П-01).
   *
   * `seen` проверяется до разбора состояния: повтор ставки, принятой до удержания, получает исходный ответ, а не
   * `LotOnHold` (RFC-011, П-09). `bidId` приходит снаружи, как и любой идентификатор: решение не рождает их само.
   */
  def decide(lot: Lot, command: PlaceBid, bidId: BidId): Either[PlaceBidRejected, Decision] =
    lot.seen.get(command.opId) match {
      case Some(original) => Right(Decision.Repeated(original))
      case None =>
        lot.state match {
          case LotState.Trading(trading) => placeBid(trading, command, bidId).map(Decision.Accepted(_))
          case LotState.Held(_) => Left(PlaceBidRejected.LotOnHold)
          case LotState.Sold(_) => Left(PlaceBidRejected.LotNotOpen)
        }
    }

  /**
   * Следующая цена: объявленный ask, если он выше текущей цены, иначе цена плюс шаг от неё (П-01, П-03). До первой
   * ставки это стартовая цена плюс шаг.
   */
  def minRequired(trading: TradingState): Money =
    trading.ask.filter(_ > trading.currentPrice) match {
      case Some(ask) => ask
      case None => trading.currentPrice.plus(StepPolicy.step(trading.config.stepPolicy, trading.currentPrice))
    }

  /**
   * Порядок проверок повторяет RFC-011: валюта, лидерство, затем порог. В `Live` сумма — ожидаемая цена, и проверка
   * `BidNotAtNextPrice` стоит выше `BidBelowMinimum`, чтобы отказ в финале был один и называл цену (ADR-049).
   */
  private def placeBid(trading: TradingState, command: PlaceBid, bidId: BidId): Either[PlaceBidRejected, LotEvent] = {
    val required = minRequired(trading)
    if (command.amount.currency != trading.config.currency) Left(PlaceBidRejected.CurrencyMismatch)
    else if (trading.leader.contains(command.participant)) Left(PlaceBidRejected.BidderIsLeader)
    else if (trading.phase == Phase.Live && command.amount != required)
      Left(PlaceBidRejected.BidNotAtNextPrice(required))
    else if (command.amount < required) Left(PlaceBidRejected.BidBelowMinimum(required))
    else
      Right(
        LotEvent.BidPlaced(
          bidId = bidId,
          participant = command.participant,
          amount = command.amount,
          previousLeader = trading.leader,
          origin = BidOrigin.Manual,
          source = command.source
        )
      )
  }

  /**
   * Применение события: только меняет состояние и не отказывает. Событие, которое к текущему состоянию не относится,
   * состояние не трогает — такой пары `decide` не порождает, а журнал её не содержит.
   */
  def apply(lot: Lot, envelope: Envelope): Lot = {
    val state = (lot.state, envelope.event) match {
      case (LotState.Trading(trading), placed: LotEvent.BidPlaced) =>
        LotState.Trading(
          trading.copy(
            currentPrice = placed.amount,
            leader = Some(placed.participant),
            leadingBidId = Some(placed.bidId)
          )
        )
      case (other, _) => other
    }
    val seen = if (lot.seen.contains(envelope.opId)) lot.seen else lot.seen.updated(envelope.opId, envelope)
    Lot(state, seen)
  }

  /**
   * Свёртка журнала в порядке `sequence` (П-07): при равных суммах лидирует ставка, записанная первой, и время события
   * в сравнении не участвует. Порядок, в котором строки пришли к вызывающему, на итог не влияет.
   */
  def replay(from: Lot, journal: Seq[Envelope]): Lot =
    journal.sortBy(_.sequence).foldLeft(from)((lot, envelope) => apply(lot, envelope))
}
