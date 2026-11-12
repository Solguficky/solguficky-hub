package auction.entity

import auction.aggregate.CloseAuctionLotRejected
import auction.aggregate.Closure
import auction.aggregate.LotEnding
import auction.catalog.LotId
import auction.lot.AddStepWindow
import auction.lot.AddStepWindowRejected
import auction.lot.ClearPeriodWindow
import auction.lot.AdvanceAsk
import auction.lot.AdvanceAskRejected
import auction.lot.CloseLot
import auction.lot.CloseLotRejected
import auction.lot.Envelope
import auction.lot.Lot
import auction.lot.LotEvent
import auction.lot.LotState
import auction.lot.MarkForFinal
import auction.lot.MarkForFinalRejected
import auction.lot.OpenLot
import auction.lot.OpenLotRejected
import auction.lot.ParticipantId
import auction.lot.PeriodWindowRejected
import auction.lot.RemoveParticipant
import auction.lot.RemoveParticipantRejected
import auction.lot.ResumeLot
import auction.lot.ResumeLotRejected
import auction.lot.Sale
import auction.lot.ScheduleLot
import auction.lot.ScheduleLotRejected
import auction.lot.SetPeriodWindow
import auction.lot.UnmarkForFinal
import auction.lot.UnmarkForFinalRejected
import auction.lot.WithdrawLot
import auction.lot.WithdrawLotRejected
import org.apache.pekko.cluster.sharding.typed.scaladsl.ClusterSharding
import org.apache.pekko.util.Timeout

import java.time.Instant
import scala.concurrent.ExecutionContext
import scala.concurrent.Future
import scala.concurrent.duration.FiniteDuration
import scala.util.Failure
import scala.util.Success
import scala.util.Try

/**
 * Лоты, какими их видит entity аукциона: вопрос о состоянии, команда открытия, закрытие по дедлайну и условия торгов.
 * Это не [[LotGateway]]: тот — порт транспорта, а `OpenLot` и `CloseLot` шлёт лоту сам аукцион, и межсервисной
 * поверхности у них нет (integration.md, «Auction gRPC»). `ScheduleLot`, отметка для финала и её снятие приходят
 * снаружи, но тоже через аукцион: заморозку условий, фазу торгов и реестр решает он; ask ведущего — так же, реестр.
 *
 * Неудачное `Future` — ответа нет: ask истёк или шардинг не доставил сообщение. Команда при этом могла быть принята,
 * поэтому аукцион после такого ответа снова спрашивает состояние, а не считает лот закрытым.
 */
trait AuctionLots {
  def stateOf(lot: LotId): Future[LotState]

  /** Подтверждение открытия несёт дедлайн из `LotOpened` лота: по нему аукцион взводит таймер закрытия. */
  def open(lot: LotId, command: OpenLot): Future[Either[OpenLotRejected, Option[Instant]]]

  /** Подтверждение закрытия различает продажу или закрытие без продажи и удержание отмеченного лота для финала. */
  def close(lot: LotId, command: CloseLot): Future[Either[CloseLotRejected, Closure]]

  /**
   * Закрытие ведущим (PER-607); инициатор — ведущий, как у `advanceAsk`. Ответ — конверт лота как есть: исход закрытия
   * и чужой `op_id` различает [[AuctionLots.ending]].
   */
  def closeByAuctioneer(lot: LotId, command: CloseLot, initiator: Initiator): Future[Either[CloseLotRejected, Envelope]]

  /** Возврат удержанного лота в торги финала (П-09); подтверждение — только его `LotResumed`. */
  def resume(lot: LotId, command: ResumeLot): Future[Either[ResumeLotRejected, Unit]]

  /**
   * Условия торгов лоту реестра — `ScheduleLot`, который идёт через аукцион (ADR-047). Инициатор — администратор,
   * отдавший команду: в отличие от открытия и закрытия, без человека она не повторяется.
   */
  def schedule(lot: LotId, command: ScheduleLot, initiator: Initiator): Future[Either[ScheduleLotRejected, Unit]]

  /** Отметка для финала по выбору администратора (ADR-047, дополнение 2026-10-06); инициатор — он, как у `schedule`. */
  def mark(lot: LotId, command: MarkForFinal, initiator: Initiator): Future[Either[MarkForFinalRejected, Unit]]

  def unmark(lot: LotId, command: UnmarkForFinal, initiator: Initiator): Future[Either[UnmarkForFinalRejected, Unit]]

  /** Ask ведущего лоту реестра (П-08); инициатор — ведущий, как у `mark`. */
  def advanceAsk(lot: LotId, command: AdvanceAsk, initiator: Initiator): Future[Either[AdvanceAskRejected, Unit]]

  /**
   * Снятие участника с лота по команде администратора (ADR-072; PER-658); инициатор — он, как у `mark`. Ответ — номер
   * лота, с которого чтение показывает снятие целиком.
   */
  def removeParticipant(
      lot: LotId,
      command: RemoveParticipant,
      initiator: Initiator
  ): Future[Either[RemoveParticipantRejected, Long]]

  /** Предпросмотр снятия: итог, который лот записал бы сейчас, без записи. */
  def previewRemoval(
      lot: LotId,
      participant: ParticipantId
  ): Future[Either[RemoveParticipantRejected, LotEntity.RemovalPreview]]

  /** Снятие лота отменённым аукционом (ADR-047, дополнение 2026-10-12); подтверждение — только его `LotWithdrawn`. */
  def withdraw(lot: LotId, command: WithdrawLot): Future[Either[WithdrawLotRejected, Unit]]

  /**
   * Окно, запущенное по ходу торгов (ADR-047, дополнение 2026-10-12). Подтверждение — и записанное окно, и принятое без
   * записи: окно в чужой валюте лот отбрасывает, и ждать от него больше нечего.
   */
  def addWindow(lot: LotId, command: AddStepWindow): Future[Either[AddStepWindowRejected, Unit]]

  /**
   * Условия лота в периоде «Счастливых часов» (PER-786). Подтверждение — и записанное окно, и принятое без записи, и
   * отказ: лот, ушедший из торгов, и период, который уже начался, ждать от лота больше нечего.
   */
  def setPeriodWindow(lot: LotId, command: SetPeriodWindow): Future[Either[PeriodWindowRejected, Unit]]

  /** Снятие условий лота в периоде (PER-786); подтверждение — как у [[setPeriodWindow]]. */
  def clearPeriodWindow(lot: LotId, command: ClearPeriodWindow): Future[Either[PeriodWindowRejected, Unit]]
}

object AuctionLots {

  /**
   * Лоты через Cluster Sharding. Вопрос о состоянии поднимает entity лота, и та восстанавливает свой журнал (ADR-045).
   * Инициатор открытия и закрытия — планировщик: аукцион открывает лот и после своего рестарта, когда человека рядом
   * нет, а администратора называет строка `PrebiddingStarted` с тем же `op_id`; закрывает он лот по таймеру.
   */
  def sharded(sharding: ClusterSharding, askTimeout: FiniteDuration): AuctionLots =
    new AuctionLots {
      private given Timeout = Timeout(askTimeout)

      private def entity(lot: LotId) = sharding.entityRefFor(LotEntity.TypeKey, lot.value.toString)

      def stateOf(lot: LotId): Future[LotState] =
        entity(lot).ask[Lot](LotEntity.Get(_)).map(_.state)(using ExecutionContext.parasitic)

      def open(lot: LotId, command: OpenLot): Future[Either[OpenLotRejected, Option[Instant]]] =
        entity(lot)
          .ask[Either[OpenLotRejected, Envelope]](LotEntity.Open(command, Initiator.Scheduler, _))
          .flatMap(answer => Future.fromTry(confirmation(answer)))(using ExecutionContext.parasitic)

      def close(lot: LotId, command: CloseLot): Future[Either[CloseLotRejected, Closure]] =
        entity(lot)
          .ask[Either[CloseLotRejected, Envelope]](LotEntity.Close(command, Initiator.Scheduler, _))
          .flatMap(answer => Future.fromTry(closure(answer)))(using ExecutionContext.parasitic)

      def closeByAuctioneer(
          lot: LotId,
          command: CloseLot,
          initiator: Initiator
      ): Future[Either[CloseLotRejected, Envelope]] =
        entity(lot).ask[Either[CloseLotRejected, Envelope]](LotEntity.Close(command, initiator, _))

      // Возвращает лот в финал аукцион, а не человек: ведущий нажал «следующий лот», но команду лоту решает аукцион.
      def resume(lot: LotId, command: ResumeLot): Future[Either[ResumeLotRejected, Unit]] =
        entity(lot)
          .ask[Either[ResumeLotRejected, Envelope]](LotEntity.Resume(command, Initiator.Scheduler, _))
          .flatMap(answer => Future.fromTry(resumption(answer)))(using ExecutionContext.parasitic)

      // Принятый ответ лота — всегда конверт `LotScheduled`: чужой `op_id` лот отклоняет сам (`OpIdTaken`).
      def schedule(lot: LotId, command: ScheduleLot, initiator: Initiator): Future[Either[ScheduleLotRejected, Unit]] =
        entity(lot)
          .ask[Either[ScheduleLotRejected, Envelope]](LotEntity.Plan(command, initiator, _))
          .map(_.map(_ => ()))(using ExecutionContext.parasitic)

      // Как у `schedule`: принятый ответ — всегда конверт своей команды, чужой `op_id` лот отклоняет `OpIdTaken`.
      def mark(lot: LotId, command: MarkForFinal, initiator: Initiator): Future[Either[MarkForFinalRejected, Unit]] =
        entity(lot)
          .ask[Either[MarkForFinalRejected, Envelope]](LotEntity.MarkFinal(command, initiator, _))
          .map(_.map(_ => ()))(using ExecutionContext.parasitic)

      def unmark(
          lot: LotId,
          command: UnmarkForFinal,
          initiator: Initiator
      ): Future[Either[UnmarkForFinalRejected, Unit]] =
        entity(lot)
          .ask[Either[UnmarkForFinalRejected, Envelope]](LotEntity.UnmarkFinal(command, initiator, _))
          .map(_.map(_ => ()))(using ExecutionContext.parasitic)

      // Как у `mark`: принятый ответ — конверт своей команды, чужой `op_id` лот отклоняет `OpIdTaken`.
      def advanceAsk(lot: LotId, command: AdvanceAsk, initiator: Initiator): Future[Either[AdvanceAskRejected, Unit]] =
        entity(lot)
          .ask[Either[AdvanceAskRejected, Envelope]](LotEntity.Ask(command, initiator, _))
          .map(_.map(_ => ()))(using ExecutionContext.parasitic)

      // Как у `mark`: повтор того же `op_id` отвечает исходным конвертом и текущим номером лота.
      def removeParticipant(
          lot: LotId,
          command: RemoveParticipant,
          initiator: Initiator
      ): Future[Either[RemoveParticipantRejected, Long]] =
        entity(lot)
          .ask[Either[RemoveParticipantRejected, LotEntity.Recorded]](LotEntity.Remove(command, initiator, _))
          .map(_.map(_.lotVersion))(using ExecutionContext.parasitic)

      def previewRemoval(
          lot: LotId,
          participant: ParticipantId
      ): Future[Either[RemoveParticipantRejected, LotEntity.RemovalPreview]] =
        entity(lot).ask[Either[RemoveParticipantRejected, LotEntity.RemovalPreview]](
          LotEntity.PreviewRemoval(participant, _)
        )

      // Снимает лот аукцион, а не человек, как открывает: после рестарта он доснимает лоты сам. Кто отменил аукцион,
      // называет его строка `AuctionCancelled`; чужой `op_id` лот отклоняет `OpIdTaken`.
      def withdraw(lot: LotId, command: WithdrawLot): Future[Either[WithdrawLotRejected, Unit]] =
        entity(lot)
          .ask[Either[WithdrawLotRejected, Envelope]](LotEntity.Withdraw(command, Initiator.Scheduler, _))
          .map(_.map(_ => ()))(using ExecutionContext.parasitic)

      // Доставляет окно аукцион, а не человек: после рестарта он шлёт его сам. Кто запустил окно, называет строка
      // `StepWindowLaunched`; чужой `op_id` лот отклоняет `OpIdTaken`.
      def addWindow(lot: LotId, command: AddStepWindow): Future[Either[AddStepWindowRejected, Unit]] =
        entity(lot)
          .ask[Either[AddStepWindowRejected, Option[Envelope]]](LotEntity.AddWindow(command, Initiator.Scheduler, _))
          .map(_.map(_ => ()))(using ExecutionContext.parasitic)

      // Условия периода доставляет аукцион, а не человек: после рестарта он шлёт их сам. Кто их задал, называет строка
      // аукциона под тем же `op_id` правки.
      def setPeriodWindow(lot: LotId, command: SetPeriodWindow): Future[Either[PeriodWindowRejected, Unit]] =
        entity(lot)
          .ask[Either[PeriodWindowRejected, Option[Envelope]]](LotEntity.SetPeriod(command, Initiator.Scheduler, _))
          .map(_.map(_ => ()))(using ExecutionContext.parasitic)

      def clearPeriodWindow(lot: LotId, command: ClearPeriodWindow): Future[Either[PeriodWindowRejected, Unit]] =
        entity(lot)
          .ask[Either[PeriodWindowRejected, Option[Envelope]]](LotEntity.ClearPeriod(command, Initiator.Scheduler, _))
          .map(_.map(_ => ()))(using ExecutionContext.parasitic)
    }

  /**
   * Подтверждение открытия — только конверт `LotOpened`. Лот отвечает на повтор `op_id` исходным конвертом, каким бы
   * событием он ни был: если под `op_id` команды открытия у лота уже записано другое событие, такой ответ — не
   * открытие, и лот остаётся без ответа, а не становится активным. Истину даст следующий вопрос о состоянии.
   */
  def confirmation(answer: Either[OpenLotRejected, Envelope]): Try[Either[OpenLotRejected, Option[Instant]]] =
    answer match {
      case Left(rejected) => Success(Left(rejected))
      case Right(Envelope(_, _, opened: LotEvent.LotOpened)) => Success(Right(opened.deadline))
      case Right(other) =>
        Failure(new IllegalStateException(s"lot answered OpenLot with ${other.event.getClass.getSimpleName}"))
    }

  /**
   * Закрытие подтверждает только конверт `LotSold`, `LotUnsold` или `LotHeldForFinal` — по той же причине, что и
   * открытие. Удержанный лот закрытием не продан, но конца онлайн-торгов он больше не держит.
   */
  def closure(answer: Either[CloseLotRejected, Envelope]): Try[Either[CloseLotRejected, Closure]] =
    answer match {
      case Left(rejected) => Success(Left(rejected))
      case Right(Envelope(_, _, _: LotEvent.LotSold | _: LotEvent.LotUnsold)) => Success(Right(Closure.Closed))
      case Right(Envelope(_, _, _: LotEvent.LotHeldForFinal)) => Success(Right(Closure.Held))
      case Right(other) =>
        Failure(new IllegalStateException(s"lot answered CloseLot with ${other.event.getClass.getSimpleName}"))
    }

  /**
   * Исход закрытия ведущим: продажа или закрытие без продажи — и на повтор того же `op_id` тоже, исходным конвертом.
   * Конверт другого события значит, что `op_id` ведущего лот уже записал под другой командой. Лот реестра без журнала —
   * дефект, а не отказ: `AddLot` рождает лот раньше, чем пишет его в реестр.
   */
  def ending(answer: Either[CloseLotRejected, Envelope]): Try[Either[CloseAuctionLotRejected, LotEnding]] =
    answer match {
      case Right(Envelope(_, _, LotEvent.LotSold(winner, price, bidId, at))) =>
        Success(Right(LotEnding.Sold(Sale(winner, price, bidId, at))))
      case Right(Envelope(_, _, LotEvent.LotUnsold(reason))) => Success(Right(LotEnding.Unsold(reason)))
      case Right(_) => Success(Left(CloseAuctionLotRejected.OpIdTaken))
      case Left(CloseLotRejected.LotNotOpen) => Success(Left(CloseAuctionLotRejected.LotNotOpen))
      case Left(CloseLotRejected.DeadlineNotReached) => Success(Left(CloseAuctionLotRejected.DeadlineNotReached))
      case Left(CloseLotRejected.LotNotFound) =>
        Failure(new IllegalStateException("a lot of the registry has no journal"))
    }

  /** Возврат в торги подтверждает только конверт `LotResumed` — по той же причине, что и открытие. */
  def resumption(answer: Either[ResumeLotRejected, Envelope]): Try[Either[ResumeLotRejected, Unit]] =
    answer match {
      case Left(rejected) => Success(Left(rejected))
      case Right(Envelope(_, _, LotEvent.LotResumed)) => Success(Right(()))
      case Right(other) =>
        Failure(new IllegalStateException(s"lot answered ResumeLot with ${other.event.getClass.getSimpleName}"))
    }
}
