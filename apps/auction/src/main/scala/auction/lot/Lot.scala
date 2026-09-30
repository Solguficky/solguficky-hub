package auction.lot

/**
 * Агрегат лота: состояние, сессия и окно дедупликации, свёрнутые из журнала.
 *
 * `seen` — это П-06 в форме значения: `seen(op_id) ⟺ в журнале агрегата есть событие с этим op_id`. Пишет в него только
 * [[Lot.apply]], поэтому окно восстанавливается реплеем журнала, а не живёт кэшем процесса, и отказ, который событий не
 * пишет, в него не попадает. Для транзакции из нескольких событий окно держит первый конверт — по нему
 * восстанавливается ответ на повтор.
 *
 * `session` пуста ровно в `Initial`: лот рождается внутри сессии, и `LotDrafted` приносит её вместе с рождением. Пишет
 * её тоже только [[Lot.apply]], и больше она не меняется.
 */
final case class Lot(state: LotState, session: Option[SessionId], seen: Map[OpId, Envelope])

/** Исход принятой команды: новое событие либо исходный ответ на повтор того же `op_id`. */
enum Decision {
  case Accepted(event: LotEvent)
  case Repeated(original: Envelope)
}

object Lot {

  /** Лот, в журнале которого ещё ничего нет: начальное состояние entity. */
  val initial: Lot = Lot(LotState.Initial, None, Map.empty)

  /** Рождение лота. Повтор того же `op_id` получает исходный ответ, другой `op_id` — `LotAlreadyExists`. */
  def decide(lot: Lot, command: DraftLot): Either[DraftLotRejected, Decision] =
    lot.seen.get(command.opId) match {
      case Some(original) => Right(Decision.Repeated(original))
      case None =>
        lot.state match {
          case LotState.Initial => Right(Decision.Accepted(LotEvent.LotDrafted(command.session)))
          case LotState.Draft | LotState.Scheduled(_) | LotState.Trading(_) | LotState.Held(_) | LotState.Sold(_) =>
            Left(DraftLotRejected.LotAlreadyExists)
        }
    }

  /**
   * Планирование условий торгов. Порядок проверок: состояние, затем И-15, затем валюта стартовой цены — отказ по
   * состоянию не зависит от того, что прислали, и после `LotOpened` лот отвечает `SchedulingClosed` на любой вход
   * (Т-20, Т-52). Каждая правка пишет `Schedule` целиком.
   */
  def decide(lot: Lot, command: ScheduleLot): Either[ScheduleLotRejected, Decision] =
    lot.seen.get(command.opId) match {
      case Some(original) => Right(Decision.Repeated(original))
      case None =>
        lot.state match {
          case LotState.Initial => Left(ScheduleLotRejected.LotNotFound)
          case LotState.Draft | LotState.Scheduled(_) =>
            LotConfig
              .parse(command.config)
              .left
              .map(ScheduleLotRejected.StepPolicyInvalid(_))
              .flatMap(Schedule.of(command.startingPrice, _))
              .map(schedule => Decision.Accepted(LotEvent.LotScheduled(schedule)))
          case LotState.Trading(_) | LotState.Held(_) | LotState.Sold(_) => Left(ScheduleLotRejected.SchedulingClosed)
        }
    }

  /**
   * Открытие торгов. Как и у ставки, `seen` проверяется первым: повтор открытия получает исходный ответ, а не
   * `LotNotScheduled`. Условия торгов берутся из `Scheduled` и уже проверены, поэтому других отказов у открытия нет.
   */
  def decide(lot: Lot, command: OpenLot): Either[OpenLotRejected, Decision] =
    lot.seen.get(command.opId) match {
      case Some(original) => Right(Decision.Repeated(original))
      case None =>
        lot.state match {
          case LotState.Initial => Left(OpenLotRejected.LotNotFound)
          case LotState.Scheduled(schedule) =>
            Right(Decision.Accepted(LotEvent.LotOpened(schedule.startingPrice, schedule.config, command.deadline)))
          case LotState.Draft | LotState.Trading(_) | LotState.Held(_) | LotState.Sold(_) =>
            Left(OpenLotRejected.LotNotScheduled)
        }
    }

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
          case LotState.Initial => Left(PlaceBidRejected.LotNotFound)
          case LotState.Draft | LotState.Scheduled(_) => Left(PlaceBidRejected.LotNotOpen)
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
   *
   * `LotOpened` строит торги только из самого события: стартовая цена становится текущей, лидера нет, фаза `Online`
   * выводится из факта открытия (RFC-011). Применяется он только к `Scheduled`: журнал, который начинается с
   * `LotOpened` без `LotDrafted`, лота не рождает.
   */
  def apply(lot: Lot, envelope: Envelope): Lot = {
    val (state, session) = (lot.state, envelope.event) match {
      case (LotState.Initial, LotEvent.LotDrafted(session)) => (LotState.Draft, Some(session))
      case (LotState.Draft | LotState.Scheduled(_), LotEvent.LotScheduled(schedule)) =>
        (LotState.Scheduled(schedule), lot.session)
      case (LotState.Scheduled(_), opened: LotEvent.LotOpened) =>
        val trading = TradingState(
          config = opened.config,
          currentPrice = opened.startingPrice,
          ask = None,
          leader = None,
          leadingBidId = None,
          phase = Phase.Online,
          deadline = opened.deadline
        )
        (LotState.Trading(trading), lot.session)
      case (LotState.Trading(trading), placed: LotEvent.BidPlaced) =>
        val next = trading.copy(
          currentPrice = placed.amount,
          leader = Some(placed.participant),
          leadingBidId = Some(placed.bidId)
        )
        (LotState.Trading(next), lot.session)
      case (other, _) => (other, lot.session)
    }
    val seen = if (lot.seen.contains(envelope.opId)) lot.seen else lot.seen.updated(envelope.opId, envelope)
    Lot(state, session, seen)
  }

  /**
   * Сессия строки, которую пишет принятое событие: у `LotDrafted` — та, что родила лот, у остальных — сессия лота.
   * Пусто только у события лота в `Initial`, а из `Initial` [[decide]] принимает одно `LotDrafted`.
   */
  def sessionOf(lot: Lot, event: LotEvent): Option[SessionId] =
    event match {
      case LotEvent.LotDrafted(session) => Some(session)
      case _ => lot.session
    }

  /**
   * Свёртка журнала в порядке `sequence` (П-07): при равных суммах лидирует ставка, записанная первой, и время события
   * в сравнении не участвует. Порядок, в котором строки пришли к вызывающему, на итог не влияет.
   */
  def replay(from: Lot, journal: Seq[Envelope]): Lot =
    journal.sortBy(_.sequence).foldLeft(from)((lot, envelope) => apply(lot, envelope))
}
