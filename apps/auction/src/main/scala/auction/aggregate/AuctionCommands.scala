package auction.aggregate

import auction.catalog.LotId
import auction.entity.AuctionAnswer
import auction.entity.AuctionGateway
import auction.entity.Initiator
import auction.entity.LotEntity
import auction.entity.LotGateway
import auction.entity.OpeningRejected
import auction.lot.AdvanceAskRejected
import auction.lot.AuctionId
import auction.lot.DraftLot
import auction.lot.DraftLotRejected
import auction.lot.LotEvent
import auction.lot.MarkForFinalRejected
import auction.lot.Money
import auction.lot.OpId
import auction.lot.ParticipantId
import auction.lot.RemoveParticipantRejected
import auction.lot.ScheduleLotRejected
import auction.lot.StepPolicyInput
import auction.lot.UnmarkForFinalRejected

import scala.concurrent.ExecutionContext
import scala.concurrent.Future

import java.time.Instant

/**
 * Ответ Meetups на `CheckMeetupAuthority` (ADR-051) в домене Auction. `Unavailable` — право сейчас не подтвердить: это
 * статус ответа, а не отказ, и события он не порождает. Сбой самой проверки — неудачное `Future`. `Granted` несёт
 * состояние сходки, если Meetups его прислал: решают по нему ворота ([[MeetupGate]]), а не клиент, потому что чтению
 * пульта и ставке зала оно не нужно.
 */
enum Authority {
  case Granted(standing: Option[MeetupStanding])
  case NotAdministrator
  case MeetupNotFound
  case Unavailable
}

/**
 * Сквозные значения цепочки, которые пришли на границу заголовками `x-request-id` и `x-use-case` и уходят дальше с
 * вызовом Meetups тем же механизмом (logging.md): сервис их не рождает и не выводит.
 */
final case class Correlation(requestId: Option[String], useCase: Option[String])

object Correlation {
  val none: Correlation = Correlation(None, None)
}

/** Проверка права человека на сходку у её владельца — Meetups, с отношением «ведущий аукциона» (ADR-070). */
trait MeetupAuthority {
  def check(meetup: MeetupId, person: ParticipantId, correlation: Correlation): Future[Authority]
}

/**
 * Почему команда аукциона не дошла до записи: так ответил Meetups, сходка отменена или скрыта ([[MeetupGate]]),
 * аукциона нет, реестр заморожен стартом торгов или лот, названный в `AddLot`, уже родился в другом аукционе — такой
 * `lot_id` край прислать не должен, и это дефект вызывающего, а не отказ человеку.
 */
enum Denial {
  case NotAdministrator
  case MeetupNotFound
  case MeetupCancelled
  case MeetupHidden
  case Unavailable
  case AuctionNotFound
  case LotsFrozen
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
 * Отказ определения и удаления сета (ADR-073): проверка до агрегата или решение агрегата. Замороженные сеты —
 * `Denied(LotsFrozen)`, как у реестра.
 */
enum LotSetRefusal {
  case Denied(denial: Denial)
  case NameEmpty
  case LotNotInAuction(lot: LotId)
  case LotInAnotherSet(lot: LotId, set: LotSetId)
  case LotSetNotFound
}

/** Отказ `ScheduleAuction`: проверка до агрегата или решение агрегата. */
enum SchedulingRefusal {
  case Denied(denial: Denial)
  case ConfigInvalid(reason: auction.aggregate.ConfigInvalid)
  case AuctionAlreadyStarted
}

/** Отказ `DiscardAuction`: проверка до агрегата или решение агрегата. */
enum DiscardRefusal {
  case Denied(denial: Denial)
  case AuctionAlreadyStarted
}

/**
 * Отказ публикации и снятия: проверка до агрегата или решение агрегата. `OpIdTaken` — под этим `op_id` записана другая
 * команда аукциона: у пары взаимно обратных команд тихое «принято» на чужой повтор оставило бы видимость не той.
 */
enum VisibilityRefusal {
  case Denied(denial: Denial)
  case AuctionAlreadyStarted
  case OpIdTaken
}

/**
 * Отказ выставления ориентировочного времени финала: проверка до агрегата или решение агрегата. `OpIdTaken` — под этим
 * `op_id` записана другая команда аукциона: у пары взаимно обратных команд тихое «принято» на чужой повтор оставило бы
 * видимость не той.
 */
enum FinalTimeRefusal {
  case Denied(denial: Denial)
  case FinalAlreadyStarted
  case AuctionAlreadyFinished
  case AuctionAlreadyCancelled
  case OpIdTaken
}

/**
 * Отказ текста оплаты (PER-322): проверка до агрегата. `OpIdTaken` — под этим `op_id` записана другая команда: у
 * выставления и снятия, как у времени финала, тихое «принято» на чужой повтор оставило бы не тот текст.
 */
enum PaymentInstructionsRefusal {
  case Denied(denial: Denial)
  case OpIdTaken
}

/** Отказ `CancelAuction`: проверка до агрегата или решение агрегата. */
enum CancellationRefusal {
  case Denied(denial: Denial)
  case AuctionNotStarted
  case AuctionAlreadyFinished
}

/**
 * Отказ `StartPrebidding`: проверка до агрегата, решение агрегата или слот торгов сообщества — торги идут у другого
 * аукциона (ADR-047, дополнение 2026-10-12) или слот не ответил в срок.
 */
enum OpeningRefusal {
  case Denied(denial: Denial)
  case AuctionNotScheduled
  case AnotherAuctionActive(holder: AuctionId)
  case SlotUnavailable
}

/** Отказ `ScheduleLot`: проверка до агрегата, решение аукциона о реестре или решение самого лота. */
enum LotSchedulingRefusal {
  case Denied(denial: Denial)
  case LotNotInAuction
  case ByLot(rejected: ScheduleLotRejected)
}

/**
 * Отказ выбора финалиста: проверка до агрегата, решение аукциона о фазе и реестре или решение самого лота (`R` — отказы
 * его команды).
 */
enum FinalChoiceRefusal[+R] {
  case Denied(denial: Denial) extends FinalChoiceRefusal[Nothing]
  case NotInPrebidding extends FinalChoiceRefusal[Nothing]
  case LotNotInAuction extends FinalChoiceRefusal[Nothing]
  case SelectionNotApplicable extends FinalChoiceRefusal[Nothing]
  case ByLot(rejected: R)
}

/**
 * Отказ снятия участника с лота и его предпросмотра (ADR-072; PER-658): проверка до агрегата, решение аукциона о фазе,
 * реестре и составе финала или решение самого лота.
 */
enum ParticipantRemovalRefusal {
  case Denied(denial: Denial)
  case NotInPrebidding
  case LotNotInAuction
  case LineupFrozen
  case ByLot(rejected: RemoveParticipantRejected)
}

/**
 * Отказ запуска окна сниженного шага: проверка до агрегата или решение агрегата. `OpIdTaken` — под этим `op_id`
 * записана другая команда аукциона, и исходного окна, которое вернул бы повтор, нет.
 */
enum LaunchRefusal {
  case Denied(denial: Denial)
  case Rejected(rejected: LaunchStepWindowRejected)
  case OpIdTaken
}

/**
 * Отказ ask ведущего: проверка до агрегата, реестр аукциона или решение самого лота. `OpIdTaken` — под этим `op_id`
 * записана команда аукциона, а не ask.
 */
enum AskRefusal {
  case Denied(denial: Denial)
  case LotNotInAuction
  case ByLot(rejected: AdvanceAskRejected)
}

/**
 * Отказ заморозки состава: проверка до агрегата или решение агрегата. `LineupUnknown` — аукцион ещё переспрашивает лоты
 * после рестарта, и повтор позже пройдёт.
 */
enum LineupRefusal {
  case Denied(denial: Denial)
  case NotInBreak
  case LineupUnknown
  case LineupEmpty
  case LineupMismatch(held: Set[LotId])
}

/** Отказ старта финала: проверка до агрегата или решение агрегата. */
enum FinalStartRefusal {
  case Denied(denial: Denial)
  case LineupNotFrozen
}

/**
 * Отказ следующего лота финала: проверка до агрегата или решение агрегата. `OpIdTaken` — под этим `op_id` записана
 * другая команда аукциона.
 */
enum NextLotRefusal {
  case Denied(denial: Denial)
  case NotInFinal
  case AnotherLotActive(lot: LotId)
  case LineupExhausted
  case OpIdTaken
}

/**
 * Отказ закрытия лота ведущим: проверка до агрегата, решение аукциона о фазе и реестре или ответ лота;
 * `Rejected(OpIdTaken)` — `op_id` уже записан другой командой аукциона или лота.
 */
enum ClosingRefusal {
  case Denied(denial: Denial)
  case Rejected(rejected: CloseAuctionLotRejected)
}

/**
 * Команды администратора аукциону (ADR-047, дополнение 2026-10-03). Порядок фиксирован:
 *
 *   1. повтор того же `op_id` получает исходный ответ раньше проверки права; 2. у всех команд, кроме рождения, аукцион
 *      без журнала — `AuctionNotFound` до обращения к Meetups; 3. право у Meetups и ворота по состоянию сходки из его
 *      ответа ([[MeetupGate]], ADR-047, дополнение 2026-10-12), и только после них — команда агрегату. Entity сверяет
 *      `seen` ещё раз, поэтому повтор, принятый между шагами, тоже получает исходный ответ.
 *
 * Открытие торгов командой здесь заканчивается записью события: лоты открывает entity аукциона, и ответ их не ждёт.
 * Повтор открытия с тем же `op_id` идёт в entity мимо Meetups — события он не пишет, но доспрашивает лоты, не
 * ответившие в прошлый раз.
 *
 * `AddLot` рождает лот в аукционе: после права лоту уходит `DraftLot` с тем же `op_id`, и только родившийся в этом
 * аукционе лот попадает в реестр. Двух записей в одной транзакции нет, поэтому порядок такой, чтобы обрыв между ними не
 * оставлял в реестре лота без журнала: оборванное добавление дописывает повтор с тем же `op_id`. Лот, который уже
 * родился, отвечает `LotAlreadyExists`; родился он в этом же аукционе — это не отказ (повторное добавление после
 * `RemoveLot`), в другом — `LotOfAnotherAuction`, и реестр не меняется. Лот прежнего рождения аукциона, удалённого до
 * торгов, рождён в этом же `auction_id`, но его отвергает уже агрегат — тем же `LotOfAnotherAuction` (ADR-047,
 * дополнение 2026-10-20).
 *
 * `ScheduleLot` идёт через аукцион (ADR-047): заморозку, реестр и незаданные условия решает entity аукциона, и она же
 * шлёт команду лоту, поэтому старт торгов между проверкой и командой здесь невозможен. Событие пишет только лот, и
 * повтор `op_id` узнаёт он: на шаге 1 аукцион находит в своём окне разве что `op_id` другой команды, и это `OpIdTaken`,
 * а не исходный ответ. Повтор принятого `ScheduleLot` после старта торгов отвечает `LotsFrozen`.
 *
 * Отметка для финала и её снятие идут тем же путём, что `ScheduleLot` (ADR-047, дополнение 2026-10-06): решает entity
 * аукциона, событие пишет лот, повтор `op_id` узнаёт лот, а `op_id` из окна аукциона — `OpIdTaken` лота.
 *
 * Команды финала (PER-334) — команды самого аукциона, как открытие торгов: событие пишет он, и повтор `op_id` получает
 * исходный ответ из его окна. Повтор `StartNextLot` отвечает лотом исходной активации, не спрашивая Meetups.
 *
 * Запуск окна сниженного шага (ADR-047, дополнение 2026-10-12) — команда самого аукциона: событие пишет он, и повтор
 * `op_id` получает исходное окно раньше права, фазы, времени и пересечений. Как у открытия, повтор идёт в entity мимо
 * Meetups и дошлёт окно лотам, не ответившим раньше.
 *
 * Ask ведущего (PER-293) идёт тем же путём, что отметка: аукцион — прокси к команде лота, он проверяет реестр и шлёт
 * лоту `AdvanceAsk`, а фазу и цену судит лот; событие пишет лот, и повтор `op_id` узнаёт он.
 */
final class AuctionCommands(
    auctions: AuctionGateway,
    lots: LotGateway,
    authority: MeetupAuthority,
    correlation: Correlation = Correlation.none
)(using ExecutionContext) {

  /** Те же команды для одного входящего вызова: право у Meetups спрашивается с его сквозными значениями. */
  def within(correlation: Correlation): AuctionCommands = AuctionCommands(auctions, lots, authority, correlation)

  def draft(meetup: MeetupId, opId: OpId, person: ParticipantId): Future[Either[Denial, Drafted]] = {
    val auctionId = Auction.idOf(meetup)
    auctions.inspect(auctionId, opId).flatMap {
      case Inspection.Repeated(original) => Future.successful(Right(Drafted(auctionId, !drafting(original.event))))
      case Inspection.Absent | Inspection.Present(_, _) =>
        authorized(meetup, person, MeetupGate.NotCancelled, (denial: Denial) => denial) {
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
      case Inspection.Present(meetup, registryOpen) =>
        authorized(meetup, person, MeetupGate.NotCancelled, (denial: Denial) => denial) {
          // Замороженный реестр отказывает до рождения лота: иначе лот остался бы с журналом, но вне реестра. Старт
          // торгов между `Inspect` и командой это не закрывает: лот успевает родиться, а реестр уже отвечает
          // `LotsFrozen`. Такой лот вне реестра модель терпит так же, как лот после оборванного `AddLot`.
          if (!registryOpen) Future.successful(Left(Denial.LotsFrozen))
          else
            born(auctionId, lot, opId, person).flatMap {
              case false => Future.successful(Left(Denial.LotOfAnotherAuction))
              case true =>
                auctions.addLot(auctionId, AddLot(lot, opId), Initiator.Operator(person)).map {
                  case Left(AddLotRejected.AuctionNotFound) => Left(Denial.AuctionNotFound)
                  case Left(AddLotRejected.LotsFrozen) => Left(Denial.LotsFrozen)
                  // Лот прежнего рождения — для вызывающего тот же лот другого аукциона: вернуть его нельзя.
                  case Left(AddLotRejected.LotOfDiscardedAuction) => Left(Denial.LotOfAnotherAuction)
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
      case Inspection.Present(meetup, _) =>
        authorized(meetup, person, MeetupGate.NotCancelled, RemovalRefusal.Denied(_)) {
          auctions.removeLot(auctionId, RemoveLot(lot, opId), Initiator.Operator(person)).map {
            case Left(RemoveLotRejected.AuctionNotFound) => Left(RemovalRefusal.Denied(Denial.AuctionNotFound))
            case Left(RemoveLotRejected.LotsFrozen) => Left(RemovalRefusal.Denied(Denial.LotsFrozen))
            case Left(RemoveLotRejected.LotNotInAuction) => Left(RemovalRefusal.LotNotInAuction)
            case Right(_) => Right(())
          }
        }
    }

  /**
   * Определение сета (ADR-073): тот же порядок, что у реестра, — повтор, аукцион, право у Meetups, затем название и
   * решение агрегата. Название проверяется после права, как у карточки каталога.
   */
  def saveLotSet(
      auctionId: AuctionId,
      set: LotSetId,
      name: String,
      lots: List[LotId],
      opId: OpId,
      person: ParticipantId
  ): Future[Either[LotSetRefusal, Unit]] =
    auctions.inspect(auctionId, opId).flatMap {
      case Inspection.Repeated(_) => Future.successful(Right(()))
      case Inspection.Absent => Future.successful(Left(LotSetRefusal.Denied(Denial.AuctionNotFound)))
      case Inspection.Present(meetup, _) =>
        authorized(meetup, person, MeetupGate.NotCancelled, LotSetRefusal.Denied(_)) {
          LotSetName(name) match {
            case Left(_) => Future.successful(Left(LotSetRefusal.NameEmpty))
            case Right(named) =>
              auctions.saveLotSet(auctionId, SaveLotSet(set, named, lots, opId), Initiator.Operator(person)).map {
                case Left(SaveLotSetRejected.AuctionNotFound) => Left(LotSetRefusal.Denied(Denial.AuctionNotFound))
                case Left(SaveLotSetRejected.LotsFrozen) => Left(LotSetRefusal.Denied(Denial.LotsFrozen))
                case Left(SaveLotSetRejected.NameEmpty) => Left(LotSetRefusal.NameEmpty)
                case Left(SaveLotSetRejected.LotNotInAuction(lot)) => Left(LotSetRefusal.LotNotInAuction(lot))
                case Left(SaveLotSetRejected.LotInAnotherSet(lot, owner)) =>
                  Left(LotSetRefusal.LotInAnotherSet(lot, owner))
                case Right(_) => Right(())
              }
          }
        }
    }

  def deleteLotSet(
      auctionId: AuctionId,
      set: LotSetId,
      opId: OpId,
      person: ParticipantId
  ): Future[Either[LotSetRefusal, Unit]] =
    auctions.inspect(auctionId, opId).flatMap {
      case Inspection.Repeated(_) => Future.successful(Right(()))
      case Inspection.Absent => Future.successful(Left(LotSetRefusal.Denied(Denial.AuctionNotFound)))
      case Inspection.Present(meetup, _) =>
        authorized(meetup, person, MeetupGate.NotCancelled, LotSetRefusal.Denied(_)) {
          auctions.deleteLotSet(auctionId, DeleteLotSet(set, opId), Initiator.Operator(person)).map {
            case Left(DeleteLotSetRejected.AuctionNotFound) => Left(LotSetRefusal.Denied(Denial.AuctionNotFound))
            case Left(DeleteLotSetRejected.LotsFrozen) => Left(LotSetRefusal.Denied(Denial.LotsFrozen))
            case Left(DeleteLotSetRejected.LotSetNotFound) => Left(LotSetRefusal.LotSetNotFound)
            case Right(_) => Right(())
          }
        }
    }

  def schedule(
      auctionId: AuctionId,
      config: AuctionConfigInput,
      opId: OpId,
      person: ParticipantId
  ): Future[Either[SchedulingRefusal, Unit]] =
    auctions.inspect(auctionId, opId).flatMap {
      case Inspection.Repeated(_) => Future.successful(Right(()))
      case Inspection.Absent => Future.successful(Left(SchedulingRefusal.Denied(Denial.AuctionNotFound)))
      case Inspection.Present(meetup, _) =>
        authorized(meetup, person, MeetupGate.NotCancelled, SchedulingRefusal.Denied(_)) {
          auctions.schedule(auctionId, ScheduleAuction(config, opId), Initiator.Operator(person)).map {
            case Left(ScheduleAuctionRejected.AuctionNotFound) =>
              Left(SchedulingRefusal.Denied(Denial.AuctionNotFound))
            case Left(ScheduleAuctionRejected.ConfigInvalid(reason)) => Left(SchedulingRefusal.ConfigInvalid(reason))
            case Left(ScheduleAuctionRejected.AuctionAlreadyStarted) => Left(SchedulingRefusal.AuctionAlreadyStarted)
            case Right(_) => Right(())
          }
        }
    }

  def startPrebidding(auctionId: AuctionId, opId: OpId, person: ParticipantId): Future[Either[OpeningRefusal, Unit]] =
    auctions.inspect(auctionId, opId).flatMap {
      // Мимо Meetups в entity идёт только повтор самой команды открытия; `op_id` другой команды отвечает, как у
      // остальных команд, и до entity не доходит.
      case Inspection.Repeated(original) =>
        original.event match {
          case AuctionEvent.PrebiddingStarted => start(auctionId, opId, person)
          case _ => Future.successful(Right(()))
        }
      case Inspection.Absent => Future.successful(Left(OpeningRefusal.Denied(Denial.AuctionNotFound)))
      case Inspection.Present(meetup, _) =>
        authorized(meetup, person, MeetupGate.Published, OpeningRefusal.Denied(_))(start(auctionId, opId, person))
    }

  /**
   * Удаление аукциона до торгов (ADR-047, дополнение 2026-10-09). Порядок тот же, что у остальных команд: повтор, затем
   * аукцион без журнала, затем право у Meetups, затем агрегат.
   */
  def discard(auctionId: AuctionId, opId: OpId, person: ParticipantId): Future[Either[DiscardRefusal, Unit]] =
    auctions.inspect(auctionId, opId).flatMap {
      case Inspection.Repeated(_) => Future.successful(Right(()))
      case Inspection.Absent => Future.successful(Left(DiscardRefusal.Denied(Denial.AuctionNotFound)))
      case Inspection.Present(meetup, _) =>
        authorized(meetup, person, MeetupGate.Unconditional, DiscardRefusal.Denied(_)) {
          auctions.discard(auctionId, DiscardAuction(opId), Initiator.Operator(person)).map {
            case Left(DiscardAuctionRejected.AuctionNotFound) => Left(DiscardRefusal.Denied(Denial.AuctionNotFound))
            case Left(DiscardAuctionRejected.AuctionAlreadyStarted) => Left(DiscardRefusal.AuctionAlreadyStarted)
            case Right(_) => Right(())
          }
        }
    }

  /**
   * Публикация (`published`) или снятие аукциона до торгов (ADR-047, дополнение 2026-10-20). Порядок тот же, что у
   * удаления; ворота — сходка не отменена.
   */
  def changeVisibility(
      auctionId: AuctionId,
      published: Boolean,
      opId: OpId,
      person: ParticipantId
  ): Future[Either[VisibilityRefusal, Unit]] =
    auctions.inspect(auctionId, opId).flatMap {
      case Inspection.Repeated(original) =>
        val same = original.event match {
          case AuctionEvent.AuctionPublished => published
          case AuctionEvent.AuctionHidden => !published
          case _ => false
        }
        Future.successful(Either.cond(same, (), VisibilityRefusal.OpIdTaken))
      case Inspection.Absent => Future.successful(Left(VisibilityRefusal.Denied(Denial.AuctionNotFound)))
      case Inspection.Present(meetup, _) =>
        authorized(meetup, person, MeetupGate.NotCancelled, VisibilityRefusal.Denied(_)) {
          val command = ChangeVisibility(published, opId)
          auctions.changeVisibility(auctionId, command, Initiator.Operator(person)).map {
            case Left(VisibilityRejected.AuctionNotFound) => Left(VisibilityRefusal.Denied(Denial.AuctionNotFound))
            case Left(VisibilityRejected.AuctionAlreadyStarted) => Left(VisibilityRefusal.AuctionAlreadyStarted)
            case Right(_) => Right(())
          }
        }
    }

  /**
   * Ориентировочное время финала (ADR-040, дополнение 2026-10-19): выставить, изменить или снять. Порядок тот же, что у
   * остальных команд: повтор, аукцион без журнала, право у Meetups, затем агрегат. Ворота — сходка не отменена.
   */
  def setFinalTime(
      auctionId: AuctionId,
      at: Option[Instant],
      opId: OpId,
      person: ParticipantId
  ): Future[Either[FinalTimeRefusal, Unit]] =
    auctions.inspect(auctionId, opId).flatMap {
      case Inspection.Repeated(original) =>
        // Выставить и снять — разные события: снятие под `op_id` выставления — чужая команда, как публикация под
        // `op_id` снятия (ADR-047, дополнение 2026-10-20). Тихое «принято» оставило бы время на месте.
        val same = original.event match {
          case AuctionEvent.FinalTimeSet(_) => at.isDefined
          case AuctionEvent.FinalTimeCleared => at.isEmpty
          case _ => false
        }
        Future.successful(Either.cond(same, (), FinalTimeRefusal.OpIdTaken))
      case Inspection.Absent => Future.successful(Left(FinalTimeRefusal.Denied(Denial.AuctionNotFound)))
      case Inspection.Present(meetup, _) =>
        authorized(meetup, person, MeetupGate.NotCancelled, FinalTimeRefusal.Denied(_)) {
          auctions.setFinalTime(auctionId, SetFinalTime(at, opId), Initiator.Operator(person)).map {
            case Left(FinalTimeRejected.AuctionNotFound) => Left(FinalTimeRefusal.Denied(Denial.AuctionNotFound))
            case Left(FinalTimeRejected.FinalAlreadyStarted) => Left(FinalTimeRefusal.FinalAlreadyStarted)
            case Left(FinalTimeRejected.AuctionAlreadyFinished) => Left(FinalTimeRefusal.AuctionAlreadyFinished)
            case Left(FinalTimeRejected.AuctionAlreadyCancelled) => Left(FinalTimeRefusal.AuctionAlreadyCancelled)
            // Ответ entity — записанный конверт: чужое событие под тем же `op_id` значит, что время не выставлено
            // (ADR-047, «Открыто»: повтор отвечает исходным ответом только своей команде).
            case Right(AuctionAnswer.Written(original)) =>
              val ours = original.event match {
                case AuctionEvent.FinalTimeSet(_) => at.isDefined
                case AuctionEvent.FinalTimeCleared => at.isEmpty
                case _ => false
              }
              Either.cond(ours, (), FinalTimeRefusal.OpIdTaken)
            case Right(AuctionAnswer.Unchanged) => Right(())
          }
        }
    }

  /**
   * Текст «как оплатить и получить» (PER-322): выставить, изменить или снять. Порядок тот же, что у времени финала, а
   * ворот по сходке нет, как у отметок счёта: проданный лот ждёт оплаты и у отменённой сходки.
   */
  def setPaymentInstructions(
      auctionId: AuctionId,
      text: Option[PaymentInstructions],
      opId: OpId,
      person: ParticipantId
  ): Future[Either[PaymentInstructionsRefusal, Unit]] = {
    // Выставить и снять — разные события: снятие под `op_id` выставления — чужая команда.
    def ours(envelope: AuctionEnvelope): Boolean =
      envelope.event match {
        case AuctionEvent.PaymentInstructionsSet(_) => text.isDefined
        case AuctionEvent.PaymentInstructionsCleared => text.isEmpty
        case _ => false
      }
    auctions.inspect(auctionId, opId).flatMap {
      case Inspection.Repeated(original) =>
        Future.successful(Either.cond(ours(original), (), PaymentInstructionsRefusal.OpIdTaken))
      case Inspection.Absent => Future.successful(Left(PaymentInstructionsRefusal.Denied(Denial.AuctionNotFound)))
      case Inspection.Present(meetup, _) =>
        authorized(meetup, person, MeetupGate.Unconditional, PaymentInstructionsRefusal.Denied(_)) {
          auctions
            .setPaymentInstructions(auctionId, SetPaymentInstructions(text, opId), Initiator.Operator(person))
            .map {
              case Left(PaymentInstructionsRejected.AuctionNotFound) =>
                Left(PaymentInstructionsRefusal.Denied(Denial.AuctionNotFound))
              case Right(AuctionAnswer.Written(original)) =>
                Either.cond(ours(original), (), PaymentInstructionsRefusal.OpIdTaken)
              case Right(AuctionAnswer.Unchanged) => Right(())
            }
        }
    }
  }

  /**
   * Отмена аукциона после старта торгов (ADR-047, дополнение 2026-10-12). Порядок тот же, что у остальных команд. Как у
   * открытия, мимо Meetups в entity идёт только повтор самой отмены: он события не пишет, но доснимает лоты, не
   * ответившие в прошлый раз; `op_id` другой команды до entity не доходит.
   */
  def cancel(auctionId: AuctionId, opId: OpId, person: ParticipantId): Future[Either[CancellationRefusal, Unit]] =
    auctions.inspect(auctionId, opId).flatMap {
      case Inspection.Repeated(original) =>
        original.event match {
          case AuctionEvent.AuctionCancelled => cancelled(auctionId, opId, person)
          case _ => Future.successful(Right(()))
        }
      case Inspection.Absent => Future.successful(Left(CancellationRefusal.Denied(Denial.AuctionNotFound)))
      case Inspection.Present(meetup, _) =>
        authorized(meetup, person, MeetupGate.Unconditional, CancellationRefusal.Denied(_))(
          cancelled(auctionId, opId, person)
        )
    }

  def scheduleLot(
      auctionId: AuctionId,
      lot: LotId,
      startingPrice: Money,
      stepPolicy: StepPolicyInput,
      opId: OpId,
      person: ParticipantId
  ): Future[Either[LotSchedulingRefusal, Unit]] =
    auctions.inspect(auctionId, opId).flatMap {
      case Inspection.Repeated(_) =>
        Future.successful(Left(LotSchedulingRefusal.ByLot(ScheduleLotRejected.OpIdTaken)))
      case Inspection.Absent => Future.successful(Left(LotSchedulingRefusal.Denied(Denial.AuctionNotFound)))
      case Inspection.Present(meetup, _) =>
        authorized(meetup, person, MeetupGate.NotCancelled, LotSchedulingRefusal.Denied(_)) {
          val command = ScheduleAuctionLot(lot, startingPrice, stepPolicy, opId)
          auctions.scheduleLot(auctionId, command, Initiator.Operator(person)).map {
            case Right(()) => Right(())
            case Left(ScheduleAuctionLotRejected.AuctionNotFound) =>
              Left(LotSchedulingRefusal.Denied(Denial.AuctionNotFound))
            case Left(ScheduleAuctionLotRejected.LotsFrozen) => Left(LotSchedulingRefusal.Denied(Denial.LotsFrozen))
            case Left(ScheduleAuctionLotRejected.LotNotInAuction) => Left(LotSchedulingRefusal.LotNotInAuction)
            case Left(ScheduleAuctionLotRejected.ByLot(rejected)) => Left(LotSchedulingRefusal.ByLot(rejected))
          }
        }
    }

  def selectForFinal(
      auctionId: AuctionId,
      lot: LotId,
      opId: OpId,
      person: ParticipantId
  ): Future[Either[FinalChoiceRefusal[MarkForFinalRejected], Unit]] =
    chosen(auctionId, opId, person, MarkForFinalRejected.OpIdTaken) {
      auctions.selectForFinal(auctionId, SelectForFinal(lot, opId), Initiator.Operator(person))
    }

  def deselectForFinal(
      auctionId: AuctionId,
      lot: LotId,
      opId: OpId,
      person: ParticipantId
  ): Future[Either[FinalChoiceRefusal[UnmarkForFinalRejected], Unit]] =
    chosen(auctionId, opId, person, UnmarkForFinalRejected.OpIdTaken) {
      auctions.deselectForFinal(auctionId, DeselectForFinal(lot, opId), Initiator.Operator(person))
    }

  /**
   * Снятие участника с лота (ADR-072; PER-658) — путь выбора финалиста: повтор из окна аукциона — чужая команда, затем
   * право у Meetups с воротами отменённой сходки, затем entity. Ответ — номер лота, с которого чтение показывает снятие
   * целиком.
   */
  def removeParticipant(
      auctionId: AuctionId,
      command: RemoveLotParticipant,
      person: ParticipantId
  ): Future[Either[ParticipantRemovalRefusal, Long]] =
    auctions.inspect(auctionId, command.opId).flatMap {
      case Inspection.Repeated(_) =>
        Future.successful(Left(ParticipantRemovalRefusal.ByLot(RemoveParticipantRejected.OpIdTaken)))
      case Inspection.Absent => Future.successful(Left(ParticipantRemovalRefusal.Denied(Denial.AuctionNotFound)))
      case Inspection.Present(meetup, _) =>
        authorized(meetup, person, MeetupGate.NotCancelled, ParticipantRemovalRefusal.Denied(_)) {
          auctions.removeParticipant(auctionId, command, Initiator.Operator(person)).map(_.left.map(removalRefusal))
        }
    }

  /**
   * Предпросмотр снятия: то же право и те же ворота, что у снятия, и тот же ответ аукциона и лота, но без записи.
   * `op_id` у него нет, поэтому аукцион берётся у entity, а не из окна.
   */
  def previewParticipantRemoval(
      auctionId: AuctionId,
      command: PreviewLotParticipantRemoval,
      person: ParticipantId
  ): Future[Either[ParticipantRemovalRefusal, LotEntity.RemovalPreview]] =
    current(auctionId).map(_.flatMap(_.meetup)).flatMap {
      case None => Future.successful(Left(ParticipantRemovalRefusal.Denied(Denial.AuctionNotFound)))
      case Some(meetup) =>
        authorized(meetup, person, MeetupGate.NotCancelled, ParticipantRemovalRefusal.Denied(_)) {
          auctions.previewParticipantRemoval(auctionId, command).map(_.left.map(removalRefusal))
        }
    }

  private def removalRefusal(rejected: ParticipantRemovalRejected): ParticipantRemovalRefusal =
    rejected match {
      case ParticipantRemovalRejected.AuctionNotFound => ParticipantRemovalRefusal.Denied(Denial.AuctionNotFound)
      case ParticipantRemovalRejected.NotInPrebidding => ParticipantRemovalRefusal.NotInPrebidding
      case ParticipantRemovalRejected.LotNotInAuction => ParticipantRemovalRefusal.LotNotInAuction
      case ParticipantRemovalRejected.LineupFrozen => ParticipantRemovalRefusal.LineupFrozen
      case ParticipantRemovalRejected.ByLot(rejected) => ParticipantRemovalRefusal.ByLot(rejected)
    }

  /** Запуск окна сниженного шага; ответ — записанное окно, с началом, которое подставил сервер, если его не задали. */
  def launchStepWindow(
      auctionId: AuctionId,
      command: LaunchStepWindow,
      person: ParticipantId
  ): Future[Either[LaunchRefusal, StepWindowConfig]] =
    auctions.inspect(auctionId, command.opId).flatMap {
      // Мимо Meetups в entity идёт только повтор самого запуска: события он не пишет, но дошлёт окно лотам, не
      // ответившим раньше. `op_id` другой команды до entity не доходит.
      case Inspection.Repeated(original) =>
        original.event match {
          case AuctionEvent.StepWindowLaunched(_) => launch(auctionId, command, person)
          case _ => Future.successful(Left(LaunchRefusal.OpIdTaken))
        }
      case Inspection.Absent => Future.successful(Left(LaunchRefusal.Denied(Denial.AuctionNotFound)))
      case Inspection.Present(meetup, _) =>
        authorized(meetup, person, MeetupGate.NotCancelled, LaunchRefusal.Denied(_))(launch(auctionId, command, person))
    }

  private def launch(
      auctionId: AuctionId,
      command: LaunchStepWindow,
      person: ParticipantId
  ): Future[Either[LaunchRefusal, StepWindowConfig]] =
    auctions.launchStepWindow(auctionId, command, Initiator.Operator(person)).map {
      case Right(AuctionAnswer.Written(envelope)) => launchedBy(envelope)
      case Right(AuctionAnswer.Unchanged) =>
        throw new IllegalStateException(s"auction $auctionId launched a step window without an event")
      case Left(LaunchStepWindowRejected.AuctionNotFound) => Left(LaunchRefusal.Denied(Denial.AuctionNotFound))
      case Left(rejected) => Left(LaunchRefusal.Rejected(rejected))
    }

  /** Ask ведущего лоту реестра (RFC-011, П-08); инициатор у лота — ведущий. */
  def advanceAsk(
      auctionId: AuctionId,
      lot: LotId,
      newAsk: Money,
      opId: OpId,
      person: ParticipantId
  ): Future[Either[AskRefusal, Unit]] =
    auctions.inspect(auctionId, opId).flatMap {
      case Inspection.Repeated(_) => Future.successful(Left(AskRefusal.ByLot(AdvanceAskRejected.OpIdTaken)))
      case Inspection.Absent => Future.successful(Left(AskRefusal.Denied(Denial.AuctionNotFound)))
      case Inspection.Present(meetup, _) =>
        authorized(meetup, person, MeetupGate.NotCancelled, AskRefusal.Denied(_)) {
          auctions.advanceAsk(auctionId, AdvanceLotAsk(lot, newAsk, opId), Initiator.Operator(person)).map {
            case Right(()) => Right(())
            case Left(AdvanceLotAskRejected.AuctionNotFound) => Left(AskRefusal.Denied(Denial.AuctionNotFound))
            case Left(AdvanceLotAskRejected.LotNotInAuction) => Left(AskRefusal.LotNotInAuction)
            case Left(AdvanceLotAskRejected.ByLot(rejected)) => Left(AskRefusal.ByLot(rejected))
          }
        }
    }

  /** Заморозка состава финала: удержанные лоты в порядке выхода (RFC-011). */
  def freezeFinalLineup(
      auctionId: AuctionId,
      order: List[LotId],
      opId: OpId,
      person: ParticipantId
  ): Future[Either[LineupRefusal, Unit]] =
    auctions.inspect(auctionId, opId).flatMap {
      case Inspection.Repeated(_) => Future.successful(Right(()))
      case Inspection.Absent => Future.successful(Left(LineupRefusal.Denied(Denial.AuctionNotFound)))
      case Inspection.Present(meetup, _) =>
        authorized(meetup, person, MeetupGate.NotCancelled, LineupRefusal.Denied(_)) {
          auctions.freezeFinalLineup(auctionId, FreezeFinalLineup(order, opId), Initiator.Operator(person)).map {
            case Right(_) => Right(())
            case Left(FreezeFinalLineupRejected.AuctionNotFound) => Left(LineupRefusal.Denied(Denial.AuctionNotFound))
            case Left(FreezeFinalLineupRejected.NotInBreak) => Left(LineupRefusal.NotInBreak)
            case Left(FreezeFinalLineupRejected.LineupUnknown) => Left(LineupRefusal.LineupUnknown)
            case Left(FreezeFinalLineupRejected.LineupEmpty) => Left(LineupRefusal.LineupEmpty)
            case Left(FreezeFinalLineupRejected.LineupMismatch(held)) => Left(LineupRefusal.LineupMismatch(held))
          }
        }
    }

  /** Старт финала ведущим: только после заморозки состава (И-19). */
  def startFinal(auctionId: AuctionId, opId: OpId, person: ParticipantId): Future[Either[FinalStartRefusal, Unit]] =
    auctions.inspect(auctionId, opId).flatMap {
      case Inspection.Repeated(_) => Future.successful(Right(()))
      case Inspection.Absent => Future.successful(Left(FinalStartRefusal.Denied(Denial.AuctionNotFound)))
      case Inspection.Present(meetup, _) =>
        authorized(meetup, person, MeetupGate.NotCancelled, FinalStartRefusal.Denied(_)) {
          auctions.startFinal(auctionId, StartFinal(opId), Initiator.Operator(person)).map {
            case Right(_) => Right(())
            case Left(StartFinalRejected.AuctionNotFound) => Left(FinalStartRefusal.Denied(Denial.AuctionNotFound))
            case Left(StartFinalRejected.LineupNotFrozen) => Left(FinalStartRefusal.LineupNotFrozen)
          }
        }
    }

  /** Следующий лот финала: ответ — лот, который вернулся в торги. */
  def startNextLot(auctionId: AuctionId, opId: OpId, person: ParticipantId): Future[Either[NextLotRefusal, LotId]] =
    auctions.inspect(auctionId, opId).flatMap {
      case Inspection.Repeated(original) =>
        original.event match {
          case AuctionEvent.FinalLotActivated(lot) => Future.successful(Right(lot))
          case _ => Future.successful(Left(NextLotRefusal.OpIdTaken))
        }
      case Inspection.Absent => Future.successful(Left(NextLotRefusal.Denied(Denial.AuctionNotFound)))
      case Inspection.Present(meetup, _) =>
        authorized(meetup, person, MeetupGate.NotCancelled, NextLotRefusal.Denied(_)) {
          auctions.startNextLot(auctionId, StartNextLot(opId), Initiator.Operator(person)).map {
            case Right(lot) => Right(lot)
            case Left(StartNextLotRejected.AuctionNotFound) => Left(NextLotRefusal.Denied(Denial.AuctionNotFound))
            case Left(StartNextLotRejected.NotInFinal) => Left(NextLotRefusal.NotInFinal)
            case Left(StartNextLotRejected.AnotherLotActive(lot)) => Left(NextLotRefusal.AnotherLotActive(lot))
            case Left(StartNextLotRejected.LineupExhausted) => Left(NextLotRefusal.LineupExhausted)
            case Left(StartNextLotRejected.OpIdTaken) => Left(NextLotRefusal.OpIdTaken)
          }
        }
    }

  /**
   * Закрытие лота ведущим (PER-607). Своего события под `op_id` ведущего аукцион не пишет: повтор узнаёт лот, поэтому
   * `op_id`, найденный в окне аукциона, — заведомо другая команда, как у ask.
   */
  def closeLot(
      auctionId: AuctionId,
      lot: LotId,
      opId: OpId,
      person: ParticipantId
  ): Future[Either[ClosingRefusal, LotEnding]] =
    auctions.inspect(auctionId, opId).flatMap {
      case Inspection.Repeated(_) =>
        Future.successful(Left(ClosingRefusal.Rejected(CloseAuctionLotRejected.OpIdTaken)))
      case Inspection.Absent => Future.successful(Left(ClosingRefusal.Denied(Denial.AuctionNotFound)))
      case Inspection.Present(meetup, _) =>
        authorized(meetup, person, MeetupGate.NotCancelled, ClosingRefusal.Denied(_)) {
          auctions.closeLot(auctionId, CloseAuctionLot(lot, opId), Initiator.Operator(person)).map {
            case Right(ending) => Right(ending)
            case Left(CloseAuctionLotRejected.AuctionNotFound) => Left(ClosingRefusal.Denied(Denial.AuctionNotFound))
            case Left(rejected) => Left(ClosingRefusal.Rejected(rejected))
          }
        }
    }

  /**
   * Право администратора без записи аукциону и без окна `seen` (PER-320): чтение пульта — ему нечего повторять — и
   * команды, которые пишет не аукцион. Чтение ворот по состоянию сходки не проходит (`Unconditional`): пульт отменённой
   * сходки показывает её аукцион; команда называет свои ворота сама.
   */
  def authorize(
      meetup: MeetupId,
      person: ParticipantId,
      gate: MeetupGate = MeetupGate.Unconditional
  ): Future[Either[Denial, Unit]] =
    authorized(meetup, person, gate, (denial: Denial) => denial)(Future.successful(Right(())))

  /**
   * Право вести торги аукциона — у Meetups, как у остальных команд администратора: ставку зала заносит помощник
   * ведущего, держатель `run_auctions` (ADR-070, п. 2). Аукцион без журнала — `AuctionNotFound` до вопроса Meetups.
   */
  def hosts(auctionId: AuctionId, person: ParticipantId): Future[Either[Denial, Unit]] =
    current(auctionId).map(_.flatMap(_.meetup)).flatMap {
      case Some(meetup) => authorize(meetup, person)
      case None => Future.successful(Left(Denial.AuctionNotFound))
    }

  /**
   * Аукцион, каким его знает entity, а не read model: пульт собирает из него следующую команду — сроки и финал целиком,
   * — и отставшая проекция затёрла бы только что принятое (PER-320). Аукцион без журнала — `None`.
   */
  def current(auctionId: AuctionId): Future[Option[Auction]] =
    auctions.get(auctionId).map(auction => Option.when(auction.state != AuctionState.Initial)(auction))

  /** Общий путь выбора финалиста: повтор из окна аукциона — чужая команда, затем право, затем entity. */
  private def chosen[R](auctionId: AuctionId, opId: OpId, person: ParticipantId, opIdTaken: R)(
      run: => Future[Either[FinalChoiceRejected[R], Unit]]
  ): Future[Either[FinalChoiceRefusal[R], Unit]] =
    auctions.inspect(auctionId, opId).flatMap {
      case Inspection.Repeated(_) => Future.successful(Left(FinalChoiceRefusal.ByLot(opIdTaken)))
      case Inspection.Absent => Future.successful(Left(FinalChoiceRefusal.Denied(Denial.AuctionNotFound)))
      case Inspection.Present(meetup, _) =>
        authorized(meetup, person, MeetupGate.NotCancelled, FinalChoiceRefusal.Denied(_)) {
          run.map {
            case Right(()) => Right(())
            case Left(FinalChoiceRejected.AuctionNotFound) => Left(FinalChoiceRefusal.Denied(Denial.AuctionNotFound))
            case Left(FinalChoiceRejected.NotInPrebidding) => Left(FinalChoiceRefusal.NotInPrebidding)
            case Left(FinalChoiceRejected.LotNotInAuction) => Left(FinalChoiceRefusal.LotNotInAuction)
            case Left(FinalChoiceRejected.SelectionNotApplicable) => Left(FinalChoiceRefusal.SelectionNotApplicable)
            case Left(FinalChoiceRejected.ByLot(rejected)) => Left(FinalChoiceRefusal.ByLot(rejected))
          }
        }
    }

  private def start(auctionId: AuctionId, opId: OpId, person: ParticipantId): Future[Either[OpeningRefusal, Unit]] =
    auctions.startPrebidding(auctionId, StartPrebidding(opId), Initiator.Operator(person)).map {
      case Left(OpeningRejected.ByAuction(StartPrebiddingRejected.AuctionNotFound)) =>
        Left(OpeningRefusal.Denied(Denial.AuctionNotFound))
      case Left(OpeningRejected.ByAuction(StartPrebiddingRejected.AuctionNotScheduled)) =>
        Left(OpeningRefusal.AuctionNotScheduled)
      case Left(OpeningRejected.AnotherAuctionActive(holder)) => Left(OpeningRefusal.AnotherAuctionActive(holder))
      case Left(OpeningRejected.SlotUnavailable) => Left(OpeningRefusal.SlotUnavailable)
      case Right(_) => Right(())
    }

  private def cancelled(
      auctionId: AuctionId,
      opId: OpId,
      person: ParticipantId
  ): Future[Either[CancellationRefusal, Unit]] =
    auctions.cancel(auctionId, CancelAuction(opId), Initiator.Operator(person)).map {
      case Left(CancelAuctionRejected.AuctionNotFound) => Left(CancellationRefusal.Denied(Denial.AuctionNotFound))
      case Left(CancelAuctionRejected.AuctionNotStarted) => Left(CancellationRefusal.AuctionNotStarted)
      case Left(CancelAuctionRejected.AuctionAlreadyFinished) => Left(CancellationRefusal.AuctionAlreadyFinished)
      case Right(_) => Right(())
    }

  /**
   * Любой ответ Meetups, кроме `Granted`, — отказ, и до агрегата команда не доходит; после `Granted` то же решают
   * ворота по состоянию сходки из ответа.
   */
  private def authorized[L, R](meetup: MeetupId, person: ParticipantId, gate: MeetupGate, deny: Denial => L)(
      run: => Future[Either[L, R]]
  ): Future[Either[L, R]] =
    authority.check(meetup, person, correlation).flatMap {
      case Authority.Granted(standing) =>
        MeetupGate.admit(gate, standing).fold(run)(denial => Future.successful(Left(deny(denial))))
      case Authority.NotAdministrator => Future.successful(Left(deny(Denial.NotAdministrator)))
      case Authority.MeetupNotFound => Future.successful(Left(deny(Denial.MeetupNotFound)))
      case Authority.Unavailable => Future.successful(Left(deny(Denial.Unavailable)))
    }

  /** Окно исходного запуска; `op_id` под другим событием — чужая команда. */
  private def launchedBy(envelope: AuctionEnvelope): Either[LaunchRefusal, StepWindowConfig] =
    envelope.event match {
      case AuctionEvent.StepWindowLaunched(window) => Right(window)
      case _ => Left(LaunchRefusal.OpIdTaken)
    }

  /** Лот родился в этом аукционе — сейчас или раньше. `false` — он уже есть, но в другом аукционе. */
  private def born(auctionId: AuctionId, lot: LotId, opId: OpId, person: ParticipantId): Future[Boolean] =
    lots.draftLot(lot.value, DraftLot(auctionId, opId), Initiator.Operator(person)).flatMap {
      // Повтор того же `op_id` у лота отвечает исходным конвертом, а он мог родить лот в другом аукционе.
      case Right(envelope) =>
        envelope.event match {
          case LotEvent.LotDrafted(born) => Future.successful(born == auctionId)
          case _ => lots.auctionOf(lot.value).map(_.contains(auctionId))
        }
      case Left(DraftLotRejected.LotAlreadyExists) => lots.auctionOf(lot.value).map(_.contains(auctionId))
    }

  private def drafting(event: AuctionEvent): Boolean =
    event match {
      case AuctionEvent.AuctionDrafted(_, _) => true
      case AuctionEvent.LotAdded(_) | AuctionEvent.LotRemoved(_) | AuctionEvent.AuctionScheduled(_) |
          AuctionEvent.PrebiddingStarted | AuctionEvent.AuctionDiscarded | AuctionEvent.AuctionCancelled |
          AuctionEvent.PrebiddingDeadlineReached | AuctionEvent.PrebiddingEnded(_) | AuctionEvent.FinalLineupFrozen(_) |
          AuctionEvent.FinalStarted | AuctionEvent.FinalLotActivated(_) | AuctionEvent.FinalLotCompleted(_) |
          AuctionEvent.AuctionFinished | AuctionEvent.StepWindowLaunched(_) | AuctionEvent.AuctionPublished |
          AuctionEvent.AuctionHidden | AuctionEvent.FinalTimeSet(_) | AuctionEvent.FinalTimeCleared |
          AuctionEvent.PaymentInstructionsSet(_) | AuctionEvent.PaymentInstructionsCleared |
          AuctionEvent.LotSetDefined(_, _, _) | AuctionEvent.LotSetDeleted(_) | AuctionEvent.LotSetSettled(_, _) =>
        false
    }
}
