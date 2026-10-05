package auction.grpc

import auction.aggregate.AuctionState
import auction.aggregate.Denial
import auction.aggregate.Drafted
import auction.aggregate.LotSchedulingRefusal
import auction.aggregate.RemovalRefusal
import auction.catalog.CatalogRefusal
import auction.catalog.LotCard
import auction.contract.AuctionValues
import auction.lot.Envelope
import auction.lot.LotEvent
import auction.lot.Money
import auction.lot.ParticipantId
import auction.lot.PlaceBidRejected
import auction.lot.ScheduleLotRejected
import auction.lot.SetProxyLimitRejected
import auction.lot.WithdrawProxyLimitRejected
import auction.naming.DisplayKind
import auction.naming.DisplayName
import auction.naming.NamingRefusal
import auction.projection.AuctionSnapshotView
import auction.projection.LotImageView
import auction.v1.auction.Money as MoneyMessage
import auction.v1.auction_events.AuctionState as AuctionStateMessage
import auction.v1.auction_service as wire
import com.google.protobuf.ByteString
import io.grpc.Status

/**
 * Отображение доменных ответов в сообщения контракта.
 *
 * Именованный отказ торгов и каталога — значение ответа, а не статус (integration.md, «Auction gRPC»): он окончателен,
 * несёт данные, которые край показывает человеку, а статус край прочитал бы как сбой и завёл в ретрай. Статусом уходит
 * только то, что решением торгов не является: `LotNotFound` — это `NOT_FOUND` из таблицы статусов контракта, а
 * `OpIdTaken` — `ALREADY_EXISTS`: `op_id` занят другой командой, и это сбой клиента, а не исход торгов, который
 * показывают человеку.
 */
object ResponseMapping {

  def placeBid(outcome: Either[PlaceBidRejected, Envelope]): Either[Status, wire.PlaceBidResponse] =
    outcome match {
      case Right(envelope) => Right(accepted(envelope))
      case Left(PlaceBidRejected.LotNotFound) => Left(Status.NOT_FOUND.withDescription("lot not found"))
      case Left(PlaceBidRejected.OpIdTaken) => Left(opIdTaken)
      case Left(rejected) => Right(wire.PlaceBidResponse().withRefused(wire.PlaceBidRefusal(refusal(rejected))))
    }

  /** Участник не выбрал имя в аукционе лота: отказ рождается на границе, лот его не знает (ADR-059). */
  val displayNameNotChosen: wire.PlaceBidResponse =
    wire
      .PlaceBidResponse()
      .withRefused(wire.PlaceBidRefusal(wire.PlaceBidRefusal.Reason.DisplayNameNotChosen(wire.DisplayNameNotChosen())))

  /** То же для прокси-лимита: лимит без имени лот не получает. */
  val proxyDisplayNameNotChosen: wire.SetProxyLimitResponse =
    wire
      .SetProxyLimitResponse()
      .withRefused(
        wire.SetProxyLimitRefusal(wire.SetProxyLimitRefusal.Reason.DisplayNameNotChosen(wire.DisplayNameNotChosen()))
      )

  def chooseDisplayName(outcome: Either[NamingRefusal, DisplayName]): wire.ChooseDisplayNameResponse =
    outcome match {
      case Right(name) => wire.ChooseDisplayNameResponse().withAccepted(displayName(name))
      case Left(refusal) =>
        val reason = refusal match {
          case NamingRefusal.UsernameMissing =>
            wire.ChooseDisplayNameRefusal.Reason.UsernameMissing(wire.UsernameMissing())
          case NamingRefusal.AliasInvalid => wire.ChooseDisplayNameRefusal.Reason.AliasInvalid(wire.AliasInvalid())
          case NamingRefusal.AliasTaken => wire.ChooseDisplayNameRefusal.Reason.AliasTaken(wire.AliasTaken())
          case NamingRefusal.NameFrozen => wire.ChooseDisplayNameRefusal.Reason.NameFrozen(wire.NameFrozen())
        }
        wire.ChooseDisplayNameResponse().withRefused(wire.ChooseDisplayNameRefusal(reason))
    }

  /** Ключ — каноническая строка идентификатора участника, та же, что пришла в запросе. */
  def displayNames(names: Map[ParticipantId, DisplayName]): wire.GetDisplayNamesResponse =
    wire.GetDisplayNamesResponse(names.map((participant, name) => participant.value.toString -> displayName(name)))

  private def displayName(name: DisplayName): wire.DisplayName = {
    val kind = name.kind match {
      case DisplayKind.Username => wire.DisplayNameKind.DISPLAY_NAME_KIND_TELEGRAM_USERNAME
      case DisplayKind.Pseudonym => wire.DisplayNameKind.DISPLAY_NAME_KIND_ALIAS
      case DisplayKind.Placeholder => wire.DisplayNameKind.DISPLAY_NAME_KIND_PLACEHOLDER
    }
    wire.DisplayName(name.text, kind)
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
      case Left(SetProxyLimitRejected.OpIdTaken) => Left(opIdTaken)
      case Left(rejected) =>
        val reason = rejected match {
          case SetProxyLimitRejected.LotNotOpen => wire.SetProxyLimitRefusal.Reason.LotNotOpen(wire.LotNotOpen())
          case SetProxyLimitRejected.ProxyBelowCurrentPrice =>
            wire.SetProxyLimitRefusal.Reason.ProxyBelowCurrentPrice(wire.ProxyBelowCurrentPrice())
          case SetProxyLimitRejected.ProxyDisabledForLot =>
            wire.SetProxyLimitRefusal.Reason.ProxyDisabledForLot(wire.ProxyDisabledForLot())
          case SetProxyLimitRejected.CurrencyMismatch =>
            wire.SetProxyLimitRefusal.Reason.CurrencyMismatch(wire.CurrencyMismatch())
          case SetProxyLimitRejected.LotNotFound | SetProxyLimitRejected.OpIdTaken =>
            throw new IllegalStateException(s"$rejected is a status, not a refusal value")
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
      case Left(WithdrawProxyLimitRejected.OpIdTaken) => Left(opIdTaken)
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
          case CatalogRefusal.ImageTooLarge(maxBytes) =>
            wire.CreateLotCardRefusal.Reason.ImageTooLarge(wire.ImageTooLarge(maxBytes.toLong))
          case CatalogRefusal.UnsupportedImage =>
            wire.CreateLotCardRefusal.Reason.UnsupportedImage(wire.UnsupportedImage())
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
          case CatalogRefusal.ImageTooLarge(maxBytes) =>
            wire.EditLotCardRefusal.Reason.ImageTooLarge(wire.ImageTooLarge(maxBytes.toLong))
          case CatalogRefusal.UnsupportedImage =>
            wire.EditLotCardRefusal.Reason.UnsupportedImage(wire.UnsupportedImage())
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
      case PlaceBidRejected.LotNotFound | PlaceBidRejected.OpIdTaken =>
        throw new IllegalStateException(s"$rejected is a status, not a refusal value")
    }

  private val opIdTaken: Status = Status.ALREADY_EXISTS.withDescription("op_id belongs to another command")

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
   * Отказы `ScheduleLot` трёх источников — право, аукцион и лот — одним `oneof`. `OpIdTaken` — статус, как у команд
   * участника. Лот реестра без журнала невозможен: `AddLot` рождает лот раньше, чем пишет его в реестр.
   */
  def scheduleLot(outcome: Either[LotSchedulingRefusal, Unit]): Either[Status, wire.ScheduleLotResponse] =
    outcome match {
      case Right(()) => Right(wire.ScheduleLotResponse().withAccepted(wire.LotSchedulingAccepted()))
      case Left(LotSchedulingRefusal.LotNotInAuction) =>
        Right(schedulingRefused(wire.ScheduleLotRefusal.Reason.LotNotInAuction(wire.LotNotInAuction())))
      case Left(LotSchedulingRefusal.Denied(Denial.NotAdministrator)) =>
        Right(schedulingRefused(wire.ScheduleLotRefusal.Reason.NotMeetupAdministrator(wire.NotMeetupAdministrator())))
      case Left(LotSchedulingRefusal.Denied(Denial.MeetupNotFound)) =>
        Right(schedulingRefused(wire.ScheduleLotRefusal.Reason.MeetupNotFound(wire.MeetupNotFound())))
      case Left(LotSchedulingRefusal.Denied(Denial.LotsFrozen)) =>
        Right(schedulingRefused(wire.ScheduleLotRefusal.Reason.LotsFrozen(wire.LotsFrozen())))
      case Left(LotSchedulingRefusal.Denied(Denial.Unavailable)) => Left(unavailable)
      case Left(LotSchedulingRefusal.Denied(Denial.AuctionNotFound)) => Left(auctionNotFound)
      case Left(LotSchedulingRefusal.Denied(Denial.LotOfAnotherAuction)) =>
        throw new IllegalStateException("lot scheduling answered LotOfAnotherAuction")
      case Left(LotSchedulingRefusal.ByLot(ScheduleLotRejected.SchedulingClosed)) =>
        Right(schedulingRefused(wire.ScheduleLotRefusal.Reason.SchedulingClosed(wire.SchedulingClosed())))
      case Left(LotSchedulingRefusal.ByLot(ScheduleLotRejected.StepPolicyInvalid(_))) =>
        Right(schedulingRefused(wire.ScheduleLotRefusal.Reason.StepPolicyInvalid(wire.StepPolicyInvalid())))
      case Left(LotSchedulingRefusal.ByLot(ScheduleLotRejected.CurrencyMismatch)) =>
        Right(schedulingRefused(wire.ScheduleLotRefusal.Reason.CurrencyMismatch(wire.CurrencyMismatch())))
      case Left(LotSchedulingRefusal.ByLot(ScheduleLotRejected.OpIdTaken)) => Left(opIdTaken)
      case Left(LotSchedulingRefusal.ByLot(ScheduleLotRejected.LotNotFound)) =>
        throw new IllegalStateException("a lot of the registry has no journal")
    }

  private def schedulingRefused(reason: wire.ScheduleLotRefusal.Reason): wire.ScheduleLotResponse =
    wire.ScheduleLotResponse().withRefused(wire.ScheduleLotRefusal(reason))

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

  /**
   * Карточка без байтов: изображение — только версия, файл читается `GetLotImage`. Её делят ответы команд и снимок
   * лота.
   */
  private[grpc] def lotCard(card: LotCard): wire.LotCard =
    wire.LotCard(card.title.value, card.description, card.image.map(version => wire.LotImageRef(version.value)))

  /** Изображение из строки каталога как есть: версия — версия этих байтов, а не прочитанной раньше карточки. */
  def lotImage(image: LotImageView): wire.LotImage =
    wire.LotImage(ByteString.copyFrom(IArray.genericWrapArray(image.content).toArray), image.mediaType, image.version)

  private def money(amount: Money): MoneyMessage = MoneyMessage(amount.minorUnits, amount.currency.value)
}
