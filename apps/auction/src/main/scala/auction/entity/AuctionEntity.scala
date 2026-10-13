package auction.entity

import auction.aggregate.*
import auction.catalog.LotId
import auction.lot.AdvanceAskRejected
import auction.lot.AuctionId
import auction.lot.CloseLotRejected
import auction.lot.LotState
import auction.lot.MarkForFinalRejected
import auction.lot.OpId
import auction.lot.OpenLotRejected
import auction.lot.ResumeLotRejected
import auction.lot.ScheduleLotRejected
import auction.lot.UnmarkForFinalRejected
import auction.lot.WithdrawLotRejected
import auction.slot.TradingSlotEntity
import net.logstash.logback.argument.StructuredArguments
import org.apache.pekko.Done
import org.apache.pekko.actor.typed.ActorRef
import org.apache.pekko.actor.typed.Behavior
import org.apache.pekko.actor.typed.scaladsl.Behaviors
import org.apache.pekko.cluster.sharding.typed.scaladsl.ClusterSharding
import org.apache.pekko.cluster.sharding.typed.scaladsl.EntityTypeKey
import org.apache.pekko.persistence.Persistence
import org.apache.pekko.persistence.typed.PersistenceId
import org.apache.pekko.persistence.typed.RecoveryCompleted
import org.apache.pekko.persistence.typed.scaladsl.Effect
import org.apache.pekko.persistence.typed.scaladsl.EventSourcedBehavior
import org.apache.pekko.persistence.typed.scaladsl.RetentionCriteria

import java.time.Clock
import java.time.Duration
import java.time.Instant
import java.util.UUID
import scala.concurrent.Future
import scala.concurrent.duration.*
import scala.jdk.DurationConverters.*
import scala.util.Failure
import scala.util.Success
import scala.util.Try

/**
 * Ответ entity аукциона на принятую команду: конверт записанного события (или исходный — на повтор) либо «без события».
 */
enum AuctionAnswer {
  case Written(envelope: AuctionEnvelope)
  case Unchanged
}

/**
 * Отказ открытия торгов у entity: решение агрегата либо ответ слота торгов сообщества (ADR-047, дополнение 2026-10-12).
 * Слот — не правило агрегата, а соседняя entity, поэтому её ответы живут здесь, а не в `StartPrebiddingRejected`.
 * `SlotUnavailable` — слот или его держатель не ответили в срок.
 */
enum OpeningRejected {
  case ByAuction(rejected: StartPrebiddingRejected)
  case AnotherAuctionActive(holder: AuctionId)
  case SlotUnavailable
}

/**
 * Аукцион как персистентный агрегат под Cluster Sharding — та же форма, что [[LotEntity]]: решение в
 * [[Auction.decide]], состояние меняет только [[Auction.apply]], `onPersistFailure` не задан (ADR-045).
 *
 * Права entity не проверяет: проверка у Meetups асинхронна и идёт в шлюзе между `Inspect` и командой. Окно `seen`
 * команда сверяет заново — повтор, принятый между двумя шагами, получает исходный ответ, а не второе событие.
 *
 * Протокол с лотами (И-14) entity только исполняет: что спросить и кого открыть, решает [[LotRoster]]. Знание о лотах в
 * журнал и snapshot не попадает и живёт в этой инкарнации entity; после recovery оно строится тем же опросом, что и
 * после команды открытия (ADR-045, «Восстановление лотов и аукциона»). Ответа лотов entity не ждёт: команда открытия
 * отвечает сразу после записи события, а ответы лотов приходят ей сообщениями.
 *
 * Таймеры закрытия — таймеры этой инкарнации: по ключу на лот, взводятся по дедлайну, который назвал лот, и пропадают
 * вместе с entity. Поэтому entity аукциона шардинг помнит и по простою не усыпляет (ADR-045, дополнение 2026-10-05), а
 * после рестарта таймеры взводятся заново тем же опросом. Лот, не ответивший на вопрос или команду, переспрашивается
 * таймером `recheckEvery`: следующего пробуждения, которое переспросило бы его, у помнящейся entity нет.
 *
 * Аукцион без журнала на тике переспроса просит шард себя пассивировать, и пассивированная entity из запоминания
 * уходит. Иначе шардинг помнил бы вечно каждый `auction_id`, по которому пришло сообщение, — в том числе вопрос
 * `Inspect` к аукциону, которого нет. Только `Initial`, а не всё, что вне торгов: команда, принятая между запросом
 * пассивации и остановкой, проходит без шарда, и запланированный аукцион мог бы войти в торги и тут же забыться вместе
 * с таймерами. Из `Initial` до торгов — рождение, реестр, планирование и старт, каждое с ответом, в одно такое окно они
 * не помещаются, а `Draft` и `Scheduled` — настоящие аукционы сходок, и их число ограничено сходками.
 *
 * Розыгрыш среди участников (ADR-066) entity открывает, но не ведёт: если у конфигурации есть момент закрытия
 * регистрации, после записи `PrebiddingStarted` она шлёт открытие entity розыгрыша и повторяет его на тике переспроса и
 * после recovery, пока не получит ответ. Знание «розыгрыш открыт» несохраняемо, как знание о лотах: открытие
 * идемпотентно, и лишний повтор ничего не меняет.
 *
 * Отмена после старта торгов (ADR-047, дополнение 2026-10-12) пишет `AuctionCancelled` и дальше идёт тем же протоколом:
 * каждому лоту реестра — `WithdrawLot`, розыгрышу — отмена, обе с `op_id` от `op_id` отмены и с переспросом на тике и
 * после recovery. Знание «лот ответил» и «розыгрыш ответил» несохраняемо, как знание об открытии.
 *
 * Слот торгов сообщества (ADR-047, дополнение 2026-10-12). Принятое открытие entity не пишет сразу, а сначала занимает
 * слот и решает заново по ответу слота: отдан — пишет `PrebiddingStarted`, занят другим — отказ с его `auction_id`.
 * Пока ответ слота в пути, открытие «в полёте»: на вопрос слота `Trading` entity отвечает «занят», и вопрос с записью
 * открытия не перекрываются, потому что entity обрабатывает сообщения по одному. Другие команды в это время не
 * откладываются — решение по ответу слота принимается по свежему состоянию. Рестарт сбрасывает открытие в полёте вместе
 * с ответом, которого вызывающий уже не дождётся. Освобождает слот entity сама, когда торгов у неё больше нет
 * ([[LotRoster.trading]]): в `Finished` и в `Cancelled` после ответа каждого лота на `WithdrawLot`. Освобождение
 * повторяется на тике переспроса и после recovery, пока слот не подтвердит; знание «слот освобождён» несохраняемо.
 * Торгующий аукцион ([[LotRoster.holding]]) так же подтверждает слот занятием после recovery и на тике: торги, открытые
 * до появления слота, иначе отдали бы его второму аукциону.
 *
 * `ScheduleLot`, отметку для финала и её снятие entity передаёт лоту, ничего не записав: условия торгов и отметка живут
 * в журнале лота, а аукцион только решает, можно ли сейчас их менять ([[Auction.decide]]), и для условий подставляет
 * незаданное.
 *
 * Перерыв и финал (PER-334, RFC-011). Общий дедлайн — таймер этой инкарнации на `closesAt`, взводится после открытия
 * торгов и после recovery в `Prebidding`; сработав, он пишет `PrebiddingDeadlineReached`. Конец ожидания лотов
 * `PrebiddingEnded` entity пишет, когда [[LotRoster]] отдаёт инструкцию `Settle`: тем же сообщением себе, потому что
 * записать событие можно только в обработке команды. У обоих шагов человека нет, и `op_id` — UUIDv5 от `op_id` открытия
 * ([[LotRoster.stepOpId]]): второй таймер после рестарта упирается в окно `seen`. Заморозка состава берёт удержанных у
 * знания о лотах, а не у журнала (ADR-047, дополнение 2026-10-06). Следующий лот финала entity возвращает в торги
 * командой `ResumeLot` и пишет `FinalLotActivated` только после ответа лота (И-14); ответ вызывающему — после записи.
 */
object AuctionEntity {

  val TypeKey: EntityTypeKey[Command] = EntityTypeKey[Command]("auction")

  val DefaultSnapshotEvery: Int = 100

  /** Как часто аукцион переспрашивает лоты, не ответившие на вопрос или команду. */
  val DefaultRecheckEvery: FiniteDuration = 30.seconds

  /** Аукцион и номер последнего применённого события; номер выводится счётом, как у лота (`LotEntity.State`). */
  final case class State(auction: Auction, sequence: Long)

  sealed trait Command

  /** Что знает аукцион до проверки права: повтор, отсутствие или сходка. Ничего не пишет. */
  final case class Inspect(opId: OpId, replyTo: ActorRef[Inspection]) extends Command

  final case class Draft(command: DraftAuction, initiator: Initiator, replyTo: ActorRef[AuctionAnswer]) extends Command

  final case class Add(command: AddLot, initiator: Initiator, replyTo: ActorRef[Either[AddLotRejected, AuctionAnswer]])
      extends Command

  final case class Remove(
      command: RemoveLot,
      initiator: Initiator,
      replyTo: ActorRef[Either[RemoveLotRejected, AuctionAnswer]]
  ) extends Command

  /** Планирование; `Schedule` — имя сообщения, как `LotEntity.Plan` у лота. */
  final case class Schedule(
      command: ScheduleAuction,
      initiator: Initiator,
      replyTo: ActorRef[Either[ScheduleAuctionRejected, AuctionAnswer]]
  ) extends Command

  /**
   * Открытие онлайн-торгов. Ответ — после ответа слота и записи события. Повтор того же `op_id` события не пишет, но
   * доспрашивает лоты, не ответившие раньше.
   */
  final case class Start(
      command: StartPrebidding,
      initiator: Initiator,
      replyTo: ActorRef[Either[OpeningRejected, AuctionAnswer]]
  ) extends Command

  /** Вопрос слота держателю: идут ли торги — в том числе открытие в полёте. Ничего не пишет. */
  final case class Trading(replyTo: ActorRef[Boolean]) extends Command

  /**
   * Отмена после старта торгов: событие `AuctionCancelled`. Ответ — после записи; лоты и розыгрыш снимаются после него.
   * Повтор того же `op_id` события не пишет, но доснимает лоты, не ответившие раньше.
   */
  final case class Cancel(
      command: CancelAuction,
      initiator: Initiator,
      replyTo: ActorRef[Either[CancelAuctionRejected, AuctionAnswer]]
  ) extends Command

  /** Удаление до торгов: событие `AuctionDiscarded`, после него аукцион — снова `Initial`. */
  final case class Discard(
      command: DiscardAuction,
      initiator: Initiator,
      replyTo: ActorRef[Either[DiscardAuctionRejected, AuctionAnswer]]
  ) extends Command

  /**
   * Условия торгов лоту реестра — `ScheduleLot`, идущий через аукцион; `PlanLot` — имя сообщения, как `LotEntity.Plan`
   * у лота. События аукцион не пишет: решает, можно ли ещё менять условия, и шлёт команду лоту. Ответ приходит после
   * ответа лота; лот не ответил — ответа нет, и повтор с тем же `op_id` узнаёт лот.
   */
  final case class PlanLot(
      command: ScheduleAuctionLot,
      initiator: Initiator,
      replyTo: ActorRef[Either[ScheduleAuctionLotRejected, Unit]]
  ) extends Command

  /**
   * Отметка лота реестра для финала и её снятие (ADR-047, дополнение 2026-10-06). Та же форма, что `PlanLot`: аукцион
   * решает по фазе и реестру и шлёт команду лоту в обработке этого же сообщения, событие пишет только лот, а ответ
   * приходит после ответа лота.
   */
  final case class Select(
      command: SelectForFinal,
      initiator: Initiator,
      replyTo: ActorRef[Either[FinalChoiceRejected[MarkForFinalRejected], Unit]]
  ) extends Command

  final case class Deselect(
      command: DeselectForFinal,
      initiator: Initiator,
      replyTo: ActorRef[Either[FinalChoiceRejected[UnmarkForFinalRejected], Unit]]
  ) extends Command

  /** Ask ведущего лоту реестра (П-08): та же форма, что `Select` — решает аукцион, событие пишет лот. */
  final case class AskLot(
      command: AdvanceLotAsk,
      initiator: Initiator,
      replyTo: ActorRef[Either[AdvanceLotAskRejected, Unit]]
  ) extends Command

  /** Заморозка состава финала; удержанных entity берёт у своего знания о лотах. */
  final case class Freeze(
      command: FreezeFinalLineup,
      initiator: Initiator,
      replyTo: ActorRef[Either[FreezeFinalLineupRejected, AuctionAnswer]]
  ) extends Command

  final case class BeginFinal(
      command: StartFinal,
      initiator: Initiator,
      replyTo: ActorRef[Either[StartFinalRejected, AuctionAnswer]]
  ) extends Command

  /**
   * Следующий лот финала. Ответ — лот, который вернулся в торги, и приходит после записи `FinalLotActivated`; лот не
   * ответил — ответа нет, и повтор с тем же `op_id` дописывает активацию.
   */
  final case class Next(
      command: StartNextLot,
      initiator: Initiator,
      replyTo: ActorRef[Either[StartNextLotRejected, LotId]]
  ) extends Command

  final case class Get(replyTo: ActorRef[Auction]) extends Command

  /** Что аукцион сейчас знает о лотах реестра. Ничего не пишет и лотов не спрашивает. */
  final case class Roster(replyTo: ActorRef[LotRoster]) extends Command

  /** Ответ лота на вопрос о состоянии; неудача — ответа нет. */
  private[entity] final case class LotObserved(lot: LotId, state: Try[LotState]) extends Command

  /** Ответ лота на `OpenLot` с дедлайном из его `LotOpened`; неудача — ответа нет. */
  private[entity] final case class LotAnswered(lot: LotId, answer: Try[Either[OpenLotRejected, Option[Instant]]])
      extends Command

  /** Наступил дедлайн лота по часам аукциона; наступил ли он для лота, решает лот. */
  private[entity] final case class DeadlineDue(lot: LotId) extends Command

  /** Ответ лота на `CloseLot`; неудача — ответа нет. */
  private[entity] final case class LotClosed(lot: LotId, answer: Try[Either[CloseLotRejected, Closure]]) extends Command

  /** Наступил общий дедлайн онлайн-торгов по часам аукциона. */
  private[entity] case object PrebiddingDue extends Command

  /** Лоты больше не держат конец онлайн-торгов; `held` — удержанные по ответам. */
  private[entity] final case class Settled(held: Set[LotId]) extends Command

  /** Ответ лота финала на `ResumeLot` вместе с командой, которая его вернула; неудача — ответа нет. */
  private[entity] final case class LotReturned(
      command: StartNextLot,
      lot: LotId,
      initiator: Initiator,
      replyTo: ActorRef[Either[StartNextLotRejected, LotId]],
      answer: Try[Either[ResumeLotRejected, Unit]]
  ) extends Command

  /** Переспросить лоты, не ответившие на вопрос или команду. */
  private[entity] case object Recheck extends Command

  /** Ответ розыгрыша на открытие; неудача — ответа нет, и открытие повторится на тике переспроса. */
  private[entity] final case class RaffleAnswered(answer: Try[Done]) extends Command

  /** Ответ лота на `WithdrawLot`; неудача — ответа нет. */
  private[entity] final case class LotWithdrew(lot: LotId, answer: Try[Either[WithdrawLotRejected, Unit]])
      extends Command

  /** Ответ розыгрыша на отмену; неудача — ответа нет, и отмена повторится на тике переспроса. */
  private[entity] final case class RaffleCancelAnswered(answer: Try[Done]) extends Command

  /**
   * Ответ слота на занятие вместе с командой открытия, которая его ждёт, и номером события аукциона на момент занятия;
   * неудача — ответа нет.
   */
  private[entity] final case class SlotAnswered(
      command: StartPrebidding,
      initiator: Initiator,
      replyTo: ActorRef[Either[OpeningRejected, AuctionAnswer]],
      sequence: Long,
      answer: Try[TradingSlotEntity.Claimed]
  ) extends Command

  /** Ответ слота на подтверждение торгующим аукционом; неудача — ответа нет, и подтверждение повторится на тике. */
  private[entity] final case class SlotConfirmed(answer: Try[TradingSlotEntity.Claimed]) extends Command

  /** Ответ слота на освобождение; неудача — ответа нет, и освобождение повторится на тике переспроса. */
  private[entity] final case class SlotReleased(answer: Try[Done]) extends Command

  private final case class DeadlineKey(lot: LotId)

  private case object RecheckKey

  private case object PrebiddingKey

  /** Ответ лота на `ScheduleLot` вместе с тем, кому его отдать; неудача — ответа нет. */
  private[entity] final case class LotPlanned(
      lot: LotId,
      replyTo: ActorRef[Either[ScheduleAuctionLotRejected, Unit]],
      answer: Try[Either[ScheduleLotRejected, Unit]]
  ) extends Command

  /** Ответ лота на отметку или снятие вместе с тем, кому его отдать; неудача — ответа нет. */
  private[entity] final case class LotChosen[R](
      lot: LotId,
      replyTo: ActorRef[Either[FinalChoiceRejected[R], Unit]],
      answer: Try[Either[R, Unit]]
  ) extends Command

  /** Ответ лота на ask вместе с тем, кому его отдать; неудача — ответа нет. */
  private[entity] final case class LotAsked(
      lot: LotId,
      replyTo: ActorRef[Either[AdvanceLotAskRejected, Unit]],
      answer: Try[Either[AdvanceAskRejected, Unit]]
  ) extends Command

  /**
   * @param auctionId
   *   идентификатор аукциона: persistence id — `auction|<auctionId>`
   * @param lots
   *   лоты реестра: вопрос о состоянии, `OpenLot` и `CloseLot`
   * @param clock
   *   серверное время конверта и отсчёт задержки таймера до дедлайна лота
   * @param raffle
   *   розыгрыш аукциона: открытие регистрации после старта торгов
   * @param slot
   *   слот торгов сообщества: занятие до открытия торгов и освобождение в конечном состоянии
   */
  def apply(
      auctionId: String,
      clock: Clock,
      newId: () => UUID,
      lots: AuctionLots,
      snapshotEvery: Int = DefaultSnapshotEvery,
      recheckEvery: FiniteDuration = DefaultRecheckEvery,
      shard: Option[ActorRef[ClusterSharding.ShardCommand]] = None,
      raffle: AuctionRaffle = AuctionRaffle.none,
      slot: AuctionSlot = AuctionSlot.none
  ): Behavior[Command] =
    Behaviors.withTimers[Command] { timers =>
      Behaviors.setup { context =>
        val persistenceId = PersistenceId(TypeKey.name, auctionId)
        val tag = Set(AuctionTags.of(Persistence(context.system.classicSystem).sliceForPersistenceId(persistenceId.id)))

        // Знание о лотах несохраняемо по решению (RFC-011): рестарт пересоздаёт замыкание пустым, и устаревшее знание
        // recovery пережить не может. Меняют его только сообщения этой entity, по одному.
        var roster = LotRoster.empty

        def follow(step: (LotRoster, List[LotInstruction])): Unit = {
          val (known, instructions) = step
          roster = known
          instructions.foreach {
            case LotInstruction.Ask(lot) => context.pipeToSelf(lots.stateOf(lot))(LotObserved(lot, _))
            case LotInstruction.Open(lot, command) => context.pipeToSelf(lots.open(lot, command))(LotAnswered(lot, _))
            case LotInstruction.Arm(lot, deadline) =>
              // Дедлайн, истёкший за время простоя, даёт нулевую задержку: лот закрывается сразу (ADR-045).
              val delay = Duration.between(clock.instant(), deadline).toScala.max(Duration.ZERO.toScala)
              timers.startSingleTimer(DeadlineKey(lot), DeadlineDue(lot), delay)
            case LotInstruction.Close(lot, command) => context.pipeToSelf(lots.close(lot, command))(LotClosed(lot, _))
            case LotInstruction.Settle(held) => context.self ! Settled(held)
            case LotInstruction.Withdraw(lot, command) =>
              // Таймер дедлайна снятого лота больше не нужен: отменённый аукцион лотов не закрывает.
              timers.cancel(DeadlineKey(lot))
              context.pipeToSelf(lots.withdraw(lot, command))(LotWithdrew(lot, _))
          }
        }

        // Общий дедлайн, истёкший за время простоя, даёт нулевую задержку, как дедлайн лота.
        def armPrebidding(auction: Auction): Unit =
          Auction.prebiddingDeadline(auction).foreach { closesAt =>
            val delay = Duration.between(clock.instant(), closesAt).toScala.max(Duration.ZERO.toScala)
            timers.startSingleTimer(PrebiddingKey, PrebiddingDue, delay)
          }

        timers.startTimerWithFixedDelay(RecheckKey, Recheck, recheckEvery)

        // Открыт ли розыгрыш в этой инкарнации; рестарт начинает с `false` и спрашивает снова.
        var raffleOpened = false

        def openRaffle(auction: Auction): Unit =
          auction.state match {
            case AuctionState.Prebidding(config, _) if !raffleOpened =>
              config.raffleClosesAt.foreach { closesAt =>
                context.pipeToSelf(raffle.open(auctionId, closesAt))(RaffleAnswered(_))
              }
            case _ => ()
          }

        // Отменил ли розыгрыш отменённый аукцион в этой инкарнации; рестарт спрашивает снова — отмена идемпотентна.
        var raffleCancelled = false

        def cancelRaffle(auction: Auction): Unit =
          auction.state match {
            case AuctionState.Cancelled(config, _, cancelledBy)
                if !raffleCancelled && config.raffleClosesAt.isDefined =>
              context.pipeToSelf(raffle.cancel(auctionId, LotRoster.stepOpId(cancelledBy, "raffle-cancelled")))(
                RaffleCancelAnswered(_)
              )
            case _ => ()
          }

        // Сколько занятий слота в пути: повтор открытия в полёте шлёт своё занятие, и «занят» держится до последнего
        // ответа. Рестарт начинает с нуля.
        var claimsInFlight = 0

        // Синхронный отказ порта — идентификатор не UUID — приходит неудачей, а не роняет entity в обработке сообщения.
        def claimOf(id: String): Future[TradingSlotEntity.Claimed] =
          Try(slot.claim(id)).fold(Future.failed, answer => answer)

        def claimFor(
            start: StartPrebidding,
            initiator: Initiator,
            replyTo: ActorRef[Either[OpeningRejected, AuctionAnswer]],
            sequence: Long
        ): Unit = {
          claimsInFlight += 1
          context.pipeToSelf(claimOf(auctionId))(SlotAnswered(start, initiator, replyTo, sequence, _))
        }

        // Знает ли торгующий аукцион в этой инкарнации, что слот за ним. Торги, открытые до появления слота или до
        // рестарта, подтверждают его тем же идемпотентным занятием: иначе слот, выложенный поверх идущих торгов, отдал бы
        // себя второму аукциону.
        var slotConfirmed = false

        def confirmSlot(auction: Auction): Unit =
          if (!slotConfirmed && LotRoster.holding(auction.state))
            context.pipeToSelf(claimOf(auctionId))(SlotConfirmed(_))

        // Подтвердил ли слот освобождение в этой инкарнации; рестарт освобождает снова — освобождение идемпотентно.
        var slotReleased = false

        def releaseSlot(auction: Auction): Unit =
          if (!slotReleased && auction.state.started.isDefined && !LotRoster.trading(auction, roster))
            context.pipeToSelf(Try(slot.release(auctionId)).fold(Future.failed, released => released))(SlotReleased(_))

        def warnSlot(message: String, failure: Throwable): Unit =
          context.log.warn(
            message,
            StructuredArguments.keyValue("auction_id", auctionId),
            StructuredArguments.keyValue("error_category", "dependency_unavailable"),
            StructuredArguments.keyValue("error", failure.getClass.getName)
          )

        def open(
            auction: Auction,
            decision: AuctionDecision,
            start: StartPrebidding,
            initiator: Initiator,
            replyTo: ActorRef[Either[OpeningRejected, AuctionAnswer]]
        ): Effect[StoredAuctionEvent, State] =
          record(auction, decision, start.opId, initiator, clock, newId) { (after, answer) =>
            replyTo ! Right(answer)
            if (LotRoster.holding(after.state)) slotConfirmed = true
            follow(LotRoster.started(after, roster, decision))
            openRaffle(after)
            armPrebidding(after)
          }

        // Ожидаемый отказ зависимости: лот не ответил в срок. Сообщение исключения в запись не идёт — только его класс.
        def logUnanswered(lot: LotId, failure: Throwable): Unit =
          context.log.warn(
            "lot did not answer the auction",
            StructuredArguments.keyValue("auction_id", auctionId),
            StructuredArguments.keyValue("lot_id", lot.value.toString),
            StructuredArguments.keyValue("error_category", "dependency_unavailable"),
            StructuredArguments.keyValue("error", failure.getClass.getName)
          )

        def unanswered(lot: LotId, failure: Throwable): Unit = {
          logUnanswered(lot, failure)
          roster = LotRoster.unanswered(roster, lot)
        }

        def onCommand(state: State, command: Command): Effect[StoredAuctionEvent, State] =
          command match {
            case Start(start, initiator, replyTo) =>
              Auction.decide(state.auction, start) match {
                case Left(rejected) => Effect.reply(replyTo)(Left(OpeningRejected.ByAuction(rejected)))
                // Принятое открытие сначала занимает слот: событие пишется только по его ответу.
                case Right(AuctionDecision.Accepted(_)) =>
                  Effect.none.thenRun(_ => claimFor(start, initiator, replyTo, state.sequence))
                case Right(decision) => open(state.auction, decision, start, initiator, replyTo)
              }
            case SlotAnswered(start, initiator, replyTo, sequence, answer) =>
              claimsInFlight -= 1
              answer match {
                case Success(TradingSlotEntity.Claimed.Granted) =>
                  Auction.decide(state.auction, start) match {
                    case Left(rejected) => Effect.reply(replyTo)(Left(OpeningRejected.ByAuction(rejected)))
                    // Пока ответ слота был в пути, аукцион записал другие события — удаление и новое включение, новое
                    // планирование. Решение о старте принималось о прежнем аукционе, поэтому слот спрашивается заново.
                    case Right(AuctionDecision.Accepted(_)) if sequence != state.sequence =>
                      Effect.none.thenRun(_ => claimFor(start, initiator, replyTo, state.sequence))
                    case Right(decision) => open(state.auction, decision, start, initiator, replyTo)
                  }
                case Success(TradingSlotEntity.Claimed.Taken(holder)) =>
                  Effect.reply(replyTo)(Left(OpeningRejected.AnotherAuctionActive(holder)))
                case Success(TradingSlotEntity.Claimed.Unavailable) =>
                  Effect.reply(replyTo)(Left(OpeningRejected.SlotUnavailable))
                case Failure(failure) =>
                  Effect.none.thenRun { _ =>
                    warnSlot("trading slot did not answer the opening", failure)
                    replyTo ! Left(OpeningRejected.SlotUnavailable)
                  }
              }
            case Trading(replyTo) =>
              Effect.reply(replyTo)(claimsInFlight > 0 || LotRoster.trading(state.auction, roster))
            case SlotConfirmed(Success(TradingSlotEntity.Claimed.Granted)) =>
              slotConfirmed = true
              Effect.none
            // Слот у другого торгующего аукциона: два аукциона торговали до появления слота. Отнять торги у одного из них
            // слот не может, и запись об этом — одна на инкарнацию.
            case SlotConfirmed(Success(TradingSlotEntity.Claimed.Taken(holder))) =>
              slotConfirmed = true
              Effect.none.thenRun { _ =>
                context.log.warn(
                  "trading slot is held by another trading auction",
                  StructuredArguments.keyValue("auction_id", auctionId),
                  StructuredArguments.keyValue("holder_id", holder.value.toString),
                  StructuredArguments.keyValue("error_category", "unexpected")
                )
              }
            case SlotConfirmed(Success(TradingSlotEntity.Claimed.Unavailable)) => Effect.none
            case SlotConfirmed(Failure(failure)) =>
              Effect.none.thenRun(_ => warnSlot("trading slot did not answer the confirmation", failure))
            case SlotReleased(Success(_)) =>
              slotReleased = true
              Effect.none
            case SlotReleased(Failure(failure)) =>
              Effect.none.thenRun(_ => warnSlot("trading slot did not answer the release", failure))
            case Cancel(cancel, initiator, replyTo) =>
              Auction.decide(state.auction, cancel) match {
                case Left(rejected) => Effect.reply(replyTo)(Left(rejected))
                case Right(decision) =>
                  record(state.auction, decision, cancel.opId, initiator, clock, newId) { (auction, answer) =>
                    replyTo ! Right(answer)
                    timers.cancel(PrebiddingKey)
                    follow(LotRoster.cancelled(auction, roster, decision))
                    cancelRaffle(auction)
                    releaseSlot(auction)
                  }
              }
            case LotWithdrew(lot, Success(answer)) =>
              Effect.none.thenRun { after =>
                roster = LotRoster.withdrawn(roster, lot, answer)
                releaseSlot(after.auction)
              }
            case LotWithdrew(lot, Failure(failure)) => Effect.none.thenRun(_ => unanswered(lot, failure))
            case RaffleCancelAnswered(Success(_)) =>
              raffleCancelled = true
              Effect.none
            case RaffleCancelAnswered(Failure(failure)) =>
              Effect.none.thenRun { _ =>
                context.log.warn(
                  "raffle did not answer the cancellation",
                  StructuredArguments.keyValue("auction_id", auctionId),
                  StructuredArguments.keyValue("error_category", "dependency_unavailable"),
                  StructuredArguments.keyValue("error", failure.getClass.getName)
                )
              }
            case Roster(replyTo) => Effect.reply(replyTo)(roster)
            case LotObserved(lot, Success(lotState)) =>
              Effect.none.thenRun(after => follow(LotRoster.observed(after.auction, roster, lot, lotState)))
            case LotObserved(lot, Failure(failure)) => Effect.none.thenRun(_ => unanswered(lot, failure))
            case LotAnswered(lot, Success(answer)) =>
              Effect.none.thenRun(after => follow(LotRoster.opened(after.auction, roster, lot, answer)))
            case LotAnswered(lot, Failure(failure)) => Effect.none.thenRun(_ => unanswered(lot, failure))
            case DeadlineDue(lot) => Effect.none.thenRun(after => follow(LotRoster.due(after.auction, roster, lot)))
            case LotClosed(lot, Success(answer)) =>
              Effect.none.thenRun(after => follow(LotRoster.closed(after.auction, roster, lot, answer)))
            case LotClosed(lot, Failure(failure)) => Effect.none.thenRun(_ => unanswered(lot, failure))
            case Recheck =>
              Effect.none.thenRun { after =>
                after.auction.state match {
                  case AuctionState.Initial => shard.foreach(_ ! ClusterSharding.Passivate(context.self))
                  case AuctionState.Draft | AuctionState.Scheduled(_) | AuctionState.Prebidding(_, _) |
                      AuctionState.Settling(_, _) | AuctionState.Break(_, _) | AuctionState.LineupFrozen(_, _, _) |
                      AuctionState.Final(_, _, _, _) | AuctionState.Finished(_, _) | AuctionState.Cancelled(_, _, _) =>
                    follow(LotRoster.recheck(after.auction, roster))
                    openRaffle(after.auction)
                    cancelRaffle(after.auction)
                    confirmSlot(after.auction)
                    releaseSlot(after.auction)
                }
              }
            case PrebiddingDue =>
              state.auction.state.started match {
                case None => Effect.none
                case Some((_, startedBy)) =>
                  val end = EndPrebidding(LotRoster.stepOpId(startedBy, "prebidding-deadline"), clock.instant())
                  Auction.decide(state.auction, end) match {
                    // Таймер сработал раньше часов: взводится снова по тому же `closesAt`.
                    case Left(EndPrebiddingRejected.DeadlineNotReached) =>
                      Effect.none.thenRun(after => armPrebidding(after.auction))
                    case Left(EndPrebiddingRejected.NotInPrebidding) => Effect.none
                    case Right(decision) =>
                      record(state.auction, decision, end.opId, Initiator.Scheduler, clock, newId) { (auction, _) =>
                        follow(LotRoster.settling(auction, (roster, Nil)))
                      }
                  }
              }
            case Settled(held) =>
              state.auction.state.started match {
                case None => Effect.none
                case Some((_, startedBy)) =>
                  val end = EndSettling(held, LotRoster.stepOpId(startedBy, "prebidding-ended"))
                  Auction.decide(state.auction, end) match {
                    case Left(EndSettlingRejected.NotSettling) => Effect.none
                    case Right(decision) =>
                      record(state.auction, decision, end.opId, Initiator.Scheduler, clock, newId) { (auction, _) =>
                        releaseSlot(auction)
                      }
                  }
              }
            case Freeze(freeze, initiator, replyTo) =>
              val decision = Auction.decide(state.auction, freeze, LotRoster.lineup(state.auction, roster))
              answered(state.auction, decision, freeze.opId, initiator, replyTo, clock, newId)
            case BeginFinal(begin, initiator, replyTo) =>
              answered(
                state.auction,
                Auction.decide(state.auction, begin),
                begin.opId,
                initiator,
                replyTo,
                clock,
                newId
              )
            case Next(next, initiator, replyTo) =>
              (Auction.decide(state.auction, next), state.auction.state.started) match {
                case (Left(rejected), _) => Effect.reply(replyTo)(Left(rejected))
                case (Right(NextLot.Repeated(original)), _) => Effect.reply(replyTo)(activated(original))
                case (Right(NextLot.Resume(lot)), Some((_, startedBy))) =>
                  Effect.none.thenRun { _ =>
                    context.pipeToSelf(lots.resume(lot, LotRoster.resumeOf(startedBy, lot)))(
                      LotReturned(next, lot, initiator, replyTo, _)
                    )
                  }
                case (Right(NextLot.Resume(_)), None) =>
                  throw new IllegalStateException(s"auction $auctionId chose a lot of the final before trading started")
              }
            case LotReturned(next, lot, initiator, replyTo, Success(Right(()))) =>
              Auction.activate(state.auction, next, lot) match {
                case Left(rejected) => Effect.reply(replyTo)(Left(rejected))
                case Right(decision) =>
                  record(state.auction, decision, next.opId, initiator, clock, newId) { (_, answer) =>
                    answer match {
                      case AuctionAnswer.Written(envelope) => replyTo ! activated(envelope)
                      case AuctionAnswer.Unchanged => replyTo ! Right(lot)
                    }
                  }
              }
            // Отказ лота значит, что он не удержан: снят или уже закрыт. Конец лота финала приходит с закрытием лота
            // ведущим, а до него такой ответ — расхождение аукциона с лотом, и вызывающий ответа не получает.
            case LotReturned(_, lot, _, _, Success(Left(rejected))) =>
              Effect.none.thenRun { _ =>
                context.log.warn(
                  "lot of the final refused to resume",
                  StructuredArguments.keyValue("auction_id", auctionId),
                  StructuredArguments.keyValue("lot_id", lot.value.toString),
                  StructuredArguments.keyValue("error_category", "unexpected"),
                  StructuredArguments.keyValue("error", rejected.toString)
                )
              }
            case LotReturned(_, lot, _, _, Failure(failure)) => Effect.none.thenRun(_ => logUnanswered(lot, failure))
            case RaffleAnswered(Success(_)) =>
              raffleOpened = true
              Effect.none
            case RaffleAnswered(Failure(failure)) =>
              Effect.none.thenRun { _ =>
                context.log.warn(
                  "raffle did not answer the auction",
                  StructuredArguments.keyValue("auction_id", auctionId),
                  StructuredArguments.keyValue("error_category", "dependency_unavailable"),
                  StructuredArguments.keyValue("error", failure.getClass.getName)
                )
              }
            case PlanLot(plan, initiator, replyTo) =>
              Auction.decide(state.auction, plan) match {
                case Left(rejected) => Effect.reply(replyTo)(Left(rejected))
                case Right(schedule) =>
                  // Команда уходит лоту в обработке этого же сообщения. Старт торгов, принятый следом, шлёт лоту
                  // вопрос и `OpenLot` тем же путём и позже, поэтому лот получает условия раньше открытия, а
                  // `ScheduleLot`, пришедший после старта, сюда уже не доходит: окна между решением и командой нет.
                  Effect.none.thenRun { _ =>
                    context.pipeToSelf(lots.schedule(plan.lot, schedule, initiator))(LotPlanned(plan.lot, replyTo, _))
                  }
              }
            case LotPlanned(_, replyTo, Success(answer)) =>
              Effect.reply(replyTo)(answer.left.map(ScheduleAuctionLotRejected.ByLot(_)))
            // Знание об открытии это не меняет: молчащий лот остаётся с прежними условиями либо с принятыми.
            case LotPlanned(lot, _, Failure(failure)) => Effect.none.thenRun(_ => logUnanswered(lot, failure))
            case Select(select, initiator, replyTo) =>
              Auction.decide(state.auction, select) match {
                case Left(rejected) => Effect.reply(replyTo)(Left(rejected))
                case Right(mark) =>
                  Effect.none.thenRun { _ =>
                    context.pipeToSelf(lots.mark(select.lot, mark, initiator))(LotChosen(select.lot, replyTo, _))
                  }
              }
            case Deselect(deselect, initiator, replyTo) =>
              Auction.decide(state.auction, deselect) match {
                case Left(rejected) => Effect.reply(replyTo)(Left(rejected))
                case Right(unmark) =>
                  Effect.none.thenRun { _ =>
                    context.pipeToSelf(lots.unmark(deselect.lot, unmark, initiator))(
                      LotChosen(deselect.lot, replyTo, _)
                    )
                  }
              }
            case chosen: LotChosen[r] =>
              chosen.answer match {
                case Success(answer) => Effect.reply(chosen.replyTo)(answer.left.map(FinalChoiceRejected.ByLot(_)))
                case Failure(failure) => Effect.none.thenRun(_ => logUnanswered(chosen.lot, failure))
              }
            case AskLot(ask, initiator, replyTo) =>
              Auction.decide(state.auction, ask) match {
                case Left(rejected) => Effect.reply(replyTo)(Left(rejected))
                case Right(command) =>
                  Effect.none.thenRun { _ =>
                    context.pipeToSelf(lots.advanceAsk(ask.lot, command, initiator))(LotAsked(ask.lot, replyTo, _))
                  }
              }
            case LotAsked(_, replyTo, Success(answer)) =>
              Effect.reply(replyTo)(answer.left.map(AdvanceLotAskRejected.ByLot(_)))
            case LotAsked(lot, _, Failure(failure)) => Effect.none.thenRun(_ => logUnanswered(lot, failure))
            case Inspect(opId, replyTo) => Effect.reply(replyTo)(Auction.inspect(state.auction, opId))
            case Draft(draft, initiator, replyTo) =>
              val decision = Auction.decide(state.auction, draft)
              record(state.auction, decision, draft.opId, initiator, clock, newId)((_, answer) => replyTo ! answer)
            case Add(add, initiator, replyTo) =>
              answered(state.auction, Auction.decide(state.auction, add), add.opId, initiator, replyTo, clock, newId)
            case Remove(remove, initiator, replyTo) =>
              val decision = Auction.decide(state.auction, remove)
              answered(state.auction, decision, remove.opId, initiator, replyTo, clock, newId)
            case Schedule(schedule, initiator, replyTo) =>
              val decision = Auction.decide(state.auction, schedule)
              answered(state.auction, decision, schedule.opId, initiator, replyTo, clock, newId)
            case Discard(discard, initiator, replyTo) =>
              val decision = Auction.decide(state.auction, discard)
              answered(state.auction, decision, discard.opId, initiator, replyTo, clock, newId)
            case Get(replyTo) => Effect.reply(replyTo)(state.auction)
          }

        EventSourcedBehavior[Command, StoredAuctionEvent, State](
          persistenceId = persistenceId,
          emptyState = State(Auction.initial, 0),
          commandHandler = onCommand,
          eventHandler = (state, stored) => {
            val sequence = state.sequence + 1
            State(Auction.apply(state.auction, AuctionJournal.envelope(sequence, stored)), sequence)
          }
        ).snapshotAdapter(AuctionJournal.snapshotAdapter)
          .withRetention(RetentionCriteria.snapshotEvery(snapshotEvery, keepNSnapshots = 2))
          .withTagger(_ => tag)
          .receiveSignal { case (state, RecoveryCompleted) =>
            follow(LotRoster.survey(state.auction))
            openRaffle(state.auction)
            cancelRaffle(state.auction)
            confirmSlot(state.auction)
            releaseSlot(state.auction)
            armPrebidding(state.auction)
          }
      }
    }

  /**
   * Событие команды пишется одним `persist` с конвертом ADR-047; отказ и «без события» ничего не пишут. Ответ получает
   * аукцион после команды: у записанного события — уже с ним.
   */
  private def record(
      auction: Auction,
      decision: AuctionDecision,
      opId: OpId,
      initiator: Initiator,
      clock: Clock,
      newId: () => UUID
  )(reply: (Auction, AuctionAnswer) => Unit): Effect[StoredAuctionEvent, State] =
    decision match {
      case AuctionDecision.Repeated(original) =>
        Effect.none.thenRun(_ => reply(auction, AuctionAnswer.Written(original)))
      case AuctionDecision.Unchanged => Effect.none.thenRun(_ => reply(auction, AuctionAnswer.Unchanged))
      case AuctionDecision.Accepted(event) =>
        val stored = AuctionJournal.store(newId(), newId(), opId, clock.instant(), initiator)(event)
        Effect
          .persist(stored)
          .thenRun(written => reply(written.auction, AuctionAnswer.Written(firstOf(written.auction, opId))))
    }

  /** Команда с именованным отказом: отказ уходит ответом без записи, принятое решение — в [[record]]. */
  private def answered[R](
      auction: Auction,
      decision: Either[R, AuctionDecision],
      opId: OpId,
      initiator: Initiator,
      replyTo: ActorRef[Either[R, AuctionAnswer]],
      clock: Clock,
      newId: () => UUID
  ): Effect[StoredAuctionEvent, State] =
    decision match {
      case Left(rejected) => Effect.reply(replyTo)(Left(rejected))
      case Right(accepted) =>
        record(auction, accepted, opId, initiator, clock, newId)((_, answer) => replyTo ! Right(answer))
    }

  /** Ответ на повтор `StartNextLot`: лот исходной активации; `op_id` под другим событием — чужая команда. */
  private def activated(original: AuctionEnvelope): Either[StartNextLotRejected, LotId] =
    original.event match {
      case AuctionEvent.FinalLotActivated(lot) => Right(lot)
      case _ => Left(StartNextLotRejected.OpIdTaken)
    }

  private def firstOf(auction: Auction, opId: OpId): AuctionEnvelope =
    auction.seen.get(opId) match {
      case Some(envelope) => envelope
      case None => throw new IllegalStateException(s"auction applied its own event without op_id ${opId.value}")
    }
}
