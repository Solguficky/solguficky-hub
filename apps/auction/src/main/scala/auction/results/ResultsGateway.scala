package auction.results

import auction.lot.AuctionId
import org.apache.pekko.Done
import org.apache.pekko.cluster.sharding.typed.scaladsl.ClusterSharding
import org.apache.pekko.util.Timeout

import scala.concurrent.ExecutionContext
import scala.concurrent.Future
import scala.concurrent.duration.FiniteDuration

/**
 * Итоги, какими их видит чтение: состояние игры вместе со строками участников (для чтения и факта). `Cancelled` —
 * аукцион отменён: итогов у игры нет и не будет (ADR-067, п. 4). Знание об отмене живёт у аукциона, а не у этой entity
 * — торгов пакет не знает, — поэтому `Cancelled` выставляет граница по состоянию аукциона.
 */
enum ResultsView {
  case Unsettled
  case Counted(outcomes: List[NominationOutcome], rows: List[ResultRow])
  case ByHand
  case Cancelled
}

/**
 * Подсчёт и чтение итогов для транспорта — как `RaffleGateway` у розыгрыша. Неудачное `Future` — ответа нет: ask истёк
 * или хранилище не ответило; подсчёт идемпотентен, и повтор снова доведёт его до конца.
 */
trait ResultsGateway {
  def settle(auction: AuctionId): Future[Either[SettleRefused, Done]]

  def recordManually(auction: AuctionId): Future[Done]

  def read(auction: AuctionId): Future[ResultsView]
}

object ResultsGateway {

  def sharded(sharding: ClusterSharding, store: ResultsStore, askTimeout: FiniteDuration)(using
      ExecutionContext
  ): ResultsGateway =
    new ResultsGateway {
      private given Timeout = Timeout(askTimeout)

      private def entity(auction: AuctionId) = sharding.entityRefFor(ResultsEntity.TypeKey, auction.value.toString)

      def settle(auction: AuctionId): Future[Either[SettleRefused, Done]] =
        entity(auction).ask(ResultsEntity.Settle(_))

      def recordManually(auction: AuctionId): Future[Done] = entity(auction).ask(ResultsEntity.RecordManually(_))

      def read(auction: AuctionId): Future[ResultsView] =
        for {
          state <- entity(auction).ask[Results](ResultsEntity.Get(_))
          rows <- store.read(auction)
        } yield state match {
          case Results.Unsettled => ResultsView.Unsettled
          case Results.Counted(outcomes) => ResultsView.Counted(outcomes, rows)
          case Results.ByHand => ResultsView.ByHand
        }
    }
}
