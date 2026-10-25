package auction.raffle

import auction.lot.AuctionId
import auction.lot.OpId
import auction.lot.ParticipantId
import net.logstash.logback.argument.StructuredArguments
import org.apache.pekko.Done
import org.apache.pekko.actor.typed.ActorRef
import org.apache.pekko.actor.typed.Behavior
import org.apache.pekko.actor.typed.scaladsl.Behaviors
import org.apache.pekko.cluster.sharding.typed.scaladsl.ClusterSharding
import org.apache.pekko.cluster.sharding.typed.scaladsl.EntityTypeKey
import org.apache.pekko.pattern.after
import org.apache.pekko.persistence.Persistence
import org.apache.pekko.persistence.typed.PersistenceId
import org.apache.pekko.persistence.typed.RecoveryCompleted
import org.apache.pekko.persistence.typed.scaladsl.Effect
import org.apache.pekko.persistence.typed.scaladsl.EffectBuilder
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
 * Розыгрыш аукциона как персистентный агрегат под Cluster Sharding — отдельная entity со своим журналом (решение
 * владельца в PER-499): persistence id `raffle|<auction_id>`. Решение в [[Raffle.decide]], состояние меняет только
 * [[Raffle.apply]], `onPersistFailure` не задан (ADR-045).
 *
 * Торгов entity не знает по построению: ни порта лотов, ни состояния аукциона она не получает (ADR-066, п. 1).
 * Открывает её аукцион командой `Open` после записи `PrebiddingStarted` и повторяет её, пока не получит ответ. Так же
 * аукцион, отменённый после старта торгов, отменяет её командой `Cancel` (ADR-066, дополнение 2026-10-12).
 *
 * Три шага после открытия идут без человека и переживают рестарт: entity помнится шардингом, а таймеры взводятся заново
 * на `RecoveryCompleted` по тому, что лежит в журнале.
 *   - В момент закрытия — проверка права кандидатов у Identity в окне `screeningWindow`, затем фиксация пула. Окно
 *     кончается до времени раунда маяка; неотвеченный кандидат остаётся в пуле.
 *   - После фиксации — снимок «номер — имя» в строку `raffle_ticket`, с повтором до успеха.
 *   - С времени раунда — опрос маяка до получения значения, затем жеребьёвка и назначение срока стирания имён.
 *
 * Ручной итог (ADR-066, дополнение 2026-10-24) включает настройка сервиса `byHand`, а не конфигурация аукциона: entity
 * читает её при фиксации пула и пишет в `PoolFixed`, поэтому рестарт и смена настройки решения не переигрывают. Пул с
 * ручным итогом маяк не опрашивает и ждёт команды `Assign` от администратора, право которого проверила граница.
 */
object RaffleEntity {

  val TypeKey: EntityTypeKey[Command] = EntityTypeKey[Command]("raffle")

  val DefaultSnapshotEvery: Int = 100

  final case class State(raffle: Raffle, sequence: Long)

  /**
   * @param screeningWindow
   *   сколько после закрытия длится проверка права; меньше запаса до раунда маяка (`Quicknet.Margin`)
   * @param retryEvery
   *   пауза перед повтором вопроса к Identity, к маяку и записи снимка имён
   * @param nameRetention
   *   сколько после жеребьёвки хранятся имена снимка (ADR-066, п. 12)
   * @param byHand
   *   итог подводит администратор, а не маяк: настройка `auction.raffle.draw` (PER-727)
   */
  final case class Settings(
      screeningWindow: FiniteDuration,
      retryEvery: FiniteDuration,
      nameRetention: Duration,
      byHand: Boolean = false
  )

  sealed trait Command

  /** Открытие регистрации по команде аукциона. Ответ — после записи или сразу, если розыгрыш уже открыт. */
  final case class Open(command: OpenRaffle, replyTo: ActorRef[Done]) extends Command

  final case class Enter(command: Register, replyTo: ActorRef[Either[RegistrationRejected, Raffle]]) extends Command

  final case class Leave(command: CancelRegistration, replyTo: ActorRef[Either[RegistrationRejected, Raffle]])
      extends Command

  /** Отмена по команде отменённого аукциона. Ответ — после записи или сразу, если отменять нечего. */
  final case class Cancel(command: CancelRaffle, replyTo: ActorRef[Done]) extends Command

  /** Ручной итог администратора. Ответ — после записи или сразу на повтор и отказ. */
  final case class Assign(command: AssignWinner, replyTo: ActorRef[Either[AssignRejected, Raffle]]) extends Command

  /** Смена приза администратором (PER-737). Ответ — после записи или сразу на повтор и отказ. */
  final case class SetPrize(command: ChangePrize, replyTo: ActorRef[Either[ChangePrizeRejected, Raffle]])
      extends Command

  final case class Get(replyTo: ActorRef[Raffle]) extends Command

  private[raffle] case object CloseDue extends Command

  private[raffle] final case class Screened(answers: Try[Map[ParticipantId, Option[Boolean]]]) extends Command

  private[raffle] case object RecordNames extends Command

  private[raffle] final case class NamesRecorded(result: Try[Unit]) extends Command

  private[raffle] case object PollBeacon extends Command

  private[raffle] final case class BeaconRead(result: Try[Option[Randomness]]) extends Command

  private[raffle] case object ExpireNames extends Command

  private[raffle] final case class NamesExpiring(result: Try[Unit]) extends Command

  private case object CloseKey

  private case object NamesKey

  private case object BeaconKey

  private case object ExpiryKey

  def apply(
      auctionId: String,
      clock: Clock,
      newId: () => UUID,
      newSeed: () => Seed,
      access: RaffleAccess,
      beacon: Beacon,
      tickets: RaffleTickets,
      settings: Settings,
      snapshotEvery: Int = DefaultSnapshotEvery,
      shard: Option[ActorRef[ClusterSharding.ShardCommand]] = None
  ): Behavior[Command] =
    Behaviors.withTimers[Command] { timers =>
      Behaviors.setup { context =>
        import context.executionContext
        val auction = AuctionId(UUID.fromString(auctionId))
        val scheduler = context.system.classicSystem.scheduler

        // Ход шагов без человека несохраняем, как знание аукциона о лотах: рестарт начинает с пустого и повторяет шаги
        // по журналу. Каждый шаг идемпотентен — фиксацию решает ядро, снимок не перезаписывается, срок не сдвигается.
        var screening = false
        var namesRecorded = false
        // Запись снимка имён в полёте: отмена ждёт её конца, иначе срок хранения лёг бы раньше самих имён.
        var recording = false
        var expiring = false

        def arm(key: Any, message: Command, at: Instant): Unit =
          timers.startSingleTimer(
            key,
            message,
            Duration.between(clock.instant(), at).toScala.max(Duration.ZERO.toScala)
          )

        def warn(message: String, failure: Option[Throwable]): Unit = {
          val fields = Seq(
            StructuredArguments.keyValue("auction_id", auctionId),
            StructuredArguments.keyValue("error_category", "dependency_unavailable")
          ) ++ failure.map(cause => StructuredArguments.keyValue("error", cause.getClass.getName))
          context.log.warn(message, fields*)
        }

        /**
         * Розыгрыш, которому больше нечего делать без человека, просит шард его забыть: иначе шардинг помнил бы каждый
         * прошедший розыгрыш, и рестарт процесса поднимал бы их все. Чтение поднимет такой розыгрыш снова из журнала.
         */
        def forget(): Unit = shard.foreach(_ ! ClusterSharding.Passivate(context.self))

        /** Что делать дальше по состоянию; зовётся после recovery и после каждой записи. */
        def follow(raffle: Raffle): Unit =
          raffle.state match {
            case RaffleState.Initial => ()
            case RaffleState.NotHeld(_) => forget()
            case RaffleState.Fixed(_, tickets) if tickets.isEmpty => forget()
            case RaffleState.Open(terms, _) => arm(CloseKey, CloseDue, terms.closesAt)
            case RaffleState.Fixed(terms, tickets) =>
              if (!namesRecorded) context.self ! RecordNames
              if (tickets.nonEmpty) arm(BeaconKey, PollBeacon, Quicknet.roundAt(terms.round))
            // Ручной итог ждёт администратора: маяка нет, и без человека остаётся только снимок имён, по которому
            // пульт показывает кандидатов.
            case RaffleState.AwaitingWinner(_, _) =>
              if (!namesRecorded) context.self ! RecordNames
            case RaffleState.Drawn(_, _, _, _) | RaffleState.Assigned(_, _, _, _) =>
              if (!namesRecorded) context.self ! RecordNames
              else if (!expiring) context.self ! ExpireNames
            // Отменённому розыгрышу ждать нечего: таймеры закрытия и маяка гаснут, а снимок имён, если пул успели
            // зафиксировать, получает срок хранения от момента отмены — иначе имена лежали бы бессрочно. Запись
            // снимка, начатая до отмены, сначала заканчивается: её ответ зовёт `follow` снова.
            case RaffleState.Cancelled(_, _, _) =>
              timers.cancel(CloseKey)
              timers.cancel(BeaconKey)
              timers.cancel(NamesKey)
              if (!recording && !expiring) context.self ! ExpireNames
          }

        def persist(opId: OpId, event: RaffleEvent): EffectBuilder[StoredRaffleEvent, State] =
          Effect.persist(RaffleJournal.store(newId(), opId, clock.instant())(event))

        def systemOp(): OpId = OpId(newId())

        /** Отвечает и, если розыгрыша нет, просит шард забыть entity: иначе шардинг помнил бы любой спрошенный id. */
        def forgetIfAbsent(after: State): Unit =
          if (after.raffle.state == RaffleState.Initial) shard.foreach(_ ! ClusterSharding.Passivate(context.self))

        def registration(
            state: State,
            decision: Either[RegistrationRejected, RaffleDecision],
            opId: OpId,
            replyTo: ActorRef[Either[RegistrationRejected, Raffle]]
        ): Effect[StoredRaffleEvent, State] =
          decision match {
            case Left(rejected) =>
              Effect.none.thenRun { after =>
                replyTo ! Left(rejected)
                forgetIfAbsent(after)
              }
            case Right(RaffleDecision.Accepted(event)) =>
              persist(opId, event).thenRun(after => replyTo ! Right(after.raffle))
            case Right(RaffleDecision.Repeated(_) | RaffleDecision.Unchanged) =>
              Effect.reply(replyTo)(Right(state.raffle))
          }

        def onCommand(state: State, command: Command): Effect[StoredRaffleEvent, State] =
          command match {
            case Open(open, replyTo) =>
              Raffle.decide(state.raffle, open, clock.instant(), newSeed()) match {
                case RaffleDecision.Accepted(event) =>
                  persist(systemOp(), event).thenRun { after =>
                    replyTo ! Done
                    follow(after.raffle)
                  }
                case RaffleDecision.Repeated(_) | RaffleDecision.Unchanged => Effect.reply(replyTo)(Done)
              }
            case Enter(register, replyTo) =>
              registration(state, Raffle.decide(state.raffle, register, clock.instant()), register.opId, replyTo)
            case Leave(cancel, replyTo) =>
              registration(state, Raffle.decide(state.raffle, cancel, clock.instant()), cancel.opId, replyTo)
            case Cancel(cancel, replyTo) =>
              Raffle.decide(state.raffle, cancel, clock.instant()) match {
                case RaffleDecision.Accepted(event) =>
                  persist(cancel.opId, event).thenRun { after =>
                    replyTo ! Done
                    follow(after.raffle)
                  }
                case RaffleDecision.Repeated(_) | RaffleDecision.Unchanged =>
                  Effect.none.thenRun { after =>
                    replyTo ! Done
                    forgetIfAbsent(after)
                  }
              }
            case Assign(assign, replyTo) =>
              Raffle.decide(state.raffle, assign, clock.instant()) match {
                case Left(rejected) =>
                  Effect.none.thenRun { after =>
                    replyTo ! Left(rejected)
                    forgetIfAbsent(after)
                  }
                case Right(RaffleDecision.Accepted(event)) =>
                  persist(assign.opId, event).thenRun { after =>
                    context.log.info(
                      "raffle winner assigned",
                      StructuredArguments.keyValue("auction_id", auctionId),
                      StructuredArguments.keyValue("winning_ticket", assign.ticket)
                    )
                    replyTo ! Right(after.raffle)
                    follow(after.raffle)
                  }
                case Right(RaffleDecision.Repeated(_) | RaffleDecision.Unchanged) =>
                  Effect.reply(replyTo)(Right(state.raffle))
              }
            // Приз ход розыгрыша не меняет: таймеры и шаги без человека остаются, как были, и `follow` не нужен.
            case SetPrize(change, replyTo) =>
              Raffle.decide(state.raffle, change) match {
                case Left(rejected) =>
                  Effect.none.thenRun { after =>
                    replyTo ! Left(rejected)
                    forgetIfAbsent(after)
                  }
                case Right(RaffleDecision.Accepted(event)) =>
                  persist(change.opId, event).thenRun { after =>
                    context.log.info("raffle prize changed", StructuredArguments.keyValue("auction_id", auctionId))
                    replyTo ! Right(after.raffle)
                  }
                case Right(RaffleDecision.Repeated(_) | RaffleDecision.Unchanged) =>
                  Effect.reply(replyTo)(Right(state.raffle))
              }
            case Get(replyTo) =>
              Effect.none.thenRun { after =>
                replyTo ! after.raffle
                forgetIfAbsent(after)
              }
            case CloseDue =>
              state.raffle.state match {
                case RaffleState.Open(terms, _) if clock.instant().isBefore(terms.closesAt) =>
                  Effect.none.thenRun(_ => arm(CloseKey, CloseDue, terms.closesAt))
                case RaffleState.Open(terms, entries) if !screening =>
                  screening = true
                  val until = terms.closesAt.plusNanos(settings.screeningWindow.toNanos)
                  val screened = PoolScreening.screen(
                    entries,
                    access,
                    until,
                    clock,
                    settings.retryEvery,
                    pause => after(pause, scheduler)(Future.unit)
                  )
                  Effect.none.thenRun(_ => context.pipeToSelf(screened)(Screened(_)))
                case _ => Effect.none
              }
            case Screened(result) =>
              screening = false
              // Сбоя опроса быть не должно: каждый вопрос сам превращает отказ в «нет ответа». Если он всё же случился,
              // правило то же — неотвеченный остаётся в пуле.
              // Ответы, пришедшие с времени раунда маяка, пул не меняют: процесс мог лежать в момент закрытия.
              // Ручному итогу маяк не нужен, и опоздавший ответ исхода не выбирает.
              val answers = state.raffle.state match {
                case RaffleState.Open(terms, _) if !settings.byHand && Raffle.answeredTooLate(terms, clock.instant()) =>
                  Map.empty
                case _ => result.getOrElse(Map.empty)
              }
              val fix = FixPool(Raffle.excluded(answers), settings.byHand)
              Raffle.decide(state.raffle, fix, clock.instant()) match {
                case Left(_) => Effect.none
                case Right(event) =>
                  persist(systemOp(), event).thenRun { after =>
                    after.raffle.state match {
                      case RaffleState.Fixed(_, fixed) =>
                        context.log.info(
                          "raffle pool fixed",
                          StructuredArguments.keyValue("auction_id", auctionId),
                          StructuredArguments.keyValue("tickets", fixed.size),
                          StructuredArguments.keyValue("draw", "automatic"),
                          StructuredArguments.keyValue("excluded", Raffle.excluded(answers).size),
                          StructuredArguments.keyValue("unverified", answers.count(_._2.isEmpty))
                        )
                      case RaffleState.AwaitingWinner(_, fixed) =>
                        context.log.info(
                          "raffle pool fixed",
                          StructuredArguments.keyValue("auction_id", auctionId),
                          StructuredArguments.keyValue("tickets", fixed.size),
                          StructuredArguments.keyValue("draw", "manual"),
                          StructuredArguments.keyValue("excluded", Raffle.excluded(answers).size),
                          StructuredArguments.keyValue("unverified", answers.count(_._2.isEmpty))
                        )
                      case _ => ()
                    }
                    follow(after.raffle)
                  }
              }
            case RecordNames =>
              state.raffle.state match {
                case RaffleState.Fixed(_, fixed) if fixed.isEmpty =>
                  namesRecorded = true
                  Effect.none
                case RaffleState.Fixed(_, fixed) =>
                  recording = true
                  Effect.none.thenRun(_ => context.pipeToSelf(tickets.record(auction, fixed))(NamesRecorded(_)))
                case RaffleState.AwaitingWinner(_, fixed) =>
                  recording = true
                  Effect.none.thenRun(_ => context.pipeToSelf(tickets.record(auction, fixed))(NamesRecorded(_)))
                case RaffleState.Drawn(_, fixed, _, _) =>
                  recording = true
                  Effect.none.thenRun(_ => context.pipeToSelf(tickets.record(auction, fixed))(NamesRecorded(_)))
                case RaffleState.Assigned(_, fixed, _, _) =>
                  recording = true
                  Effect.none.thenRun(_ => context.pipeToSelf(tickets.record(auction, fixed))(NamesRecorded(_)))
                case _ => Effect.none
              }
            case NamesRecorded(Success(())) =>
              recording = false
              namesRecorded = true
              Effect.none.thenRun(after => follow(after.raffle))
            case NamesRecorded(Failure(failure)) =>
              recording = false
              Effect.none.thenRun { after =>
                warn("raffle ticket names were not recorded", Some(failure))
                after.raffle.state match {
                  // Отменённому розыгрышу снимок не нужен: срок хранения ляжет на то, что успело записаться.
                  case RaffleState.Cancelled(_, _, _) => follow(after.raffle)
                  case _ => timers.startSingleTimer(NamesKey, RecordNames, settings.retryEvery)
                }
              }
            case PollBeacon =>
              state.raffle.state match {
                case RaffleState.Fixed(terms, fixed) if fixed.nonEmpty =>
                  Effect.none.thenRun(_ => context.pipeToSelf(beacon.randomness(terms.round))(BeaconRead(_)))
                case _ => Effect.none
              }
            case BeaconRead(Success(Some(randomness))) =>
              Raffle.decide(state.raffle, DrawWinner(randomness, clock.instant())) match {
                case Left(_) => Effect.none
                case Right(event) =>
                  persist(systemOp(), event).thenRun { after =>
                    after.raffle.state match {
                      case RaffleState.Drawn(terms, fixed, value, _) =>
                        context.log.info(
                          "raffle drawn",
                          StructuredArguments.keyValue("auction_id", auctionId),
                          StructuredArguments.keyValue("beacon_round", terms.round),
                          StructuredArguments.keyValue("tickets", fixed.size),
                          StructuredArguments.keyValue("winning_ticket", Draw.winner(terms.seed, fixed.size, value))
                        )
                      case _ => ()
                    }
                    follow(after.raffle)
                  }
              }
            // Значения пока нет или зеркала не договорились — штатное ожидание, без записи на каждом тике. Запись — только
            // на сбое самого опроса.
            case BeaconRead(result) =>
              Effect.none.thenRun { _ =>
                result.failed.foreach(failure => warn("raffle beacon poll failed", Some(failure)))
                timers.startSingleTimer(BeaconKey, PollBeacon, settings.retryEvery)
              }
            case ExpireNames =>
              state.raffle.state match {
                case RaffleState.Drawn(_, _, _, at) if !expiring =>
                  expiring = true
                  val expiry = tickets.expireAt(auction, at.plus(settings.nameRetention))
                  Effect.none.thenRun(_ => context.pipeToSelf(expiry)(NamesExpiring(_)))
                case RaffleState.Assigned(_, _, _, at) if !expiring =>
                  expiring = true
                  val expiry = tickets.expireAt(auction, at.plus(settings.nameRetention))
                  Effect.none.thenRun(_ => context.pipeToSelf(expiry)(NamesExpiring(_)))
                case RaffleState.Cancelled(_, _, at) if !expiring =>
                  expiring = true
                  val expiry = tickets.expireAt(auction, at.plus(settings.nameRetention))
                  Effect.none.thenRun(_ => context.pipeToSelf(expiry)(NamesExpiring(_)))
                case _ => Effect.none
              }
            case NamesExpiring(Success(())) => Effect.none.thenRun(_ => forget())
            case NamesExpiring(Failure(failure)) =>
              expiring = false
              Effect.none.thenRun { _ =>
                warn("raffle name erasure was not scheduled", Some(failure))
                timers.startSingleTimer(ExpiryKey, ExpireNames, settings.retryEvery)
              }
          }

        val persistenceId = PersistenceId(TypeKey.name, auctionId)
        // Тег один на розыгрыш: срез зависит только от persistence id (RaffleTags).
        val tag = Set(RaffleTags.of(Persistence(context.system.classicSystem).sliceForPersistenceId(persistenceId.id)))
        EventSourcedBehavior[Command, StoredRaffleEvent, State](
          persistenceId = persistenceId,
          emptyState = State(Raffle.initial, 0),
          commandHandler = onCommand,
          eventHandler = (state, stored) => {
            val sequence = state.sequence + 1
            State(Raffle.apply(state.raffle, RaffleJournal.envelope(sequence, stored)), sequence)
          }
        ).snapshotAdapter(RaffleJournal.snapshotAdapter)
          .withRetention(RetentionCriteria.snapshotEvery(snapshotEvery, keepNSnapshots = 2))
          .withTagger(_ => tag)
          .receiveSignal { case (state, RecoveryCompleted) => follow(state.raffle) }
      }
    }
}
