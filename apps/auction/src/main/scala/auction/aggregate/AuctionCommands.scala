package auction.aggregate

import auction.catalog.LotId
import auction.entity.AuctionAnswer
import auction.entity.AuctionGateway
import auction.entity.Initiator
import auction.entity.LotGateway
import auction.lot.AuctionId
import auction.lot.DraftLot
import auction.lot.DraftLotRejected
import auction.lot.OpId
import auction.lot.ParticipantId

import scala.concurrent.ExecutionContext
import scala.concurrent.Future

/**
 * Ответ Meetups на `CheckMeetupAuthority` (ADR-051) в домене Auction. `Unavailable` — право сейчас не подтвердить: это
 * статус ответа, а не отказ, и события он не порождает. Сбой самой проверки — неудачное `Future`.
 */
enum Authority {
  case Granted
  case NotAdministrator
  case MeetupNotFound
  case Unavailable
}

/** Проверка права человека на сходку у её владельца — Meetups, с отношением «администратор сообщества». */
trait MeetupAuthority {
  def check(meetup: MeetupId, person: ParticipantId): Future[Authority]
}

/**
 * Почему команда аукциона не дошла до решения агрегата: так ответил Meetups, аукциона нет или лот, названный в
 * `AddLot`, уже родился в другом аукционе — такой `lot_id` край прислать не должен, и это дефект вызывающего, а не
 * отказ человеку.
 */
enum Denial {
  case NotAdministrator
  case MeetupNotFound
  case Unavailable
  case AuctionNotFound
  case LotOfAnotherAuction
}

/** Аукцион сходки после `DraftAuction`: `alreadyExisted` — аукцион был и ничего не записано. */
final case class Drafted(auctionId: AuctionId, alreadyExisted: Boolean)

/** Отказ `RemoveLot`: проверка до агрегата или решение агрегата. */
enum RemovalRefusal {
  case Denied(denial: Denial)
  case LotNotInAuction
}

/**
 * Команды администратора аукциону (ADR-047, дополнение 2026-10-03). Порядок фиксирован:
 *
 *   1. повтор того же `op_id` получает исходный ответ раньше проверки права; 2. у `AddLot` и `RemoveLot` аукцион без
 *      журнала — `AuctionNotFound` до обращения к Meetups; 3. право у Meetups, и только после `Granted` — команда
 *      агрегату. Entity сверяет `seen` ещё раз, поэтому повтор, принятый между шагами, тоже получает исходный ответ.
 *
 * `AddLot` рождает лот в аукционе: после права лоту уходит `DraftLot` с тем же `op_id`, и только родившийся в этом
 * аукционе лот попадает в реестр. Двух записей в одной транзакции нет, поэтому порядок такой, чтобы обрыв между ними не
 * оставлял в реестре лота без журнала: оборванное добавление дописывает повтор с тем же `op_id`. Лот, который уже
 * родился, отвечает `LotAlreadyExists`; родился он в этом же аукционе — это не отказ (повторное добавление после
 * `RemoveLot`), в другом — `LotOfAnotherAuction`, и реестр не меняется.
 */
final class AuctionCommands(auctions: AuctionGateway, lots: LotGateway, authority: MeetupAuthority)(using
    ExecutionContext
) {

  def draft(meetup: MeetupId, opId: OpId, person: ParticipantId): Future[Either[Denial, Drafted]] = {
    val auctionId = Auction.idOf(meetup)
    auctions.inspect(auctionId, opId).flatMap {
      case Inspection.Repeated(original) => Future.successful(Right(Drafted(auctionId, !drafting(original.event))))
      case Inspection.Absent | Inspection.Present(_) =>
        authorized(meetup, person, (denial: Denial) => denial) {
          auctions
            .draft(auctionId, DraftAuction(meetup, opId), Initiator.Operator(person))
            .map {
              case AuctionAnswer.Written(envelope) => Right(Drafted(auctionId, !drafting(envelope.event)))
              case AuctionAnswer.Unchanged => Right(Drafted(auctionId, alreadyExisted = true))
            }
        }
    }
  }

  def addLot(auctionId: AuctionId, lot: LotId, opId: OpId, person: ParticipantId): Future[Either[Denial, Unit]] =
    auctions.inspect(auctionId, opId).flatMap {
      case Inspection.Repeated(original) =>
        original.event match {
          case AuctionEvent.LotAdded(added) => born(auctionId, added, opId, person).map(_ => Right(()))
          case _ => Future.successful(Right(()))
        }
      case Inspection.Absent => Future.successful(Left(Denial.AuctionNotFound))
      case Inspection.Present(meetup) =>
        authorized(meetup, person, (denial: Denial) => denial) {
          born(auctionId, lot, opId, person).flatMap {
            case false => Future.successful(Left(Denial.LotOfAnotherAuction))
            case true =>
              auctions.addLot(auctionId, AddLot(lot, opId), Initiator.Operator(person)).map {
                case Left(AddLotRejected.AuctionNotFound) => Left(Denial.AuctionNotFound)
                case Right(_) => Right(())
              }
          }
        }
    }

  def removeLot(
      auctionId: AuctionId,
      lot: LotId,
      opId: OpId,
      person: ParticipantId
  ): Future[Either[RemovalRefusal, Unit]] =
    auctions.inspect(auctionId, opId).flatMap {
      case Inspection.Repeated(_) => Future.successful(Right(()))
      case Inspection.Absent => Future.successful(Left(RemovalRefusal.Denied(Denial.AuctionNotFound)))
      case Inspection.Present(meetup) =>
        authorized(meetup, person, RemovalRefusal.Denied(_)) {
          auctions.removeLot(auctionId, RemoveLot(lot, opId), Initiator.Operator(person)).map {
            case Left(RemoveLotRejected.AuctionNotFound) => Left(RemovalRefusal.Denied(Denial.AuctionNotFound))
            case Left(RemoveLotRejected.LotNotInAuction) => Left(RemovalRefusal.LotNotInAuction)
            case Right(_) => Right(())
          }
        }
    }

  /** Любой ответ Meetups, кроме `Granted`, — отказ, и до агрегата команда не доходит. */
  private def authorized[L, R](meetup: MeetupId, person: ParticipantId, deny: Denial => L)(
      run: => Future[Either[L, R]]
  ): Future[Either[L, R]] =
    authority.check(meetup, person).flatMap {
      case Authority.Granted => run
      case Authority.NotAdministrator => Future.successful(Left(deny(Denial.NotAdministrator)))
      case Authority.MeetupNotFound => Future.successful(Left(deny(Denial.MeetupNotFound)))
      case Authority.Unavailable => Future.successful(Left(deny(Denial.Unavailable)))
    }

  /** Лот родился в этом аукционе — сейчас или раньше. `false` — он уже есть, но в другом аукционе. */
  private def born(auctionId: AuctionId, lot: LotId, opId: OpId, person: ParticipantId): Future[Boolean] =
    lots.draftLot(lot.value, DraftLot(auctionId, opId), Initiator.Operator(person)).flatMap {
      case Right(_) => Future.successful(true)
      case Left(DraftLotRejected.LotAlreadyExists) => lots.auctionOf(lot.value).map(_.contains(auctionId))
    }

  private def drafting(event: AuctionEvent): Boolean =
    event match {
      case AuctionEvent.AuctionDrafted(_) => true
      case AuctionEvent.LotAdded(_) | AuctionEvent.LotRemoved(_) => false
    }
}
