package auction.entity

import auction.lot.*
import org.apache.pekko.actor.typed.ActorRef
import org.apache.pekko.actor.typed.Behavior
import org.apache.pekko.cluster.sharding.typed.scaladsl.EntityTypeKey
import org.apache.pekko.persistence.typed.PersistenceId
import org.apache.pekko.persistence.typed.scaladsl.Effect
import org.apache.pekko.persistence.typed.scaladsl.EventSourcedBehavior
import org.apache.pekko.persistence.typed.scaladsl.RetentionCriteria

import java.time.Clock
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
   * конверт из окна `seen`: повтор получает исходный ответ (П-06, Т-14), и вызывающий их не различает.
   */
  sealed trait Command

  final case class Open(command: OpenLot, initiator: Initiator, replyTo: ActorRef[Either[OpenLotRejected, Envelope]])
      extends Command

  final case class Bid(command: PlaceBid, initiator: Initiator, replyTo: ActorRef[Either[PlaceBidRejected, Envelope]])
      extends Command

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
    EventSourcedBehavior[Command, StoredLotEvent, State](
      persistenceId = PersistenceId(TypeKey.name, lotId),
      emptyState = State(Lot.notOpened, 0),
      commandHandler = (state, command) => handle(state.lot, command, clock, newId),
      eventHandler = (state, stored) => {
        val sequence = state.sequence + 1
        State(Lot.apply(state.lot, LotJournal.envelope(sequence, stored)), sequence)
      }
    ).snapshotAdapter(LotJournal.snapshotAdapter)
      .withRetention(RetentionCriteria.snapshotEvery(snapshotEvery, keepNSnapshots = 2))

  private def handle(lot: Lot, command: Command, clock: Clock, newId: () => UUID): Effect[StoredLotEvent, State] =
    command match {
      case Open(open, initiator, replyTo) =>
        record(Lot.decide(lot, open), open.opId, initiator, replyTo, clock, newId)
      case Bid(bid, initiator, replyTo) =>
        record(Lot.decide(lot, bid, BidId(newId())), bid.opId, initiator, replyTo, clock, newId)
      case Get(replyTo) =>
        Effect.reply(replyTo)(lot)
    }

  /**
   * Все события одной команды пишутся одним `persist` — одним `AtomicWrite`, который плагин JDBC кладёт в базу одной
   * транзакцией, — и несут один `op_id`, одну транзакцию и одно время решения (ADR-047). Отказ событий не пишет.
   */
  private def record[R](
      decision: Either[R, Decision],
      opId: OpId,
      initiator: Initiator,
      replyTo: ActorRef[Either[R, Envelope]],
      clock: Clock,
      newId: () => UUID
  ): Effect[StoredLotEvent, State] =
    decision match {
      case Left(rejected) => Effect.reply(replyTo)(Left(rejected))
      case Right(Decision.Repeated(original)) => Effect.reply(replyTo)(Right(original))
      case Right(Decision.Accepted(event)) =>
        val transaction = Transaction(newId(), opId, clock.instant(), initiator)
        Effect
          .persist(List(LotJournal.store(newId(), transaction, event)))
          .thenReply(replyTo)(written => Right(firstOf(written.lot, opId)))
    }

  /** Первый конверт записанной транзакции: `apply` кладёт его в окно `seen`, поэтому после записи он там есть. */
  private def firstOf(lot: Lot, opId: OpId): Envelope =
    lot.seen.get(opId) match {
      case Some(envelope) => envelope
      case None => throw new IllegalStateException(s"lot applied its own transaction without op_id ${opId.value}")
    }
}
