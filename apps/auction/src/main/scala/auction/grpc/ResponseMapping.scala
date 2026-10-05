package auction.grpc

import auction.aggregate.AuctionState
import auction.aggregate.Denial
import auction.aggregate.Drafted
import auction.aggregate.RemovalRefusal
import auction.catalog.CatalogRefusal
import auction.catalog.LotCard
import auction.contract.AuctionValues
import auction.lot.Envelope
import auction.lot.LotEvent
import auction.lot.Money
import auction.lot.PlaceBidRejected
import auction.lot.SetProxyLimitRejected
import auction.lot.WithdrawProxyLimitRejected
import auction.projection.AuctionSnapshotView
import auction.v1.auction.Money as MoneyMessage
import auction.v1.auction_events.AuctionState as AuctionStateMessage
import auction.v1.auction_service as wire
import io.grpc.Status

/**
 * Отображение доменных ответов в сообщения контракта.
 *
 * Именованный отказ торгов и каталога — значение ответа, а не статус (integration.md, «Auction gRPC»): он окончателен,
 * несёт данные, которые край показывает человеку, а статус край прочитал бы как сбой и завёл в ретрай. Статусом уходит
 * только то, что решением торгов не является: `LotNotFound` — это `NOT_FOUND` из таблицы статусов контракта.
 */
object ResponseMapping {

  def placeBid(outcome: Either[PlaceBidRejected, Envelope]): Either[Status, wire.PlaceBidResponse] =
    outcome match {
      case Right(envelope) => Right(accepted(envelope))
      case Left(PlaceBidRejected.LotNotFound) => Left(Status.NOT_FOUND.withDescription("lot not found"))
      case Left(rejected) => Right(wire.PlaceBidResponse().withRefused(wire.PlaceBidRefusal(refusal(rejected))))
    }

  /**
   * Принятый лимит ответа не несёт: выросла ли за ним цена, видно в состоянии лота (контракт). Конверт другого события
   * — дефект ядра, а не отказ.
   */
  def setProxyLimit(outcome: Either[SetProxyLimitRejected, Envelope]): Either[Status, wire.SetProxyLimitResponse] =
    outcome match {
      case Right(envelope) =>
        envelope.event match {
          case _: LotEvent.ProxyLimitSet => Right(wire.SetProxyLimitResponse().withAccepted(wire.ProxyLimitAccepted()))
          case other =>
            throw new IllegalStateException(s"lot answered a proxy limit with ${other.getClass.getSimpleName}")
        }
      case Left(SetProxyLimitRejected.LotNotFound) => Left(Status.NOT_FOUND.withDescription("lot not found"))
      case Left(rejected) =>
        val reason = rejected match {
          case SetProxyLimitRejected.LotNotOpen => wire.SetProxyLimitRefusal.Reason.LotNotOpen(wire.LotNotOpen())
          case SetProxyLimitRejected.ProxyBelowCurrentPrice =>
            wire.SetProxyLimitRefusal.Reason.ProxyBelowCurrentPrice(wire.ProxyBelowCurrentPrice())
          case SetProxyLimitRejected.ProxyDisabledForLot =>
            wire.SetProxyLimitRefusal.Reason.ProxyDisabledForLot(wire.ProxyDisabledForLot())
          case SetProxyLimitRejected.CurrencyMismatch =>
            wire.SetProxyLimitRefusal.Reason.CurrencyMismatch(wire.CurrencyMismatch())
          case SetProxyLimitRejected.LotNotFound =>
            throw new IllegalStateException("LotNotFound is a status, not a refusal value")
        }
        Right(wire.SetProxyLimitResponse().withRefused(wire.SetProxyLimitRefusal(reason)))
    }

  def withdrawProxyLimit(
      outcome: Either[WithdrawProxyLimitRejected, Envelope]
  ): Either[Status, wire.WithdrawProxyLimitResponse] =
    outcome match {
      case Right(envelope) =>
        envelope.event match {
          case _: LotEvent.ProxyLimitWithdrawn =>
            Right(wire.WithdrawProxyLimitResponse().withAccepted(wire.ProxyLimitWithdrawalAccepted()))
          case other =>
            throw new IllegalStateException(s"lot answered a proxy withdrawal with ${other.getClass.getSimpleName}")
        }
      case Left(WithdrawProxyLimitRejected.LotNotFound) => Left(Status.NOT_FOUND.withDescription("lot not found"))
      case Left(WithdrawProxyLimitRejected.NoActiveProxyLimit) =>
        Right(
          wire
            .WithdrawProxyLimitResponse()
            .withRefused(
              wire.WithdrawProxyLimitRefusal(
                wire.WithdrawProxyLimitRefusal.Reason.NoActiveProxyLimit(wire.NoActiveProxyLimit())
              )
            )
        )
    }

  def createLotCard(outcome: Either[CatalogRefusal, LotCard]): wire.CreateLotCardResponse =
    outcome match {
      case Right(card) => wire.CreateLotCardResponse().withAccepted(lotCard(card))
      case Left(refusal) =>
        val reason = refusal match {
          case CatalogRefusal.NotAdmin => wire.CreateLotCardRefusal.Reason.NotAdmin(wire.NotAdmin())
          case CatalogRefusal.EmptyTitle => wire.CreateLotCardRefusal.Reason.EmptyTitle(wire.EmptyTitle())
          case CatalogRefusal.CardConflict => wire.CreateLotCardRefusal.Reason.CardConflict(wire.CardConflict())
          case CatalogRefusal.CardNotFound =>
            throw new IllegalStateException("lot catalog creation refused with CardNotFound")
        }
        wire.CreateLotCardResponse().withRefused(wire.CreateLotCardRefusal(reason))
    }

  def editLotCard(outcome: Either[CatalogRefusal, LotCard]): wire.EditLotCardResponse =
    outcome match {
      case Right(card) => wire.EditLotCardResponse().withAccepted(lotCard(card))
      case Left(refusal) =>
        val reason = refusal match {
          case CatalogRefusal.NotAdmin => wire.EditLotCardRefusal.Reason.NotAdmin(wire.NotAdmin())
          case CatalogRefusal.EmptyTitle => wire.EditLotCardRefusal.Reason.EmptyTitle(wire.EmptyTitle())
          case CatalogRefusal.CardNotFound => wire.EditLotCardRefusal.Reason.CardNotFound(wire.CardNotFound())
          case CatalogRefusal.CardConflict =>
            throw new IllegalStateException("lot catalog edit refused with CardConflict")
        }
        wire.EditLotCardResponse().withRefused(wire.EditLotCardRefusal(reason))
    }

  /**
   * Ответ на принятую ставку — её `bid_id`. Повтор того же `op_id` приносит исходный конверт и тот же `bid_id`. Конверт
   * другого события на команду ставки — дефект ядра, а не отказ.
   */
  private def accepted(envelope: Envelope): wire.PlaceBidResponse =
    envelope.event match {
      case bid: LotEvent.BidPlaced => wire.PlaceBidResponse().withAccepted(wire.BidAccepted(bid.bidId.value.toString))
      case other =>
        throw new IllegalStateException(s"lot answered a bid with ${other.getClass.getSimpleName}")
    }

  private def refusal(rejected: PlaceBidRejected): wire.PlaceBidRefusal.Reason =
    rejected match {
      case PlaceBidRejected.LotNotOpen => wire.PlaceBidRefusal.Reason.LotNotOpen(wire.LotNotOpen())
      case PlaceBidRejected.LotOnHold => wire.PlaceBidRefusal.Reason.LotOnHold(wire.LotOnHold())
      case PlaceBidRejected.CurrencyMismatch => wire.PlaceBidRefusal.Reason.CurrencyMismatch(wire.CurrencyMismatch())
      case PlaceBidRejected.BidderIsLeader => wire.PlaceBidRefusal.Reason.BidderIsLeader(wire.BidderIsLeader())
      case PlaceBidRejected.BidNotAtNextPrice(expected) =>
        wire.PlaceBidRefusal.Reason.BidNotAtNextPrice(wire.BidNotAtNextPrice(Some(money(expected))))
      case PlaceBidRejected.BidBelowMinimum(minRequired) =>
        wire.PlaceBidRefusal.Reason.BidBelowMinimum(wire.BidBelowMinimum(Some(money(minRequired))))
      case PlaceBidRejected.LotNotFound =>
        throw new IllegalStateException("LotNotFound is a status, not a refusal value")
    }

  /**
   * Отказ по праву — значение ответа, как отказ каталога: он окончателен, и экран администратора показывает его
   * человеку. `Unavailable` — статус: право сейчас не подтвердить, и повтор уместен. Аукциона нет — `NOT_FOUND`, как у
   * лота (integration.md, «Аукцион у сходки»).
   */
  def draftAuction(outcome: Either[Denial, Drafted]): Either[Status, wire.DraftAuctionResponse] =
    outcome match {
      case Right(drafted) =>
        Right(
          wire
            .DraftAuctionResponse()
            .withAccepted(wire.DraftAuctionAccepted(drafted.auctionId.value.toString, drafted.alreadyExisted))
        )
      case Left(Denial.NotAdministrator) =>
        Right(
          wire
            .DraftAuctionResponse()
            .withRefused(
              wire.DraftAuctionRefusal(
                wire.DraftAuctionRefusal.Reason.NotMeetupAdministrator(wire.NotMeetupAdministrator())
              )
            )
        )
      case Left(Denial.MeetupNotFound) =>
        Right(
          wire
            .DraftAuctionResponse()
            .withRefused(
              wire.DraftAuctionRefusal(wire.DraftAuctionRefusal.Reason.MeetupNotFound(wire.MeetupNotFound()))
            )
        )
      case Left(Denial.Unavailable) => Left(unavailable)
      case Left(Denial.AuctionNotFound | Denial.LotsFrozen | Denial.LotOfAnotherAuction) =>
        throw new IllegalStateException("auction draft answered a registry denial")
    }

  def addLot(outcome: Either[Denial, Unit]): Either[Status, wire.AddLotResponse] =
    outcome match {
      case Right(()) => Right(wire.AddLotResponse().withAccepted(wire.LotAdditionAccepted()))
      case Left(Denial.NotAdministrator) =>
        Right(
          wire
            .AddLotResponse()
            .withRefused(
              wire.AddLotRefusal(wire.AddLotRefusal.Reason.NotMeetupAdministrator(wire.NotMeetupAdministrator()))
            )
        )
      case Left(Denial.MeetupNotFound) =>
        Right(
          wire
            .AddLotResponse()
            .withRefused(wire.AddLotRefusal(wire.AddLotRefusal.Reason.MeetupNotFound(wire.MeetupNotFound())))
        )
      case Left(Denial.LotsFrozen) =>
        Right(
          wire
            .AddLotResponse()
            .withRefused(wire.AddLotRefusal(wire.AddLotRefusal.Reason.LotsFrozen(wire.LotsFrozen())))
        )
      case Left(Denial.Unavailable) => Left(unavailable)
      case Left(Denial.AuctionNotFound) => Left(auctionNotFound)
      case Left(Denial.LotOfAnotherAuction) =>
        Left(Status.FAILED_PRECONDITION.withDescription("lot belongs to another auction"))
    }

  def removeLot(outcome: Either[RemovalRefusal, Unit]): Either[Status, wire.RemoveLotResponse] =
    outcome match {
      case Right(()) => Right(wire.RemoveLotResponse().withAccepted(wire.LotRemovalAccepted()))
      case Left(RemovalRefusal.LotNotInAuction) =>
        Right(removalRefused(wire.RemoveLotRefusal.Reason.LotNotInAuction(wire.LotNotInAuction())))
      case Left(RemovalRefusal.Denied(Denial.NotAdministrator)) =>
        Right(removalRefused(wire.RemoveLotRefusal.Reason.NotMeetupAdministrator(wire.NotMeetupAdministrator())))
      case Left(RemovalRefusal.Denied(Denial.MeetupNotFound)) =>
        Right(removalRefused(wire.RemoveLotRefusal.Reason.MeetupNotFound(wire.MeetupNotFound())))
      case Left(RemovalRefusal.Denied(Denial.LotsFrozen)) =>
        Right(removalRefused(wire.RemoveLotRefusal.Reason.LotsFrozen(wire.LotsFrozen())))
      case Left(RemovalRefusal.Denied(Denial.Unavailable)) => Left(unavailable)
      case Left(RemovalRefusal.Denied(Denial.AuctionNotFound)) => Left(auctionNotFound)
      case Left(RemovalRefusal.Denied(Denial.LotOfAnotherAuction)) =>
        throw new IllegalStateException("lot removal answered LotOfAnotherAuction")
    }

  /**
   * Снимок аукциона в форме `AuctionSnapshot`: те же поля, что `AuctionState` шины, кроме `meetup_id`. Конфигурации у
   * черновика нет, с `Scheduled` она есть всегда; реестр — по возрастанию `lot_id`, порядок смысла не несёт. Какие лоты
   * подтвердили открытие, снимок не несёт: это знание entity, а не журнала.
   */
  def auctionSnapshot(view: AuctionSnapshotView): wire.AuctionSnapshot = {
    val (status, config) = view.auction.state match {
      case AuctionState.Draft => (wire.AuctionSnapshot.Status.Draft(AuctionStateMessage.Draft()), None)
      case AuctionState.Scheduled(config) =>
        (wire.AuctionSnapshot.Status.Scheduled(AuctionStateMessage.Scheduled()), Some(config))
      case AuctionState.Prebidding(config, _) =>
        (wire.AuctionSnapshot.Status.Prebidding(AuctionStateMessage.Prebidding()), Some(config))
      case AuctionState.Initial =>
        throw new IllegalStateException(s"auction view ${view.auctionId} holds an unborn auction")
    }
    wire.AuctionSnapshot(
      id = view.auctionId.toString,
      config = config.map(AuctionValues.config),
      lotIds = view.auction.lots.toList.map(_.value).sorted.map(_.toString),
      status = status
    )
  }

  private def removalRefused(reason: wire.RemoveLotRefusal.Reason): wire.RemoveLotResponse =
    wire.RemoveLotResponse().withRefused(wire.RemoveLotRefusal(reason))

  private def unavailable: Status = Status.UNAVAILABLE.withDescription("meetup authority is unavailable")

  private def auctionNotFound: Status = Status.NOT_FOUND.withDescription("auction not found")

  private def lotCard(card: LotCard): wire.LotCard = wire.LotCard(card.title.value, card.description)

  private def money(amount: Money): MoneyMessage = MoneyMessage(amount.minorUnits, amount.currency.value)
}
