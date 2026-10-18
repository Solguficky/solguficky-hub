package auction.entity

import auction.lot.*
import org.apache.pekko.actor.typed.ActorRef
import org.apache.pekko.actor.typed.Behavior
import org.apache.pekko.actor.typed.scaladsl.Behaviors
import org.apache.pekko.cluster.sharding.typed.scaladsl.EntityTypeKey
import org.apache.pekko.persistence.Persistence
import org.apache.pekko.persistence.typed.PersistenceId
import org.apache.pekko.persistence.typed.scaladsl.Effect
import org.apache.pekko.persistence.typed.scaladsl.EventSourcedBehavior
import org.apache.pekko.persistence.typed.scaladsl.RetentionCriteria

import java.time.Clock
import java.time.Instant
import java.util.UUID

/**
 * Лот как персистентный агрегат под Cluster Sharding (ADR-045).
 *
 * Решения здесь нет: команда уходит в чистое `Lot.decide`, принятое событие пишется в журнал, а состояние меняет только
 * `Lot.apply` — и при записи, и при replay.
 *
 * `onPersistFailure` не задан намеренно: отказ записи — например, конкурентный append в тот же persistence id —
 * останавливает entity, и следующая команда поднимает её replay'ем из того, что журнал действительно держит (ADR-045,
 * `apps/auction/AGENTS.md`). Ответа на такую команду нет, и отправитель повторяет её по `op_id`.
 */
object LotEntity {

  val TypeKey: EntityTypeKey[Command] = EntityTypeKey[Command]("lot")

  /** Snapshot через каждые сто событий; журнал при этом не усекается — он источник истины и окно дедупликации. */
  val DefaultSnapshotEvery: Int = 100

  /**
   * Состояние entity: лот и номер последнего применённого события.
   *
   * Номер — это `sequence_number` строки журнала, выведенный счётом: через `eventHandler` проходит каждое событие
   * persistence id ровно один раз и по порядку, начиная с номера snapshot, поэтому счёт совпадает с журналом по
   * построению. Взять номер у `EventSourcedBehavior.lastSequenceNumber` нельзя: команда, пришедшая во время recovery,
   * исполняется из stash, пока текущим поведением ещё числится replay, и тот отдаёт номер предыдущего события — а будит
   * пассивированную entity как раз команда. В журнал номер не пишется: в строке он уже есть, и второй копии, которая
   * могла бы разойтись с ней, нет.
   */
  final case class State(lot: Lot, sequence: Long)

  /**
   * Протокол entity. Ответ на принятую команду — первый конверт её транзакции, на повтор того же `op_id` — тот же
   * конверт из окна `seen`: повтор получает исходный ответ (П-06, Т-14), и вызывающий их не различает. Ставка и
   * прокси-лимит отвечают ещё и версией лота — `Recorded`.
   */
  sealed trait Command

  /**
   * Ответ ставки и прокси-лимита: первый конверт транзакции и номер, начиная с которого чтение лота показывает команду
   * целиком (PER-470). Проекция применяет события по одному, поэтому номер первого конверта не годится: на нём чтение
   * ещё не знает ответа прокси и продления. На принятую команду номер — последнее событие её транзакции; на повтор —
   * текущий номер лота: окно `seen` хранит только первый конверт, а транзакция пишется одним `AtomicWrite` и к повтору
   * уже в журнале целиком, поэтому номер не меньше её последнего события.
   */
  final case class Recorded(envelope: Envelope, lotVersion: Long)

  final case class Draft(command: DraftLot, initiator: Initiator, replyTo: ActorRef[Either[DraftLotRejected, Envelope]])
      extends Command

  /** Планирование условий торгов; `Schedule` уже занято доменным снимком условий. */
  final case class Plan(
      command: ScheduleLot,
      initiator: Initiator,
      replyTo: ActorRef[Either[ScheduleLotRejected, Envelope]]
  ) extends Command

  final case class Open(command: OpenLot, initiator: Initiator, replyTo: ActorRef[Either[OpenLotRejected, Envelope]])
      extends Command

  final case class Bid(command: PlaceBid, initiator: Initiator, replyTo: ActorRef[Either[PlaceBidRejected, Recorded]])
      extends Command

  final case class SetLimit(
      command: SetProxyLimit,
      initiator: Initiator,
      replyTo: ActorRef[Either[SetProxyLimitRejected, Recorded]]
  ) extends Command

  final case class WithdrawLimit(
      command: WithdrawProxyLimit,
      initiator: Initiator,
      replyTo: ActorRef[Either[WithdrawProxyLimitRejected, Envelope]]
  ) extends Command

  /** Закрытие лота; по дедлайну его шлёт аукцион с инициатором `Scheduler`. */
  final case class Close(command: CloseLot, initiator: Initiator, replyTo: ActorRef[Either[CloseLotRejected, Envelope]])
      extends Command

  /** Отметка для финала; шлёт аукцион по выбору организатора (PER-320). */
  final case class MarkFinal(
      command: MarkForFinal,
      initiator: Initiator,
      replyTo: ActorRef[Either[MarkForFinalRejected, Envelope]]
  ) extends Command

  /** Снятие отметки для финала; шлёт аукцион по выбору организатора (PER-320). */
  final case class UnmarkFinal(
      command: UnmarkForFinal,
      initiator: Initiator,
      replyTo: ActorRef[Either[UnmarkForFinalRejected, Envelope]]
  ) extends Command

  /** Возврат удержанного лота в торги живого финала; шлёт аукцион (PER-334). */
  final case class Resume(
      command: ResumeLot,
      initiator: Initiator,
      replyTo: ActorRef[Either[ResumeLotRejected, Envelope]]
  ) extends Command

  /** Ask ведущего (П-08); шлёт аукцион по команде ведущего, инициатор — `Operator`. */
  final case class Ask(
      command: AdvanceAsk,
      initiator: Initiator,
      replyTo: ActorRef[Either[AdvanceAskRejected, Envelope]]
  ) extends Command

  /** Снятие лота с торгов; шлёт аукцион, отменённый после старта торгов (ADR-047, дополнение 2026-10-12). */
  final case class Withdraw(
      command: WithdrawLot,
      initiator: Initiator,
      replyTo: ActorRef[Either[WithdrawLotRejected, Envelope]]
  ) extends Command

  final case class Get(replyTo: ActorRef[Lot]) extends Command

  /**
   * @param lotId
   *   идентификатор лота: persistence id — `lot|<lotId>`
   * @param clock
   *   серверное время решения, `occurred_at` конверта (ADR-047)
   * @param newId
   *   идентификаторы событий, транзакций и ставок
   */
  def apply(
      lotId: String,
      clock: Clock,
      newId: () => UUID,
      snapshotEvery: Int = DefaultSnapshotEvery
  ): Behavior[Command] =
    Behaviors.setup { context =>
      val persistenceId = PersistenceId(TypeKey.name, lotId)
      // Тег один на лот и вычисляется один раз: срез зависит только от persistence id (LotTags).
      val tag = Set(LotTags.of(Persistence(context.system.classicSystem).sliceForPersistenceId(persistenceId.id)))
      EventSourcedBehavior[Command, StoredLotEvent, State](
        persistenceId = persistenceId,
        emptyState = State(Lot.initial, 0),
        commandHandler = (state, command) => handle(state, command, clock, newId),
        eventHandler = (state, stored) => {
          val sequence = state.sequence + 1
          State(Lot.apply(state.lot, LotJournal.envelope(sequence, stored)), sequence)
        }
      ).snapshotAdapter(LotJournal.snapshotAdapter)
        .withRetention(RetentionCriteria.snapshotEvery(snapshotEvery, keepNSnapshots = 2))
        .withTagger(_ => tag)
    }

  /** Номер следующей строки — `state.sequence + 1`, та же арифметика, что в `eventHandler`. */
  private def handle(state: State, command: Command, clock: Clock, newId: () => UUID): Effect[StoredLotEvent, State] = {
    val lot = state.lot
    // Одно время на команду: оно и `now` решения, и `occurred_at` конверта, поэтому `LotSold.at` совпадает со строкой.
    val now = clock.instant()
    command match {
      case Draft(draft, initiator, replyTo) =>
        record(state, Lot.decide(lot, draft), draft.opId, initiator, replyTo, now, newId)
      case Plan(schedule, initiator, replyTo) =>
        record(state, Lot.decide(lot, schedule), schedule.opId, initiator, replyTo, now, newId)
      case Open(open, initiator, replyTo) =>
        record(state, Lot.decide(lot, open), open.opId, initiator, replyTo, now, newId)
      case Bid(bid, initiator, replyTo) =>
        val decision = Lot.decide(lot, bid, BidId(newId()), BidId(newId()), now)
        recordWith(state, decision, bid.opId, initiator, replyTo, now, newId)(Recorded(_, _))
      case SetLimit(limit, initiator, replyTo) =>
        val decision = Lot.decide(lot, limit, state.sequence + 1, BidId(newId()), now)
        recordWith(state, decision, limit.opId, initiator, replyTo, now, newId)(Recorded(_, _))
      case WithdrawLimit(withdrawal, initiator, replyTo) =>
        record(state, Lot.decide(lot, withdrawal), withdrawal.opId, initiator, replyTo, now, newId)
      case Close(close, initiator, replyTo) =>
        record(state, Lot.decide(lot, close, now), close.opId, initiator, replyTo, now, newId)
      case MarkFinal(mark, initiator, replyTo) =>
        record(state, Lot.decide(lot, mark, now), mark.opId, initiator, replyTo, now, newId)
      case UnmarkFinal(unmark, initiator, replyTo) =>
        record(state, Lot.decide(lot, unmark, now), unmark.opId, initiator, replyTo, now, newId)
      case Resume(resume, initiator, replyTo) =>
        record(state, Lot.decide(lot, resume, BidId(newId()), now), resume.opId, initiator, replyTo, now, newId)
      case Ask(ask, initiator, replyTo) =>
        record(state, Lot.decide(lot, ask, BidId(newId()), now), ask.opId, initiator, replyTo, now, newId)
      case Withdraw(withdrawal, initiator, replyTo) =>
        record(state, Lot.decide(lot, withdrawal), withdrawal.opId, initiator, replyTo, now, newId)
      case Get(replyTo) =>
        Effect.reply(replyTo)(lot)
    }
  }

  /**
   * Все события одной команды пишутся одним `persist` — одним `AtomicWrite`, который плагин JDBC кладёт в базу одной
   * транзакцией, — и несут один `op_id`, одну транзакцию, один аукцион и одно время решения (ADR-047): событие команды
   * первым, производные за ним. У каждого события свой `event_id`. Отказ событий не пишет.
   */
  private def record[R](
      state: State,
      decision: Either[R, Decision],
      opId: OpId,
      initiator: Initiator,
      replyTo: ActorRef[Either[R, Envelope]],
      now: Instant,
      newId: () => UUID
  ): Effect[StoredLotEvent, State] =
    recordWith(state, decision, opId, initiator, replyTo, now, newId)((envelope, _) => envelope)

  /**
   * То же с ответом, собранным из первого конверта и номера лота, с которого команда видна целиком: `written.sequence`
   * после записи, текущий `state.sequence` на повтор (`Recorded`).
   */
  private def recordWith[R, A](
      state: State,
      decision: Either[R, Decision],
      opId: OpId,
      initiator: Initiator,
      replyTo: ActorRef[Either[R, A]],
      now: Instant,
      newId: () => UUID
  )(reply: (Envelope, Long) => A): Effect[StoredLotEvent, State] =
    decision match {
      case Left(rejected) => Effect.reply(replyTo)(Left(rejected))
      case Right(Decision.Repeated(original)) => Effect.reply(replyTo)(Right(reply(original, state.sequence)))
      case Right(Decision.Accepted(event, derived)) =>
        val auction = Lot
          .auctionOf(state.lot, event)
          .getOrElse(
            throw new IllegalStateException(s"lot accepted ${event.getClass.getSimpleName} without an auction")
          )
        val transaction = Transaction(newId(), opId, auction, now, initiator)
        Effect
          .persist((event :: derived).map(LotJournal.store(newId(), transaction, _)))
          .thenReply(replyTo)(written => Right(reply(firstOf(written.lot, opId), written.sequence)))
    }

  /** Первый конверт записанной транзакции: `apply` кладёт его в окно `seen`, поэтому после записи он там есть. */
  private def firstOf(lot: Lot, opId: OpId): Envelope =
    lot.seen.get(opId) match {
      case Some(envelope) => envelope
      case None => throw new IllegalStateException(s"lot applied its own transaction without op_id ${opId.value}")
    }
}
