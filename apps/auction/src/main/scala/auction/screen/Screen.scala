package auction.screen

import auction.aggregate.Auction
import auction.aggregate.AuctionState
import auction.aggregate.MeetupLifecycle
import auction.aggregate.MeetupStanding
import auction.aggregate.MeetupVisibility
import auction.catalog.ImageVersion
import auction.lot.BidOrigin
import auction.lot.BidSource
import auction.lot.Lot
import auction.lot.LotState
import auction.lot.Money
import auction.lot.ParticipantId
import auction.projection.LotSnapshotView

import java.time.Instant
import java.util.UUID

/**
 * Публичное представление экрана зала (ADR-040, дополнение 2026-10-19). Каждое состояние заменяет предыдущее целиком:
 * разниц нет, и страница рисует то, что пришло. Внутренних идентификаторов людей, прокси-лимитов и числа участников
 * здесь нет по построению: люди приходят только отображаемым именем.
 */
enum ScreenState {

  /**
   * До заморозки состава: торги не дошли до финала. `withFinal` — у аукциона есть финал, и экран ведёт отсчёт к нему.
   * `finalAt` — ориентировочное время финала (ADR-040, дополнение 2026-10-19): его выставляет администратор, а без него
   * экран пишет «скоро».
   */
  case Upcoming(withFinal: Boolean, finalAt: Option[Instant])

  /** Состав заморожен, первый лот финала ещё не вышел. `finalAt` — тот же отсчёт, что и до заморозки. */
  case Lineup(lots: List[ScreenLot], finalAt: Option[Instant])

  /** Лот финала в торгах. */
  case Live(lot: LiveLot)

  /** Между лотами финала: исход закрытого и следующий по составу. */
  case Between(closed: ClosedLot, next: Option[ScreenLot])

  /** Аукцион завершён: проданные лоты по порядку продажи и итог сбора. */
  case Finished(sold: List[ScreenSold], totals: Totals)

  /** Аукцион отменён после старта торгов: то, что успело продаться, и итог. */
  case Cancelled(sold: List[ScreenSold], totals: Totals)
}

/** Лот так, как его видит зритель: название и версия изображения из карточки, если карточка есть. */
final case class ScreenLot(lotId: UUID, title: Option[String], image: Option[ImageVersion])

/** Ставка в ленте последних: имя, сумма и канал. */
final case class ScreenBid(name: String, amount: Money, channel: BidChannel)

/** Канал ставки (ADR-070, дополнение 2026-10-19): «зал» — ставка с источником `FLOOR`, остальное — «онлайн». */
enum BidChannel {
  case Hall
  case Online
}

object BidChannel {
  def of(origin: BidOrigin): BidChannel =
    origin match {
      case BidOrigin.Manual(BidSource.Floor) => Hall
      case BidOrigin.Manual(BidSource.Bot) | BidOrigin.Proxy => Online
    }
}

/**
 * Лот в торгах. `next` — следующая цена, главная цифра экрана: ask ведущего, если он выше цены, иначе цена плюс шаг
 * (`Lot.minRequired`). `step` — шаг при текущей цене. `startedAt` — когда лот вернулся в торги финала: у лота,
 * возвращённого до появления времени в read model, его нет. `startingPrice` и `onlineEndPrice` — база роста: стартовая
 * цена лота и цена, с которой лот удержан в конце онлайн-торгов; нет базы — нет и роста.
 */
final case class LiveLot(
    lot: ScreenLot,
    price: Money,
    ask: Option[Money],
    leader: Option[String],
    bids: List[ScreenBid],
    next: Money,
    step: Money,
    startedAt: Option[Instant],
    startingPrice: Option[Money],
    onlineEndPrice: Option[Money]
)

final case class ClosedLot(lot: ScreenLot, outcome: Outcome)

enum Outcome {
  case Sold(price: Money, buyer: String)
  case Unsold
  case Withdrawn
}

/** Проданные лоты: число и сумма по валютам. Сумма — список, а не число: валюта лота — его условие, а не аукциона. */
final case class Sales(count: Int, sums: List[Money])

/** Итог сбора всего аукциона, онлайн и в финале. Лот, проданный в перерыве, в состав не входит и считается онлайн. */
final case class Totals(all: Sales, online: Sales, inFinal: Sales)

/**
 * Проданный лот для итога: сам лот, цена, покупатель, база роста и признак состава финала из `auction_lineup`. `at` —
 * время продажи, по нему лоты идут в итоге по порядку.
 */
final case class SoldLot(
    lot: ScreenLot,
    price: Money,
    buyer: ParticipantId,
    startingPrice: Option[Money],
    onlineEndPrice: Option[Money],
    inLineup: Boolean,
    at: Instant
)

/** Проданный лот так, как его видит зритель: покупатель — отображаемое имя. */
final case class ScreenSold(
    lot: ScreenLot,
    price: Money,
    buyer: String,
    startingPrice: Option[Money],
    onlineEndPrice: Option[Money],
    inFinal: Boolean
)

/** Ставка, как её читает экран: автор, сумма и происхождение. */
final case class RecentBid(participant: ParticipantId, amount: Money, origin: BidOrigin)

/**
 * То, что прочитано для одного состояния: аукцион, лоты состава в порядке выхода, последние ставки активного лота от
 * новой к старой и проданные лоты аукциона. Последние два читаются, только когда нужны состоянию. `resumedAt` и
 * `heldPrice` — время возврата в торги и цена удержания показанного лота; `readAt` — момент чтения.
 */
final case class ScreenReading(
    auctionId: UUID,
    meetupId: UUID,
    auction: Auction,
    lineup: List[LotSnapshotView],
    recentBids: List[RecentBid],
    sold: List[SoldLot],
    resumedAt: Option[Instant] = None,
    heldPrice: Option[Money] = None,
    readAt: Instant = Instant.EPOCH
) {

  /** Кого экран назовёт: лидер и авторы ставок активного лота, покупатель закрытого и предыдущего. */
  def participants: Set[ParticipantId] = {
    val inLot =
      (Screen.shownLot(this) ++ Screen.previousLot(this)).toList.flatMap(view => Screen.people(view.lot.state))
    (inLot ++ recentBids.map(_.participant) ++ sold.map(_.buyer)).toSet
  }
}

/** Видна ли страница аукциона зрителю (ADR-040, дополнение 2026-10-19). */
enum Admission {
  case Open
  case NotFound

  /** Состояние сходки сейчас не подтвердить: Meetups недоступен или ответил без состояния. */
  case Unavailable
}

/** Ответ Meetups о сходке аукциона. */
enum StandingAnswer {
  case Found(standing: MeetupStanding)
  case Missing
  case Unavailable
}

/** Состояние сходки у Meetups — `GetMeetupStanding`: служебное чтение без человека. */
trait MeetupStandings {
  def standing(meetup: UUID): scala.concurrent.Future[StandingAnswer]
}

object Screen {

  /** Последних ставок активного лота на экране. */
  val RecentBids: Int = 5

  /**
   * Ворота страницы. «Не найдено» одинаково для скрытой сходки, сходки, отменённой до торгов, и отсутствующей: ссылка
   * не выдаёт, что аукцион был. Аукцион, отменённый после старта торгов, остаётся виден — экран говорит «Аукцион
   * отменён».
   */
  def admit(auction: Auction, answer: StandingAnswer): Admission =
    answer match {
      case StandingAnswer.Missing => Admission.NotFound
      case StandingAnswer.Unavailable => Admission.Unavailable
      case StandingAnswer.Found(MeetupStanding(_, MeetupVisibility.Hidden)) => Admission.NotFound
      case StandingAnswer.Found(MeetupStanding(MeetupLifecycle.Cancelled, _)) if auction.state.started.isEmpty =>
        Admission.NotFound
      case StandingAnswer.Found(_) => Admission.Open
    }

  /**
   * Лот, который экран показывает в финале: активный, а без него — последний завершённый. Активный лот, уже проданный
   * или закрытый без продажи до записи `FinalLotCompleted`, показывается закрытым.
   */
  def shownLot(reading: ScreenReading): Option[LotSnapshotView] =
    reading.auction.state match {
      case AuctionState.Final(_, _, _, activated, completed) =>
        val id = reading.auction.state.activeLot.orElse(completed.lastOption).orElse(activated.lastOption)
        id.flatMap(lot => reading.lineup.find(_.lotId == lot.value))
      case _ => None
    }

  /** Последний завершённый лот финала: его исход экран держит, пока следующий не вышел в торги. */
  private[screen] def previousLot(reading: ScreenReading): Option[LotSnapshotView] =
    reading.auction.state match {
      case AuctionState.Final(_, _, _, _, completed) =>
        completed.lastOption.flatMap(lot => reading.lineup.find(_.lotId == lot.value))
      case _ => None
    }

  private[screen] def people(state: LotState): List[ParticipantId] =
    state match {
      case LotState.Trading(trading) => trading.leader.toList
      case LotState.Sold(sale) => List(sale.winner)
      case _ => Nil
    }

  /** Состояние экрана. `name` — отображаемое имя участника (ADR-059). */
  def of(reading: ScreenReading, name: ParticipantId => String): ScreenState = {
    val finalAt = reading.auction.finalAt
    reading.auction.state match {
      case AuctionState.Initial | AuctionState.Draft =>
        ScreenState.Upcoming(withFinal = true, finalAt = finalAt)
      case AuctionState.Scheduled(config) => ScreenState.Upcoming(config.finalBlocks > 0, finalAt = finalAt)
      case AuctionState.Prebidding(config, _) => ScreenState.Upcoming(config.finalBlocks > 0, finalAt = finalAt)
      case AuctionState.Settling(config, _) => ScreenState.Upcoming(config.finalBlocks > 0, finalAt = finalAt)
      case AuctionState.Break(config, _) => ScreenState.Upcoming(config.finalBlocks > 0, finalAt = finalAt)
      case AuctionState.LineupFrozen(_, _, _) => ScreenState.Lineup(reading.lineup.map(lot), finalAt)
      case AuctionState.Final(_, _, _, activated, completed) =>
        shownLot(reading) match {
          case None => ScreenState.Lineup(reading.lineup.map(lot), finalAt)
          case Some(view) =>
            view.lot.state match {
              case LotState.Trading(trading) =>
                ScreenState.Live(
                  LiveLot(
                    lot(view),
                    trading.currentPrice,
                    trading.ask,
                    trading.leader.map(name),
                    reading.recentBids.map(bid =>
                      ScreenBid(name(bid.participant), bid.amount, BidChannel.of(bid.origin))
                    ),
                    Lot.minRequired(trading, reading.readAt),
                    Lot.step(trading, trading.currentPrice, reading.readAt),
                    reading.resumedAt,
                    trading.course.map(_.startingPrice),
                    reading.heldPrice
                  )
                )
              // Лот уже активирован аукционом, а `LotResumed` в read model ещё нет: проекции лота и аукциона
              // коммитят независимо. Это ещё не исход, а следующий лот.
              case LotState.Held(_) =>
                previousLot(reading).filterNot(_.lotId == view.lotId) match {
                  case Some(previous) =>
                    ScreenState.Between(ClosedLot(lot(previous), outcome(previous.lot.state, name)), Some(lot(view)))
                  case None => ScreenState.Lineup(reading.lineup.map(lot), finalAt)
                }
              case closedState =>
                val done = (activated ++ completed).map(_.value).toSet + view.lotId
                val next = reading.lineup.find(candidate => !done.contains(candidate.lotId)).map(lot)
                ScreenState.Between(ClosedLot(lot(view), outcome(closedState, name)), next)
            }
        }
      case AuctionState.Finished(_, _) => ScreenState.Finished(sold(reading.sold, name), totals(reading.sold))
      case AuctionState.Cancelled(_, _, _) => ScreenState.Cancelled(sold(reading.sold, name), totals(reading.sold))
    }
  }

  private def lot(view: LotSnapshotView): ScreenLot =
    ScreenLot(view.lotId, view.card.map(_.title.value), view.card.flatMap(_.image))

  /**
   * Лот, который не торгуется и не продан: удержанный сюда не доходит — он «следующий», — поэтому остальное — «не
   * продан».
   */
  private def outcome(state: LotState, name: ParticipantId => String): Outcome =
    state match {
      case LotState.Sold(sale) => Outcome.Sold(sale.price, name(sale.winner))
      case LotState.Withdrawn(_) => Outcome.Withdrawn
      case _ => Outcome.Unsold
    }

  /** Проданные лоты по порядку продажи. */
  private def sold(lots: List[SoldLot], name: ParticipantId => String): List[ScreenSold] =
    lots
      .sortBy(_.at)
      .map(lot => ScreenSold(lot.lot, lot.price, name(lot.buyer), lot.startingPrice, lot.onlineEndPrice, lot.inLineup))

  def totals(sold: List[SoldLot]): Totals =
    Totals(sales(sold), sales(sold.filterNot(_.inLineup)), sales(sold.filter(_.inLineup)))

  private def sales(sold: List[SoldLot]): Sales =
    Sales(
      sold.size,
      sold
        .groupMapReduce(_.price.currency)(_.price.minorUnits)(_ + _)
        .toList
        .sortBy(_._1.value)
        .map((currency, minor) => Money(minor, currency))
    )
}
