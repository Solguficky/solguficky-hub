package auction.grpc

import auction.aggregate.Auction
import auction.contract.AuctionValues
import auction.lot.Lot
import auction.lot.LotState
import auction.lot.ParticipantId
import auction.prediction.PredictionTally
import auction.projection.AuctionSnapshotView
import auction.projection.LotSnapshotView
import auction.v1.auction_service as wire

import java.time.Duration
import java.time.Instant

/**
 * Пульт администратора сходки (PER-320) в форме `AuctionConsole`. Только здесь до заморозки состава видна отметка для
 * финала: в снимке лота её нет, потому что выбор организатора до объявления состава рабочий (RFC-011).
 *
 * Просроченный лот — тот же, что считает метрика `auction.lots.overdue`: в торгах по read model, с дедлайном раньше
 * `now − grace`. Одно определение на метрику и пульт, поэтому допуск на отставание проекции у них общий.
 */
object ConsoleMapping {

  def console(
      auction: AuctionSnapshotView,
      lots: List[LotSnapshotView],
      viewer: ParticipantId,
      now: Instant,
      grace: Duration
  ): wire.AuctionConsole =
    wire.AuctionConsole(
      auction = Some(ResponseMapping.auctionSnapshot(auction)),
      lots = lots.map { view =>
        wire.ConsoleLot(
          lot = Some(SnapshotMapping.snapshot(view, viewer, now)),
          markedForFinal = marked(view.lot),
          overdue = overdue(view.lot, now, grace)
        )
      },
      // Запущенные по ходу торгов окна (PER-615): пульт показывает их рядом с объявленными, и в конфигурации их
      // нет — конфигурация заменяется планированием и заморожена после открытия недели.
      launchedStepWindows = auction.auction.launched.map(_.window).map(AuctionValues.stepWindow),
      // Сеты (ADR-073, п. 3; PER-509) — из агрегата, все, и неполные: организатор собирает сет постепенно и видит его
      // до второго лота. Снимок лота неполный сет не показывает.
      lotSets = lotSets(auction.auction),
      // Сходка аукциона (PER-782): пульт открыт только тому, чьё право на эту сходку проверено, и по ней бот адресует
      // объявление аукциона. Снимок аукциона и чтения участника её не называют.
      meetupId = auction.auction.meetup.fold("")(_.value.toString)
    )

  /**
   * Розыгрыш и прогнозы числами (PER-734): организаторы подбирают призы по числу участников. Только агрегаты — ни
   * имени, ни идентификатора. Числа больше `uint32` в аукционе сообщества не бывает, поэтому они не усекаются.
   */
  def withParticipation(
      console: wire.AuctionConsole,
      registrations: Option[Int],
      tally: Option[PredictionTally]
  ): wire.AuctionConsole =
    console.copy(
      raffleRegistrations = registrations,
      predictions = tally.map(found =>
        wire.ConsolePredictions(participants = found.participants.toInt, answers = found.answers.toInt)
      )
    )

  /** Сеты аукциона в порядке идентификатора: UUIDv7 сортируется по времени создания, и номер сета в пульте устойчив. */
  def lotSets(auction: Auction): List[wire.ConsoleLotSet] =
    auction.sets.toList.sortBy(_._1.value.toString).map { case (id, set) =>
      wire.ConsoleLotSet(
        lotSetId = id.value.toString,
        name = set.name.value,
        lotIds = set.lots.map(_.value.toString)
      )
    }

  /** Отмечен для финала: в торгах с отметкой либо уже удержан — удерживается только отмеченный лот. */
  def marked(lot: Lot): Boolean =
    lot.state match {
      case LotState.Trading(trading) => trading.markedForFinal
      case LotState.Held(_) => true
      case _ => false
    }

  def overdue(lot: Lot, now: Instant, grace: Duration): Boolean =
    lot.state match {
      case LotState.Trading(trading) => trading.deadline.exists(_.isBefore(now.minus(grace)))
      case _ => false
    }
}
