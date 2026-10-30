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
              LotState.Unsold(_) | LotState.Withdrawn(_) =>
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
        case LotState.Trading(_) | LotState.Held(_) | LotState.Sold(_) | LotState.Unsold(_) | LotState.Withdrawn(_) =>
          Left(ScheduleLotRejected.SchedulingClosed)
      }
    }

  /**
   * Открытие торгов. Как и у ставки, `seen` проверяется первым: повтор открытия получает исходный ответ, а не
   * `LotNotScheduled`. Условия торгов берутся из `Scheduled` и уже проверены, поэтому других отказов у открытия нет.
   *
   * Окна сниженного шага лот записывает только в своей валюте: аукцион валюты лота не знает, а лот, запланированный с
   * прежними умолчаниями, сохраняет их валюту и после перепланирования аукциона (ADR-047, дополнение 2026-10-08, И-04).
   * Окно в чужой валюте отбрасывается молча — отказа у открытия по-прежнему нет. Окна идут по возрастанию начала.
   */
  def decide(lot: Lot, command: OpenLot): Either[OpenLotRejected, Decision] =
    lot.seen.get(command.opId) match {
      case Some(original) => Right(Decision.Repeated(original))
      case None =>
        lot.state match {
          case LotState.Initial => Left(OpenLotRejected.LotNotFound)
          case LotState.Scheduled(schedule) =>
            val windows = command.stepWindows
              .filter(_.in(schedule.config.currency))
              .sortBy(_.from)
            Right(
              Decision.Accepted(
                LotEvent.LotOpened(schedule.startingPrice, schedule.config, command.deadline, windows)
              )
            )
          // Снятый лот запоздавшего открытия не принимает: `Withdrawn` терминален (ADR-047, дополнение 2026-10-12).
          case LotState.Draft | LotState.Trading(_) | LotState.Held(_) | LotState.Sold(_) | LotState.Unsold(_) |
              LotState.Withdrawn(_) =>
            Left(OpenLotRejected.LotNotScheduled)
        }
    }

  /**
   * Приём ставки (П-01), ответ прокси на неё (П-02) и продление дедлайна (П-04). Снятый с лота участник получает
   * `ParticipantRemovedFromLot` до остальных проверок, в торгах и в удержании (ADR-072, И-22).
   *
   * `seen` проверяется до разбора состояния: повтор ставки, принятой до удержания, получает исходный ответ, а не
   * `LotOnHold` (RFC-011, П-09). `bidId` и `proxyBidId` приходят снаружи, как и любой идентификатор: решение не рождает
   * их само. Второй нужен производной ставке и пропадает, если её нет. `now` — серверное время команды, оно же
   * `occurred_at` её строк: им П-04 решает, попала ли ставка в окно. Производная ставка другого участника помечает
   * ручную `overtakenByProxy`: лидерство ставки до конца команды не дожило, и факт о ней не должен сообщать прежнему
   * лидеру о перебитии (PER-473).
   */
  def decide(
      lot: Lot,
      command: PlaceBid,
      bidId: BidId,
      proxyBidId: BidId,
      now: Instant
  ): Either[PlaceBidRejected, Decision] =
    repeatOf(lot, command.opId, PlaceBidRejected.OpIdTaken) {
      case LotEvent.BidPlaced(_, participant, _, _, BidOrigin.Manual(_), _) => participant == command.participant
      case _ => false
    }.getOrElse {
      lot.state match {
        case LotState.Initial => Left(PlaceBidRejected.LotNotFound)
        case LotState.Draft | LotState.Scheduled(_) => Left(PlaceBidRejected.LotNotOpen)
        case LotState.Trading(trading) if removedFrom(trading.course, command.participant) =>
          Left(PlaceBidRejected.ParticipantRemovedFromLot)
        case LotState.Held(held) if removedFrom(held.course, command.participant) =>
          Left(PlaceBidRejected.ParticipantRemovedFromLot)
        case LotState.Trading(trading) =>
          placeBid(trading, command, bidId, now).map { placed =>
            val derived = resolve(bidden(trading, placed), proxyBidId, now)
            val overtaken = derived.exists(_.participant != command.participant)
            Decision.Accepted(placed.copy(overtakenByProxy = overtaken), derived.toList ++ extended(trading, now))
          }
        case LotState.Held(held) => Left(PlaceBidRejected.LotOnHold(held.currentPrice))
        case LotState.Sold(_) | LotState.Unsold(_) | LotState.Withdrawn(_) => Left(PlaceBidRejected.LotNotOpen)
      }
    }

  /**
   * Прокси-лимит (ADR-047). В торгах за `ProxyLimitSet` идёт пересчёт П-02 на состоянии после него, и производная
   * ставка, если она есть, пишется той же транзакцией — одним событием с итоговой ценой, а за ней продление П-04 на
   * время `now`. Лимит без производной ставки ставкой не является и дедлайн не продлевает. В удержании лимит
   * записывается без пересчёта и ждёт финала (RFC-011, П-09); дедлайна там нет. Снятому с лота — как у ставки.
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
        case LotState.Draft | LotState.Scheduled(_) | LotState.Sold(_) | LotState.Unsold(_) | LotState.Withdrawn(_) =>
          Left(SetProxyLimitRejected.LotNotOpen)
        case LotState.Trading(trading) if removedFrom(trading.course, command.participant) =>
          Left(SetProxyLimitRejected.ParticipantRemovedFromLot)
        case LotState.Held(held) if removedFrom(held.course, command.participant) =>
          Left(SetProxyLimitRejected.ParticipantRemovedFromLot)
        case LotState.Trading(trading) =>
          proxyLimitSet(trading.config, limitFloor(trading, now), command).map { set =>
            val after = trading.copy(proxyLimits = limited(trading.proxyLimits, set, sequence))
            val derived = resolve(after, proxyBidId, now).toList
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
        case LotState.Draft | LotState.Scheduled(_) | LotState.Sold(_) | LotState.Unsold(_) | LotState.Withdrawn(_) =>
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
   * snapshot прежней формы читаются тем же состоянием. У `ScheduleLot`, `MarkForFinal`, `UnmarkForFinal`, `ResumeLot`,
   * `WithdrawLot`, `AddStepWindow`, `SetPeriodWindow` и `ClearPeriodWindow` участника в событии нет, и своя команда —
   * событие того же вида.
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
          case LotState.Draft | LotState.Scheduled(_) | LotState.Sold(_) | LotState.Unsold(_) | LotState.Withdrawn(_) =>
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
        case LotState.Draft | LotState.Scheduled(_) | LotState.Held(_) | LotState.Sold(_) | LotState.Unsold(_) |
            LotState.Withdrawn(_) =>
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
        case LotState.Draft | LotState.Scheduled(_) | LotState.Sold(_) | LotState.Unsold(_) | LotState.Withdrawn(_) =>
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
   * Возврат удержанного лота в торги живого финала (П-09). Лимиты, записанные в удержании, ждали финала без пересчёта,
   * и пересчёт П-02 по сетке идёт той же транзакцией на торгах после возврата: производная ставка, если она есть,
   * пишется за `LotResumed`, как у `SetProxyLimit`. Повтор — только своей команды, как у отметки.
   */
  def decide(lot: Lot, command: ResumeLot, proxyBidId: BidId, now: Instant): Either[ResumeLotRejected, Decision] =
    repeatOf(lot, command.opId, ResumeLotRejected.OpIdTaken)(_ == LotEvent.LotResumed).getOrElse {
      lot.state match {
        case LotState.Initial => Left(ResumeLotRejected.LotNotFound)
        case LotState.Held(held) =>
          Right(Decision.Accepted(LotEvent.LotResumed, resolve(resumed(held), proxyBidId, now).toList))
        case LotState.Draft | LotState.Scheduled(_) | LotState.Trading(_) | LotState.Sold(_) | LotState.Unsold(_) |
            LotState.Withdrawn(_) =>
          Left(ResumeLotRejected.LotNotHeld)
      }
    }

  /**
   * Ask ведущего (RFC-011, П-08): следующая цена, которую он объявил залу. Ask поднимает нижнюю границу торга, но не
   * цену и не лидера, и обязан её превысить. Удержанный лот ask не принимает: ведущий объявляет цену торгам, а не
   * перерыву.
   *
   * В фазе `Live` за `AskAdvanced` той же транзакцией идёт пересчёт П-02 на торгах с новым ask (О-6.B): лимит, которому
   * ask по карману, берёт его производной ставкой. В онлайн-неделе пересчёта за ask нет: ask поднимает нижнюю границу,
   * и лимиты меряются от неё только на следующей ставке или лимите (RFC-011, П-02). Дедлайна в `Live` нет, поэтому нет
   * и продления П-04.
   */
  def decide(lot: Lot, command: AdvanceAsk, proxyBidId: BidId, now: Instant): Either[AdvanceAskRejected, Decision] =
    repeatOf(lot, command.opId, AdvanceAskRejected.OpIdTaken) {
      case _: LotEvent.AskAdvanced => true
      case _ => false
    }.getOrElse {
      lot.state match {
        case LotState.Initial => Left(AdvanceAskRejected.LotNotFound)
        case LotState.Draft | LotState.Scheduled(_) | LotState.Held(_) | LotState.Sold(_) | LotState.Unsold(_) |
            LotState.Withdrawn(_) =>
          Left(AdvanceAskRejected.LotNotOpen)
        case LotState.Trading(trading) =>
          val f = floor(trading)
          if (command.newAsk.currency != trading.config.currency) Left(AdvanceAskRejected.CurrencyMismatch)
          else if (command.newAsk <= f) Left(AdvanceAskRejected.AskBelowCurrentPrice(f))
          else {
            val derived =
              if (trading.phase == Phase.Live) resolve(trading.copy(ask = Some(command.newAsk)), proxyBidId, now).toList
              else Nil
            Right(Decision.Accepted(LotEvent.AskAdvanced(command.newAsk), derived))
          }
      }
    }

  /**
   * Снятие участника с лота (ADR-072). Повтор — только своей команды: снятие того же участника. Порядок проверок:
   * состояние, фаза, дедлайн тем же судьёй, что у отметки финала, затем сам участник. Итог переигрывания торгов без
   * снятого — [[rerun]] — ложится в событие, а `positionId` — новая ставка, позиция лидера (п. 1): ставки, которой
   * лидер держался бы без снятого, в журнале может не быть.
   *
   * `version` — номер последнего события лота, его даёт entity. Расхождение с `expectedVersion` команды — последняя
   * проверка, `LotChanged` (PER-658): лот, ушедший от предпросмотра, но снятие всё равно не принимающий, отвечает своим
   * отказом, а повтор принятого снятия — исходным конвертом, хотя номер с тех пор вырос. Предпросмотр — то же решение с
   * `expectedVersion = version`.
   *
   * Снятие в окне анти-снайпа продлевает торги, только если сменило лидера или цену (п. 3): `DeadlineExtended` идёт
   * следом с прежним `extensionsUsed` — предел у этого продления свой, одно на снятого, и `K` он не тратит. В удержании
   * дедлайна нет, и продления тоже.
   */
  def decide(
      lot: Lot,
      command: RemoveParticipant,
      version: Long,
      positionId: BidId,
      now: Instant
  ): Either[RemoveParticipantRejected, Decision] =
    repeatOf(lot, command.opId, RemoveParticipantRejected.OpIdTaken) {
      case LotEvent.ParticipantRemoved(participant, _, _, _) => participant == command.participant
      case _ => false
    }.getOrElse {
      lot.state match {
        case LotState.Initial => Left(RemoveParticipantRejected.LotNotFound)
        case LotState.Draft | LotState.Scheduled(_) | LotState.Sold(_) | LotState.Unsold(_) | LotState.Withdrawn(_) =>
          Left(RemoveParticipantRejected.LotNotOpen)
        case LotState.Trading(trading) =>
          if (trading.phase != Phase.Online) Left(RemoveParticipantRejected.NotInOnlinePhase)
          else if (deadlinePassed(trading, now)) Left(RemoveParticipantRejected.DeadlinePassed)
          else
            removal(trading.config, historyOf(trading.course), command.participant, positionId, trading.currentPrice)
              .map { removed =>
                val changed = removed.leader != trading.leader || removed.price != trading.currentPrice
                Decision.Accepted(removed, if (changed) extendedByRemoval(trading, now).toList else Nil)
              }
        case LotState.Held(held) =>
          removal(held.config, historyOf(held.course), command.participant, positionId, held.currentPrice)
            .map(Decision.Accepted(_))
      }
    }.flatMap {
      case Decision.Accepted(_, _) if version != command.expectedVersion => Left(RemoveParticipantRejected.LotChanged)
      case decided => Right(decided)
    }

  /**
   * Снятие по истории: снятого второй раз не снимают (И-22), а участник лота — тот, у кого есть принятая ручная ставка
   * или выставленный лимит, в том числе снятый потом им самим (ADR-072, п. 1).
   *
   * Лидера даёт переигрывание, а цена — меньшая из переигранной и `ceiling`, цены до снятия (И-23). Без снятого лимит
   * соперника может прийти раньше, при цене ниже, и поднять лидера выше прежней цены; снятие защищает оставшихся, и
   * платить за чужую накрутку больше лидер не должен (решение владельца на PER-657).
   */
  private def removal(
      config: LotConfig,
      course: Course,
      participant: ParticipantId,
      positionId: BidId,
      ceiling: Money
  ): Either[RemoveParticipantRejected, LotEvent.ParticipantRemoved] =
    if (course.removed.contains(participant)) Left(RemoveParticipantRejected.ParticipantAlreadyRemoved)
    else if (!(course.online ++ course.held).exists(entry => entry.participant == participant && committed(entry)))
      Left(RemoveParticipantRejected.NotALotParticipant)
    else {
      val result = rerun(config, course, course.removed + participant, positionId)
      val price = if (result.currentPrice <= ceiling) result.currentPrice else ceiling
      Right(LotEvent.ParticipantRemoved(participant, price, result.leader, result.leadingBidId))
    }

  /** Вход, который делает человека участником лота: ставка или выставленный лимит, а не снятие лимита. */
  private def committed(entry: Entry): Boolean =
    entry.move match {
      case Move.Bid(_) | Move.LimitSet(_) => true
      case Move.LimitWithdrawn => false
    }

  /**
   * Переигрывание торгов без `without` (ADR-072, п. 2) от стартовой цены по входам оставшихся в порядке журнала.
   * Правила те же, что в торгах, и функции те же: ручная ставка ложится [[bidden]] без проверок П-01 — она уже принята,
   * и отказ при повторе был бы новым решением за участника, — а её участник, который при повторе уже лидер, поднимает
   * цену до своей суммы, но не опускает её. Лимиты выставляются и снимаются в свои моменты, и на каждый вход
   * онлайн-недели отвечает [[resolve]] с шагом П-03 на момент входа, то есть и с окнами сниженного шага — теми, что лот
   * знал к этому входу ([[Course.windowsAt]]): окно, запущенное по ходу торгов, действует с его строки. Лимиты
   * удержания только записываются: в торгах пересчёт на них не шёл. Анти-снайп и дедлайн не переигрываются — их здесь
   * нет.
   *
   * Позиция лидера — `positionId` у любой ставки повтора: какая ставка её дала, событию не важно, а сумма позиции —
   * итоговая цена.
   */
  private def rerun(config: LotConfig, course: Course, without: Set[ParticipantId], positionId: BidId): TradingState = {
    val start = TradingState(
      config = config,
      currentPrice = course.startingPrice,
      ask = None,
      leader = None,
      leadingBidId = None,
      phase = Phase.Online,
      deadline = None,
      extensionsUsed = 0,
      proxyLimits = Map.empty,
      markedForFinal = false,
      course = None,
      stepWindows = course.stepWindows
    )
    val kept = (entry: Entry) => !without.contains(entry.participant)
    val answered = (trading: TradingState, at: Instant) =>
      resolve(trading, positionId, at).fold(trading)(bidden(trading, _))
    val known = (trading: TradingState, entry: Entry) => trading.copy(stepWindows = course.windowsAt(entry.sequence))
    val limit = (trading: TradingState, entry: Entry, max: Money) =>
      trading.copy(proxyLimits = trading.proxyLimits.updated(entry.participant, ProxyLimit(max, entry.sequence)))
    val online = course.online.filter(kept).foldLeft(start) { (before, entry) =>
      val trading = known(before, entry)
      entry.move match {
        case Move.Bid(amount) =>
          val price = if (trading.leader.contains(entry.participant)) greater(trading.currentPrice, amount) else amount
          val placed: LotEvent.BidPlaced =
            LotEvent.BidPlaced(positionId, entry.participant, price, trading.leader, BidOrigin.Proxy)
          answered(bidden(trading, placed), entry.at)
        case Move.LimitSet(max) => answered(limit(trading, entry, max), entry.at)
        case Move.LimitWithdrawn => trading.copy(proxyLimits = trading.proxyLimits.removed(entry.participant))
      }
    }
    course.held.filter(kept).foldLeft(online) { (trading, entry) =>
      entry.move match {
        case Move.LimitSet(max) => limit(trading, entry, max)
        case Move.LimitWithdrawn => trading.copy(proxyLimits = trading.proxyLimits.removed(entry.participant))
        case Move.Bid(_) => trading
      }
    }
  }

  /**
   * История торгов, без которой снятие не решается. Её нет только у состояния из строки прежней формы, а entity
   * поднимает лот replay'ем журнала (`LotEntity`), поэтому здесь её отсутствие — дефект, а не отказ.
   */
  private def historyOf(course: Option[Course]): Course =
    course.getOrElse(throw new IllegalStateException("lot decided a removal without its trading history"))

  private def removedFrom(course: Option[Course], participant: ParticipantId): Boolean =
    course.exists(_.removed.contains(participant))

  /**
   * Снятие с торгов по отмене аукциона (ADR-047, дополнение 2026-10-12): что завершилось, остаётся, что идёт,
   * обрывается. Снимается лот без исхода — черновик, запланированный, в торгах или удержанный; проданный, закрытый без
   * продажи и уже снятый под другим `op_id` отвечает `LotAlreadyClosed`. Гонку с закрытием по дедлайну решает порядок в
   * журнале: продажа, записанная первой, остаётся. Повтор — только своей команды: аукцион шлёт её после рестарта с тем
   * же `op_id`, и второго события лот не пишет.
   */
  def decide(lot: Lot, command: WithdrawLot): Either[WithdrawLotRejected, Decision] =
    repeatOf(lot, command.opId, WithdrawLotRejected.OpIdTaken) {
      case _: LotEvent.LotWithdrawn => true
      case _ => false
    }.getOrElse {
      lot.state match {
        case LotState.Initial => Left(WithdrawLotRejected.LotNotFound)
        case LotState.Draft | LotState.Scheduled(_) | LotState.Trading(_) | LotState.Held(_) =>
          Right(Decision.Accepted(LotEvent.LotWithdrawn(command.reason)))
        case LotState.Sold(_) | LotState.Unsold(_) | LotState.Withdrawn(_) => Left(WithdrawLotRejected.LotAlreadyClosed)
      }
    }

  /**
   * Окно, запущенное по ходу торгов (ADR-047, дополнение 2026-10-12, И-21): лот в торгах онлайн-этапа дописывает его к
   * своим окнам событием `StepWindowAdded`. Закрытый, снятый, удержанный и уже вышедший в живой финал лот отвечает
   * `LotNotOpen`, и аукцион его не ждёт. Повтор — только своей команды: аукцион шлёт её после рестарта с тем же
   * `op_id`.
   *
   * `None` — принято без записи. Окно в чужой валюте лот отбрасывает так же, как при открытии: валюты лота аукцион не
   * знает. Окно, пересекающееся с окном лота, тоже не пишется: пересечения проверяет аукцион по всем окнам, и такой
   * запуск до лота не доходит, а записанное пересечение сделало бы журнал нечитаемым (И-21).
   */
  def decide(lot: Lot, command: AddStepWindow): Either[AddStepWindowRejected, Option[Decision]] =
    repeatOf(lot, command.opId, AddStepWindowRejected.OpIdTaken) {
      case _: LotEvent.StepWindowAdded => true
      case _ => false
    }.map(_.map(Some(_))).getOrElse {
      lot.state match {
        case LotState.Initial => Left(AddStepWindowRejected.LotNotFound)
        case LotState.Trading(trading) if trading.phase == Phase.Online =>
          val window = command.window
          if (!window.in(trading.config.currency) || trading.stepWindows.exists(_.overlaps(window)))
            Right(None)
          else Right(Some(Decision.Accepted(LotEvent.StepWindowAdded(window))))
        case LotState.Draft | LotState.Scheduled(_) | LotState.Trading(_) | LotState.Held(_) |
            LotState.Sold(_) | LotState.Unsold(_) | LotState.Withdrawn(_) =>
          Left(AddStepWindowRejected.LotNotOpen)
      }
    }

  /**
   * Условия лота в периоде «Счастливых часов» (ADR-047, дополнение 2026-10-27, PER-786): лот в торгах онлайн-этапа
   * заменяет окно этого периода или дописывает новое событием `PeriodWindowSet` — только пока `now` раньше начала окна:
   * с начала период заморожен (`PeriodStarted`). Закрытый, снятый, удержанный и вышедший в живой финал лот отвечает
   * `LotNotOpen`, и аукцион его не ждёт. Повтор — только своей команды.
   *
   * `None` — принято без записи: окно то же, что уже записано, в чужой валюте или пересекается с окном другого
   * происхождения. Пересечения проверяет аукцион, и такая команда до лота не доходит; записанное пересечение сделало бы
   * журнал нечитаемым (И-21).
   */
  def decide(lot: Lot, command: SetPeriodWindow, now: Instant): Either[PeriodWindowRejected, Option[Decision]] =
    repeatOf(lot, command.opId, PeriodWindowRejected.OpIdTaken) {
      case _: LotEvent.PeriodWindowSet => true
      case _ => false
    }.map(_.map(Some(_))).getOrElse {
      lot.state match {
        case LotState.Initial => Left(PeriodWindowRejected.LotNotFound)
        case LotState.Trading(trading) if trading.phase == Phase.Online =>
          val window = command.window
          val others = trading.stepWindows.filterNot(other => window.period.exists(other.of))
          if (!now.isBefore(window.from)) Left(PeriodWindowRejected.PeriodStarted)
          else if (trading.stepWindows.contains(window)) Right(None)
          else if (!window.in(trading.config.currency) || others.exists(_.overlaps(window))) Right(None)
          else Right(Some(Decision.Accepted(LotEvent.PeriodWindowSet(window))))
        case LotState.Draft | LotState.Scheduled(_) | LotState.Trading(_) | LotState.Held(_) |
            LotState.Sold(_) | LotState.Unsold(_) | LotState.Withdrawn(_) =>
          Left(PeriodWindowRejected.LotNotOpen)
      }
    }

  /**
   * Снятие условий лота в периоде (PER-786): окно периода уходит событием `PeriodWindowCleared`, только пока `now`
   * раньше его начала. Окна этого периода у лота нет — принято без записи: условия не доходили или уже сняты.
   */
  def decide(lot: Lot, command: ClearPeriodWindow, now: Instant): Either[PeriodWindowRejected, Option[Decision]] =
    repeatOf(lot, command.opId, PeriodWindowRejected.OpIdTaken) {
      case _: LotEvent.PeriodWindowCleared => true
      case _ => false
    }.map(_.map(Some(_))).getOrElse {
      lot.state match {
        case LotState.Initial => Left(PeriodWindowRejected.LotNotFound)
        case LotState.Trading(trading) if trading.phase == Phase.Online =>
          trading.stepWindows.find(_.of(command.period)) match {
            case None => Right(None)
            case Some(window) if !now.isBefore(window.from) => Left(PeriodWindowRejected.PeriodStarted)
            case Some(_) => Right(Some(Decision.Accepted(LotEvent.PeriodWindowCleared(command.period))))
          }
        case LotState.Draft | LotState.Scheduled(_) | LotState.Trading(_) | LotState.Held(_) |
            LotState.Sold(_) | LotState.Unsold(_) | LotState.Withdrawn(_) =>
          Left(PeriodWindowRejected.LotNotOpen)
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
   * Следующая цена в момент `at`: объявленный ask, если он выше текущей цены, иначе цена плюс шаг от неё (П-01, П-03).
   * До первой ставки — пока лидера нет (И-02) — шага нет: следующая цена равна стартовой, которая до первой ставки и
   * есть текущая (решение владельца 14.10.2026, PER-618), а в окне со стартовой ценой — стартовой окна
   * ([[openingPrice]]). `at` — серверное время команды, а у чтения — время ответа: в окне следующая цена ниже.
   */
  def minRequired(trading: TradingState, at: Instant): Money =
    trading.ask.filter(_ > trading.currentPrice) match {
      case Some(ask) => ask
      case None if opening(trading) => openingPrice(trading, at)
      case None => trading.currentPrice.plus(step(trading, trading.currentPrice, at))
    }

  /**
   * Цена первой ставки в момент `at` (ADR-047, дополнение 2026-10-27): стартовая окна, если `at` внутри окна лота с ней
   * и лот в фазе `Online`, причём строго ниже обычной стартовой; иначе обычная — она до первой ставки и есть текущая
   * цена. После первой ставки лидер есть, и стартовая окна ни на что не влияет: дальше цену ведёт шаг.
   */
  def openingPrice(trading: TradingState, at: Instant): Money =
    activeWindow(trading, at).flatMap(_.start).filter(_ < trading.currentPrice).getOrElse(trading.currentPrice)

  /**
   * Нижняя граница прокси-лимита в торгах в момент `at`: до первой ставки — цена первой ставки, в окне со стартовой
   * ценой — стартовая окна, как у ручной ставки; после неё — [[floor]].
   */
  private def limitFloor(trading: TradingState, at: Instant): Money =
    if (opening(trading)) minRequired(trading, at) else floor(trading)

  /**
   * Ставок по лоту ещё не было: лидера нет только до первой принятой ставки (И-02), и текущая цена тогда — стартовая.
   * Первая ставка, ручная или производная, вправе быть равной ей, а не выше на шаг (PER-618).
   */
  private def opening(trading: TradingState): Boolean = trading.leader.isEmpty

  /** Обычный шаг при цене `price`: политика шага лота без окон (П-03, `base`). */
  def baseStep(trading: TradingState, price: Money): Money =
    StepPolicy.step(trading.config.stepPolicy, price)

  /**
   * Шаг при цене `price` в момент `at` (П-03, дополнение 2026-10-08): сумма окна, если `at` внутри `[from, until)` окна
   * лота и лот в фазе `Online`, но не выше обычного шага; иначе обычный шаг. Окна одного лота не пересекаются (И-21),
   * поэтому подходит не больше одного. Окно без шага шаг не меняет (дополнение 2026-10-27). Событий на границах окна
   * нет: шаг вычисляется в момент команды.
   */
  def step(trading: TradingState, price: Money, at: Instant): Money = {
    val base = baseStep(trading, price)
    activeWindow(trading, at).flatMap(_.step).fold(base)(step => if (step < base) step else base)
  }

  /** Окно, которое действует в момент `at`: только в фазе `Online` — в живом финале окна нет по фазе (П-03). */
  def activeWindow(trading: TradingState, at: Instant): Option[StepWindow] =
    onlineWindows(trading).find(window => !at.isBefore(window.from) && at.isBefore(window.until))

  /** Ближайшее окно, которое в момент `at` ещё не началось; в живом финале его нет, как и действующего. */
  def nextWindow(trading: TradingState, at: Instant): Option[StepWindow] =
    onlineWindows(trading).filter(_.from.isAfter(at)).minByOption(_.from)

  private def onlineWindows(trading: TradingState): List[StepWindow] =
    if (trading.phase == Phase.Online) trading.stepWindows else Nil

  /** Нижняя граница торга: текущая цена либо объявленный ask, если он выше (RFC-011, «Состояние лота»). */
  def floor(trading: TradingState): Money =
    trading.ask.filter(_ > trading.currentPrice).getOrElse(trading.currentPrice)

  private val OnlineBidCeiling = 5

  /**
   * Следующая цена без окна сниженного шага: ask, если он выше текущей, иначе стартовая, пока лидера нет, иначе цена
   * плюс обычный шаг. Потолок ручной онлайн-ставки считается от неё, и счастливый час его не сдвигает (PER-660).
   */
  private def ceilingReference(trading: TradingState): Money =
    trading.ask.filter(_ > trading.currentPrice) match {
      case Some(ask) => ask
      case None if opening(trading) => trading.currentPrice
      case None => saturatedPlus(trading.currentPrice, baseStep(trading, trading.currentPrice))
    }

  /**
   * Пять баз, насыщенные на край `Long`. Произведение, которое в него не входит, не бросает исключение. Если пять баз
   * ниже следующей цены — так бывает при отрицательной базе, — потолок равен ей, а не этой пятёрке (PER-660).
   */
  private def onlineMaximum(trading: TradingState, required: Money): Money = {
    val reference = ceilingReference(trading)
    val units = reference.minorUnits
    val scale = OnlineBidCeiling.toLong
    val scaled =
      if (units > 0 && units > Long.MaxValue / scale) Long.MaxValue
      else if (units < 0 && units < Long.MinValue / scale) Long.MinValue
      else units * scale
    val ceiling = reference.copy(minorUnits = scaled)
    if (ceiling < required) required else ceiling
  }

  /**
   * Порядок проверок повторяет RFC-011: валюта, лидерство, затем порог. В `Live` сумма — ожидаемая цена, и проверка
   * `BidNotAtNextPrice` стоит выше `BidBelowMinimum`, чтобы отказ в финале был один и называл цену (ADR-049). В
   * `Online` сумма выше пяти [[ceilingReference]] — `BidAboveMaximum` с этим максимумом (PER-660).
   *
   * Ставку зала лот принимает только в живом финале: зала в онлайн-неделе нет, а право человека в зале никто не
   * проверяет — его заменяет право помощника ведущего (решение владельца в PER-293). Вне `Live` она — `LotNotOpen`, и
   * этот отказ стоит первым: от суммы и лидерства он не зависит.
   */
  private def placeBid(
      trading: TradingState,
      command: PlaceBid,
      bidId: BidId,
      now: Instant
  ): Either[PlaceBidRejected, LotEvent.BidPlaced] = {
    val required = minRequired(trading, now)
    if (command.source == BidSource.Floor && trading.phase != Phase.Live) Left(PlaceBidRejected.LotNotOpen)
    else if (command.amount.currency != trading.config.currency) Left(PlaceBidRejected.CurrencyMismatch)
    else if (trading.leader.contains(command.participant)) Left(PlaceBidRejected.BidderIsLeader(trading.currentPrice))
    else if (trading.phase == Phase.Live && command.amount != required)
      Left(PlaceBidRejected.BidNotAtNextPrice(required))
    else if (command.amount < required) Left(PlaceBidRejected.BidBelowMinimum(required))
    else {
      val maximum = if (trading.phase == Phase.Online) Some(onlineMaximum(trading, required)) else None
      maximum.filter(command.amount > _) match {
        case Some(ceiling) => Left(PlaceBidRejected.BidAboveMaximum(ceiling))
        case None =>
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
    }
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
   * победителя, второй максимум + шаг)`, и после неё выше `floor` остаётся только лимит победителя — повторный пересчёт
   * ничего не находит. Сильнее тот, чей максимум больше, при равных — чей лимит записан раньше (`setSeq`, П-07), и
   * сравнение идёт с лидером, а не только между соперниками. Второй максимум — самый большой из всех остальных лимитов,
   * а не только лимита лидера или одного соперника: в торгах лимиты появляются по одному, и выше цены остаётся не
   * больше одного чужого, но лимиты удержания копятся без пересчёта, и возврат (`ResumeLot`) разбирает их все этим
   * одним вызовом (PER-700). Ручная ставка лидера главнее его старого лимита: база — `max(L.max, f)`. Производная
   * ставка может быть ниже порога П-01 (Т-22): лимит исчерпан, но `target > f` держит И-01.
   *
   * Цена на шаг выше насыщается на `Long.MaxValue`: лимит — ввод участника, и у самого большого из них сумма с шагом
   * переполнила бы `Long` в отрицательную, а пересчёт молча не нашёл бы ставки.
   *
   * Шаг берётся в момент `now` команды — один на всю свёрнутую серию: в окне сниженного шага серия считается по шагу
   * окна, вне окна — по обычному, и шаги двух режимов в одном событии не смешиваются (П-03).
   *
   * До первой ставки лидера нет, и первая ставка равна `f` без шага, как у ручной (решение владельца 14.10.2026,
   * PER-618): кандидат — лимит с `max ≥ f`, а производная ставка — ровно `f`. В окне со стартовой ценой `f` до первой
   * ставки — стартовая окна, как у ручной ставки (ADR-047, дополнение 2026-10-27).
   *
   * Так правило читается в фазе `Online`; в `Live` цель ложится на сетку ADR-049 — [[resolveLive]].
   */
  private[lot] def resolve(trading: TradingState, bidId: BidId, now: Instant): Option[LotEvent.BidPlaced] =
    trading.phase match {
      case Phase.Online => resolveOnline(trading, bidId, now)
      case Phase.Live => resolveLive(trading, bidId)
    }

  private def resolveOnline(trading: TradingState, bidId: BidId, now: Instant): Option[LotEvent.BidPlaced] = {
    val f = limitFloor(trading, now)
    val stepAbove = (price: Money) => {
      val step = Lot.step(trading, price, now).minorUnits
      if (price.minorUnits > Long.MaxValue - step) price.copy(minorUnits = Long.MaxValue)
      else price.copy(minorUnits = price.minorUnits + step)
    }
    val reaches = (amount: Money) => if (opening(trading)) !(amount < f) else amount > f
    val (contender, runnerUp) = rivals(trading, reaches)
    val leading = trading.leader.flatMap(leader => trading.proxyLimits.get(leader).map(leader -> _))
    contender.flatMap { (rival, c) =>
      leading match {
        case Some((leader, l)) if l.max > c.max || (l.max == c.max && l.setSeq < c.setSeq) =>
          val target = lesser(l.max, stepAbove(c.max))
          Option.when(target > f)(proxyBid(bidId, leader, target, trading.leader))
        case _ if opening(trading) =>
          val target = runnerUp.filter(_ > f).fold(f)(second => lesser(c.max, stepAbove(second)))
          Some(proxyBid(bidId, rival, target, trading.leader))
        case _ =>
          val base = (leading.map((_, l) => l.max) ++ runnerUp).foldLeft(f)(greater)
          val target = lesser(c.max, stepAbove(base))
          Option.when(target > f)(proxyBid(bidId, rival, target, trading.leader))
      }
    }
  }

  /**
   * Соперники лидера по лимитам: тот, кто может взять лот, и второй максимум среди остальных нелидеров. В торгах лимиты
   * появляются по одному и второго выше цены нет; в удержании они копятся, и возврат разбирает их одним пересчётом, где
   * второй максимум входит в цену победителя наравне с лимитом лидера.
   */
  private def rivals(
      trading: TradingState,
      reaches: Money => Boolean
  ): (Option[(ParticipantId, ProxyLimit)], Option[Money]) = {
    val others = trading.proxyLimits.toList
      .filter((who, _) => !trading.leader.contains(who))
      .sortBy((_, limit) => (-limit.max.minorUnits, limit.setSeq))
    val contender = others.headOption.filter((_, limit) => reaches(limit.max))
    (contender, others.drop(1).headOption.map((_, limit) => limit.max))
  }

  /**
   * П-02 в живом финале (ADR-049, О-6.B). Те же две ветки, но цель округляется вниз до сетки `f, f + step(f), …`: в
   * финале производная ставка всегда равна цене, которую ведущий мог бы объявить, а лимит, которого не хватает на
   * полный шаг, исчерпан (Т-42). Сетка строится обычным шагом — окон в `Live` нет.
   *
   * Пока ask выше цены, лимиты меряются по нему: кандидат — лимит с `max ≥ ask`, а не `max > f`, ставка — не ниже ask,
   * а в ветке смены лидера цель не опускается ниже ask, хотя база считается от цены (`max(ask, base + шаг)`): после
   * скачка ask больше чем на шаг `цена + шаг` лежит ниже него. Без ask `f` — сама цена, и правило то же, что в
   * `Online`, с округлением. Когда обоим лимитам хватает только на одну точку, её берёт сильнейший (Т-76). До первой
   * ставки, как в `Online`, кандидату хватает `max ≥ f`, и ставит он саму `f` — или ask, если он объявлен (PER-618).
   */
  private def resolveLive(trading: TradingState, bidId: BidId): Option[LotEvent.BidPlaced] = {
    val f = floor(trading)
    val ask = trading.ask.filter(_ > trading.currentPrice)
    val reaches = (amount: Money) =>
      ask.fold(if (opening(trading)) !(amount < f) else amount > f)(threshold => !(amount < threshold))
    val stepAbove = (price: Money) => saturatedPlus(price, baseStep(trading, price))
    val onGrid = (target: Money) => StepPolicy.gridFloor(trading.config.stepPolicy, f, target).filter(reaches)
    val (contender, runnerUp) = rivals(trading, reaches)
    val leading = trading.leader.flatMap(leader => trading.proxyLimits.get(leader).map(leader -> _))
    contender.flatMap { (rival, c) =>
      leading match {
        case Some((leader, l)) if l.max > c.max || (l.max == c.max && l.setSeq < c.setSeq) =>
          onGrid(lesser(l.max, stepAbove(c.max))).map(proxyBid(bidId, leader, _, trading.leader))
        case _ =>
          val price = trading.currentPrice
          val next =
            if (opening(trading)) runnerUp.filter(_ > price).fold(price)(stepAbove)
            else stepAbove((leading.map((_, l) => l.max) ++ runnerUp).foldLeft(price)(greater))
          onGrid(lesser(c.max, ask.fold(next)(greater(_, next)))).map(proxyBid(bidId, rival, _, trading.leader))
      }
    }
  }

  /** Цена на шаг выше, насыщенная на `Long.MaxValue`, как в [[resolve]]. */
  private def saturatedPlus(price: Money, step: Money): Money =
    if (price.minorUnits > Long.MaxValue - step.minorUnits) price.copy(minorUnits = Long.MaxValue)
    else price.copy(minorUnits = price.minorUnits + step.minorUnits)

  /**
   * Анти-снайп (П-04): одно продление на команду, сколько бы ставок она ни записала. Ставки команды несут одно время
   * `now`, поэтому окно проверяется один раз — по дедлайну до команды, — а продление идёт последним событием транзакции
   * (ADR-047). Ставка ровно в `deadline − window` в окно не попадает. Лот без дедлайна ведёт человек, и правило молчит;
   * исчерпанный лимит продлений — тоже.
   */
  private[lot] def extended(trading: TradingState, now: Instant): Option[LotEvent.DeadlineExtended] = {
    val antiSnipe = trading.config.antiSnipe
    trading.deadline
      .filter(inAntiSnipeWindow(trading, _, now))
      .filter(_ => trading.extensionsUsed < antiSnipe.maxExtensions)
      .map(deadline => LotEvent.DeadlineExtended(deadline.plus(antiSnipe.extension), trading.extensionsUsed + 1))
  }

  /**
   * Продление за снятием участника (ADR-072, п. 3): то же окно и та же длина продления, что у анти-снайпа, но счётчик
   * прежний и `K` не проверяется — предел у него свой, одно продление на снятого (И-12).
   */
  private def extendedByRemoval(trading: TradingState, now: Instant): Option[LotEvent.DeadlineExtended] =
    trading.deadline
      .filter(inAntiSnipeWindow(trading, _, now))
      .map(deadline =>
        LotEvent.DeadlineExtended(deadline.plus(trading.config.antiSnipe.extension), trading.extensionsUsed)
      )

  /** Команда в момент `now` попала в окно анти-снайпа: ровно `deadline − window` в окно не входит. */
  private def inAntiSnipeWindow(trading: TradingState, deadline: Instant, now: Instant): Boolean =
    now.isAfter(deadline.minus(trading.config.antiSnipe.window))

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

  /** Торги живого финала из удержания; общее для [[apply]] и пересчёта на возврате в [[decide]]. */
  private def resumed(held: HeldState): TradingState =
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
      markedForFinal = false,
      course = held.course
    )

  /**
   * История после входа в торгах: входы онлайн-недели копятся, входы живого финала — нет (см. [[Course]]). Неизвестная
   * история остаётся неизвестной.
   */
  private def online(trading: TradingState, entry: Entry): Option[Course] =
    if (trading.phase == Phase.Online) trading.course.map(course => course.copy(online = course.online :+ entry))
    else trading.course

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
   * `at` — момент команды, `occurred_at` строки (ADR-047): время конверта ядро читает только здесь, записывая вход в
   * историю торгов (ADR-072, п. 2) — ручную ставку, выставленный и снятый лимит, — а номер входа берётся из `sequence`,
   * как `setSeq`. `ParticipantRemoved` только присваивает итог из события, убирает лимит снятого и помечает его снятым:
   * переигрывает [[decide]].
   *
   * Удержание `LotHeldForFinal` переносит цену, лидера, лимиты и счётчик продлений из торгов как есть, а возврат
   * `LotResumed` строит торги живого финала из удержания: фаза `Live`, без дедлайна и ask, отметка снята (П-09).
   * `AskAdvanced` ставит ask и больше ничего не трогает: цену и лидера меняет только ставка (П-08). `StepWindowAdded`
   * дописывает окно к окнам торгов в порядке начала (И-21), `PeriodWindowSet` заменяет окно своего периода или
   * дописывает его, `PeriodWindowCleared` окно периода снимает (PER-786). Окон сниженного шага удержание не несёт
   * (RFC-011, «Состояние лота»), и в финале их нет; правило шага не применяет их в `Live` и тогда, когда они в
   * состоянии лежат.
   */
  def apply(lot: Lot, envelope: Envelope, at: Instant): Lot = {
    val entry = (participant: ParticipantId, move: Move) => Entry(participant, move, at, envelope.sequence)
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
            markedForFinal = false,
            course = Some(Course.opened(opened.startingPrice, opened.stepWindows)),
            stepWindows = opened.stepWindows
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
            extensionsUsed = trading.extensionsUsed,
            course = trading.course
          )
        )
      case (LotState.Held(held), LotEvent.LotResumed) => LotState.Trading(resumed(held))
      case (LotState.Trading(trading), LotEvent.AskAdvanced(ask)) => LotState.Trading(trading.copy(ask = Some(ask)))
      // Окно ложится и в историю с номером строки: переигрывание даст его только входам после неё (ADR-072, п. 2).
      case (LotState.Trading(trading), LotEvent.StepWindowAdded(window)) =>
        LotState.Trading(
          trading.copy(
            stepWindows = (trading.stepWindows :+ window).sortBy(_.from),
            course = trading.course.map(course =>
              course.copy(addedWindows = course.addedWindows :+ AddedWindow(window, envelope.sequence))
            )
          )
        )
      // Окно периода заменяет прежнее окно того же периода и в торгах, и в истории: прежняя форма не действовала ни
      // на один вход, потому что замена идёт только до начала периода (PER-786).
      case (LotState.Trading(trading), LotEvent.PeriodWindowSet(window)) =>
        val period = (other: StepWindow) => window.period.exists(other.of)
        LotState.Trading(
          trading.copy(
            stepWindows = (trading.stepWindows.filterNot(period) :+ window).sortBy(_.from),
            course = trading.course.map(course =>
              course.copy(addedWindows =
                course.addedWindows.filterNot(added => period(added.window)) :+ AddedWindow(window, envelope.sequence)
              )
            )
          )
        )
      case (LotState.Trading(trading), LotEvent.PeriodWindowCleared(period)) =>
        LotState.Trading(
          trading.copy(
            stepWindows = trading.stepWindows.filterNot(_.of(period)),
            course = trading.course.map(course =>
              course.copy(addedWindows = course.addedWindows.filterNot(_.window.of(period)))
            )
          )
        )
      case (LotState.Trading(trading), placed: LotEvent.BidPlaced) =>
        val course = placed.origin match {
          case BidOrigin.Manual(_) => online(trading, entry(placed.participant, Move.Bid(placed.amount)))
          case BidOrigin.Proxy => trading.course
        }
        LotState.Trading(bidden(trading, placed).copy(course = course))
      case (LotState.Trading(trading), LotEvent.DeadlineExtended(deadline, extensionsUsed)) =>
        LotState.Trading(trading.copy(deadline = Some(deadline), extensionsUsed = extensionsUsed))
      case (LotState.Trading(trading), set: LotEvent.ProxyLimitSet) =>
        LotState.Trading(
          trading.copy(
            proxyLimits = limited(trading.proxyLimits, set, envelope.sequence),
            course = online(trading, entry(set.participant, Move.LimitSet(set.max)))
          )
        )
      case (LotState.Held(held), set: LotEvent.ProxyLimitSet) =>
        LotState.Held(
          held.copy(
            proxyLimits = limited(held.proxyLimits, set, envelope.sequence),
            course = held.course.map(course =>
              course.copy(held = course.held :+ entry(set.participant, Move.LimitSet(set.max)))
            )
          )
        )
      case (LotState.Trading(trading), LotEvent.ProxyLimitWithdrawn(participant)) =>
        LotState.Trading(
          trading.copy(
            proxyLimits = trading.proxyLimits.removed(participant),
            course = online(trading, entry(participant, Move.LimitWithdrawn))
          )
        )
      case (LotState.Held(held), LotEvent.ProxyLimitWithdrawn(participant)) =>
        LotState.Held(
          held.copy(
            proxyLimits = held.proxyLimits.removed(participant),
            course =
              held.course.map(course => course.copy(held = course.held :+ entry(participant, Move.LimitWithdrawn)))
          )
        )
      case (LotState.Trading(trading), removed: LotEvent.ParticipantRemoved) =>
        LotState.Trading(
          trading.copy(
            currentPrice = removed.price,
            leader = removed.leader,
            leadingBidId = removed.leadingBidId,
            proxyLimits = trading.proxyLimits.removed(removed.participant),
            course = trading.course.map(course => course.copy(removed = course.removed + removed.participant))
          )
        )
      case (LotState.Held(held), removed: LotEvent.ParticipantRemoved) =>
        LotState.Held(
          held.copy(
            currentPrice = removed.price,
            leader = removed.leader,
            leadingBidId = removed.leadingBidId,
            proxyLimits = held.proxyLimits.removed(removed.participant),
            course = held.course.map(course => course.copy(removed = course.removed + removed.participant))
          )
        )
      case (LotState.Trading(_) | LotState.Held(_), sold: LotEvent.LotSold) =>
        LotState.Sold(Sale(sold.winner, sold.price, sold.bidId, sold.at))
      case (LotState.Trading(_) | LotState.Held(_), LotEvent.LotUnsold(reason)) => LotState.Unsold(reason)
      case (
            LotState.Draft | LotState.Scheduled(_) | LotState.Trading(_) | LotState.Held(_),
            LotEvent.LotWithdrawn(reason)
          ) =>
        LotState.Withdrawn(reason)
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
   * Свёртка журнала в порядке `sequence` (П-07); строка журнала — конверт и его момент: при равных суммах лидирует
   * ставка, записанная первой, и время события в сравнении не участвует. Порядок, в котором строки пришли к
   * вызывающему, на итог не влияет.
   */
  def replay(from: Lot, journal: Seq[Written]): Lot =
    journal.sortBy(_.envelope.sequence).foldLeft(from)((lot, row) => apply(lot, row.envelope, row.at))
}
