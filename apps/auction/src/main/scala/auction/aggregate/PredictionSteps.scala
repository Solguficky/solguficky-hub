package auction.aggregate

import auction.prediction.PredictionRound

/**
 * Что entity аукциона узнала от прогнозов в этой инкарнации (ADR-067, п. 4). Знание несохраняемо, как знание о лотах:
 * рестарт начинает с пустого и спрашивает снова — каждый шаг прогнозов идемпотентен.
 */
final case class PredictionProgress(
    catalogOpened: Boolean,
    catalogClosed: Boolean,
    finalOpened: Boolean,
    cancelled: Boolean
)

object PredictionProgress {
  val empty: PredictionProgress = PredictionProgress(false, false, false, false)
}

/** Шаг, который аукцион просит у прогнозов. */
enum PredictionStep {
  case Open(round: PredictionRound)
  case Close(round: PredictionRound)
  case Cancel
}

/**
 * Протокол аукциона с прогнозами чистыми функциями — как [[LotRoster]] с лотами: entity только исполняет шаги и
 * запоминает ответы. Порядок выбран так, чтобы после падения между двумя шагами оставалось «ещё не сделано, кто-то
 * повторит». Раунд каталога открыт всю онлайн-неделю и закрывается после записи `PrebiddingDeadlineReached` — в момент
 * общего дедлайна, до перерыва и заморозки состава (ADR-067, дополнение 2026-10-24); открытие торгов закрытия не ждёт.
 * Закрытие раунда финала до `FinalStarted` и удаление до `AuctionDiscarded` идут в обработке своих команд, а не здесь:
 * они ждут ответа до записи.
 */
object PredictionSteps {

  /**
   * Шаги, которые нужны сейчас и ещё не подтверждены: открытие каталога у запланированного аукциона и у аукциона в
   * онлайн-торгах, его закрытие у прошедшего общий дедлайн, открытие финала у замороженного состава и отмена у
   * отменённого. Открытие в торгах идемпотентно: раунд, уже открытый или закрытый по прежнему правилу — при открытии
   * торгов, — не переоткрывается. Отменённому закрывать раунд не нужно: отмена закрывает открытый раунд сама.
   */
  def due(auction: Auction, progress: PredictionProgress): List[PredictionStep] =
    auction.state match {
      case AuctionState.Scheduled(_) | AuctionState.Prebidding(_, _) =>
        if (progress.catalogOpened) Nil else List(PredictionStep.Open(PredictionRound.Catalog))
      case AuctionState.Cancelled(_, _, _) => if (progress.cancelled) Nil else List(PredictionStep.Cancel)
      case current if current.started.isDefined =>
        val closing =
          if (progress.catalogClosed) Nil else List(PredictionStep.Close(PredictionRound.Catalog))
        val opening = current match {
          case AuctionState.LineupFrozen(_, _, _) if !progress.finalOpened =>
            List(PredictionStep.Open(PredictionRound.Final))
          case _ => Nil
        }
        closing ++ opening
      case _ => Nil
    }

  /** Знание после подтверждения шага. Закрытие финала здесь не помнится: его ждёт сама команда старта финала. */
  def answered(progress: PredictionProgress, step: PredictionStep): PredictionProgress =
    step match {
      case PredictionStep.Open(PredictionRound.Catalog) => progress.copy(catalogOpened = true)
      case PredictionStep.Close(PredictionRound.Catalog) => progress.copy(catalogClosed = true)
      case PredictionStep.Open(PredictionRound.Final) => progress.copy(finalOpened = true)
      case PredictionStep.Close(PredictionRound.Final) => progress
      case PredictionStep.Cancel => progress.copy(cancelled = true)
    }
}
