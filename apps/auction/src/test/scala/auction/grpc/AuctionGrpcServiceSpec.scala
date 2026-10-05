package auction.grpc

import auction.aggregate.AddLot
import auction.aggregate.Auction
import auction.aggregate.AuctionCommands
import auction.aggregate.AuctionFixtures
import auction.aggregate.AuctionState
import auction.aggregate.Authority
import auction.aggregate.DraftAuction
import auction.aggregate.Inspection
import auction.aggregate.MeetupAuthority
import auction.aggregate.MeetupId
import auction.aggregate.RemoveLot
import auction.aggregate.RemoveLotRejected
import auction.aggregate.ScheduleAuction
import auction.aggregate.StartPrebidding
import auction.catalog.CardEdit
import auction.catalog.LotCard
import auction.catalog.LotCatalogCommands
import auction.catalog.LotCatalogStore
import auction.catalog.LotId
import auction.catalog.LotImage
import auction.catalog.NewCard
import auction.entity.AuctionAnswer
import auction.entity.AuctionGateway
import auction.entity.Initiator
import auction.entity.LotGateway
import auction.lot.AuctionId
import auction.lot.DraftLot
import auction.lot.DraftLotRejected
import auction.lot.Envelope
import auction.lot.OpId
import auction.lot.LotFixtures.*
import auction.lot.ParticipantId
import auction.lot.PlaceBid
import auction.lot.PlaceBidRejected
import auction.lot.SetProxyLimit
import auction.lot.SetProxyLimitRejected
import auction.lot.WithdrawProxyLimit
import auction.lot.WithdrawProxyLimitRejected
import auction.onboarding.FaqAcknowledgements
import auction.projection.AuctionListing
import auction.projection.AuctionSnapshotView
import auction.projection.AuctionViews
import auction.projection.LotImageView
import auction.projection.BidRecord
import auction.projection.LotSnapshotView
import auction.projection.LotViews
import auction.v1.auction.BidSource as BidSourceMessage
import auction.v1.auction.Money as MoneyMessage
import auction.v1.auction_service as wire
import com.google.protobuf.ByteString
import identity.v1.roles.GlobalRole as GlobalRoleMessage
import io.grpc.Status
import org.apache.pekko.grpc.GrpcServiceException
import org.apache.pekko.pattern.AskTimeoutException
import org.scalatest.concurrent.ScalaFutures
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

import java.time.Instant
import java.util.UUID
import scala.concurrent.ExecutionContext
import scala.concurrent.Future

final class AuctionGrpcServiceSpec extends AnyWordSpec with Matchers with ScalaFutures {

  import RequestMappingSpec.*

  private given ExecutionContext = ExecutionContext.parasitic

  /** Шлюз, до которого запрос не должен дойти: любой вызов, который тест не переопределил, роняет тест. */
  private class Gateway extends LotGateway {
    def draftLot(lotId: UUID, command: DraftLot, initiator: Initiator): Future[Either[DraftLotRejected, Envelope]] =
      fail("the lot was reached")

    def auctionOf(lotId: UUID): Future[Option[AuctionId]] = fail("the lot was reached")

    def placeBid(lotId: UUID, command: PlaceBid, initiator: Initiator): Future[Either[PlaceBidRejected, Envelope]] =
      fail("the lot was reached")

    def setProxyLimit(
        lotId: UUID,
        command: SetProxyLimit,
        initiator: Initiator
    ): Future[Either[SetProxyLimitRejected, Envelope]] = fail("the lot was reached")

    def withdrawProxyLimit(
        lotId: UUID,
        command: WithdrawProxyLimit,
        initiator: Initiator
    ): Future[Either[WithdrawProxyLimitRejected, Envelope]] = fail("the lot was reached")
  }

  private object Unreachable extends Gateway

  private object UntouchableStore extends LotCatalogStore {
    private def touched = fail("the catalog store was touched")
    def insertIfAbsent(card: NewCard): Future[Option[LotCard]] = touched
    def update(edit: CardEdit): Future[Option[LotCard]] = touched
    def find(lotId: LotId): Future[Option[LotCard]] = touched
  }

  private def answering(outcome: Future[Either[PlaceBidRejected, Envelope]]): LotGateway =
    new Gateway {
      override def placeBid(
          lotId: UUID,
          command: PlaceBid,
          initiator: Initiator
      ): Future[Either[PlaceBidRejected, Envelope]] = outcome
    }

  private object UntouchableFaq extends FaqAcknowledgements {
    def acknowledged(participant: ParticipantId): Future[Boolean] = fail("the FAQ store was touched")
    def acknowledge(participant: ParticipantId): Future[Unit] = fail("the FAQ store was touched")
  }

  /** Read model лота: выборка, которую тест не переопределил, роняет тест. */
  private abstract class Views extends LotViews {
    def find(lotId: UUID): Future[Option[LotSnapshotView]] = fail("the read model was touched")
    def page(auctionId: UUID, after: Option[UUID], limit: Int): Future[List[LotSnapshotView]] =
      fail("the read model was touched")
    def registryPage(auctionId: UUID, after: Option[UUID], limit: Int): Future[List[LotSnapshotView]] =
      fail("the registry was touched")
    def image(lotId: UUID): Future[Option[LotImageView]] = fail("the image was read")
    def history(lotId: UUID, after: Option[Long], limit: Int): Future[Option[List[BidRecord]]] =
      fail("the history was touched")
  }

  private object UntouchableViews extends Views

  /** Шлюз аукциона: команда, которую тест не переопределил, роняет тест. */
  private class Auctions extends AuctionGateway {
    def inspect(auctionId: AuctionId, opId: OpId): Future[Inspection] = fail("the auction was reached")
    def draft(auctionId: AuctionId, command: DraftAuction, initiator: Initiator): Future[AuctionAnswer] =
      fail("the auction was reached")
    def addLot(auctionId: AuctionId, command: AddLot, initiator: Initiator) = fail("the auction was reached")
    def removeLot(auctionId: AuctionId, command: RemoveLot, initiator: Initiator) = fail("the auction was reached")
    def schedule(auctionId: AuctionId, command: ScheduleAuction, initiator: Initiator) =
      fail("the auction was reached")
    def startPrebidding(auctionId: AuctionId, command: StartPrebidding, initiator: Initiator) =
      fail("the auction was reached")
  }

  private val NoMeetups: MeetupAuthority = (_, _, _) => fail("meetups was asked")

  private object UntouchableAuctionViews extends AuctionViews {
    def byMeetup(meetup: MeetupId): Future[Option[AuctionSnapshotView]] = fail("the auction read model was touched")
    def page(listing: AuctionListing, after: Option[UUID], limit: Int): Future[List[AuctionSnapshotView]] =
      fail("the auction read model was touched")
  }

  private def service(
      lots: LotGateway,
      faq: FaqAcknowledgements = UntouchableFaq,
      views: LotViews = UntouchableViews,
      auctions: AuctionCommands = AuctionCommands(new Auctions, Unreachable, NoMeetups),
      auctionViews: AuctionViews = UntouchableAuctionViews
  ) =
    AuctionGrpcService(lots, LotCatalogCommands(UntouchableStore), faq, views, auctions, auctionViews)

  private def statusOf(call: Future[?]): Status.Code =
    call.failed.futureValue match {
      case refused: GrpcServiceException => refused.status.getCode
      case other => fail(s"expected a status, got $other")
    }

  "auction grpc service" should {

    "refuses FAQ requests without a valid viewer or public role before storage" in {
      val auction = service(Unreachable)
      statusOf(auction.getFaqAcknowledgement(wire.GetFaqAcknowledgementRequest())) shouldBe Status.Code.INVALID_ARGUMENT
      statusOf(auction.acknowledgeFaq(wire.AcknowledgeFaqRequest())) shouldBe Status.Code.INVALID_ARGUMENT
      val member = viewer.withGlobalRoles(Seq(GlobalRoleMessage.GLOBAL_ROLE_MEMBER))
      statusOf(
        auction.getFaqAcknowledgement(wire.GetFaqAcknowledgementRequest(Some(member)))
      ) shouldBe Status.Code.PERMISSION_DENIED
      statusOf(auction.acknowledgeFaq(wire.AcknowledgeFaqRequest(Some(member)))) shouldBe Status.Code.PERMISSION_DENIED
      statusOf(
        auction.acknowledgeFaq(wire.AcknowledgeFaqRequest(Some(viewer.withIdentityId("bad"))))
      ) shouldBe Status.Code.INVALID_ARGUMENT
      val unknown = viewer.withGlobalRoles(Seq(GlobalRoleMessage.Unrecognized(999)))
      statusOf(
        auction.getFaqAcknowledgement(wire.GetFaqAcknowledgementRequest(Some(unknown)))
      ) shouldBe Status.Code.INVALID_ARGUMENT
    }

    "records acknowledgement only for the viewer and answers repeated completion successfully" in {
      var completed = Set.empty[ParticipantId]
      val faq = new FaqAcknowledgements {
        def acknowledged(participant: ParticipantId) = Future.successful(completed.contains(participant))
        def acknowledge(participant: ParticipantId) = {
          completed += participant
          Future.successful(())
        }
      }
      val auction = service(Unreachable, faq)
      val read = wire.GetFaqAcknowledgementRequest(Some(viewer))
      val finish = wire.AcknowledgeFaqRequest(Some(viewer))
      auction.getFaqAcknowledgement(read).futureValue.acknowledged shouldBe false
      auction.acknowledgeFaq(finish).futureValue.acknowledged shouldBe true
      auction.acknowledgeFaq(finish).futureValue.acknowledged shouldBe true
      auction.getFaqAcknowledgement(read).futureValue.acknowledged shouldBe true
      completed shouldBe Set(ParticipantId(UUID.fromString(identity)))
    }

    "does not report completed onboarding when storage fails" in {
      val failure = IllegalStateException("storage failed")
      val faq = new FaqAcknowledgements {
        def acknowledged(participant: ParticipantId) = Future.failed(failure)
        def acknowledge(participant: ParticipantId) = Future.failed(failure)
      }
      val auction = service(Unreachable, faq)
      auction.getFaqAcknowledgement(wire.GetFaqAcknowledgementRequest(Some(viewer))).failed.futureValue shouldBe failure
      auction.acknowledgeFaq(wire.AcknowledgeFaqRequest(Some(viewer))).failed.futureValue shouldBe failure
    }

    "refuses a bid from a viewer without the public role before reaching the lot" in {
      val withoutPublic = Seq(
        Seq.empty,
        Seq(GlobalRoleMessage.GLOBAL_ROLE_MEMBER),
        Seq(GlobalRoleMessage.GLOBAL_ROLE_ADMIN, GlobalRoleMessage.GLOBAL_ROLE_MEMBER)
      )
      withoutPublic.foreach { roles =>
        val request = validBid.withViewer(viewer.withGlobalRoles(roles))
        statusOf(service(Unreachable).placeBid(request)) shouldBe Status.Code.PERMISSION_DENIED
      }
    }

    "refuses a malformed bid with INVALID_ARGUMENT before reaching the lot" in {
      statusOf(service(Unreachable).placeBid(validBid.clearViewer)) shouldBe Status.Code.INVALID_ARGUMENT
      statusOf(service(Unreachable).placeBid(validBid.withAmount(MoneyMessage(1, "rub")))) shouldBe
        Status.Code.INVALID_ARGUMENT
    }

    "sends the viewer's bid to the addressed lot as a participant" in {
      var seen = Option.empty[(UUID, PlaceBid, Initiator)]
      val recording = new Gateway {
        override def placeBid(lotId: UUID, command: PlaceBid, initiator: Initiator) = {
          seen = Some((lotId, command, initiator))
          Future.successful(Left(PlaceBidRejected.LotNotOpen))
        }
      }
      service(recording).placeBid(validBid).futureValue.getRefused.reason.isLotNotOpen shouldBe true
      val (lotId, command, initiator) = seen.getOrElse(fail("the lot was not reached"))
      lotId shouldBe UUID.fromString(lot)
      initiator shouldBe Initiator.Participant(ParticipantId(UUID.fromString(identity)))
      command.participant shouldBe ParticipantId(UUID.fromString(identity))
    }

    "answers a below-minimum bid with the minimum price as a value of the response" in {
      val lots = answering(Future.successful(Left(PlaceBidRejected.BidBelowMinimum(money(110)))))
      service(lots).placeBid(validBid).futureValue.getRefused.getBidBelowMinimum.minRequired shouldBe
        Some(MoneyMessage(110, "RUB"))
    }

    "answers a bid to a lot that does not exist with NOT_FOUND" in {
      statusOf(service(answering(Future.successful(Left(PlaceBidRejected.LotNotFound)))).placeBid(validBid)) shouldBe
        Status.Code.NOT_FOUND
    }

    "answers DEADLINE_EXCEEDED when the lot does not answer in time" in {
      val silent = answering(Future.failed(new AskTimeoutException("no reply")))
      statusOf(service(silent).placeBid(validBid)) shouldBe Status.Code.DEADLINE_EXCEEDED
    }

    "answers a catalog command from a non-administrator with NotAdmin before touching the store" in {
      val upload = wire.LotImageUpload(ByteString.copyFrom(Array[Byte](0xff.toByte, 0xd8.toByte, 0xff.toByte)))
      val request = wire.CreateLotCardRequest(Some(viewer), lot, "Лот", "", Some(upload))
      service(Unreachable).createLotCard(request).futureValue.getRefused.reason.isNotAdmin shouldBe true
      val edit = wire.EditLotCardRequest(Some(viewer), lot, "Лот", "").withReplaceImage(upload)
      service(Unreachable).editLotCard(edit).futureValue.getRefused.reason.isNotAdmin shouldBe true
    }

    "answers an oversized image from an administrator with the limit before touching the store" in {
      val admin = viewer.withGlobalRoles(Seq(GlobalRoleMessage.GLOBAL_ROLE_ADMIN, GlobalRoleMessage.GLOBAL_ROLE_PUBLIC))
      val oversized = wire.LotImageUpload(ByteString.copyFrom(Array.fill[Byte](LotImage.MaxBytes + 1)(0)))
      val edit = wire.EditLotCardRequest(Some(admin), lot, "Лот", "").withReplaceImage(oversized)
      service(Unreachable).editLotCard(edit).futureValue.getRefused.reason.imageTooLarge shouldBe
        Some(wire.ImageTooLarge(LotImage.MaxBytes.toLong))
    }

    "refuses an image read from a viewer without the public role or of a wrong form before the read model" in {
      val member = Some(viewer.withGlobalRoles(Seq(GlobalRoleMessage.GLOBAL_ROLE_MEMBER)))
      statusOf(service(Unreachable).getLotImage(wire.GetLotImageRequest(member, lot))) shouldBe
        Status.Code.PERMISSION_DENIED
      statusOf(service(Unreachable).getLotImage(wire.GetLotImageRequest(Some(viewer), "lot"))) shouldBe
        Status.Code.INVALID_ARGUMENT
    }

    "answers an image read with the stored bytes and NOT_FOUND when the read model holds none" in {
      val bytes = Array[Byte](0xff.toByte, 0xd8.toByte, 0xff.toByte, 7)
      val stored = new Views {
        override def image(lotId: UUID) =
          Future.successful(
            Option.when(lotId == UUID.fromString(lot))(LotImageView(IArray.from(bytes), "image/jpeg", "v1"))
          )
      }
      val auction = service(Unreachable, views = stored)
      val read = auction.getLotImage(wire.GetLotImageRequest(Some(viewer), lot)).futureValue
      read.content.toByteArray shouldBe bytes
      read.mediaType shouldBe "image/jpeg"
      read.version shouldBe "v1"
      val other = "01890a5d-ac97-7c2b-9f3a-0d1b2c3d4e60"
      statusOf(auction.getLotImage(wire.GetLotImageRequest(Some(viewer), other))) shouldBe Status.Code.NOT_FOUND
    }

    "refuses a proxy limit and its withdrawal from a viewer without the public role before reaching the lot" in {
      val member = viewer.withGlobalRoles(Seq(GlobalRoleMessage.GLOBAL_ROLE_MEMBER))
      statusOf(service(Unreachable).setProxyLimit(validLimit.withViewer(member))) shouldBe Status.Code.PERMISSION_DENIED
      statusOf(service(Unreachable).withdrawProxyLimit(validWithdrawal.withViewer(member))) shouldBe
        Status.Code.PERMISSION_DENIED
    }

    "refuses a malformed proxy limit with INVALID_ARGUMENT before reaching the lot" in {
      statusOf(service(Unreachable).setProxyLimit(validLimit.clearMax)) shouldBe Status.Code.INVALID_ARGUMENT
      statusOf(service(Unreachable).withdrawProxyLimit(validWithdrawal.withOpId("x"))) shouldBe
        Status.Code.INVALID_ARGUMENT
    }

    "sends the viewer's proxy limit to the addressed lot as the participant's own limit" in {
      var seen = Option.empty[(UUID, SetProxyLimit, Initiator)]
      val recording = new Gateway {
        override def setProxyLimit(lotId: UUID, command: SetProxyLimit, initiator: Initiator) = {
          seen = Some((lotId, command, initiator))
          Future.successful(Left(SetProxyLimitRejected.ProxyBelowCurrentPrice))
        }
      }
      service(recording).setProxyLimit(validLimit).futureValue.getRefused.reason.isProxyBelowCurrentPrice shouldBe true
      val (lotId, command, initiator) = seen.getOrElse(fail("the lot was not reached"))
      lotId shouldBe UUID.fromString(lot)
      initiator shouldBe Initiator.Participant(ParticipantId(UUID.fromString(identity)))
      command.participant shouldBe ParticipantId(UUID.fromString(identity))
      command.max shouldBe money(200)
    }

    "answers a withdrawal without an active limit with NoActiveProxyLimit and a missing lot with NOT_FOUND" in {
      val none = new Gateway {
        override def withdrawProxyLimit(lotId: UUID, command: WithdrawProxyLimit, initiator: Initiator) =
          Future.successful(Left(WithdrawProxyLimitRejected.NoActiveProxyLimit))
      }
      service(none).withdrawProxyLimit(validWithdrawal).futureValue.getRefused.reason.isNoActiveProxyLimit shouldBe true
      val missing = new Gateway {
        override def setProxyLimit(lotId: UUID, command: SetProxyLimit, initiator: Initiator) =
          Future.successful(Left(SetProxyLimitRejected.LotNotFound))
      }
      statusOf(service(missing).setProxyLimit(validLimit)) shouldBe Status.Code.NOT_FOUND
    }

    "refuses a read from a viewer without the public role before touching the read model" in {
      val member = Some(viewer.withGlobalRoles(Seq(GlobalRoleMessage.GLOBAL_ROLE_MEMBER)))
      statusOf(service(Unreachable).getLot(wire.GetLotRequest(member, lot))) shouldBe Status.Code.PERMISSION_DENIED
      statusOf(service(Unreachable).listAuctionLots(wire.ListAuctionLotsRequest(member, lot))) shouldBe
        Status.Code.PERMISSION_DENIED
    }

    "refuses a malformed read with INVALID_ARGUMENT before touching the read model" in {
      val auction = service(Unreachable)
      statusOf(auction.getLot(wire.GetLotRequest(Some(viewer), "lot"))) shouldBe Status.Code.INVALID_ARGUMENT
      statusOf(auction.listAuctionLots(wire.ListAuctionLotsRequest(Some(viewer), lot, "forged"))) shouldBe
        Status.Code.INVALID_ARGUMENT
      statusOf(auction.listAuctionLots(wire.ListAuctionLotsRequest(Some(viewer), lot, "", -1))) shouldBe
        Status.Code.INVALID_ARGUMENT
    }

    "answers NOT_FOUND to a lot the read model does not hold" in {
      val empty = new Views {
        override def find(lotId: UUID) = Future.successful(None)
      }
      statusOf(service(Unreachable, views = empty).getLot(wire.GetLotRequest(Some(viewer), lot))) shouldBe
        Status.Code.NOT_FOUND
    }

    "answers a lot from the read model as the viewer sees it" in {
      val held = new Views {
        override def find(lotId: UUID) =
          Future.successful(Some(LotSnapshotView(lotId, auctionId(1).value, 3, trading(price = 120), None)))
      }
      val snapshot = service(Unreachable, views = held).getLot(wire.GetLotRequest(Some(viewer), lot)).futureValue
      snapshot.id shouldBe lot
      snapshot.getTrading.currentPrice shouldBe Some(MoneyMessage(120, "RUB"))
    }

    "pages the lots of an auction and continues after the last lot it answered" in {
      val ids = (1 to 5).map(n => new UUID(0x01926f3c8b7a7cdeL, 0x8f00000000000000L | n.toLong)).toList
      val catalog = new Views {
        override def page(auctionId: UUID, after: Option[UUID], limit: Int) =
          Future.successful(
            ids
              .filter(id => after.forall(id.compareTo(_) > 0))
              .take(limit)
              .map(LotSnapshotView(_, auctionId, 1, drafted, None))
          )
      }
      val auction = service(Unreachable, views = catalog)
      val first = auction.listAuctionLots(wire.ListAuctionLotsRequest(Some(viewer), lot, "", 2)).futureValue
      first.lots.map(_.id) shouldBe ids.take(2).map(_.toString)
      val second =
        auction.listAuctionLots(wire.ListAuctionLotsRequest(Some(viewer), lot, first.nextPageToken, 2)).futureValue
      second.lots.map(_.id) shouldBe ids.slice(2, 4).map(_.toString)
      val last =
        auction.listAuctionLots(wire.ListAuctionLotsRequest(Some(viewer), lot, second.nextPageToken, 2)).futureValue
      last.lots.map(_.id) shouldBe ids.drop(4).map(_.toString)
      last.nextPageToken shouldBe ""
    }

    "reads the lots of a meetup auction from its registry and of a test auction from the lots born in it" in {
      val meetupAuction = Auction.idOf(MeetupId(UUID.fromString(meetupId))).value
      val both = new Views {
        override def page(auctionId: UUID, after: Option[UUID], limit: Int) =
          Future.successful(List(LotSnapshotView(UUID.fromString(lot), auctionId, 1, drafted, None)))
        override def registryPage(auctionId: UUID, after: Option[UUID], limit: Int) = Future.successful(Nil)
      }
      val auction = service(Unreachable, views = both)
      auction
        .listAuctionLots(wire.ListAuctionLotsRequest(Some(viewer), meetupAuction.toString))
        .futureValue
        .lots shouldBe empty
      auction.listAuctionLots(wire.ListAuctionLotsRequest(Some(viewer), lot)).futureValue.lots should have size 1
    }

    "refuses a history read without the public role or with a forged token before touching the read model" in {
      val member = Some(viewer.withGlobalRoles(Seq(GlobalRoleMessage.GLOBAL_ROLE_MEMBER)))
      val auction = service(Unreachable)
      statusOf(auction.listLotHistory(wire.ListLotHistoryRequest(member, lot))) shouldBe Status.Code.PERMISSION_DENIED
      statusOf(auction.listLotHistory(wire.ListLotHistoryRequest(Some(viewer), "lot"))) shouldBe
        Status.Code.INVALID_ARGUMENT
      statusOf(auction.listLotHistory(wire.ListLotHistoryRequest(Some(viewer), lot, "forged"))) shouldBe
        Status.Code.INVALID_ARGUMENT
      statusOf(auction.listLotHistory(wire.ListLotHistoryRequest(Some(viewer), lot, "", -1))) shouldBe
        Status.Code.INVALID_ARGUMENT
    }

    "answers NOT_FOUND to the history of a lot the read model does not hold" in {
      val empty = new Views {
        override def history(lotId: UUID, after: Option[Long], limit: Int) = Future.successful(None)
      }
      statusOf(
        service(Unreachable, views = empty).listLotHistory(wire.ListLotHistoryRequest(Some(viewer), lot))
      ) shouldBe
        Status.Code.NOT_FOUND
    }

    "pages the history of a lot by journal position and continues after the last entry it answered" in {
      val at = Instant.parse("2026-10-04T12:00:00Z")
      // Позиции с пропусками, как у журнала с приватными событиями, и одно время на всех.
      val bids = List(3L, 4L, 7L, 9L, 12L).map(seq => bidRecord(seq, 100 + seq, "Manual", Some("Bot"), at))
      val journal = new Views {
        override def history(lotId: UUID, after: Option[Long], limit: Int) =
          Future.successful(Some(bids.filter(bid => after.forall(bid.sequence > _)).take(limit)))
      }
      val auction = service(Unreachable, views = journal)
      val first = auction.listLotHistory(wire.ListLotHistoryRequest(Some(viewer), lot, "", 2)).futureValue
      first.entries.map(_.sequence) shouldBe Seq(3L, 4L)
      val second =
        auction.listLotHistory(wire.ListLotHistoryRequest(Some(viewer), lot, first.nextPageToken, 2)).futureValue
      second.entries.map(_.sequence) shouldBe Seq(7L, 9L)
      val last =
        auction.listLotHistory(wire.ListLotHistoryRequest(Some(viewer), lot, second.nextPageToken, 2)).futureValue
      last.entries.map(_.sequence) shouldBe Seq(12L)
      last.nextPageToken shouldBe ""
    }

    "answers a manual bid with its channel and a proxy bid without one" in {
      val at = Instant.parse("2026-10-04T12:00:00Z")
      val journal = new Views {
        override def history(lotId: UUID, after: Option[Long], limit: Int) =
          Future.successful(
            Some(List(bidRecord(2, 150, "Manual", Some("Floor"), at), bidRecord(5, 260, "Proxy", None, at)))
          )
      }
      val entries = service(Unreachable, views = journal)
        .listLotHistory(wire.ListLotHistoryRequest(Some(viewer), lot))
        .futureValue
        .entries
      entries.map(_.occurredAt) shouldBe Seq("2026-10-04T12:00:00Z", "2026-10-04T12:00:00Z")
      entries.map(_.getBid.amount) shouldBe Seq(Some(MoneyMessage(150, "RUB")), Some(MoneyMessage(260, "RUB")))
      entries.head.getBid.getManual.source shouldBe BidSourceMessage.BID_SOURCE_FLOOR
      entries(1).getBid.origin.isProxy shouldBe true
    }

    "answers a draft to an existing meetup auction with its derived id and the already-existed mark" in {
      val existing = new Auctions {
        override def inspect(auctionId: AuctionId, opId: OpId) =
          Future.successful(Inspection.Present(MeetupId(UUID.fromString(meetupId)), registryOpen = true))
        override def draft(auctionId: AuctionId, command: DraftAuction, initiator: Initiator) =
          Future.successful(AuctionAnswer.Unchanged)
      }
      val granted: MeetupAuthority = (_, _, _) => Future.successful(Authority.Granted)
      val answer = service(Unreachable, auctions = AuctionCommands(existing, Unreachable, granted))
        .draftAuction(wire.DraftAuctionRequest(Some(viewer), meetupId, op))
        .futureValue
      answer.getAccepted.auctionId shouldBe Auction.idOf(MeetupId(UUID.fromString(meetupId))).value.toString
      answer.getAccepted.alreadyExisted shouldBe true
    }

    "answers UNAVAILABLE when meetups cannot confirm the administrator" in {
      val absent = new Auctions {
        override def inspect(auctionId: AuctionId, opId: OpId) = Future.successful(Inspection.Absent)
      }
      val unavailable: MeetupAuthority = (_, _, _) => Future.successful(Authority.Unavailable)
      statusOf(
        service(Unreachable, auctions = AuctionCommands(absent, Unreachable, unavailable))
          .draftAuction(wire.DraftAuctionRequest(Some(viewer), meetupId, op))
      ) shouldBe Status.Code.UNAVAILABLE
    }

    "refuses auction requests of a wrong form before asking the auction or meetups" in {
      val auction = service(Unreachable)
      statusOf(auction.draftAuction(wire.DraftAuctionRequest(Some(viewer), "meetup", op))) shouldBe
        Status.Code.INVALID_ARGUMENT
      // Реестр есть только у аукциона сходки, UUIDv5: UUIDv7 тестового аукциона здесь — нарушение формы.
      statusOf(auction.addLot(wire.AddLotRequest(Some(viewer), lot, lot, op))) shouldBe Status.Code.INVALID_ARGUMENT
      statusOf(auction.removeLot(wire.RemoveLotRequest(Some(viewer), lot, lot, op))) shouldBe
        Status.Code.INVALID_ARGUMENT
      statusOf(auction.getMeetupAuction(wire.GetMeetupAuctionRequest(Some(viewer), "meetup"))) shouldBe
        Status.Code.INVALID_ARGUMENT
      statusOf(auction.listAuctions(wire.ListAuctionsRequest(Some(viewer)))) shouldBe Status.Code.INVALID_ARGUMENT
    }

    "answers a meetup without an auction with an empty response, not an error" in {
      val none = new AuctionViews {
        def byMeetup(meetup: MeetupId) = Future.successful(None)
        def page(listing: AuctionListing, after: Option[UUID], limit: Int) = fail("a list was read")
      }
      service(Unreachable, auctionViews = none)
        .getMeetupAuction(wire.GetMeetupAuctionRequest(Some(viewer), meetupId))
        .futureValue
        .auction shouldBe None
    }

    "answers a meetup auction draft with its registry and pages a listing by auction id" in {
      val ids = (1 to 3).map(n => Auction.idOf(MeetupId(new UUID(0x01926f3c8b7a7cdeL, 0x8f00000000000000L | n))).value)
      val sorted = ids.sorted.toList
      val draft = Auction(
        AuctionState.Draft,
        Some(MeetupId(UUID.fromString(meetupId))),
        Set(LotId(UUID.fromString(lot))),
        Map.empty
      )
      val views = new AuctionViews {
        def byMeetup(meetup: MeetupId) = Future.successful(Some(AuctionSnapshotView(sorted.head, draft)))
        def page(listing: AuctionListing, after: Option[UUID], limit: Int) =
          Future.successful(
            sorted.filter(id => after.forall(id.compareTo(_) > 0)).take(limit).map(AuctionSnapshotView(_, draft))
          )
      }
      val auction = service(Unreachable, auctionViews = views)
      val read = auction.getMeetupAuction(wire.GetMeetupAuctionRequest(Some(viewer), meetupId)).futureValue.getAuction
      read.lotIds shouldBe Seq(lot)
      read.status.isDraft shouldBe true
      val active = wire.AuctionListing.AUCTION_LISTING_ACTIVE
      val first = auction.listAuctions(wire.ListAuctionsRequest(Some(viewer), active, "", 2)).futureValue
      first.auctions.map(_.id) shouldBe sorted.take(2).map(_.toString)
      val rest =
        auction.listAuctions(wire.ListAuctionsRequest(Some(viewer), active, first.nextPageToken, 2)).futureValue
      rest.auctions.map(_.id) shouldBe sorted.drop(2).map(_.toString)
      rest.nextPageToken shouldBe ""
    }

    "answers a registry command to an auction in prebidding with LotsFrozen as a value, without drafting the lot" in {
      val auctionId = Auction.idOf(MeetupId(UUID.fromString(meetupId))).value.toString
      val frozen = new Auctions {
        override def inspect(auctionId: AuctionId, opId: OpId) =
          Future.successful(Inspection.Present(MeetupId(UUID.fromString(meetupId)), registryOpen = false))
        override def removeLot(auctionId: AuctionId, command: RemoveLot, initiator: Initiator) =
          Future.successful(Left(RemoveLotRejected.LotsFrozen))
      }
      val granted: MeetupAuthority = (_, _, _) => Future.successful(Authority.Granted)
      val auction = service(Unreachable, auctions = AuctionCommands(frozen, Unreachable, granted))
      auction
        .addLot(wire.AddLotRequest(Some(viewer), auctionId, lot, op))
        .futureValue
        .getRefused
        .reason
        .isLotsFrozen shouldBe true
      auction
        .removeLot(wire.RemoveLotRequest(Some(viewer), auctionId, lot, op))
        .futureValue
        .getRefused
        .reason
        .isLotsFrozen shouldBe true
    }

    "answers a scheduled auction and an auction in prebidding with their config and status" in {
      val meetup = MeetupId(UUID.fromString(meetupId))
      val id = Auction.idOf(meetup).value
      def read(state: AuctionState): wire.AuctionSnapshot = {
        val views = new AuctionViews {
          def byMeetup(meetup: MeetupId) =
            Future.successful(Some(AuctionSnapshotView(id, Auction(state, Some(meetup), Set.empty, Map.empty))))
          def page(listing: AuctionListing, after: Option[UUID], limit: Int) = fail("a list was read")
        }
        service(Unreachable, auctionViews = views)
          .getMeetupAuction(wire.GetMeetupAuctionRequest(Some(viewer), meetupId))
          .futureValue
          .getAuction
      }
      val scheduled = read(AuctionState.Scheduled(AuctionFixtures.config()))
      scheduled.status.isScheduled shouldBe true
      val config = scheduled.getConfig
      config.getOnlinePhase.opensAt shouldBe "2026-10-01T18:00:00Z"
      config.getOnlinePhase.closesAt shouldBe Some("2026-10-08T21:00:00Z")
      config.getOnlinePhase.closesLots shouldBe true
      config.finalBlocks shouldBe 1
      config.getClosingPolicy.getMixed.onlineByDeadline shouldBe true
      config.getLotDefaults.currency shouldBe "RUB"
      config.getLotDefaults.getStepPolicy.getFixed.minorUnits shouldBe 10
      val started = read(AuctionState.Prebidding(AuctionFixtures.config(), OpId(UUID.fromString(op))))
      started.status.isPrebidding shouldBe true
      started.config shouldBe scheduled.config
      val ledByPerson = read(AuctionState.Scheduled(AuctionFixtures.config(AuctionFixtures.byAuctioneer))).getConfig
      ledByPerson.getOnlinePhase.closesAt shouldBe None
      ledByPerson.getClosingPolicy.policy.isByAuctioneer shouldBe true
    }

    "answers UNIMPLEMENTED on display names that belong to a later slice" in {
      val auction = service(Unreachable)
      statusOf(auction.chooseDisplayName(wire.ChooseDisplayNameRequest())) shouldBe Status.Code.UNIMPLEMENTED
      statusOf(auction.getDisplayNames(wire.GetDisplayNamesRequest())) shouldBe Status.Code.UNIMPLEMENTED
    }

    "answers UNIMPLEMENTED on invoices until the invoice slice" in {
      val auction = service(Unreachable)
      statusOf(auction.markInvoicePaid(wire.MarkInvoicePaidRequest())) shouldBe Status.Code.UNIMPLEMENTED
      statusOf(auction.markInvoiceHandedOver(wire.MarkInvoiceHandedOverRequest())) shouldBe Status.Code.UNIMPLEMENTED
      statusOf(auction.chooseFulfillment(wire.ChooseFulfillmentRequest())) shouldBe Status.Code.UNIMPLEMENTED
      statusOf(auction.listMyInvoices(wire.ListMyInvoicesRequest())) shouldBe Status.Code.UNIMPLEMENTED
      statusOf(auction.listAuctionInvoices(wire.ListAuctionInvoicesRequest())) shouldBe Status.Code.UNIMPLEMENTED
    }
  }

  private def bidRecord(sequence: Long, amount: Long, origin: String, source: Option[String], at: Instant) =
    BidRecord(
      lotId = UUID.fromString(lot),
      sequence = sequence,
      bidId = new UUID(0x01926f3c8b7a7cdeL, 0x8f00000000000000L | sequence),
      participant = UUID.fromString(identity),
      minorUnits = amount,
      currency = "RUB",
      origin = origin,
      source = source,
      occurredAt = at
    )
}
