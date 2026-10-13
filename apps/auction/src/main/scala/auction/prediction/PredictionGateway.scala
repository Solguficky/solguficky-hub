package auction.prediction

import auction.lot.AuctionId
import auction.lot.ParticipantId
import org.apache.pekko.cluster.sharding.typed.scaladsl.ClusterSharding
import org.apache.pekko.util.Timeout

import scala.concurrent.ExecutionContext
import scala.concurrent.Future
import scala.concurrent.duration.FiniteDuration

/** Игра и прогнозы одного участника: другого участника это чтение не несёт (ADR-067, п. 9). */
final case class MyPredictions(game: Predictions, forecasts: Map[PredictionRound, Forecast])

/**
 * Отправка и чтение прогнозов для транспорта — как `RaffleGateway` у розыгрыша. Неудачное `Future` — ответа нет: ask
 * истёк или хранилище не ответило; отправка могла быть принята, и повтор с тем же `op_id` вернёт исходный ответ.
 */
trait PredictionGateway {
  def submit(auction: AuctionId, command: SubmitForecast): Future[Either[SubmitRejected, Forecast]]

  def mine(auction: AuctionId, participant: ParticipantId): Future[MyPredictions]
}

object PredictionGateway {

  def sharded(sharding: ClusterSharding, store: PredictionStore, askTimeout: FiniteDuration)(using
      ExecutionContext
  ): PredictionGateway =
    new PredictionGateway {
      private given Timeout = Timeout(askTimeout)

      private def entity(auction: AuctionId) = sharding.entityRefFor(PredictionEntity.TypeKey, auction.value.toString)

      def submit(auction: AuctionId, command: SubmitForecast): Future[Either[SubmitRejected, Forecast]] =
        entity(auction).ask(PredictionEntity.Submit(command, _))

      def mine(auction: AuctionId, participant: ParticipantId): Future[MyPredictions] =
        for {
          game <- entity(auction).ask[Predictions](PredictionEntity.Get(_))
          forecasts <- store.mine(auction, participant)
        } yield MyPredictions(game, forecasts)
    }
}
