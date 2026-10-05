package auction.aggregate

import auction.catalog.LotId
import auction.lot.AuctionId
import auction.lot.OpId

import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.UUID

/** Сходка, у которой родился аукцион. Её идентификатор принадлежит Meetups; Auction хранит его и не меняет (И-21). */
final case class MeetupId(value: UUID)

/**
 * Где аукцион (ADR-047). `Initial` — аукцион без журнала: под шардингом entity поднимается на любой `auction_id`, и из
 * `Initial` выводит только `AuctionDrafted`. `Draft` — после рождения. `Scheduled` несёт проверенную конфигурацию,
 * которую повторное планирование заменяет целиком. `Prebidding` — онлайн-торги: конфигурация и реестр заморожены, а
 * `startedBy` — `op_id` команды открытия, с которым аукцион шлёт лотам `OpenLot`. Перерыв и финал приносит PER-334.
 */
enum AuctionState {
  case Initial
  case Draft
  case Scheduled(config: AuctionConfig)
  case Prebidding(config: AuctionConfig, startedBy: OpId)
}

/** Команды аукциона. Каждая несёт `op_id`; инициатор едет в конверте, а не в команде. */
final case class DraftAuction(meetup: MeetupId, opId: OpId)

final case class AddLot(lot: LotId, opId: OpId)

final case class RemoveLot(lot: LotId, opId: OpId)

/** Планирование: конфигурация приходит непроверенной и повторяется до старта торгов, каждый раз целиком. */
final case class ScheduleAuction(config: AuctionConfigInput, opId: OpId)

/** Открытие онлайн-торгов. Лоты открывает не сама команда, а протокол подтверждения после неё ([[LotRoster]]). */
final case class StartPrebidding(opId: OpId)

/**
 * События аукциона: payload рождения — `meetup_id`, реестра — `lot_id`, планирования — конфигурация целиком, у старта
 * торгов payload нет (ADR-047).
 */
enum AuctionEvent {
  case AuctionDrafted(meetup: MeetupId)
  case LotAdded(lot: LotId)
  case LotRemoved(lot: LotId)
  case AuctionScheduled(config: AuctionConfig)
  case PrebiddingStarted
}

/** Строка журнала аукциона в той части конверта, которую читает ядро; `sequence` назначает тот, кто пишет журнал. */
final case class AuctionEnvelope(sequence: Long, opId: OpId, event: AuctionEvent)

/** Отказы `AddLot`: аукциона нет или реестр заморожен стартом торгов (И-20). */
enum AddLotRejected {
  case AuctionNotFound
  case LotsFrozen
}

/** Отказы `RemoveLot`: аукциона нет, реестр заморожен или лота нет в реестре. */
enum RemoveLotRejected {
  case AuctionNotFound
  case LotsFrozen
  case LotNotInAuction
}

/** Отказы `ScheduleAuction`: аукциона нет, конфигурация противоречива (Т-19, Т-44) или торги уже идут. */
enum ScheduleAuctionRejected {
  case AuctionNotFound
  case ConfigInvalid(reason: auction.aggregate.ConfigInvalid)
  case AuctionAlreadyStarted
}

/** Отказы `StartPrebidding`: аукциона нет либо он не в `Scheduled` — не запланирован или уже открыт. */
enum StartPrebiddingRejected {
  case AuctionNotFound
  case AuctionNotScheduled
}

/**
 * Исход принятой команды.
 *
 * `Unchanged` — команда принята, но событие не нужно: аукцион у сходки уже есть. Такой ответ в окно `seen` не попадает,
 * потому что ничего не записано, и повтор того же `op_id` приходит к тому же решению заново — `Draft` необратим.
 */
enum AuctionDecision {
  case Accepted(event: AuctionEvent)
  case Repeated(original: AuctionEnvelope)
  case Unchanged
}

/**
 * Что знает аукцион до проверки права (ADR-047, «Порядок»): повтор уже принятого `op_id`, аукциона нет или аукцион
 * сходки `meetup`. Первые два ответа отдаются без обращения к Meetups. `registryOpen` — открыт ли реестр (И-20): по
 * нему `AddLot` отказывает раньше, чем лот родится.
 */
enum Inspection {
  case Repeated(original: AuctionEnvelope)
  case Absent
  case Present(meetup: MeetupId, registryOpen: Boolean)
}

/**
 * Агрегат аукциона: состояние, сходка, реестр лотов и окно дедупликации, свёрнутые из журнала.
 *
 * `meetup` пуста ровно в `Initial` и после рождения не меняется. Реестр `lots` меняется только в `Draft` и `Scheduled`
 * (И-20). `seen` — то же окно, что у лота: `seen(op_id) ⟺ в журнале есть событие с этим op_id`, и пишет его только
 * [[Auction.apply]].
 */
final case class Auction(
    state: AuctionState,
    meetup: Option[MeetupId],
    lots: Set[LotId],
    seen: Map[OpId, AuctionEnvelope]
)

object Auction {

  val initial: Auction = Auction(AuctionState.Initial, None, Set.empty, Map.empty)

  /**
   * Пространство имён UUIDv5 аукциона сходки (integration.md, «Аукцион у сходки»). Не меняется никогда: другое
   * пространство дало бы той же сходке другой аукцион.
   */
  val MeetupNamespace: UUID = UUID.fromString("83a6d0b2-84ed-4444-a77b-dd0338dc84a4")

  /**
   * Аукцион сходки — UUIDv5 (RFC 9562) от канонической строки `meetup_id` в UTF-8. Две команды рождения одной сходки
   * поэтому приходят в одну entity, и вторая упирается в первую в журнале (ADR-047, И-21).
   */
  def idOf(meetup: MeetupId): AuctionId = {
    val digest = MessageDigest.getInstance("SHA-1")
    digest.update(bytes(MeetupNamespace))
    digest.update(meetup.value.toString.getBytes(StandardCharsets.UTF_8))
    val hash = digest.digest()
    hash(6) = ((hash(6) & 0x0f) | 0x50).toByte
    hash(8) = ((hash(8) & 0x3f) | 0x80).toByte
    AuctionId(new UUID(long(hash, 0), long(hash, 8)))
  }

  def inspect(auction: Auction, opId: OpId): Inspection =
    auction.seen.get(opId) match {
      case Some(original) => Inspection.Repeated(original)
      case None => auction.meetup.fold(Inspection.Absent)(Inspection.Present(_, registryOpen(auction.state)))
    }

  /** Реестр открыт в `Draft` и `Scheduled` и заморожен стартом торгов (И-20). */
  private def registryOpen(state: AuctionState): Boolean =
    state match {
      case AuctionState.Draft | AuctionState.Scheduled(_) => true
      case AuctionState.Initial | AuctionState.Prebidding(_, _) => false
    }

  /** Рождение у сходки. Аукцион, который уже есть, не отказывает и события не пишет: включение идемпотентно. */
  def decide(auction: Auction, command: DraftAuction): AuctionDecision =
    auction.seen.get(command.opId) match {
      case Some(original) => AuctionDecision.Repeated(original)
      case None =>
        auction.state match {
          case AuctionState.Initial => AuctionDecision.Accepted(AuctionEvent.AuctionDrafted(command.meetup))
          case AuctionState.Draft | AuctionState.Scheduled(_) | AuctionState.Prebidding(_, _) =>
            AuctionDecision.Unchanged
        }
    }

  /**
   * Лот в реестр (И-20: только до старта торгов). Лот, который уже в реестре, тоже пишет `LotAdded`: реестр —
   * множество, а `op_id` попадает в окно `seen`. Ответ без события повтором не защищён, и запоздавший повтор после
   * `RemoveLot` вернул бы снятый лот; у включения аукциона такой опасности нет, потому что `Draft` необратим.
   */
  def decide(auction: Auction, command: AddLot): Either[AddLotRejected, AuctionDecision] =
    auction.seen.get(command.opId) match {
      case Some(original) => Right(AuctionDecision.Repeated(original))
      case None =>
        auction.state match {
          case AuctionState.Initial => Left(AddLotRejected.AuctionNotFound)
          case AuctionState.Draft | AuctionState.Scheduled(_) =>
            Right(AuctionDecision.Accepted(AuctionEvent.LotAdded(command.lot)))
          case AuctionState.Prebidding(_, _) => Left(AddLotRejected.LotsFrozen)
        }
    }

  /** Лот из реестра. Лота нет в реестре — `LotNotInAuction`. */
  def decide(auction: Auction, command: RemoveLot): Either[RemoveLotRejected, AuctionDecision] =
    auction.seen.get(command.opId) match {
      case Some(original) => Right(AuctionDecision.Repeated(original))
      case None =>
        auction.state match {
          case AuctionState.Initial => Left(RemoveLotRejected.AuctionNotFound)
          case AuctionState.Draft | AuctionState.Scheduled(_) =>
            if (auction.lots.contains(command.lot))
              Right(AuctionDecision.Accepted(AuctionEvent.LotRemoved(command.lot)))
            else Left(RemoveLotRejected.LotNotInAuction)
          case AuctionState.Prebidding(_, _) => Left(RemoveLotRejected.LotsFrozen)
        }
    }

  /**
   * Планирование. Состояние проверяется раньше конфигурации: после старта торгов ответ — `AuctionAlreadyStarted`, какой
   * бы ни была конфигурация. В `Scheduled` команда пишет событие всегда и заменяет конфигурацию целиком (RFC-011).
   */
  def decide(auction: Auction, command: ScheduleAuction): Either[ScheduleAuctionRejected, AuctionDecision] =
    auction.seen.get(command.opId) match {
      case Some(original) => Right(AuctionDecision.Repeated(original))
      case None =>
        auction.state match {
          case AuctionState.Initial => Left(ScheduleAuctionRejected.AuctionNotFound)
          case AuctionState.Prebidding(_, _) => Left(ScheduleAuctionRejected.AuctionAlreadyStarted)
          case AuctionState.Draft | AuctionState.Scheduled(_) =>
            AuctionConfig
              .parse(command.config)
              .left
              .map(ScheduleAuctionRejected.ConfigInvalid(_))
              .map(config => AuctionDecision.Accepted(AuctionEvent.AuctionScheduled(config)))
        }
    }

  /**
   * Открытие онлайн-торгов — только из `Scheduled`. Повтор того же `op_id` получает исходный ответ и второй раз аукцион
   * не открывает; новый `op_id` на уже открытом — `AuctionNotScheduled`.
   */
  def decide(auction: Auction, command: StartPrebidding): Either[StartPrebiddingRejected, AuctionDecision] =
    auction.seen.get(command.opId) match {
      case Some(original) => Right(AuctionDecision.Repeated(original))
      case None =>
        auction.state match {
          case AuctionState.Initial => Left(StartPrebiddingRejected.AuctionNotFound)
          case AuctionState.Scheduled(_) => Right(AuctionDecision.Accepted(AuctionEvent.PrebiddingStarted))
          case AuctionState.Draft | AuctionState.Prebidding(_, _) => Left(StartPrebiddingRejected.AuctionNotScheduled)
        }
    }

  /**
   * Применение события: меняет состояние и не отказывает. Событие, которое к состоянию не относится, состояние не
   * трогает — такой пары `decide` не порождает.
   */
  def apply(auction: Auction, envelope: AuctionEnvelope): Auction = {
    val next = (auction.state, envelope.event) match {
      case (AuctionState.Initial, AuctionEvent.AuctionDrafted(meetup)) =>
        auction.copy(state = AuctionState.Draft, meetup = Some(meetup))
      case (AuctionState.Draft | AuctionState.Scheduled(_), AuctionEvent.LotAdded(lot)) =>
        auction.copy(lots = auction.lots + lot)
      case (AuctionState.Draft | AuctionState.Scheduled(_), AuctionEvent.LotRemoved(lot)) =>
        auction.copy(lots = auction.lots - lot)
      case (AuctionState.Draft | AuctionState.Scheduled(_), AuctionEvent.AuctionScheduled(config)) =>
        auction.copy(state = AuctionState.Scheduled(config))
      case (AuctionState.Scheduled(config), AuctionEvent.PrebiddingStarted) =>
        auction.copy(state = AuctionState.Prebidding(config, envelope.opId))
      case _ => auction
    }
    val seen = if (auction.seen.contains(envelope.opId)) auction.seen else auction.seen.updated(envelope.opId, envelope)
    next.copy(seen = seen)
  }

  /** Свёртка журнала в порядке `sequence`. */
  def replay(from: Auction, journal: Seq[AuctionEnvelope]): Auction =
    journal.sortBy(_.sequence).foldLeft(from)(apply)

  private def bytes(uuid: UUID): Array[Byte] = {
    val buffer = java.nio.ByteBuffer.allocate(16)
    buffer.putLong(uuid.getMostSignificantBits)
    buffer.putLong(uuid.getLeastSignificantBits)
    buffer.array()
  }

  private def long(bytes: Array[Byte], from: Int): Long =
    (from until from + 8).foldLeft(0L)((acc, i) => (acc << 8) | (bytes(i) & 0xffL))
}
