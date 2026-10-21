package auction.grpc

import auction.aggregate.AskRefusal
import auction.aggregate.AuctionState
import auction.aggregate.CancellationRefusal
import auction.aggregate.CloseAuctionLotRejected
import auction.aggregate.ClosingRefusal
import auction.aggregate.ConfigInvalid
import auction.aggregate.Denial
import auction.aggregate.DiscardRefusal
import auction.aggregate.FinalStartRefusal
import auction.aggregate.FinalTimeRefusal
import auction.aggregate.LineupRefusal
import auction.aggregate.LotEnding
import auction.aggregate.NextLotRefusal
import auction.aggregate.Drafted
import auction.aggregate.FinalChoiceRefusal
import auction.aggregate.LaunchRefusal
import auction.aggregate.LaunchStepWindowRejected
import auction.aggregate.StepWindowConfig
import auction.aggregate.LotSchedulingRefusal
import auction.aggregate.LotSetRefusal
import auction.aggregate.OpeningRefusal
import auction.aggregate.ParticipantRemovalRefusal
import auction.aggregate.RemovalRefusal
import auction.aggregate.SchedulingRefusal
import auction.aggregate.VisibilityRefusal
import auction.catalog.CatalogRefusal
import auction.catalog.LotCard
import auction.catalog.LotId
import auction.contract.AuctionValues
import auction.contract.LotValues
import auction.entity.LotEntity
import auction.lot.AdvanceAskRejected
import auction.lot.Envelope
import auction.lot.LotEvent
import auction.lot.MarkForFinalRejected
import auction.lot.Money
import auction.lot.ParticipantId
import auction.lot.PlaceBidRejected
import auction.lot.RemoveParticipantRejected
import auction.lot.ScheduleLotRejected
import auction.lot.SetProxyLimitRejected
import auction.lot.UnmarkForFinalRejected
import auction.lot.WithdrawProxyLimitRejected
import auction.naming.DisplayKind
import auction.naming.DisplayName
import auction.naming.NamedParticipant
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

  def placeBid(outcome: Either[PlaceBidRejected, LotEntity.Recorded]): Either[Status, wire.PlaceBidResponse] =
    outcome match {
      case Right(recorded) => Right(accepted(recorded))
      case Left(PlaceBidRejected.LotNotFound) => Left(Status.NOT_FOUND.withDescription("lot not found"))
      case Left(PlaceBidRejected.OpIdTaken) => Left(opIdTaken)
      case Left(rejected) => Right(wire.PlaceBidResponse().withRefused(wire.PlaceBidRefusal(refusal(rejected))))
    }

  /** Участник не выбрал имя в аукционе лота: отказ рождается на границе, лот его не знает (ADR-059). */
  val displayNameNotChosen: wire.PlaceBidResponse =
    wire
      .PlaceBidResponse()
      .withRefused(wire.PlaceBidRefusal(wire.PlaceBidRefusal.Reason.DisplayNameNotChosen(wire.DisplayNameNotChosen())))

  /** Человек, названный ставкой зала, не держит `place_bids` (ADR-070, п. 3): отказ рождается на границе. */
  val participantCannotBid: wire.PlaceBidResponse =
    wire
      .PlaceBidResponse()
      .withRefused(wire.PlaceBidRefusal(wire.PlaceBidRefusal.Reason.ParticipantCannotBid(wire.ParticipantCannotBid())))

  /**
   * Право помощника ведущего на ставку зала: отказ — значение ответа, как у команд администратора, `Unavailable` —
   * статус. Реестровых отказов у проверки права нет.
   */
  def floorDenied(denial: Denial): Either[Status, wire.PlaceBidResponse] = {
    def refused(reason: wire.PlaceBidRefusal.Reason) =
      Right(wire.PlaceBidResponse().withRefused(wire.PlaceBidRefusal(reason)))
    denial match {
      case Denial.NotAdministrator =>
        refused(wire.PlaceBidRefusal.Reason.NotMeetupAdministrator(wire.NotMeetupAdministrator()))
      case Denial.MeetupNotFound => refused(wire.PlaceBidRefusal.Reason.MeetupNotFound(wire.MeetupNotFound()))
      case Denial.Unavailable => Left(unavailable)
      case Denial.AuctionNotFound => Left(auctionNotFound)
      case Denial.MeetupCancelled | Denial.MeetupHidden | Denial.LotsFrozen | Denial.LotOfAnotherAuction =>
        throw new IllegalStateException(s"floor bid answered $denial")
    }
  }

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

  /** Имена аукциона в порядке, который посчитал сервис: сверху ставившие в финале. */
  def auctionNames(names: List[NamedParticipant]): wire.ListAuctionNamesResponse =
    wire.ListAuctionNamesResponse(
      names.map(named =>
        wire.AuctionName(participantId = named.participant.value.toString, name = Some(displayName(named.name)))
      )
    )

  private[grpc] def displayName(name: DisplayName): wire.DisplayName = {
    val kind = name.kind match {
      case DisplayKind.Username => wire.DisplayNameKind.DISPLAY_NAME_KIND_TELEGRAM_USERNAME
      case DisplayKind.Pseudonym => wire.DisplayNameKind.DISPLAY_NAME_KIND_ALIAS
      case DisplayKind.Placeholder => wire.DisplayNameKind.DISPLAY_NAME_KIND_PLACEHOLDER
    }
    wire.DisplayName(name.text, kind, name.frozen)
  }

  /**
   * Принятый лимит несёт только версию лота: выросла ли за ним цена, видно в состоянии лота начиная с неё (контракт).
   * Конверт другого события — дефект ядра, а не отказ.
   */
  def setProxyLimit(
      outcome: Either[SetProxyLimitRejected, LotEntity.Recorded]
  ): Either[Status, wire.SetProxyLimitResponse] =
    outcome match {
      case Right(LotEntity.Recorded(envelope, lotVersion)) =>
        envelope.event match {
          case _: LotEvent.ProxyLimitSet =>
            Right(wire.SetProxyLimitResponse().withAccepted(wire.ProxyLimitAccepted(lotVersion)))
          case other =>
            throw new IllegalStateException(s"lot answered a proxy limit with ${other.getClass.getSimpleName}")
        }
      case Left(SetProxyLimitRejected.LotNotFound) => Left(Status.NOT_FOUND.withDescription("lot not found"))
      case Left(SetProxyLimitRejected.OpIdTaken) => Left(opIdTaken)
      case Left(rejected) =>
        val reason = rejected match {
          case SetProxyLimitRejected.LotNotOpen => wire.SetProxyLimitRefusal.Reason.LotNotOpen(wire.LotNotOpen())
          case SetProxyLimitRejected.ProxyBelowCurrentPrice(minLimit) =>
            wire.SetProxyLimitRefusal.Reason.ProxyBelowCurrentPrice(wire.ProxyBelowCurrentPrice(Some(money(minLimit))))
          case SetProxyLimitRejected.ProxyDisabledForLot =>
            wire.SetProxyLimitRefusal.Reason.ProxyDisabledForLot(wire.ProxyDisabledForLot())
          case SetProxyLimitRejected.CurrencyMismatch =>
            wire.SetProxyLimitRefusal.Reason.CurrencyMismatch(wire.CurrencyMismatch())
          case SetProxyLimitRejected.ParticipantRemovedFromLot =>
            wire.SetProxyLimitRefusal.Reason.ParticipantRemovedFromLot(wire.ParticipantRemovedFromLot())
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
          case CatalogRefusal.CardClosed =>
            throw new IllegalStateException("lot catalog creation refused with CardClosed")
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
          case CatalogRefusal.CardClosed => wire.EditLotCardRefusal.Reason.CardClosed(wire.CardClosed())
          case CatalogRefusal.CardConflict =>
            throw new IllegalStateException("lot catalog edit refused with CardConflict")
        }
        wire.EditLotCardResponse().withRefused(wire.EditLotCardRefusal(reason))
    }

  /**
   * Ответ на принятую ставку — её `bid_id` и версия лота, с которой ставку видно в чтении. Повтор того же `op_id`
   * приносит исходный конверт и тот же `bid_id`. Конверт другого события на команду ставки — дефект ядра, а не отказ.
   */
  private def accepted(recorded: LotEntity.Recorded): wire.PlaceBidResponse =
    recorded.envelope.event match {
      case bid: LotEvent.BidPlaced =>
        wire.PlaceBidResponse().withAccepted(wire.BidAccepted(bid.bidId.value.toString, recorded.lotVersion))
      case other =>
        throw new IllegalStateException(s"lot answered a bid with ${other.getClass.getSimpleName}")
    }

  private def refusal(rejected: PlaceBidRejected): wire.PlaceBidRefusal.Reason =
    rejected match {
      case PlaceBidRejected.LotNotOpen => wire.PlaceBidRefusal.Reason.LotNotOpen(wire.LotNotOpen())
      case PlaceBidRejected.LotOnHold(currentPrice) =>
        wire.PlaceBidRefusal.Reason.LotOnHold(wire.LotOnHold(Some(money(currentPrice))))
      case PlaceBidRejected.CurrencyMismatch => wire.PlaceBidRefusal.Reason.CurrencyMismatch(wire.CurrencyMismatch())
      case PlaceBidRejected.BidderIsLeader(currentPrice) =>
        wire.PlaceBidRefusal.Reason.BidderIsLeader(wire.BidderIsLeader(Some(money(currentPrice))))
      case PlaceBidRejected.BidNotAtNextPrice(expected) =>
        wire.PlaceBidRefusal.Reason.BidNotAtNextPrice(wire.BidNotAtNextPrice(Some(money(expected))))
      case PlaceBidRejected.BidBelowMinimum(minRequired) =>
        wire.PlaceBidRefusal.Reason.BidBelowMinimum(wire.BidBelowMinimum(Some(money(minRequired))))
      case PlaceBidRejected.ParticipantRemovedFromLot =>
        wire.PlaceBidRefusal.Reason.ParticipantRemovedFromLot(wire.ParticipantRemovedFromLot())
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
      case Left(Denial.MeetupCancelled) =>
        Right(
          wire
            .DraftAuctionResponse()
            .withRefused(
              wire.DraftAuctionRefusal(wire.DraftAuctionRefusal.Reason.MeetupCancelled(wire.MeetupCancelled()))
            )
        )
      case Left(Denial.Unavailable) => Left(unavailable)
      case Left(Denial.MeetupHidden | Denial.AuctionNotFound | Denial.LotsFrozen | Denial.LotOfAnotherAuction) =>
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
      case Left(Denial.MeetupCancelled) =>
        Right(
          wire
            .AddLotResponse()
            .withRefused(wire.AddLotRefusal(wire.AddLotRefusal.Reason.MeetupCancelled(wire.MeetupCancelled())))
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
      case Left(Denial.MeetupHidden) => throw new IllegalStateException("lot addition answered MeetupHidden")
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
      case Left(RemovalRefusal.Denied(Denial.MeetupCancelled)) =>
        Right(removalRefused(wire.RemoveLotRefusal.Reason.MeetupCancelled(wire.MeetupCancelled())))
      case Left(RemovalRefusal.Denied(Denial.LotsFrozen)) =>
        Right(removalRefused(wire.RemoveLotRefusal.Reason.LotsFrozen(wire.LotsFrozen())))
      case Left(RemovalRefusal.Denied(Denial.Unavailable)) => Left(unavailable)
      case Left(RemovalRefusal.Denied(Denial.AuctionNotFound)) => Left(auctionNotFound)
      case Left(RemovalRefusal.Denied(denial @ (Denial.MeetupHidden | Denial.LotOfAnotherAuction))) =>
        throw new IllegalStateException(s"lot removal answered $denial")
    }

  /** Отказы определения сета (ADR-073): право, заморозка, название и лоты — одним `oneof`. */
  def saveLotSet(outcome: Either[LotSetRefusal, Unit]): Either[Status, wire.SaveLotSetResponse] = {
    def refused(reason: wire.SaveLotSetRefusal.Reason) =
      Right(wire.SaveLotSetResponse().withRefused(wire.SaveLotSetRefusal(reason)))
    outcome match {
      case Right(()) => Right(wire.SaveLotSetResponse().withAccepted(wire.LotSetSaved()))
      case Left(LotSetRefusal.NameEmpty) => refused(wire.SaveLotSetRefusal.Reason.NameEmpty(wire.LotSetNameEmpty()))
      case Left(LotSetRefusal.LotNotInAuction(lot)) =>
        refused(wire.SaveLotSetRefusal.Reason.LotNotInAuction(wire.LotSetLotNotInAuction(lot.value.toString)))
      case Left(LotSetRefusal.LotInAnotherSet(lot, set)) =>
        refused(
          wire.SaveLotSetRefusal.Reason.LotInAnotherSet(wire.LotInAnotherSet(lot.value.toString, set.value.toString))
        )
      case Left(LotSetRefusal.Denied(Denial.NotAdministrator)) =>
        refused(wire.SaveLotSetRefusal.Reason.NotMeetupAdministrator(wire.NotMeetupAdministrator()))
      case Left(LotSetRefusal.Denied(Denial.MeetupNotFound)) =>
        refused(wire.SaveLotSetRefusal.Reason.MeetupNotFound(wire.MeetupNotFound()))
      case Left(LotSetRefusal.Denied(Denial.MeetupCancelled)) =>
        refused(wire.SaveLotSetRefusal.Reason.MeetupCancelled(wire.MeetupCancelled()))
      case Left(LotSetRefusal.Denied(Denial.LotsFrozen)) =>
        refused(wire.SaveLotSetRefusal.Reason.LotsFrozen(wire.LotsFrozen()))
      case Left(LotSetRefusal.Denied(Denial.Unavailable)) => Left(unavailable)
      case Left(LotSetRefusal.Denied(Denial.AuctionNotFound)) => Left(auctionNotFound)
      case Left(
            refusal @ (LotSetRefusal.LotSetNotFound | LotSetRefusal.Denied(Denial.MeetupHidden) |
            LotSetRefusal.Denied(Denial.LotOfAnotherAuction))
          ) =>
        throw new IllegalStateException(s"lot set saving answered $refusal")
    }
  }

  def deleteLotSet(outcome: Either[LotSetRefusal, Unit]): Either[Status, wire.DeleteLotSetResponse] = {
    def refused(reason: wire.DeleteLotSetRefusal.Reason) =
      Right(wire.DeleteLotSetResponse().withRefused(wire.DeleteLotSetRefusal(reason)))
    outcome match {
      case Right(()) => Right(wire.DeleteLotSetResponse().withAccepted(wire.LotSetDeleted()))
      case Left(LotSetRefusal.LotSetNotFound) =>
        refused(wire.DeleteLotSetRefusal.Reason.LotSetNotFound(wire.LotSetNotFound()))
      case Left(LotSetRefusal.Denied(Denial.NotAdministrator)) =>
        refused(wire.DeleteLotSetRefusal.Reason.NotMeetupAdministrator(wire.NotMeetupAdministrator()))
      case Left(LotSetRefusal.Denied(Denial.MeetupNotFound)) =>
        refused(wire.DeleteLotSetRefusal.Reason.MeetupNotFound(wire.MeetupNotFound()))
      case Left(LotSetRefusal.Denied(Denial.MeetupCancelled)) =>
        refused(wire.DeleteLotSetRefusal.Reason.MeetupCancelled(wire.MeetupCancelled()))
      case Left(LotSetRefusal.Denied(Denial.LotsFrozen)) =>
        refused(wire.DeleteLotSetRefusal.Reason.LotsFrozen(wire.LotsFrozen()))
      case Left(LotSetRefusal.Denied(Denial.Unavailable)) => Left(unavailable)
      case Left(LotSetRefusal.Denied(Denial.AuctionNotFound)) => Left(auctionNotFound)
      case Left(
            refusal @ (LotSetRefusal.NameEmpty | LotSetRefusal.LotNotInAuction(_) |
            LotSetRefusal.LotInAnotherSet(_, _) | LotSetRefusal.Denied(Denial.MeetupHidden) |
            LotSetRefusal.Denied(Denial.LotOfAnotherAuction))
          ) =>
        throw new IllegalStateException(s"lot set deletion answered $refusal")
    }
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
      case Left(LotSchedulingRefusal.Denied(Denial.MeetupCancelled)) =>
        Right(schedulingRefused(wire.ScheduleLotRefusal.Reason.MeetupCancelled(wire.MeetupCancelled())))
      case Left(LotSchedulingRefusal.Denied(Denial.LotsFrozen)) =>
        Right(schedulingRefused(wire.ScheduleLotRefusal.Reason.LotsFrozen(wire.LotsFrozen())))
      case Left(LotSchedulingRefusal.Denied(Denial.Unavailable)) => Left(unavailable)
      case Left(LotSchedulingRefusal.Denied(Denial.AuctionNotFound)) => Left(auctionNotFound)
      case Left(LotSchedulingRefusal.Denied(denial @ (Denial.MeetupHidden | Denial.LotOfAnotherAuction))) =>
        throw new IllegalStateException(s"lot scheduling answered $denial")
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
   * Право — как у реестра: отказы значениями, `Unavailable` статусом, аукциона нет — `NOT_FOUND`. Повтор принятого
   * `op_id` отвечает принятием до права, поэтому `OpIdTaken` у команды аукциона нет.
   */
  def scheduleAuction(outcome: Either[SchedulingRefusal, Unit]): Either[Status, wire.ScheduleAuctionResponse] =
    outcome match {
      case Right(()) => Right(wire.ScheduleAuctionResponse().withAccepted(wire.AuctionSchedulingAccepted()))
      case Left(SchedulingRefusal.ConfigInvalid(reason)) =>
        Right(auctionSchedulingRefused(wire.ScheduleAuctionRefusal.Reason.ConfigInvalid(configInvalid(reason))))
      case Left(SchedulingRefusal.AuctionAlreadyStarted) =>
        Right(
          auctionSchedulingRefused(
            wire.ScheduleAuctionRefusal.Reason.AuctionAlreadyStarted(wire.AuctionAlreadyStarted())
          )
        )
      case Left(SchedulingRefusal.Denied(Denial.NotAdministrator)) =>
        Right(
          auctionSchedulingRefused(
            wire.ScheduleAuctionRefusal.Reason.NotMeetupAdministrator(wire.NotMeetupAdministrator())
          )
        )
      case Left(SchedulingRefusal.Denied(Denial.MeetupNotFound)) =>
        Right(auctionSchedulingRefused(wire.ScheduleAuctionRefusal.Reason.MeetupNotFound(wire.MeetupNotFound())))
      case Left(SchedulingRefusal.Denied(Denial.MeetupCancelled)) =>
        Right(auctionSchedulingRefused(wire.ScheduleAuctionRefusal.Reason.MeetupCancelled(wire.MeetupCancelled())))
      case Left(SchedulingRefusal.Denied(Denial.Unavailable)) => Left(unavailable)
      case Left(SchedulingRefusal.Denied(Denial.AuctionNotFound)) => Left(auctionNotFound)
      case Left(
            SchedulingRefusal.Denied(denial @ (Denial.MeetupHidden | Denial.LotsFrozen | Denial.LotOfAnotherAuction))
          ) =>
        throw new IllegalStateException(s"auction scheduling answered $denial")
    }

  private def configInvalid(reason: ConfigInvalid): wire.ConfigInvalid = {
    val named = reason match {
      case ConfigInvalid.ClosesAtMissing => wire.ConfigInvalid.Reason.ClosesAtMissing(wire.ClosesAtMissing())
      case ConfigInvalid.ClosesAtNotAfterOpensAt =>
        wire.ConfigInvalid.Reason.ClosesAtNotAfterOpensAt(wire.ClosesAtNotAfterOpensAt())
      case ConfigInvalid.FinalBlocksOutOfRange =>
        wire.ConfigInvalid.Reason.FinalBlocksOutOfRange(wire.FinalBlocksOutOfRange())
      case ConfigInvalid.LotDefaults(_) =>
        wire.ConfigInvalid.Reason.LotDefaultsStepPolicyInvalid(wire.StepPolicyInvalid())
      case ConfigInvalid.StepWindowWithoutClosesAt(window) =>
        wire.ConfigInvalid.Reason.StepWindowWithoutClosesAt(wire.StepWindowWithoutClosesAt(window))
      case ConfigInvalid.StepWindowOutsideOnlinePhase(window) =>
        wire.ConfigInvalid.Reason.StepWindowOutsideOnlinePhase(wire.StepWindowOutsideOnlinePhase(window))
      case ConfigInvalid.StepWindowsOverlap(first, second) =>
        wire.ConfigInvalid.Reason.StepWindowsOverlap(wire.StepWindowsOverlap(first, second))
      case ConfigInvalid.StepWindowStepInvalid(window) =>
        wire.ConfigInvalid.Reason.StepWindowStepInvalid(wire.StepWindowStepInvalid(window))
      case ConfigInvalid.StepWindowLotsEmpty(window) =>
        wire.ConfigInvalid.Reason.StepWindowLotsEmpty(wire.StepWindowLotsEmpty(window))
      case ConfigInvalid.RaffleClosesAtNotAfterOpensAt =>
        wire.ConfigInvalid.Reason.RaffleClosesAtNotAfterOpensAt(wire.RaffleClosesAtNotAfterOpensAt())
      case ConfigInvalid.RaffleClosesAtNotBeforeClosesAt =>
        wire.ConfigInvalid.Reason.RaffleClosesAtNotBeforeClosesAt(wire.RaffleClosesAtNotBeforeClosesAt())
      case ConfigInvalid.RafflePrizeWithoutRaffle =>
        wire.ConfigInvalid.Reason.RafflePrizeWithoutRaffle(wire.RafflePrizeWithoutRaffle())
      case ConfigInvalid.RafflePrizeBlank =>
        wire.ConfigInvalid.Reason.RafflePrizeBlank(wire.RafflePrizeBlank())
      case ConfigInvalid.RafflePrizeTooLong =>
        wire.ConfigInvalid.Reason.RafflePrizeTooLong(wire.RafflePrizeTooLong())
      case ConfigInvalid.PaymentTermOutOfRange =>
        wire.ConfigInvalid.Reason.PaymentTermOutOfRange(wire.PaymentTermOutOfRange())
    }
    wire.ConfigInvalid(named)
  }

  private def auctionSchedulingRefused(reason: wire.ScheduleAuctionRefusal.Reason): wire.ScheduleAuctionResponse =
    wire.ScheduleAuctionResponse().withRefused(wire.ScheduleAuctionRefusal(reason))

  /** Принятие не ждёт лотов: их открывает entity аукциона после записи события, и ответ этого не несёт. */
  def startPrebidding(outcome: Either[OpeningRefusal, Unit]): Either[Status, wire.StartPrebiddingResponse] =
    outcome match {
      case Right(()) => Right(wire.StartPrebiddingResponse().withAccepted(wire.PrebiddingStartAccepted()))
      case Left(OpeningRefusal.AuctionNotScheduled) =>
        Right(openingRefused(wire.StartPrebiddingRefusal.Reason.AuctionNotScheduled(wire.AuctionNotScheduled())))
      case Left(OpeningRefusal.Denied(Denial.NotAdministrator)) =>
        Right(openingRefused(wire.StartPrebiddingRefusal.Reason.NotMeetupAdministrator(wire.NotMeetupAdministrator())))
      case Left(OpeningRefusal.Denied(Denial.MeetupNotFound)) =>
        Right(openingRefused(wire.StartPrebiddingRefusal.Reason.MeetupNotFound(wire.MeetupNotFound())))
      case Left(OpeningRefusal.Denied(Denial.MeetupCancelled)) =>
        Right(openingRefused(wire.StartPrebiddingRefusal.Reason.MeetupCancelled(wire.MeetupCancelled())))
      case Left(OpeningRefusal.Denied(Denial.MeetupHidden)) =>
        Right(openingRefused(wire.StartPrebiddingRefusal.Reason.MeetupHidden(wire.MeetupHidden())))
      case Left(OpeningRefusal.AnotherAuctionActive(holder)) =>
        Right(
          openingRefused(
            wire.StartPrebiddingRefusal.Reason.AnotherAuctionActive(wire.AnotherAuctionActive(holder.value.toString))
          )
        )
      case Left(OpeningRefusal.SlotUnavailable) => Left(slotUnavailable)
      case Left(OpeningRefusal.Denied(Denial.Unavailable)) => Left(unavailable)
      case Left(OpeningRefusal.Denied(Denial.AuctionNotFound)) => Left(auctionNotFound)
      case Left(OpeningRefusal.Denied(denial @ (Denial.LotsFrozen | Denial.LotOfAnotherAuction))) =>
        throw new IllegalStateException(s"prebidding start answered $denial")
    }

  private def openingRefused(reason: wire.StartPrebiddingRefusal.Reason): wire.StartPrebiddingResponse =
    wire.StartPrebiddingResponse().withRefused(wire.StartPrebiddingRefusal(reason))

  def discardAuction(outcome: Either[DiscardRefusal, Unit]): Either[Status, wire.DiscardAuctionResponse] =
    outcome match {
      case Right(()) => Right(wire.DiscardAuctionResponse().withAccepted(wire.AuctionDiscardAccepted()))
      case Left(DiscardRefusal.AuctionAlreadyStarted) =>
        Right(discardRefused(wire.DiscardAuctionRefusal.Reason.AuctionAlreadyStarted(wire.AuctionAlreadyStarted())))
      case Left(DiscardRefusal.Denied(Denial.NotAdministrator)) =>
        Right(discardRefused(wire.DiscardAuctionRefusal.Reason.NotMeetupAdministrator(wire.NotMeetupAdministrator())))
      case Left(DiscardRefusal.Denied(Denial.MeetupNotFound)) =>
        Right(discardRefused(wire.DiscardAuctionRefusal.Reason.MeetupNotFound(wire.MeetupNotFound())))
      case Left(DiscardRefusal.Denied(Denial.Unavailable)) => Left(unavailable)
      case Left(DiscardRefusal.Denied(Denial.AuctionNotFound)) => Left(auctionNotFound)
      case Left(
            DiscardRefusal.Denied(
              denial @ (Denial.MeetupCancelled | Denial.MeetupHidden | Denial.LotsFrozen | Denial.LotOfAnotherAuction)
            )
          ) =>
        throw new IllegalStateException(s"auction discard answered $denial")
    }

  private def discardRefused(reason: wire.DiscardAuctionRefusal.Reason): wire.DiscardAuctionResponse =
    wire.DiscardAuctionResponse().withRefused(wire.DiscardAuctionRefusal(reason))

  /**
   * Публикация и снятие (ADR-047, дополнение 2026-10-20) отвечают одной формой: `None` — принято, иначе именованный
   * отказ, который вызывающий кладёт в ответ своей команды.
   */
  def auctionVisibility(
      outcome: Either[VisibilityRefusal, Unit]
  ): Either[Status, Option[wire.AuctionVisibilityRefusal]] = {
    import wire.AuctionVisibilityRefusal.Reason
    def refused(reason: Reason) = Right(Some(wire.AuctionVisibilityRefusal(reason)))
    outcome match {
      case Right(()) => Right(None)
      case Left(VisibilityRefusal.AuctionAlreadyStarted) =>
        refused(Reason.AuctionAlreadyStarted(wire.AuctionAlreadyStarted()))
      case Left(VisibilityRefusal.Denied(Denial.NotAdministrator)) =>
        refused(Reason.NotMeetupAdministrator(wire.NotMeetupAdministrator()))
      case Left(VisibilityRefusal.Denied(Denial.MeetupNotFound)) =>
        refused(Reason.MeetupNotFound(wire.MeetupNotFound()))
      case Left(VisibilityRefusal.Denied(Denial.MeetupCancelled)) =>
        refused(Reason.MeetupCancelled(wire.MeetupCancelled()))
      case Left(VisibilityRefusal.OpIdTaken) => Left(opIdTaken)
      case Left(VisibilityRefusal.Denied(Denial.Unavailable)) => Left(unavailable)
      case Left(VisibilityRefusal.Denied(Denial.AuctionNotFound)) => Left(auctionNotFound)
      case Left(
            VisibilityRefusal.Denied(denial @ (Denial.MeetupHidden | Denial.LotsFrozen | Denial.LotOfAnotherAuction))
          ) =>
        throw new IllegalStateException(s"auction visibility answered $denial")
    }
  }

  /**
   * Ориентировочное время финала (ADR-040, дополнение 2026-10-19) отвечает формой остальных команд администратора:
   * принятие — значением, отказ — именованным значением ответа, а не статусом.
   */
  def setFinalTime(outcome: Either[FinalTimeRefusal, Unit]): Either[Status, wire.SetFinalTimeResponse] = {
    import wire.FinalTimeRefusal.Reason
    def refused(reason: Reason) = Right(wire.SetFinalTimeResponse().withRefused(wire.FinalTimeRefusal(reason)))
    outcome match {
      case Right(()) => Right(wire.SetFinalTimeResponse().withAccepted(wire.FinalTimeAccepted()))
      case Left(FinalTimeRefusal.FinalAlreadyStarted) =>
        refused(Reason.FinalAlreadyStarted(wire.FinalAlreadyStarted()))
      case Left(FinalTimeRefusal.AuctionAlreadyFinished) =>
        refused(Reason.AuctionAlreadyFinished(wire.AuctionAlreadyFinished()))
      case Left(FinalTimeRefusal.AuctionAlreadyCancelled) =>
        refused(Reason.AuctionAlreadyCancelled(wire.AuctionAlreadyCancelled()))
      case Left(FinalTimeRefusal.Denied(Denial.NotAdministrator)) =>
        refused(Reason.NotMeetupAdministrator(wire.NotMeetupAdministrator()))
      case Left(FinalTimeRefusal.Denied(Denial.MeetupNotFound)) =>
        refused(Reason.MeetupNotFound(wire.MeetupNotFound()))
      case Left(FinalTimeRefusal.Denied(Denial.MeetupCancelled)) =>
        refused(Reason.MeetupCancelled(wire.MeetupCancelled()))
      case Left(FinalTimeRefusal.OpIdTaken) => Left(opIdTaken)
      case Left(FinalTimeRefusal.Denied(Denial.Unavailable)) => Left(unavailable)
      case Left(FinalTimeRefusal.Denied(Denial.AuctionNotFound)) => Left(auctionNotFound)
      case Left(
            FinalTimeRefusal.Denied(denial @ (Denial.MeetupHidden | Denial.LotsFrozen | Denial.LotOfAnotherAuction))
          ) =>
        throw new IllegalStateException(s"auction final time answered $denial")
    }
  }

  def cancelAuction(outcome: Either[CancellationRefusal, Unit]): Either[Status, wire.CancelAuctionResponse] =
    outcome match {
      case Right(()) => Right(wire.CancelAuctionResponse().withAccepted(wire.AuctionCancelAccepted()))
      case Left(CancellationRefusal.AuctionNotStarted) =>
        Right(cancelRefused(wire.CancelAuctionRefusal.Reason.AuctionNotStarted(wire.AuctionNotStarted())))
      case Left(CancellationRefusal.AuctionAlreadyFinished) =>
        Right(cancelRefused(wire.CancelAuctionRefusal.Reason.AuctionAlreadyFinished(wire.AuctionAlreadyFinished())))
      case Left(CancellationRefusal.Denied(Denial.NotAdministrator)) =>
        Right(cancelRefused(wire.CancelAuctionRefusal.Reason.NotMeetupAdministrator(wire.NotMeetupAdministrator())))
      case Left(CancellationRefusal.Denied(Denial.MeetupNotFound)) =>
        Right(cancelRefused(wire.CancelAuctionRefusal.Reason.MeetupNotFound(wire.MeetupNotFound())))
      case Left(CancellationRefusal.Denied(Denial.Unavailable)) => Left(unavailable)
      case Left(CancellationRefusal.Denied(Denial.AuctionNotFound)) => Left(auctionNotFound)
      case Left(
            CancellationRefusal.Denied(
              denial @ (Denial.MeetupCancelled | Denial.MeetupHidden | Denial.LotsFrozen | Denial.LotOfAnotherAuction)
            )
          ) =>
        throw new IllegalStateException(s"auction cancellation answered $denial")
    }

  private def cancelRefused(reason: wire.CancelAuctionRefusal.Reason): wire.CancelAuctionResponse =
    wire.CancelAuctionResponse().withRefused(wire.CancelAuctionRefusal(reason))

  /**
   * Заморозка состава (RFC-011). `LineupMismatch` несёт удержанных на момент решения — пульт пересобирает порядок без
   * отдельного чтения. `LineupUnknown` — аукцион ещё переспрашивает лоты после рестарта: `UNAVAILABLE`, повтор с тем же
   * `op_id` пройдёт.
   */
  def freezeFinalLineup(outcome: Either[LineupRefusal, Unit]): Either[Status, wire.FreezeFinalLineupResponse] = {
    import wire.FreezeFinalLineupRefusal.Reason
    def refused(reason: Reason) = Right(
      wire.FreezeFinalLineupResponse().withRefused(wire.FreezeFinalLineupRefusal(reason))
    )
    outcome match {
      case Right(()) => Right(wire.FreezeFinalLineupResponse().withAccepted(wire.FinalLineupFreezeAccepted()))
      case Left(LineupRefusal.NotInBreak) => refused(Reason.NotInBreak(wire.NotInBreak()))
      case Left(LineupRefusal.LineupEmpty) => refused(Reason.LineupEmpty(wire.LineupEmpty()))
      case Left(LineupRefusal.LineupMismatch(held)) =>
        refused(Reason.LineupMismatch(wire.LineupMismatch(held.toList.map(_.value).sorted.map(_.toString))))
      case Left(LineupRefusal.LineupUnknown) => Left(lineupUnknown)
      case Left(LineupRefusal.Denied(Denial.NotAdministrator)) =>
        refused(Reason.NotMeetupAdministrator(wire.NotMeetupAdministrator()))
      case Left(LineupRefusal.Denied(Denial.MeetupNotFound)) => refused(Reason.MeetupNotFound(wire.MeetupNotFound()))
      case Left(LineupRefusal.Denied(Denial.Unavailable)) => Left(unavailable)
      case Left(LineupRefusal.Denied(Denial.AuctionNotFound)) => Left(auctionNotFound)
      case Left(LineupRefusal.Denied(Denial.MeetupCancelled)) => refused(Reason.MeetupCancelled(wire.MeetupCancelled()))
      case Left(
            LineupRefusal.Denied(denial @ (Denial.MeetupHidden | Denial.LotsFrozen | Denial.LotOfAnotherAuction))
          ) =>
        throw new IllegalStateException(s"lineup freeze answered $denial")
    }
  }

  def startFinal(outcome: Either[FinalStartRefusal, Unit]): Either[Status, wire.StartFinalResponse] = {
    import wire.StartFinalRefusal.Reason
    def refused(reason: Reason) = Right(wire.StartFinalResponse().withRefused(wire.StartFinalRefusal(reason)))
    outcome match {
      case Right(()) => Right(wire.StartFinalResponse().withAccepted(wire.FinalStartAccepted()))
      case Left(FinalStartRefusal.LineupNotFrozen) => refused(Reason.LineupNotFrozen(wire.LineupNotFrozen()))
      case Left(FinalStartRefusal.Denied(Denial.NotAdministrator)) =>
        refused(Reason.NotMeetupAdministrator(wire.NotMeetupAdministrator()))
      case Left(FinalStartRefusal.Denied(Denial.MeetupNotFound)) =>
        refused(Reason.MeetupNotFound(wire.MeetupNotFound()))
      case Left(FinalStartRefusal.Denied(Denial.Unavailable)) => Left(unavailable)
      case Left(FinalStartRefusal.Denied(Denial.AuctionNotFound)) => Left(auctionNotFound)
      case Left(FinalStartRefusal.Denied(Denial.MeetupCancelled)) =>
        refused(Reason.MeetupCancelled(wire.MeetupCancelled()))
      case Left(
            FinalStartRefusal.Denied(denial @ (Denial.MeetupHidden | Denial.LotsFrozen | Denial.LotOfAnotherAuction))
          ) =>
        throw new IllegalStateException(s"final start answered $denial")
    }
  }

  /** Следующий лот финала: ответ — вернувшийся в торги лот; повтор того же `op_id` — тот же лот. */
  def startNextLot(outcome: Either[NextLotRefusal, LotId]): Either[Status, wire.StartNextLotResponse] = {
    import wire.StartNextLotRefusal.Reason
    def refused(reason: Reason) = Right(wire.StartNextLotResponse().withRefused(wire.StartNextLotRefusal(reason)))
    outcome match {
      case Right(lot) => Right(wire.StartNextLotResponse().withAccepted(wire.FinalLotActivation(lot.value.toString)))
      case Left(NextLotRefusal.NotInFinal) => refused(Reason.NotInFinal(wire.NotInFinal()))
      case Left(NextLotRefusal.AnotherLotActive(lot)) =>
        refused(Reason.AnotherLotActive(wire.AnotherLotActive(lot.value.toString)))
      case Left(NextLotRefusal.LineupExhausted) => refused(Reason.LineupExhausted(wire.LineupExhausted()))
      case Left(NextLotRefusal.OpIdTaken) => Left(opIdTaken)
      case Left(NextLotRefusal.Denied(Denial.NotAdministrator)) =>
        refused(Reason.NotMeetupAdministrator(wire.NotMeetupAdministrator()))
      case Left(NextLotRefusal.Denied(Denial.MeetupNotFound)) => refused(Reason.MeetupNotFound(wire.MeetupNotFound()))
      case Left(NextLotRefusal.Denied(Denial.Unavailable)) => Left(unavailable)
      case Left(NextLotRefusal.Denied(Denial.AuctionNotFound)) => Left(auctionNotFound)
      case Left(NextLotRefusal.Denied(Denial.MeetupCancelled)) =>
        refused(Reason.MeetupCancelled(wire.MeetupCancelled()))
      case Left(
            NextLotRefusal.Denied(denial @ (Denial.MeetupHidden | Denial.LotsFrozen | Denial.LotOfAnotherAuction))
          ) =>
        throw new IllegalStateException(s"next lot of the final answered $denial")
    }
  }

  /**
   * Ask ведущего (RFC-011, П-08). Отказы лота и аукциона — значения ответа: пульт показывает ведущему сумму, которую
   * ask обязан превысить. Лот реестра без журнала — дефект, как у `scheduleLot`.
   */
  def advanceAsk(outcome: Either[AskRefusal, Unit]): Either[Status, wire.AdvanceAskResponse] = {
    import wire.AdvanceAskRefusal.Reason
    def refused(reason: Reason) = Right(wire.AdvanceAskResponse().withRefused(wire.AdvanceAskRefusal(reason)))
    outcome match {
      case Right(()) => Right(wire.AdvanceAskResponse().withAccepted(wire.AskAdvanceAccepted()))
      case Left(AskRefusal.ByLot(AdvanceAskRejected.LotNotOpen)) => refused(Reason.LotNotOpen(wire.LotNotOpen()))
      case Left(AskRefusal.ByLot(AdvanceAskRejected.CurrencyMismatch)) =>
        refused(Reason.CurrencyMismatch(wire.CurrencyMismatch()))
      case Left(AskRefusal.ByLot(AdvanceAskRejected.AskBelowCurrentPrice(mustExceed))) =>
        refused(Reason.AskBelowCurrentPrice(wire.AskBelowCurrentPrice(Some(money(mustExceed)))))
      case Left(AskRefusal.ByLot(AdvanceAskRejected.OpIdTaken)) => Left(opIdTaken)
      case Left(AskRefusal.ByLot(AdvanceAskRejected.LotNotFound)) =>
        throw new IllegalStateException("a lot of the registry has no journal")
      case Left(AskRefusal.LotNotInAuction) => refused(Reason.LotNotInAuction(wire.LotNotInAuction()))
      case Left(AskRefusal.Denied(Denial.NotAdministrator)) =>
        refused(Reason.NotMeetupAdministrator(wire.NotMeetupAdministrator()))
      case Left(AskRefusal.Denied(Denial.MeetupNotFound)) => refused(Reason.MeetupNotFound(wire.MeetupNotFound()))
      case Left(AskRefusal.Denied(Denial.Unavailable)) => Left(unavailable)
      case Left(AskRefusal.Denied(Denial.AuctionNotFound)) => Left(auctionNotFound)
      case Left(AskRefusal.Denied(Denial.MeetupCancelled)) => refused(Reason.MeetupCancelled(wire.MeetupCancelled()))
      case Left(AskRefusal.Denied(denial @ (Denial.MeetupHidden | Denial.LotsFrozen | Denial.LotOfAnotherAuction))) =>
        throw new IllegalStateException(s"ask answered $denial")
    }
  }

  /**
   * Закрытие лота ведущим (PER-607): исход лота — `LotClosure`, отказы аукциона и лота — значения ответа, как у ask.
   * `OpIdTaken` — статус, как у остальных команд с `op_id`.
   */
  def closeLot(outcome: Either[ClosingRefusal, LotEnding]): Either[Status, wire.CloseLotResponse] = {
    import wire.CloseLotRefusal.Reason
    def refused(reason: Reason) = Right(wire.CloseLotResponse().withRefused(wire.CloseLotRefusal(reason)))
    def accepted(closure: wire.LotClosure) = Right(wire.CloseLotResponse().withAccepted(closure))
    outcome match {
      case Right(LotEnding.Sold(sale)) => accepted(wire.LotClosure().withSold(LotValues.sale(sale)))
      case Right(LotEnding.Unsold(reason)) => accepted(wire.LotClosure().withUnsold(LotValues.unsold(reason)))
      case Left(ClosingRefusal.Rejected(CloseAuctionLotRejected.LotNotInAuction)) =>
        refused(Reason.LotNotInAuction(wire.LotNotInAuction()))
      case Left(ClosingRefusal.Rejected(CloseAuctionLotRejected.LotNotOpen)) =>
        refused(Reason.LotNotOpen(wire.LotNotOpen()))
      case Left(ClosingRefusal.Rejected(CloseAuctionLotRejected.DeadlineNotReached)) =>
        refused(Reason.DeadlineNotReached(wire.DeadlineNotReached()))
      case Left(ClosingRefusal.Rejected(CloseAuctionLotRejected.OpIdTaken)) => Left(opIdTaken)
      case Left(ClosingRefusal.Rejected(CloseAuctionLotRejected.AuctionNotFound)) => Left(auctionNotFound)
      case Left(ClosingRefusal.Denied(Denial.NotAdministrator)) =>
        refused(Reason.NotMeetupAdministrator(wire.NotMeetupAdministrator()))
      case Left(ClosingRefusal.Denied(Denial.MeetupNotFound)) => refused(Reason.MeetupNotFound(wire.MeetupNotFound()))
      case Left(ClosingRefusal.Denied(Denial.Unavailable)) => Left(unavailable)
      case Left(ClosingRefusal.Denied(Denial.AuctionNotFound)) => Left(auctionNotFound)
      case Left(ClosingRefusal.Denied(Denial.MeetupCancelled)) =>
        refused(Reason.MeetupCancelled(wire.MeetupCancelled()))
      case Left(
            ClosingRefusal.Denied(denial @ (Denial.MeetupHidden | Denial.LotsFrozen | Denial.LotOfAnotherAuction))
          ) =>
        throw new IllegalStateException(s"close answered $denial")
    }
  }

  /**
   * Отметка для финала (ADR-047, дополнение 2026-10-06). Отказы аукциона и лота — значения ответа: `DeadlinePassed`
   * администратор видит на пульте как отказ, а не как сбой. Лот реестра без журнала, как у `scheduleLot`, — дефект.
   */
  def selectForFinal(
      outcome: Either[FinalChoiceRefusal[MarkForFinalRejected], Unit]
  ): Either[Status, wire.SelectForFinalResponse] = {
    import wire.SelectForFinalRefusal.Reason
    def refused(reason: Reason) = Right(wire.SelectForFinalResponse().withRefused(wire.SelectForFinalRefusal(reason)))
    outcome match {
      case Right(()) => Right(wire.SelectForFinalResponse().withAccepted(wire.FinalistSelectionAccepted()))
      case Left(FinalChoiceRefusal.ByLot(MarkForFinalRejected.LotNotOpen)) =>
        refused(Reason.LotNotOpen(wire.LotNotOpen()))
      case Left(FinalChoiceRefusal.ByLot(MarkForFinalRejected.NotInOnlinePhase)) =>
        refused(Reason.NotInOnlinePhase(wire.NotInOnlinePhase()))
      case Left(FinalChoiceRefusal.ByLot(MarkForFinalRejected.AlreadyMarkedForFinal)) =>
        refused(Reason.AlreadyMarkedForFinal(wire.AlreadyMarkedForFinal()))
      case Left(FinalChoiceRefusal.ByLot(MarkForFinalRejected.DeadlinePassed)) =>
        refused(Reason.DeadlinePassed(wire.DeadlinePassed()))
      case Left(FinalChoiceRefusal.ByLot(MarkForFinalRejected.OpIdTaken)) => Left(opIdTaken)
      case Left(FinalChoiceRefusal.ByLot(MarkForFinalRejected.LotNotFound)) =>
        throw new IllegalStateException("a lot of the registry has no journal")
      case Left(FinalChoiceRefusal.NotInPrebidding) => refused(Reason.NotInPrebidding(wire.NotInPrebidding()))
      case Left(FinalChoiceRefusal.LotNotInAuction) => refused(Reason.LotNotInAuction(wire.LotNotInAuction()))
      case Left(FinalChoiceRefusal.SelectionNotApplicable) =>
        refused(Reason.SelectionNotApplicable(wire.SelectionNotApplicable()))
      case Left(FinalChoiceRefusal.Denied(Denial.NotAdministrator)) =>
        refused(Reason.NotMeetupAdministrator(wire.NotMeetupAdministrator()))
      case Left(FinalChoiceRefusal.Denied(Denial.MeetupNotFound)) =>
        refused(Reason.MeetupNotFound(wire.MeetupNotFound()))
      case Left(FinalChoiceRefusal.Denied(Denial.Unavailable)) => Left(unavailable)
      case Left(FinalChoiceRefusal.Denied(Denial.AuctionNotFound)) => Left(auctionNotFound)
      case Left(FinalChoiceRefusal.Denied(Denial.MeetupCancelled)) =>
        refused(Reason.MeetupCancelled(wire.MeetupCancelled()))
      case Left(
            FinalChoiceRefusal.Denied(denial @ (Denial.MeetupHidden | Denial.LotsFrozen | Denial.LotOfAnotherAuction))
          ) =>
        throw new IllegalStateException(s"final selection answered $denial")
    }
  }

  /**
   * Предпросмотр снятия участника (PER-658): итог — цена, лидер, продлённый дедлайн и номер лота, на котором он решён.
   * Отказы — те же, что у снятия; `LotChanged` предпросмотр не получает по построению.
   */
  def previewParticipantRemoval(
      outcome: Either[ParticipantRemovalRefusal, LotEntity.RemovalPreview]
  ): Either[Status, wire.PreviewParticipantRemovalResponse] =
    outcome match {
      case Right(preview) =>
        Right(
          wire
            .PreviewParticipantRemovalResponse()
            .withPreview(
              wire.ParticipantRemovalPreview(
                price = Some(LotValues.money(preview.removed.price)),
                leaderId = preview.removed.leader.map(_.value.toString),
                extendedDeadline = preview.extendedDeadline.map(_.toString),
                version = preview.version
              )
            )
        )
      case Left(refusal) =>
        removalReason(refusal).map(reason =>
          wire.PreviewParticipantRemovalResponse().withRefused(wire.ParticipantRemovalRefusal(reason))
        )
    }

  /** Снятие участника (PER-658): принятое — номер лота, с которого чтение показывает снятие целиком. */
  def removeParticipant(
      outcome: Either[ParticipantRemovalRefusal, Long]
  ): Either[Status, wire.RemoveParticipantResponse] =
    outcome match {
      case Right(version) =>
        Right(wire.RemoveParticipantResponse().withAccepted(wire.ParticipantRemovalAccepted(lotVersion = version)))
      case Left(refusal) =>
        removalReason(refusal).map(reason =>
          wire.RemoveParticipantResponse().withRefused(wire.ParticipantRemovalRefusal(reason))
        )
    }

  /**
   * Отказы снятия и предпросмотра — значения ответа, кроме сбоев: недоступный Meetups, аукцион без журнала и чужой
   * `op_id` — статусы, как у выбора финалиста. Лот реестра без журнала — дефект.
   */
  private def removalReason(
      refusal: ParticipantRemovalRefusal
  ): Either[Status, wire.ParticipantRemovalRefusal.Reason] = {
    import wire.ParticipantRemovalRefusal.Reason
    refusal match {
      case ParticipantRemovalRefusal.NotInPrebidding => Right(Reason.NotInPrebidding(wire.NotInPrebidding()))
      case ParticipantRemovalRefusal.LotNotInAuction => Right(Reason.LotNotInAuction(wire.LotNotInAuction()))
      case ParticipantRemovalRefusal.LineupFrozen => Right(Reason.LineupFrozen(wire.LineupFrozen()))
      case ParticipantRemovalRefusal.ByLot(RemoveParticipantRejected.LotNotOpen) =>
        Right(Reason.LotNotOpen(wire.LotNotOpen()))
      case ParticipantRemovalRefusal.ByLot(RemoveParticipantRejected.NotInOnlinePhase) =>
        Right(Reason.NotInOnlinePhase(wire.NotInOnlinePhase()))
      case ParticipantRemovalRefusal.ByLot(RemoveParticipantRejected.DeadlinePassed) =>
        Right(Reason.DeadlinePassed(wire.DeadlinePassed()))
      case ParticipantRemovalRefusal.ByLot(RemoveParticipantRejected.NotALotParticipant) =>
        Right(Reason.NotALotParticipant(wire.NotALotParticipant()))
      case ParticipantRemovalRefusal.ByLot(RemoveParticipantRejected.ParticipantAlreadyRemoved) =>
        Right(Reason.ParticipantAlreadyRemoved(wire.ParticipantAlreadyRemoved()))
      case ParticipantRemovalRefusal.ByLot(RemoveParticipantRejected.LotChanged) =>
        Right(Reason.LotChanged(wire.LotChanged()))
      case ParticipantRemovalRefusal.ByLot(RemoveParticipantRejected.OpIdTaken) => Left(opIdTaken)
      case ParticipantRemovalRefusal.ByLot(RemoveParticipantRejected.LotNotFound) =>
        throw new IllegalStateException("a lot of the registry has no journal")
      case ParticipantRemovalRefusal.Denied(Denial.NotAdministrator) =>
        Right(Reason.NotMeetupAdministrator(wire.NotMeetupAdministrator()))
      case ParticipantRemovalRefusal.Denied(Denial.MeetupNotFound) =>
        Right(Reason.MeetupNotFound(wire.MeetupNotFound()))
      case ParticipantRemovalRefusal.Denied(Denial.MeetupCancelled) =>
        Right(Reason.MeetupCancelled(wire.MeetupCancelled()))
      case ParticipantRemovalRefusal.Denied(Denial.Unavailable) => Left(unavailable)
      case ParticipantRemovalRefusal.Denied(Denial.AuctionNotFound) => Left(auctionNotFound)
      case ParticipantRemovalRefusal.Denied(
            denial @ (Denial.MeetupHidden | Denial.LotsFrozen | Denial.LotOfAnotherAuction)
          ) =>
        throw new IllegalStateException(s"participant removal answered $denial")
    }
  }

  /** Снятие отметки — те же правила отображения, что у отметки. */
  def deselectForFinal(
      outcome: Either[FinalChoiceRefusal[UnmarkForFinalRejected], Unit]
  ): Either[Status, wire.DeselectForFinalResponse] = {
    import wire.DeselectForFinalRefusal.Reason
    def refused(reason: Reason) =
      Right(wire.DeselectForFinalResponse().withRefused(wire.DeselectForFinalRefusal(reason)))
    outcome match {
      case Right(()) => Right(wire.DeselectForFinalResponse().withAccepted(wire.FinalistDeselectionAccepted()))
      case Left(FinalChoiceRefusal.ByLot(UnmarkForFinalRejected.LotNotOpen)) =>
        refused(Reason.LotNotOpen(wire.LotNotOpen()))
      case Left(FinalChoiceRefusal.ByLot(UnmarkForFinalRejected.NotInOnlinePhase)) =>
        refused(Reason.NotInOnlinePhase(wire.NotInOnlinePhase()))
      case Left(FinalChoiceRefusal.ByLot(UnmarkForFinalRejected.NotMarkedForFinal)) =>
        refused(Reason.NotMarkedForFinal(wire.NotMarkedForFinal()))
      case Left(FinalChoiceRefusal.ByLot(UnmarkForFinalRejected.DeadlinePassed)) =>
        refused(Reason.DeadlinePassed(wire.DeadlinePassed()))
      case Left(FinalChoiceRefusal.ByLot(UnmarkForFinalRejected.OpIdTaken)) => Left(opIdTaken)
      case Left(FinalChoiceRefusal.ByLot(UnmarkForFinalRejected.LotNotFound)) =>
        throw new IllegalStateException("a lot of the registry has no journal")
      case Left(FinalChoiceRefusal.NotInPrebidding) => refused(Reason.NotInPrebidding(wire.NotInPrebidding()))
      case Left(FinalChoiceRefusal.LotNotInAuction) => refused(Reason.LotNotInAuction(wire.LotNotInAuction()))
      case Left(FinalChoiceRefusal.SelectionNotApplicable) =>
        throw new IllegalStateException("final deselection answered SelectionNotApplicable")
      case Left(FinalChoiceRefusal.Denied(Denial.NotAdministrator)) =>
        refused(Reason.NotMeetupAdministrator(wire.NotMeetupAdministrator()))
      case Left(FinalChoiceRefusal.Denied(Denial.MeetupNotFound)) =>
        refused(Reason.MeetupNotFound(wire.MeetupNotFound()))
      case Left(FinalChoiceRefusal.Denied(Denial.Unavailable)) => Left(unavailable)
      case Left(FinalChoiceRefusal.Denied(Denial.AuctionNotFound)) => Left(auctionNotFound)
      case Left(FinalChoiceRefusal.Denied(Denial.MeetupCancelled)) =>
        refused(Reason.MeetupCancelled(wire.MeetupCancelled()))
      case Left(
            FinalChoiceRefusal.Denied(denial @ (Denial.MeetupHidden | Denial.LotsFrozen | Denial.LotOfAnotherAuction))
          ) =>
        throw new IllegalStateException(s"final deselection answered $denial")
    }
  }

  /**
   * Запуск окна сниженного шага: принятое окно отдаётся с моментами, которые записал аукцион, — начало без `from` им
   * подставлено. `OpIdTaken` — статус, как у остальных команд аукциона.
   */
  def launchStepWindow(
      outcome: Either[LaunchRefusal, StepWindowConfig]
  ): Either[Status, wire.LaunchStepWindowResponse] = {
    import wire.LaunchStepWindowRefusal.Reason
    def refused(reason: Reason) =
      Right(wire.LaunchStepWindowResponse().withRefused(wire.LaunchStepWindowRefusal(reason)))
    outcome match {
      case Right(window) =>
        val accepted = wire.StepWindowLaunchAccepted(LotValues.instant(window.from), LotValues.instant(window.until))
        Right(wire.LaunchStepWindowResponse().withAccepted(accepted))
      case Left(LaunchRefusal.OpIdTaken) => Left(opIdTaken)
      case Left(LaunchRefusal.Rejected(LaunchStepWindowRejected.NotInPrebidding)) =>
        refused(Reason.NotInPrebidding(wire.NotInPrebidding()))
      case Left(LaunchRefusal.Rejected(LaunchStepWindowRejected.StepWindowInPast)) =>
        refused(Reason.StepWindowInPast(wire.StepWindowInPast()))
      case Left(LaunchRefusal.Rejected(LaunchStepWindowRejected.StepWindowOutsideOnlinePhase)) =>
        refused(Reason.StepWindowOutsideOnlinePhase(wire.LaunchedStepWindowOutsideOnlinePhase()))
      case Left(LaunchRefusal.Rejected(LaunchStepWindowRejected.StepWindowStepInvalid)) =>
        refused(Reason.StepWindowStepInvalid(wire.LaunchedStepWindowStepInvalid()))
      case Left(LaunchRefusal.Rejected(LaunchStepWindowRejected.StepWindowLotsEmpty)) =>
        refused(Reason.StepWindowLotsEmpty(wire.LaunchedStepWindowLotsEmpty()))
      case Left(LaunchRefusal.Rejected(LaunchStepWindowRejected.LotNotInAuction(lot))) =>
        refused(Reason.LotNotInAuction(wire.StepWindowLotNotInAuction(lot.value.toString)))
      case Left(LaunchRefusal.Rejected(LaunchStepWindowRejected.LotNotOpen(lot))) =>
        refused(Reason.LotNotOpen(wire.StepWindowLotNotOpen(lot.value.toString)))
      case Left(LaunchRefusal.Rejected(LaunchStepWindowRejected.StepWindowsOverlap(lot, existing))) =>
        val overlap = wire.LaunchedStepWindowsOverlap(
          lot.value.toString,
          LotValues.instant(existing.from),
          LotValues.instant(existing.until)
        )
        refused(Reason.StepWindowsOverlap(overlap))
      case Left(LaunchRefusal.Rejected(LaunchStepWindowRejected.AuctionNotFound)) => Left(auctionNotFound)
      case Left(LaunchRefusal.Denied(Denial.NotAdministrator)) =>
        refused(Reason.NotMeetupAdministrator(wire.NotMeetupAdministrator()))
      case Left(LaunchRefusal.Denied(Denial.MeetupNotFound)) => refused(Reason.MeetupNotFound(wire.MeetupNotFound()))
      case Left(LaunchRefusal.Denied(Denial.MeetupCancelled)) =>
        refused(Reason.MeetupCancelled(wire.MeetupCancelled()))
      case Left(LaunchRefusal.Denied(Denial.Unavailable)) => Left(unavailable)
      case Left(LaunchRefusal.Denied(Denial.AuctionNotFound)) => Left(auctionNotFound)
      case Left(
            LaunchRefusal.Denied(denial @ (Denial.MeetupHidden | Denial.LotsFrozen | Denial.LotOfAnotherAuction))
          ) =>
        throw new IllegalStateException(s"step window launch answered $denial")
    }
  }

  /** Отказ права на чтение пульта: значения ответа, как у команд; недоступный Meetups — статус. */
  def consoleDenied(denial: Denial): Either[Status, wire.GetAuctionConsoleResponse] =
    consoleRefusal(denial).map(wire.GetAuctionConsoleResponse().withRefused)

  /** Отказ права на статистику лотов — тот же, что у пульта: контракт делит с ним тип отказа. */
  def statisticsDenied(denial: Denial): Either[Status, wire.GetAuctionLotStatisticsResponse] =
    consoleRefusal(denial).map(wire.GetAuctionLotStatisticsResponse().withRefused)

  /** Отказ права на сводку дня — тот же, что у пульта: контракт делит с ним тип отказа. */
  def daySummaryDenied(denial: Denial): Either[Status, wire.GetAuctionDaySummaryResponse] =
    consoleRefusal(denial).map(wire.GetAuctionDaySummaryResponse().withRefused)

  /** Отказ права на ручную отметку итогов — та же пара, что у пульта: контракт делит с ним отказы. */
  def settleResultsDenied(denial: Denial): Either[Status, wire.SettlePredictionResultsManuallyResponse] =
    settleResultsRefusal(denial).map(wire.SettlePredictionResultsManuallyResponse().withRefused)

  /** Ручная отметка принята: подсчёт подавлен, значения номинаций не несутся (ADR-067, п. 8). */
  val settleResultsAccepted: wire.SettlePredictionResultsManuallyResponse =
    wire.SettlePredictionResultsManuallyResponse().withAccepted(wire.PredictionResultsByHand())

  private def settleResultsRefusal(denial: Denial): Either[Status, wire.SettlePredictionResultsManuallyRefusal] = {
    import wire.SettlePredictionResultsManuallyRefusal.Reason
    denial match {
      case Denial.NotAdministrator =>
        Right(
          wire.SettlePredictionResultsManuallyRefusal(Reason.NotMeetupAdministrator(wire.NotMeetupAdministrator()))
        )
      case Denial.MeetupNotFound =>
        Right(wire.SettlePredictionResultsManuallyRefusal(Reason.MeetupNotFound(wire.MeetupNotFound())))
      case Denial.MeetupCancelled =>
        Right(wire.SettlePredictionResultsManuallyRefusal(Reason.MeetupCancelled(wire.MeetupCancelled())))
      case Denial.Unavailable => Left(unavailable)
      case Denial.AuctionNotFound => Left(auctionNotFound)
      case Denial.MeetupHidden | Denial.LotsFrozen | Denial.LotOfAnotherAuction =>
        throw new IllegalStateException(s"results authority answered $denial")
    }
  }

  private def consoleRefusal(denial: Denial): Either[Status, wire.GetAuctionConsoleRefusal] = {
    import wire.GetAuctionConsoleRefusal.Reason
    denial match {
      case Denial.NotAdministrator =>
        Right(wire.GetAuctionConsoleRefusal(Reason.NotMeetupAdministrator(wire.NotMeetupAdministrator())))
      case Denial.MeetupNotFound => Right(wire.GetAuctionConsoleRefusal(Reason.MeetupNotFound(wire.MeetupNotFound())))
      case Denial.Unavailable => Left(unavailable)
      case Denial.AuctionNotFound => Left(auctionNotFound)
      case Denial.MeetupCancelled | Denial.MeetupHidden | Denial.LotsFrozen | Denial.LotOfAnotherAuction =>
        throw new IllegalStateException(s"console authority answered $denial")
    }
  }

  /**
   * Снимок аукциона в форме `AuctionSnapshot`: те же поля, что `AuctionState` шины, кроме `meetup_id`. Конфигурации у
   * черновика нет, с `Scheduled` она есть всегда; реестр — по возрастанию `lot_id`, порядок смысла не несёт. Какие лоты
   * подтвердили открытие, снимок не несёт: это знание entity, а не журнала. Ориентировочное время финала — только у
   * чтения: факта у него на шине нет (ADR-040, дополнение 2026-10-19).
   */
  def auctionSnapshot(view: AuctionSnapshotView): wire.AuctionSnapshot = {
    val (status, config) = view.auction.state match {
      case AuctionState.Draft => (wire.AuctionSnapshot.Status.Draft(AuctionStateMessage.Draft()), None)
      case AuctionState.Scheduled(config) =>
        (wire.AuctionSnapshot.Status.Scheduled(AuctionStateMessage.Scheduled()), Some(config))
      case AuctionState.Prebidding(config, _) =>
        (wire.AuctionSnapshot.Status.Prebidding(AuctionStateMessage.Prebidding()), Some(config))
      case AuctionState.Settling(config, _) =>
        (wire.AuctionSnapshot.Status.Settling(AuctionStateMessage.Settling()), Some(config))
      case AuctionState.Break(config, _) =>
        (wire.AuctionSnapshot.Status.OnBreak(AuctionStateMessage.Break()), Some(config))
      case AuctionState.LineupFrozen(config, _, order) =>
        (wire.AuctionSnapshot.Status.LineupFrozen(AuctionValues.lineupFrozen(order)), Some(config))
      case final_ @ AuctionState.Final(config, _, order, _, _) =>
        (wire.AuctionSnapshot.Status.InFinal(AuctionValues.inFinal(order, final_.activeLot)), Some(config))
      case AuctionState.Finished(config, _) =>
        (wire.AuctionSnapshot.Status.Finished(AuctionStateMessage.Finished()), Some(config))
      case AuctionState.Cancelled(config, _, _) =>
        (wire.AuctionSnapshot.Status.Cancelled(AuctionStateMessage.Cancelled()), Some(config))
      case AuctionState.Initial =>
        throw new IllegalStateException(s"auction view ${view.auctionId} holds an unborn auction")
    }
    wire.AuctionSnapshot(
      id = view.auctionId.toString,
      config = config.map(AuctionValues.config),
      lotIds = view.auction.lots.toList.map(_.value).sorted.map(_.toString),
      hidden = view.auction.hidden,
      finalAt = view.auction.finalAt.map(LotValues.instant),
      status = status
    )
  }

  private def removalRefused(reason: wire.RemoveLotRefusal.Reason): wire.RemoveLotResponse =
    wire.RemoveLotResponse().withRefused(wire.RemoveLotRefusal(reason))

  private def unavailable: Status = Status.UNAVAILABLE.withDescription("meetup authority is unavailable")

  private def slotUnavailable: Status = Status.UNAVAILABLE.withDescription("trading slot is unavailable")

  private def lineupUnknown: Status = Status.UNAVAILABLE.withDescription("auction is still asking its lots")

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
