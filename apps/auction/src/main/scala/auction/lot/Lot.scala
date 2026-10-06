package auction.lot

import java.time.Instant

/**
 * Агрегат лота: состояние, аукцион и окно дедупликации, свёрнутые из журнала.
 *
 * `seen` — это П-06 в форме значения: `seen(op_id) ⟺ в журнале агрегата есть событие с этим op_id`. Пишет в него только
 * [[Lot.apply]], поэтому окно восстанавливается реплеем журнала, а не живёт кэшем процесса, и отказ, который событий не
 * пишет, в него не попадает. Для транзакции из нескольких событий окно держит первый конверт — по нему
 * восстанавливается ответ на повтор.
 *
 * `auction` пуста ровно в `Initial`: лот рождается внутри аукциона, и `LotDrafted` приносит его вместе с рождением.
 * Пишет его тоже только [[Lot.apply]], и больше она не меняется.
 */
final case class Lot(state: LotState, auction: Option[AuctionId], seen: Map[OpId, Envelope])

/**
 * Исход принятой команды: события её транзакции либо исходный ответ на повтор того же `op_id`.
 *
 * Транзакция непуста по построению: `event` — событие самой команды, по нему строится ответ, а `derived` — производные
 * события, которые команда вызвала, в порядке записи: производная ставка прокси (П-02), за ней продление дедлайна
 * (П-04). Все события транзакции пишутся одной записью с одним `op_id` (RFC-011, П-06).
 */
enum Decision {
  case Accepted(event: LotEvent, derived: List[LotEvent] = Nil)
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
          case LotState.Initial => Right(Decision.Accepted(LotEvent.LotDrafted(command.auction)))
          case LotState.Draft | LotState.Scheduled(_) | LotState.Trading(_) | LotState.Held(_) | LotState.Sold(_) |
              LotState.Unsold(_) =>
            Left(DraftLotRejected.LotAlreadyExists)
        }
    }

  /**
   * Планирование условий торгов. Порядок проверок: состояние, затем И-15, затем валюта стартовой цены — отказ по
   * состоянию не зависит от того, что прислали, и после `LotOpened` лот отвечает `SchedulingClosed` на любой вход
   * (Т-20, Т-52). Каждая правка пишет `Schedule` целиком.
   *
   * `op_id` команды приходит от администратора снаружи, поэтому повтор отвечает исходным конвертом только своей команде
   * — событию `LotScheduled`. `op_id`, записанный под другим событием лота, получает `OpIdTaken`: исходный конверт
   * выдал бы чужое событие за принятые условия (ADR-047, дополнение 2026-10-05).
   */
  def decide(lot: Lot, command: ScheduleLot): Either[ScheduleLotRejected, Decision] =
    repeatOf(lot, command.opId, ScheduleLotRejected.OpIdTaken) {
      case _: LotEvent.LotScheduled => true
      case _ => false
    }.getOrElse {
      lot.state match {
        case LotState.Initial => Left(ScheduleLotRejected.LotNotFound)
        case LotState.Draft | LotState.Scheduled(_) =>
          LotConfig
            .parse(command.config)
            .left
            .map(ScheduleLotRejected.StepPolicyInvalid(_))
            .flatMap(Schedule.of(command.startingPrice, _))
            .map(schedule => Decision.Accepted(LotEvent.LotScheduled(schedule)))
        case LotState.Trading(_) | LotState.Held(_) | LotState.Sold(_) | LotState.Unsold(_) =>
          Left(ScheduleLotRejected.SchedulingClosed)
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
          case LotState.Draft | LotState.Trading(_) | LotState.Held(_) | LotState.Sold(_) | LotState.Unsold(_) =>
            Left(OpenLotRejected.LotNotScheduled)
        }
    }

  /**
   * Приём ставки (П-01), ответ прокси на неё (П-02) и продление дедлайна (П-04).
   *
   * `seen` проверяется до разбора состояния: повтор ставки, принятой до удержания, получает исходный ответ, а не
   * `LotOnHold` (RFC-011, П-09). `bidId` и `proxyBidId` приходят снаружи, как и любой идентификатор: решение не рождает
   * их само. Второй нужен производной ставке и пропадает, если её нет. `now` — серверное время команды, оно же
   * `occurred_at` её строк: им П-04 решает, попала ли ставка в окно.
   */
  def decide(
      lot: Lot,
      command: PlaceBid,
      bidId: BidId,
      proxyBidId: BidId,
      now: Instant
  ): Either[PlaceBidRejected, Decision] =
    repeatOf(lot, command.opId, PlaceBidRejected.OpIdTaken) {
      case LotEvent.BidPlaced(_, participant, _, _, BidOrigin.Manual(_)) => participant == command.participant
      case _ => false
    }.getOrElse {
      lot.state match {
        case LotState.Initial => Left(PlaceBidRejected.LotNotFound)
        case LotState.Draft | LotState.Scheduled(_) => Left(PlaceBidRejected.LotNotOpen)
        case LotState.Trading(trading) =>
          placeBid(trading, command, bidId).map { placed =>
            Decision.Accepted(placed, resolve(bidden(trading, placed), proxyBidId).toList ++ extended(trading, now))
          }
        case LotState.Held(held) => Left(PlaceBidRejected.LotOnHold(held.currentPrice))
        case LotState.Sold(_) | LotState.Unsold(_) => Left(PlaceBidRejected.LotNotOpen)
      }
    }

  /**
   * Прокси-лимит (ADR-047). В торгах за `ProxyLimitSet` идёт пересчёт П-02 на состоянии после него, и производная
   * ставка, если она есть, пишется той же транзакцией — одним событием с итоговой ценой, а за ней продление П-04 на
   * время `now`. Лимит без производной ставки ставкой не является и дедлайн не продлевает. В удержании лимит
   * записывается без пересчёта и ждёт финала (RFC-011, П-09); дедлайна там нет.
   *
   * `sequence` — номер, который получит `ProxyLimitSet` в журнале. Его назначает тот, кто пишет журнал, и передаёт сюда
   * так же, как идентификаторы: пересчёт идёт на том же состоянии, что даст [[apply]] с этим номером из конверта, и
   * второго счётчика рядом с журнальным ядро не заводит.
   */
  def decide(
      lot: Lot,
      command: SetProxyLimit,
      sequence: Long,
      proxyBidId: BidId,
      now: Instant
  ): Either[SetProxyLimitRejected, Decision] =
    repeatOf(lot, command.opId, SetProxyLimitRejected.OpIdTaken) {
      case LotEvent.ProxyLimitSet(participant, _) => participant == command.participant
      case _ => false
    }.getOrElse {
      lot.state match {
        case LotState.Initial => Left(SetProxyLimitRejected.LotNotFound)
        case LotState.Draft | LotState.Scheduled(_) | LotState.Sold(_) | LotState.Unsold(_) =>
          Left(SetProxyLimitRejected.LotNotOpen)
        case LotState.Trading(trading) =>
          proxyLimitSet(trading.config, floor(trading), command).map { set =>
            val after = trading.copy(proxyLimits = limited(trading.proxyLimits, set, sequence))
            val derived = resolve(after, proxyBidId).toList
            Decision.Accepted(set, if (derived.isEmpty) Nil else derived ++ extended(trading, now))
          }
        case LotState.Held(held) =>
          proxyLimitSet(held.config, held.currentPrice, command).map(Decision.Accepted(_))
      }
    }

  /**
   * Снятие прокси-лимита. Разрешено и лидеру (RFC-011, О-3): цена и лидерство не меняются, `floor` не двигается,
   * поэтому пересчёт П-02 за снятием не запускается. Лота, у которого лимитов нет вовсе, это касается так же:
   * действующего лимита нет — `NoActiveProxyLimit`.
   */
  def decide(lot: Lot, command: WithdrawProxyLimit): Either[WithdrawProxyLimitRejected, Decision] =
    repeatOf(lot, command.opId, WithdrawProxyLimitRejected.OpIdTaken) {
      case LotEvent.ProxyLimitWithdrawn(participant) => participant == command.participant
      case _ => false
    }.getOrElse {
      val limits = lot.state match {
        case LotState.Initial => None
        case LotState.Draft | LotState.Scheduled(_) | LotState.Sold(_) | LotState.Unsold(_) =>
          Some(Map.empty[ParticipantId, ProxyLimit])
        case LotState.Trading(trading) => Some(trading.proxyLimits)
        case LotState.Held(held) => Some(held.proxyLimits)
      }
      limits match {
        case None => Left(WithdrawProxyLimitRejected.LotNotFound)
        case Some(active) if active.contains(command.participant) =>
          Right(Decision.Accepted(LotEvent.ProxyLimitWithdrawn(command.participant)))
        case Some(_) => Left(WithdrawProxyLimitRejected.NoActiveProxyLimit)
      }
    }

  /**
   * Повтор команды участника (ADR-047, раздел 6, дополнение 2026-10-05). `op_id` присылает внешний клиент, поэтому окно
   * отвечает исходным конвертом только своей команде: событие того же вида от того же участника. Первый конверт
   * транзакции — всегда событие самой команды, не производная ставка прокси, и участник в нём — инициатор. Чужой
   * участник или команда другого вида с тем же `op_id` получает `conflict`: исходный ответ выдал бы чужой `bid_id`, а
   * исполнение заново записало бы вторую транзакцию под тем же `op_id`. Инициатор в окне не хранится, поэтому журнал и
   * snapshot прежней формы читаются тем же состоянием. У `ScheduleLot`, `MarkForFinal`, `UnmarkForFinal` и `ResumeLot`
   * участника в событии нет, и своя команда — событие того же вида.
   */
  private def repeatOf[R](lot: Lot, opId: OpId, conflict: R)(own: LotEvent => Boolean): Option[Either[R, Decision]] =
    lot.seen.get(opId).map(original => if (own(original.event)) Right(Decision.Repeated(original)) else Left(conflict))

  /**
   * Закрытие лота (RFC-011, П-05). Таймер внешний, а наступил ли дедлайн, решает лот по серверному `now`: команда,
   * пришедшая раньше дедлайна или к лоту без дедлайна, получает `DeadlineNotReached` (Т-11), и досрочно закрыть лот
   * планировщик не может. С лидером лот продаётся по текущей цене (Т-12), без лидера закрывается без продажи (Т-13). У
   * удержанного лота дедлайна нет, поэтому закрыть его может только ведущий (Т-49).
   *
   * Отмеченный для финала лот по дедлайну не продаётся, а удерживается `LotHeldForFinal` с той ценой, тем лидером и
   * теми лимитами, что у него были (Т-35, П-09). Закрытие ведущим отметку не читает: так организатор продаёт лот,
   * который решил не выводить в финал.
   */
  def decide(lot: Lot, command: CloseLot, now: Instant): Either[CloseLotRejected, Decision] =
    lot.seen.get(command.opId) match {
      case Some(original) => Right(Decision.Repeated(original))
      case None =>
        lot.state match {
          case LotState.Initial => Left(CloseLotRejected.LotNotFound)
          case LotState.Draft | LotState.Scheduled(_) | LotState.Sold(_) | LotState.Unsold(_) =>
            Left(CloseLotRejected.LotNotOpen)
          case LotState.Trading(trading) =>
            val byDeadline = command.reason == CloseReason.DeadlineReached
            if (byDeadline && !deadlinePassed(trading, now)) Left(CloseLotRejected.DeadlineNotReached)
            else if (byDeadline && trading.markedForFinal) Right(Decision.Accepted(LotEvent.LotHeldForFinal(now)))
            else Right(Decision.Accepted(closed(trading.leader, trading.currentPrice, trading.leadingBidId, now)))
          case LotState.Held(held) =>
            if (command.reason == CloseReason.DeadlineReached) Left(CloseLotRejected.DeadlineNotReached)
            else Right(Decision.Accepted(closed(held.leader, held.currentPrice, held.leadingBidId, now)))
        }
    }

  /**
   * Отметка для финала (RFC-011, П-09). Повтор `op_id` получает исходный ответ до разбора состояния, поэтому повтор
   * отметки после удержания отвечает исходным `LotMarkedForFinal`, а не `LotNotOpen`. Команду шлёт аукцион, но ответ
   * лота уходит администратору подтверждением финалиста, поэтому окно отвечает исходным конвертом только своей команде,
   * а `op_id` под другим событием лота получает `OpIdTaken` (ADR-047, дополнение 2026-10-05, «Открыто»).
   *
   * Наступил ли дедлайн, решает лот по серверному `now` и тем же сравнением, что закрытие: отметка в момент дедлайна и
   * позже получает `DeadlinePassed`, даже если `CloseLot` от аукциона ещё не дошёл (Т-36). Лот без дедлайна ведёт
   * человек, и отметить его можно в любой момент торгов.
   */
  def decide(lot: Lot, command: MarkForFinal, now: Instant): Either[MarkForFinalRejected, Decision] =
    repeatOf(lot, command.opId, MarkForFinalRejected.OpIdTaken)(_ == LotEvent.LotMarkedForFinal).getOrElse {
      lot.state match {
        case LotState.Initial => Left(MarkForFinalRejected.LotNotFound)
        case LotState.Draft | LotState.Scheduled(_) | LotState.Held(_) | LotState.Sold(_) | LotState.Unsold(_) =>
          Left(MarkForFinalRejected.LotNotOpen)
        case LotState.Trading(trading) =>
          if (trading.phase != Phase.Online) Left(MarkForFinalRejected.NotInOnlinePhase)
          else if (trading.markedForFinal) Left(MarkForFinalRejected.AlreadyMarkedForFinal)
          else if (deadlinePassed(trading, now)) Left(MarkForFinalRejected.DeadlinePassed)
          else Right(Decision.Accepted(LotEvent.LotMarkedForFinal))
      }
    }

  /**
   * Снятие отметки для финала (ADR-047, дополнение 2026-10-06). Зеркало отметки: тот же порядок проверок, тот же судья
   * дедлайна и повтор только своей команды. Снять отметку в момент дедлайна и позже нельзя — ни у лота, к которому
   * закрытие ещё не дошло, ни у удержанного: иначе финалист вернулся бы к закрытию задним числом. Снятая отметка
   * возвращает лоту обычное закрытие по дедлайну, а следующая отметка с новым `op_id` ставит её снова.
   */
  def decide(lot: Lot, command: UnmarkForFinal, now: Instant): Either[UnmarkForFinalRejected, Decision] =
    repeatOf(lot, command.opId, UnmarkForFinalRejected.OpIdTaken)(_ == LotEvent.LotUnmarkedForFinal).getOrElse {
      lot.state match {
        case LotState.Initial => Left(UnmarkForFinalRejected.LotNotFound)
        case LotState.Draft | LotState.Scheduled(_) | LotState.Sold(_) | LotState.Unsold(_) =>
          Left(UnmarkForFinalRejected.LotNotOpen)
        case LotState.Held(_) => Left(UnmarkForFinalRejected.DeadlinePassed)
        case LotState.Trading(trading) =>
          if (trading.phase != Phase.Online) Left(UnmarkForFinalRejected.NotInOnlinePhase)
          else if (!trading.markedForFinal) Left(UnmarkForFinalRejected.NotMarkedForFinal)
          else if (deadlinePassed(trading, now)) Left(UnmarkForFinalRejected.DeadlinePassed)
          else Right(Decision.Accepted(LotEvent.LotUnmarkedForFinal))
      }
    }

  /**
   * Возврат удержанного лота в торги живого финала (П-09). Производной ставки прокси по сетке, которую RFC-011 пишет
   * той же транзакцией, здесь нет: пересчёт в `Live` — [PER-293](https://linear.app/anticnvm/issue/per-293), и до него
   * лимиты, записанные в удержании, ждут первой ставки финала. Повтор — только своей команды, как у отметки.
   */
  def decide(lot: Lot, command: ResumeLot): Either[ResumeLotRejected, Decision] =
    repeatOf(lot, command.opId, ResumeLotRejected.OpIdTaken)(_ == LotEvent.LotResumed).getOrElse {
      lot.state match {
        case LotState.Initial => Left(ResumeLotRejected.LotNotFound)
        case LotState.Held(_) => Right(Decision.Accepted(LotEvent.LotResumed))
        case LotState.Draft | LotState.Scheduled(_) | LotState.Trading(_) | LotState.Sold(_) | LotState.Unsold(_) =>
          Left(ResumeLotRejected.LotNotHeld)
      }
    }

  /** Дедлайн наступил: он есть, и `now` не раньше него. Одно сравнение для закрытия и отметки — у гонки один судья. */
  private def deadlinePassed(trading: TradingState, now: Instant): Boolean =
    trading.deadline.exists(deadline => !now.isBefore(deadline))

  /** Исход закрытия: продажа лидеру по текущей цене либо закрытие без продажи, если ставок не было (И-02, И-11). */
  private def closed(
      leader: Option[ParticipantId],
      price: Money,
      leadingBidId: Option[BidId],
      now: Instant
  ): LotEvent =
    (leader, leadingBidId) match {
      case (Some(winner), Some(bidId)) => LotEvent.LotSold(winner, price, bidId, now)
      case _ => LotEvent.LotUnsold(UnsoldReason.NoBids)
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

  /** Нижняя граница торга: текущая цена либо объявленный ask, если он выше (RFC-011, «Состояние лота»). */
  def floor(trading: TradingState): Money =
    trading.ask.filter(_ > trading.currentPrice).getOrElse(trading.currentPrice)

  /**
   * Порядок проверок повторяет RFC-011: валюта, лидерство, затем порог. В `Live` сумма — ожидаемая цена, и проверка
   * `BidNotAtNextPrice` стоит выше `BidBelowMinimum`, чтобы отказ в финале был один и называл цену (ADR-049).
   */
  private def placeBid(
      trading: TradingState,
      command: PlaceBid,
      bidId: BidId
  ): Either[PlaceBidRejected, LotEvent.BidPlaced] = {
    val required = minRequired(trading)
    if (command.amount.currency != trading.config.currency) Left(PlaceBidRejected.CurrencyMismatch)
    else if (trading.leader.contains(command.participant)) Left(PlaceBidRejected.BidderIsLeader(trading.currentPrice))
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
          origin = BidOrigin.Manual(command.source)
        )
      )
  }

  /** Проверки лимита, общие для торгов и удержания; лидер ставить лимит вправе (О-3). */
  private def proxyLimitSet(
      config: LotConfig,
      floor: Money,
      command: SetProxyLimit
  ): Either[SetProxyLimitRejected, LotEvent.ProxyLimitSet] =
    if (!config.proxyEnabled) Left(SetProxyLimitRejected.ProxyDisabledForLot)
    else if (command.max.currency != config.currency) Left(SetProxyLimitRejected.CurrencyMismatch)
    else if (command.max < floor) Left(SetProxyLimitRejected.ProxyBelowCurrentPrice(floor))
    else Right(LotEvent.ProxyLimitSet(command.participant, command.max))

  /**
   * Прокси-перебивание (П-02) на состоянии после применения `BidPlaced` или `ProxyLimitSet`.
   *
   * Серия автоставок сворачивается в одно событие с итоговой ценой: обе ветки сразу дают конечную точку `min(max
   * лидера, второй максимум + шаг)`, и после неё выше `floor` остаётся только лимит лидера — повторный пересчёт ничего
   * не находит. Сильнее тот, чей максимум больше, при равных — чей лимит записан раньше (`setSeq`, П-07), и сравнение
   * идёт с лидером, а не только между соперниками. Ручная ставка лидера главнее его старого лимита: база — `max(L.max,
   * f)`. Производная ставка может быть ниже порога П-01 (Т-22): лимит исчерпан, но `target > f` держит И-01.
   *
   * Цена на шаг выше насыщается на `Long.MaxValue`: лимит — ввод участника, и у самого большого из них сумма с шагом
   * переполнила бы `Long` в отрицательную, а пересчёт молча не нашёл бы ставки.
   *
   * Только фаза `Online`: в `Live` цель округляется до сетки, а это
   * [PER-293](https://linear.app/anticnvm/issue/per-293). После `AskAdvanced` пересчёт не запускается, пока открыт О-6.
   */
  private[lot] def resolve(trading: TradingState, bidId: BidId): Option[LotEvent.BidPlaced] =
    if (trading.phase != Phase.Online) None
    else {
      val f = floor(trading)
      val stepAbove = (price: Money) => {
        val step = StepPolicy.step(trading.config.stepPolicy, price).minorUnits
        if (price.minorUnits > Long.MaxValue - step) price.copy(minorUnits = Long.MaxValue)
        else price.copy(minorUnits = price.minorUnits + step)
      }
      val contender = trading.proxyLimits.toList
        .filter((who, limit) => !trading.leader.contains(who) && limit.max > f)
        .sortBy((_, limit) => (-limit.max.minorUnits, limit.setSeq))
        .headOption
      val leading = trading.leader.flatMap(leader => trading.proxyLimits.get(leader).map(leader -> _))
      contender.flatMap { (rival, c) =>
        leading match {
          case Some((leader, l)) if l.max > c.max || (l.max == c.max && l.setSeq < c.setSeq) =>
            val target = lesser(l.max, stepAbove(c.max))
            Option.when(target > f)(proxyBid(bidId, leader, target, trading.leader))
          case _ =>
            val base = leading.fold(f)((_, l) => greater(l.max, f))
            val target = lesser(c.max, stepAbove(base))
            Option.when(target > f)(proxyBid(bidId, rival, target, trading.leader))
        }
      }
    }

  /**
   * Анти-снайп (П-04): одно продление на команду, сколько бы ставок она ни записала. Ставки команды несут одно время
   * `now`, поэтому окно проверяется один раз — по дедлайну до команды, — а продление идёт последним событием транзакции
   * (ADR-047). Ставка ровно в `deadline − window` в окно не попадает. Лот без дедлайна ведёт человек, и правило молчит;
   * исчерпанный лимит продлений — тоже.
   */
  private[lot] def extended(trading: TradingState, now: Instant): Option[LotEvent.DeadlineExtended] = {
    val antiSnipe = trading.config.antiSnipe
    trading.deadline
      .filter(deadline => now.isAfter(deadline.minus(antiSnipe.window)))
      .filter(_ => trading.extensionsUsed < antiSnipe.maxExtensions)
      .map(deadline => LotEvent.DeadlineExtended(deadline.plus(antiSnipe.extension), trading.extensionsUsed + 1))
  }

  private def proxyBid(
      bidId: BidId,
      participant: ParticipantId,
      amount: Money,
      previousLeader: Option[ParticipantId]
  ): LotEvent.BidPlaced =
    LotEvent.BidPlaced(bidId, participant, amount, previousLeader, BidOrigin.Proxy)

  private def lesser(a: Money, b: Money): Money = if (a < b) a else b

  private def greater(a: Money, b: Money): Money = if (a > b) a else b

  /** Торги после ставки; общее для [[apply]] и пересчёта в [[decide]], чтобы они не разошлись. */
  private def bidden(trading: TradingState, placed: LotEvent.BidPlaced): TradingState =
    trading.copy(
      currentPrice = placed.amount,
      leader = Some(placed.participant),
      leadingBidId = Some(placed.bidId)
    )

  /** Лимиты после `ProxyLimitSet`: новый заменяет прежний лимит участника (И-03). */
  private def limited(
      limits: Map[ParticipantId, ProxyLimit],
      set: LotEvent.ProxyLimitSet,
      setSeq: Long
  ): Map[ParticipantId, ProxyLimit] =
    limits.updated(set.participant, ProxyLimit(set.max, setSeq))

  /**
   * Применение события: только меняет состояние и не отказывает. Событие, которое к текущему состоянию не относится,
   * состояние не трогает — такой пары `decide` не порождает, а журнал её не содержит.
   *
   * `LotOpened` строит торги только из самого события: стартовая цена становится текущей, лидера и лимитов нет, фаза
   * `Online` выводится из факта открытия (RFC-011). Применяется он только к `Scheduled`: журнал, который начинается с
   * `LotOpened` без `LotDrafted`, лота не рождает. `ProxyLimitSet` получает `setSeq` из `sequence` своего конверта.
   * `DeadlineExtended` ставит дедлайн и счётчик из события, а не прибавляет к ним.
   *
   * Удержание `LotHeldForFinal` переносит цену, лидера, лимиты и счётчик продлений из торгов как есть, а возврат
   * `LotResumed` строит торги живого финала из удержания: фаза `Live`, без дедлайна и ask, отметка снята (П-09).
   */
  def apply(lot: Lot, envelope: Envelope): Lot = {
    val state = (lot.state, envelope.event) match {
      case (LotState.Initial, LotEvent.LotDrafted(_)) => LotState.Draft
      case (LotState.Draft | LotState.Scheduled(_), LotEvent.LotScheduled(schedule)) => LotState.Scheduled(schedule)
      case (LotState.Scheduled(_), opened: LotEvent.LotOpened) =>
        LotState.Trading(
          TradingState(
            config = opened.config,
            currentPrice = opened.startingPrice,
            ask = None,
            leader = None,
            leadingBidId = None,
            phase = Phase.Online,
            deadline = opened.deadline,
            extensionsUsed = 0,
            proxyLimits = Map.empty,
            markedForFinal = false
          )
        )
      case (LotState.Trading(trading), LotEvent.LotMarkedForFinal) =>
        LotState.Trading(trading.copy(markedForFinal = true))
      case (LotState.Trading(trading), LotEvent.LotUnmarkedForFinal) =>
        LotState.Trading(trading.copy(markedForFinal = false))
      case (LotState.Trading(trading), LotEvent.LotHeldForFinal(_)) =>
        LotState.Held(
          HeldState(
            config = trading.config,
            currentPrice = trading.currentPrice,
            leader = trading.leader,
            leadingBidId = trading.leadingBidId,
            proxyLimits = trading.proxyLimits,
            extensionsUsed = trading.extensionsUsed
          )
        )
      case (LotState.Held(held), LotEvent.LotResumed) =>
        LotState.Trading(
          TradingState(
            config = held.config,
            currentPrice = held.currentPrice,
            ask = None,
            leader = held.leader,
            leadingBidId = held.leadingBidId,
            phase = Phase.Live,
            deadline = None,
            extensionsUsed = held.extensionsUsed,
            proxyLimits = held.proxyLimits,
            markedForFinal = false
          )
        )
      case (LotState.Trading(trading), placed: LotEvent.BidPlaced) => LotState.Trading(bidden(trading, placed))
      case (LotState.Trading(trading), LotEvent.DeadlineExtended(deadline, extensionsUsed)) =>
        LotState.Trading(trading.copy(deadline = Some(deadline), extensionsUsed = extensionsUsed))
      case (LotState.Trading(trading), set: LotEvent.ProxyLimitSet) =>
        LotState.Trading(trading.copy(proxyLimits = limited(trading.proxyLimits, set, envelope.sequence)))
      case (LotState.Held(held), set: LotEvent.ProxyLimitSet) =>
        LotState.Held(held.copy(proxyLimits = limited(held.proxyLimits, set, envelope.sequence)))
      case (LotState.Trading(trading), LotEvent.ProxyLimitWithdrawn(participant)) =>
        LotState.Trading(trading.copy(proxyLimits = trading.proxyLimits.removed(participant)))
      case (LotState.Held(held), LotEvent.ProxyLimitWithdrawn(participant)) =>
        LotState.Held(held.copy(proxyLimits = held.proxyLimits.removed(participant)))
      case (LotState.Trading(_) | LotState.Held(_), sold: LotEvent.LotSold) =>
        LotState.Sold(Sale(sold.winner, sold.price, sold.bidId, sold.at))
      case (LotState.Trading(_) | LotState.Held(_), LotEvent.LotUnsold(reason)) => LotState.Unsold(reason)
      case (other, _) => other
    }
    val auction = (lot.state, envelope.event) match {
      case (LotState.Initial, LotEvent.LotDrafted(auction)) => Some(auction)
      case _ => lot.auction
    }
    val seen = if (lot.seen.contains(envelope.opId)) lot.seen else lot.seen.updated(envelope.opId, envelope)
    Lot(state, auction, seen)
  }

  /**
   * Аукцион строки, которую пишет принятое событие: у `LotDrafted` — тот, что родил лот, у остальных — аукцион лота.
   * Пусто только у события лота в `Initial`, а из `Initial` [[decide]] принимает одно `LotDrafted`.
   */
  def auctionOf(lot: Lot, event: LotEvent): Option[AuctionId] =
    event match {
      case LotEvent.LotDrafted(auction) => Some(auction)
      case _ => lot.auction
    }

  /**
   * Свёртка журнала в порядке `sequence` (П-07): при равных суммах лидирует ставка, записанная первой, и время события
   * в сравнении не участвует. Порядок, в котором строки пришли к вызывающему, на итог не влияет.
   */
  def replay(from: Lot, journal: Seq[Envelope]): Lot =
    journal.sortBy(_.sequence).foldLeft(from)((lot, envelope) => apply(lot, envelope))
}
