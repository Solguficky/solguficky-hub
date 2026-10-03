package auction.grpc

import auction.catalog.LotCard
import auction.catalog.LotCatalogCommands
import auction.catalog.LotCatalogStore
import auction.catalog.LotId
import auction.entity.Initiator
import auction.entity.LotGateway
import auction.lot.Envelope
import auction.lot.LotFixtures.*
import auction.lot.ParticipantId
import auction.lot.PlaceBid
import auction.lot.PlaceBidRejected
import auction.lot.SetProxyLimit
import auction.lot.SetProxyLimitRejected
import auction.lot.WithdrawProxyLimit
import auction.lot.WithdrawProxyLimitRejected
import auction.onboarding.FaqAcknowledgements
import auction.projection.LotSnapshotView
import auction.projection.LotViews
import auction.v1.auction.Money as MoneyMessage
import auction.v1.auction_service as wire
import identity.v1.roles.GlobalRole as GlobalRoleMessage
import io.grpc.Status
import org.apache.pekko.grpc.GrpcServiceException
import org.apache.pekko.pattern.AskTimeoutException
import org.scalatest.concurrent.ScalaFutures
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

import java.util.UUID
import scala.concurrent.ExecutionContext
import scala.concurrent.Future

final class AuctionGrpcServiceSpec extends AnyWordSpec with Matchers with ScalaFutures {

  import RequestMappingSpec.*

  private given ExecutionContext = ExecutionContext.parasitic

  /** Шлюз, до которого запрос не должен дойти: любой вызов, который тест не переопределил, роняет тест. */
  private class Gateway extends LotGateway {
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
    def insertIfAbsent(card: LotCard): Future[Option[LotCard]] = touched
    def update(card: LotCard): Future[Boolean] = touched
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

  private object UntouchableViews extends LotViews {
    def find(lotId: UUID): Future[Option[LotSnapshotView]] = fail("the read model was touched")
    def page(auctionId: UUID, after: Option[UUID], limit: Int): Future[List[LotSnapshotView]] =
      fail("the read model was touched")
  }

  private def service(lots: LotGateway, faq: FaqAcknowledgements = UntouchableFaq, views: LotViews = UntouchableViews) =
    AuctionGrpcService(lots, LotCatalogCommands(UntouchableStore), faq, views)

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
      val request = wire.CreateLotCardRequest(Some(viewer), lot, "Лот", "")
      service(Unreachable).createLotCard(request).futureValue.getRefused.reason.isNotAdmin shouldBe true
      val edit = wire.EditLotCardRequest(Some(viewer), lot, "Лот", "")
      service(Unreachable).editLotCard(edit).futureValue.getRefused.reason.isNotAdmin shouldBe true
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
      val empty = new LotViews {
        def find(lotId: UUID) = Future.successful(None)
        def page(auctionId: UUID, after: Option[UUID], limit: Int) = Future.successful(Nil)
      }
      statusOf(service(Unreachable, views = empty).getLot(wire.GetLotRequest(Some(viewer), lot))) shouldBe
        Status.Code.NOT_FOUND
    }

    "answers a lot from the read model as the viewer sees it" in {
      val held = new LotViews {
        def find(lotId: UUID) =
          Future.successful(Some(LotSnapshotView(lotId, auctionId(1).value, 3, trading(price = 120), None)))
        def page(auctionId: UUID, after: Option[UUID], limit: Int) = fail("a page was read")
      }
      val snapshot = service(Unreachable, views = held).getLot(wire.GetLotRequest(Some(viewer), lot)).futureValue
      snapshot.id shouldBe lot
      snapshot.getTrading.currentPrice shouldBe Some(MoneyMessage(120, "RUB"))
    }

    "pages the lots of an auction and continues after the last lot it answered" in {
      val ids = (1 to 5).map(n => new UUID(0x01926f3c8b7a7cdeL, 0x8f00000000000000L | n.toLong)).toList
      val catalog = new LotViews {
        def find(lotId: UUID) = fail("a single lot was read")
        def page(auctionId: UUID, after: Option[UUID], limit: Int) =
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

    "answers UNIMPLEMENTED on display names that belong to a later slice" in {
      val auction = service(Unreachable)
      statusOf(auction.chooseDisplayName(wire.ChooseDisplayNameRequest())) shouldBe Status.Code.UNIMPLEMENTED
      statusOf(auction.getDisplayNames(wire.GetDisplayNamesRequest())) shouldBe Status.Code.UNIMPLEMENTED
    }
  }
}
