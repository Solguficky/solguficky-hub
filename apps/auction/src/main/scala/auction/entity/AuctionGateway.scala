package auction.entity

import auction.aggregate.*
import auction.catalog.LotId
import auction.lot.AuctionId
import auction.lot.MarkForFinalRejected
import auction.lot.OpId
import auction.lot.UnmarkForFinalRejected
import org.apache.pekko.cluster.sharding.typed.scaladsl.ClusterSharding
import org.apache.pekko.util.Timeout

import scala.concurrent.Future
import scala.concurrent.duration.FiniteDuration

/**
 * Команды аукциона для тех, кто стоит снаружи entity, — как [[LotGateway]]. Неудачное `Future` — ответа нет: ask истёк
 * или шардинг не доставил команду; команда могла быть принята, и повтор с тем же `op_id` вернёт исходный ответ.
 */
trait AuctionGateway {
  def inspect(auctionId: AuctionId, opId: OpId): Future[Inspection]

  /** Аукцион целиком, как его знает entity; ничего не пишет. */
  def get(auctionId: AuctionId): Future[Auction]

  def draft(auctionId: AuctionId, command: DraftAuction, initiator: Initiator): Future[AuctionAnswer]

  def addLot(auctionId: AuctionId, command: AddLot, initiator: Initiator): Future[Either[AddLotRejected, AuctionAnswer]]

  def removeLot(
      auctionId: AuctionId,
      command: RemoveLot,
      initiator: Initiator
  ): Future[Either[RemoveLotRejected, AuctionAnswer]]

  /** Определение сета лотов до старта торгов (ADR-073). */
  def saveLotSet(
      auctionId: AuctionId,
      command: SaveLotSet,
      initiator: Initiator
  ): Future[Either[SaveLotSetRejected, AuctionAnswer]]

  def deleteLotSet(
      auctionId: AuctionId,
      command: DeleteLotSet,
      initiator: Initiator
  ): Future[Either[DeleteLotSetRejected, AuctionAnswer]]

  def schedule(
      auctionId: AuctionId,
      command: ScheduleAuction,
      initiator: Initiator
  ): Future[Either[ScheduleAuctionRejected, AuctionAnswer]]

  /** Открытие онлайн-торгов. Ответ приходит после ответа слота и записи события и подтверждений лотов не ждёт. */
  def startPrebidding(
      auctionId: AuctionId,
      command: StartPrebidding,
      initiator: Initiator
  ): Future[Either[OpeningRejected, AuctionAnswer]]

  /** Удаление аукциона до торгов. */
  def discard(
      auctionId: AuctionId,
      command: DiscardAuction,
      initiator: Initiator
  ): Future[Either[DiscardAuctionRejected, AuctionAnswer]]

  /** Публикация или снятие аукциона до торгов (ADR-047, дополнение 2026-10-20). */
  def changeVisibility(
      auctionId: AuctionId,
      command: ChangeVisibility,
      initiator: Initiator
  ): Future[Either[VisibilityRejected, AuctionAnswer]]

  /** Ориентировочное время финала (ADR-040, дополнение 2026-10-19): выставить, изменить или снять. */
  def setFinalTime(
      auctionId: AuctionId,
      command: SetFinalTime,
      initiator: Initiator
  ): Future[Either[FinalTimeRejected, AuctionAnswer]]

  /** Отмена после старта торгов. Ответ приходит после записи события и снятия лотов не ждёт. */
  def cancel(
      auctionId: AuctionId,
      command: CancelAuction,
      initiator: Initiator
  ): Future[Either[CancelAuctionRejected, AuctionAnswer]]

  /** Условия торгов лоту реестра. Ответ приходит после ответа лота: событие пишет он, а не аукцион. */
  def scheduleLot(
      auctionId: AuctionId,
      command: ScheduleAuctionLot,
      initiator: Initiator
  ): Future[Either[ScheduleAuctionLotRejected, Unit]]

  /** Отметка лота реестра для финала. Ответ приходит после ответа лота, как у `scheduleLot`. */
  def selectForFinal(
      auctionId: AuctionId,
      command: SelectForFinal,
      initiator: Initiator
  ): Future[Either[FinalChoiceRejected[MarkForFinalRejected], Unit]]

  def deselectForFinal(
      auctionId: AuctionId,
      command: DeselectForFinal,
      initiator: Initiator
  ): Future[Either[FinalChoiceRejected[UnmarkForFinalRejected], Unit]]

  /** Снятие участника с лота реестра. Ответ — номер лота после ответа лота, как у `selectForFinal`. */
  def removeParticipant(
      auctionId: AuctionId,
      command: RemoveLotParticipant,
      initiator: Initiator
  ): Future[Either[ParticipantRemovalRejected, Long]]

  /** Предпросмотр того же снятия: итог лота без записи. */
  def previewParticipantRemoval(
      auctionId: AuctionId,
      command: PreviewLotParticipantRemoval
  ): Future[Either[ParticipantRemovalRejected, LotEntity.RemovalPreview]]

  /** Запуск окна сниженного шага. Ответ — после записи `StepWindowLaunched`, лотов он не ждёт. */
  def launchStepWindow(
      auctionId: AuctionId,
      command: LaunchStepWindow,
      initiator: Initiator
  ): Future[Either[LaunchStepWindowRejected, AuctionAnswer]]

  /** Ask ведущего лоту реестра. Ответ приходит после ответа лота, как у `scheduleLot`. */
  def advanceAsk(
      auctionId: AuctionId,
      command: AdvanceLotAsk,
      initiator: Initiator
  ): Future[Either[AdvanceLotAskRejected, Unit]]

  /** Заморозка состава финала в перерыве. */
  def freezeFinalLineup(
      auctionId: AuctionId,
      command: FreezeFinalLineup,
      initiator: Initiator
  ): Future[Either[FreezeFinalLineupRejected, AuctionAnswer]]

  def startFinal(
      auctionId: AuctionId,
      command: StartFinal,
      initiator: Initiator
  ): Future[Either[StartFinalRejected, AuctionAnswer]]

  /** Следующий лот финала. Ответ — лот, вернувшийся в торги, после записи его активации. */
  def startNextLot(
      auctionId: AuctionId,
      command: StartNextLot,
      initiator: Initiator
  ): Future[Either[StartNextLotRejected, LotId]]

  /** Закрытие лота ведущим. Ответ — исход лота, у активного лота финала — после записи его завершения. */
  def closeLot(
      auctionId: AuctionId,
      command: CloseAuctionLot,
      initiator: Initiator
  ): Future[Either[CloseAuctionLotRejected, LotEnding]]
}

object AuctionGateway {

  /**
   * Шлюз через Cluster Sharding: идентификатор entity — идентификатор аукциона, как в `AuctionNode.registerAuctions`.
   */
  def sharded(sharding: ClusterSharding, askTimeout: FiniteDuration): AuctionGateway =
    new AuctionGateway {
      private given Timeout = Timeout(askTimeout)

      private def entity(auctionId: AuctionId) =
        sharding.entityRefFor(AuctionEntity.TypeKey, auctionId.value.toString)

      def inspect(auctionId: AuctionId, opId: OpId): Future[Inspection] =
        entity(auctionId).ask(AuctionEntity.Inspect(opId, _))

      def get(auctionId: AuctionId): Future[Auction] =
        entity(auctionId).ask(AuctionEntity.Get(_))

      def draft(auctionId: AuctionId, command: DraftAuction, initiator: Initiator): Future[AuctionAnswer] =
        entity(auctionId).ask(AuctionEntity.Draft(command, initiator, _))

      def addLot(
          auctionId: AuctionId,
          command: AddLot,
          initiator: Initiator
      ): Future[Either[AddLotRejected, AuctionAnswer]] =
        entity(auctionId).ask(AuctionEntity.Add(command, initiator, _))

      def removeLot(
          auctionId: AuctionId,
          command: RemoveLot,
          initiator: Initiator
      ): Future[Either[RemoveLotRejected, AuctionAnswer]] =
        entity(auctionId).ask(AuctionEntity.Remove(command, initiator, _))

      def saveLotSet(
          auctionId: AuctionId,
          command: SaveLotSet,
          initiator: Initiator
      ): Future[Either[SaveLotSetRejected, AuctionAnswer]] =
        entity(auctionId).ask(AuctionEntity.SaveSet(command, initiator, _))

      def deleteLotSet(
          auctionId: AuctionId,
          command: DeleteLotSet,
          initiator: Initiator
      ): Future[Either[DeleteLotSetRejected, AuctionAnswer]] =
        entity(auctionId).ask(AuctionEntity.DeleteSet(command, initiator, _))

      def schedule(
          auctionId: AuctionId,
          command: ScheduleAuction,
          initiator: Initiator
      ): Future[Either[ScheduleAuctionRejected, AuctionAnswer]] =
        entity(auctionId).ask(AuctionEntity.Schedule(command, initiator, _))

      def startPrebidding(
          auctionId: AuctionId,
          command: StartPrebidding,
          initiator: Initiator
      ): Future[Either[OpeningRejected, AuctionAnswer]] =
        entity(auctionId).ask(AuctionEntity.Start(command, initiator, _))

      def discard(
          auctionId: AuctionId,
          command: DiscardAuction,
          initiator: Initiator
      ): Future[Either[DiscardAuctionRejected, AuctionAnswer]] =
        entity(auctionId).ask(AuctionEntity.Discard(command, initiator, _))

      def changeVisibility(
          auctionId: AuctionId,
          command: ChangeVisibility,
          initiator: Initiator
      ): Future[Either[VisibilityRejected, AuctionAnswer]] =
        entity(auctionId).ask(AuctionEntity.Show(command, initiator, _))

      def setFinalTime(
          auctionId: AuctionId,
          command: SetFinalTime,
          initiator: Initiator
      ): Future[Either[FinalTimeRejected, AuctionAnswer]] =
        entity(auctionId).ask(AuctionEntity.Announce(command, initiator, _))

      def cancel(
          auctionId: AuctionId,
          command: CancelAuction,
          initiator: Initiator
      ): Future[Either[CancelAuctionRejected, AuctionAnswer]] =
        entity(auctionId).ask(AuctionEntity.Cancel(command, initiator, _))

      def scheduleLot(
          auctionId: AuctionId,
          command: ScheduleAuctionLot,
          initiator: Initiator
      ): Future[Either[ScheduleAuctionLotRejected, Unit]] =
        entity(auctionId).ask(AuctionEntity.PlanLot(command, initiator, _))

      def selectForFinal(
          auctionId: AuctionId,
          command: SelectForFinal,
          initiator: Initiator
      ): Future[Either[FinalChoiceRejected[MarkForFinalRejected], Unit]] =
        entity(auctionId).ask(AuctionEntity.Select(command, initiator, _))

      def deselectForFinal(
          auctionId: AuctionId,
          command: DeselectForFinal,
          initiator: Initiator
      ): Future[Either[FinalChoiceRejected[UnmarkForFinalRejected], Unit]] =
        entity(auctionId).ask(AuctionEntity.Deselect(command, initiator, _))

      def removeParticipant(
          auctionId: AuctionId,
          command: RemoveLotParticipant,
          initiator: Initiator
      ): Future[Either[ParticipantRemovalRejected, Long]] =
        entity(auctionId).ask(AuctionEntity.RemoveParticipantFromLot(command, initiator, _))

      def previewParticipantRemoval(
          auctionId: AuctionId,
          command: PreviewLotParticipantRemoval
      ): Future[Either[ParticipantRemovalRejected, LotEntity.RemovalPreview]] =
        entity(auctionId).ask(AuctionEntity.PreviewParticipantRemoval(command, _))

      def launchStepWindow(
          auctionId: AuctionId,
          command: LaunchStepWindow,
          initiator: Initiator
      ): Future[Either[LaunchStepWindowRejected, AuctionAnswer]] =
        entity(auctionId).ask(AuctionEntity.Launch(command, initiator, _))

      def advanceAsk(
          auctionId: AuctionId,
          command: AdvanceLotAsk,
          initiator: Initiator
      ): Future[Either[AdvanceLotAskRejected, Unit]] =
        entity(auctionId).ask(AuctionEntity.AskLot(command, initiator, _))

      def freezeFinalLineup(
          auctionId: AuctionId,
          command: FreezeFinalLineup,
          initiator: Initiator
      ): Future[Either[FreezeFinalLineupRejected, AuctionAnswer]] =
        entity(auctionId).ask(AuctionEntity.Freeze(command, initiator, _))

      def startFinal(
          auctionId: AuctionId,
          command: StartFinal,
          initiator: Initiator
      ): Future[Either[StartFinalRejected, AuctionAnswer]] =
        entity(auctionId).ask(AuctionEntity.BeginFinal(command, initiator, _))

      def startNextLot(
          auctionId: AuctionId,
          command: StartNextLot,
          initiator: Initiator
      ): Future[Either[StartNextLotRejected, LotId]] =
        entity(auctionId).ask(AuctionEntity.Next(command, initiator, _))

      def closeLot(
          auctionId: AuctionId,
          command: CloseAuctionLot,
          initiator: Initiator
      ): Future[Either[CloseAuctionLotRejected, LotEnding]] =
        entity(auctionId).ask(AuctionEntity.CloseByAuctioneer(command, initiator, _))
    }
}
