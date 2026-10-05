package auction.entity

import auction.catalog.LotId
import auction.lot.Envelope
import auction.lot.Lot
import auction.lot.LotEvent
import auction.lot.LotState
import auction.lot.OpenLot
import auction.lot.OpenLotRejected
import org.apache.pekko.cluster.sharding.typed.scaladsl.ClusterSharding
import org.apache.pekko.util.Timeout

import scala.concurrent.ExecutionContext
import scala.concurrent.Future
import scala.concurrent.duration.FiniteDuration
import scala.util.Failure
import scala.util.Success
import scala.util.Try

/**
 * Лоты, какими их видит entity аукциона: вопрос о состоянии и команда открытия. Это не [[LotGateway]]: тот — порт
 * транспорта, а `OpenLot` шлёт лоту сам аукцион, и межсервисной поверхности у него нет (integration.md, «Auction
 * gRPC»).
 *
 * Неудачное `Future` — ответа нет: ask истёк или шардинг не доставил сообщение. Команда при этом могла быть принята,
 * поэтому аукцион после такого ответа снова спрашивает состояние, а не считает лот закрытым.
 */
trait AuctionLots {
  def stateOf(lot: LotId): Future[LotState]

  def open(lot: LotId, command: OpenLot): Future[Either[OpenLotRejected, Unit]]
}

object AuctionLots {

  /**
   * Лоты через Cluster Sharding. Вопрос о состоянии поднимает entity лота, и та восстанавливает свой журнал (ADR-045).
   * Инициатор открытия — планировщик: аукцион открывает лот и после своего рестарта, когда человека рядом нет, а
   * администратора называет строка `PrebiddingStarted` с тем же `op_id`.
   */
  def sharded(sharding: ClusterSharding, askTimeout: FiniteDuration): AuctionLots =
    new AuctionLots {
      private given Timeout = Timeout(askTimeout)

      private def entity(lot: LotId) = sharding.entityRefFor(LotEntity.TypeKey, lot.value.toString)

      def stateOf(lot: LotId): Future[LotState] =
        entity(lot).ask[Lot](LotEntity.Get(_)).map(_.state)(using ExecutionContext.parasitic)

      def open(lot: LotId, command: OpenLot): Future[Either[OpenLotRejected, Unit]] =
        entity(lot)
          .ask[Either[OpenLotRejected, Envelope]](LotEntity.Open(command, Initiator.Scheduler, _))
          .flatMap(answer => Future.fromTry(confirmation(answer)))(using ExecutionContext.parasitic)
    }

  /**
   * Подтверждение открытия — только конверт `LotOpened`. Лот отвечает на повтор `op_id` исходным конвертом, каким бы
   * событием он ни был: если под `op_id` команды открытия у лота уже записано другое событие, такой ответ — не
   * открытие, и лот остаётся без ответа, а не становится активным. Истину даст следующий вопрос о состоянии.
   */
  def confirmation(answer: Either[OpenLotRejected, Envelope]): Try[Either[OpenLotRejected, Unit]] =
    answer match {
      case Left(rejected) => Success(Left(rejected))
      case Right(Envelope(_, _, _: LotEvent.LotOpened)) => Success(Right(()))
      case Right(other) =>
        Failure(new IllegalStateException(s"lot answered OpenLot with ${other.event.getClass.getSimpleName}"))
    }
}
