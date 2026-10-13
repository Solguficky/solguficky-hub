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
 * повторит»: раунд каталога закрывается после записи `PrebiddingStarted`, и аукцион не шлёт лотам `OpenLot`, пока
 * прогнозы не подтвердили закрытие. Закрытие раунда финала до `FinalStarted` и удаление до `AuctionDiscarded` идут в
 * обработке своих команд, а не здесь: они ждут ответа до записи.
 */
object PredictionSteps {

  /**
   * Шаги, которые нужны сейчас и ещё не подтверждены: открытие каталога у запланированного аукциона, его закрытие у
   * начавшегося, открытие финала у замороженного состава и отмена у отменённого. Отменённому закрывать раунд не нужно:
   * отмена закрывает открытый раунд сама.
   */
  def due(auction: Auction, progress: PredictionProgress): List[PredictionStep] =
    auction.state match {
      case AuctionState.Scheduled(_) if !progress.catalogOpened => List(PredictionStep.Open(PredictionRound.Catalog))
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

  /**
   * Держит ли аукцион `OpenLot`: раунд каталога не подтверждён закрытым. Вопросы к лотам и таймеры их дедлайнов идут и
   * так — лот, открытый до рестарта, закрывается по своему дедлайну, даже пока прогнозы молчат.
   */
  def holdsOpening(progress: PredictionProgress): Boolean = !progress.catalogClosed

  /**
   * Держит ли аукцион общий дедлайн: торги ещё не начались — ни один лот реестра не открыт по знанию аукциона, — а
   * раунд каталога не подтверждён. Иначе торги кончились бы, не начавшись. Начавшиеся торги дедлайн не держат.
   */
  def holdsDeadline(auction: Auction, progress: PredictionProgress, roster: LotRoster): Boolean =
    auction.state match {
      case AuctionState.Prebidding(_, _) => !progress.catalogClosed && !begun(roster)
      case _ => false
    }

  /**
   * Пускает ли подтверждение шага придержанные `OpenLot`: первое подтверждённое закрытие каталога у аукциона, который
   * ещё ждёт лоты. В `Prebidding` entity отправляет придержанные команды, в `Settling` открывать уже поздно, и опрос
   * отмечает лоты неоткрытыми.
   */
  def releases(auction: Auction, before: PredictionProgress, step: PredictionStep): Boolean =
    step == PredictionStep.Close(PredictionRound.Catalog) && !before.catalogClosed && (auction.state match {
      case AuctionState.Prebidding(_, _) | AuctionState.Settling(_, _) => true
      case _ => false
    })

  private def begun(roster: LotRoster): Boolean =
    roster.lots.values.exists {
      case LotStanding.Active | LotStanding.Closing | LotStanding.Closed | LotStanding.Held => true
      case _ => false
    }
}
