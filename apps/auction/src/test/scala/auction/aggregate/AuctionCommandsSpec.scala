package auction.aggregate

import auction.catalog.LotId
import auction.entity.AuctionAnswer
import auction.entity.AuctionGateway
import auction.entity.Initiator
import auction.entity.LotGateway
import auction.lot.*
import auction.lot.LotFixtures.*
import org.scalatest.concurrent.ScalaFutures
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

import java.util.UUID
import scala.concurrent.ExecutionContext
import scala.concurrent.Future

/**
 * Порядок команд администратора (ADR-047, дополнение 2026-10-03): повтор раньше права, отсутствие аукциона раньше
 * права, право раньше агрегата. Шлюзы и Meetups — записи вызовов; не заданный тестом ответ роняет тест.
 */
final class AuctionCommandsSpec extends AnyWordSpec with Matchers with ScalaFutures {

  private given ExecutionContext = ExecutionContext.parasitic

  private val meetup = MeetupId(UUID.fromString("0190a0e0-0000-7000-8000-000000000001"))
  private val auctionOfMeetup = Auction.idOf(meetup)
  private val lot = LotId(new UUID(5L, 1L))
  private val person = participant(1)

  private final class Auctions(inspection: Inspection) extends AuctionGateway {
    var commands: List[Any] = Nil
    var addAnswer: Either[AddLotRejected, AuctionAnswer] = Right(AuctionAnswer.Unchanged)
    var removeAnswer: Either[RemoveLotRejected, AuctionAnswer] = Right(AuctionAnswer.Unchanged)

    def inspect(auctionId: AuctionId, opId: OpId): Future[Inspection] = Future.successful(inspection)

    def draft(auctionId: AuctionId, command: DraftAuction, initiator: Initiator): Future[AuctionAnswer] = {
      commands :+= command
      Future.successful(AuctionAnswer.Written(AuctionEnvelope(1, command.opId, AuctionEvent.AuctionDrafted(meetup))))
    }

    def addLot(auctionId: AuctionId, command: AddLot, initiator: Initiator) = {
      commands :+= command
      Future.successful(addAnswer)
    }

    def removeLot(auctionId: AuctionId, command: RemoveLot, initiator: Initiator) = {
      commands :+= command
      Future.successful(removeAnswer)
    }
  }

  private class Lots(answer: Either[DraftLotRejected, Envelope], bornIn: Option[AuctionId] = None) extends LotGateway {
    var drafted: List[(UUID, DraftLot)] = Nil
    def draftLot(lotId: UUID, command: DraftLot, initiator: Initiator) = {
      drafted :+= lotId -> command
      Future.successful(answer)
    }
    def auctionOf(lotId: UUID) = Future.successful(bornIn)
    def placeBid(lotId: UUID, command: PlaceBid, initiator: Initiator) = fail("a bid was placed")
    def setProxyLimit(lotId: UUID, command: SetProxyLimit, initiator: Initiator) = fail("a limit was set")
    def withdrawProxyLimit(lotId: UUID, command: WithdrawProxyLimit, initiator: Initiator) =
      fail("a limit was withdrawn")
  }

  private val noLots = new Lots(Left(DraftLotRejected.LotAlreadyExists)) {
    override def draftLot(lotId: UUID, command: DraftLot, initiator: Initiator) = fail("a lot was drafted")
  }

  private final class Meetups(answer: Authority) extends MeetupAuthority {
    var asked = 0
    def check(meetup: MeetupId, person: ParticipantId): Future[Authority] = {
      asked += 1
      Future.successful(answer)
    }
  }

  "auction commands" should {

    "answers a repeated draft from the window without asking meetups" in {
      val original = AuctionEnvelope(1, op(1), AuctionEvent.AuctionDrafted(meetup))
      val auctions = Auctions(Inspection.Repeated(original))
      val meetups = Meetups(Authority.NotAdministrator)
      AuctionCommands(auctions, noLots, meetups).draft(meetup, op(1), person).futureValue shouldBe
        Right(Drafted(auctionOfMeetup, alreadyExisted = false))
      meetups.asked shouldBe 0
      auctions.commands shouldBe empty
    }

    "refuses a draft that meetups does not confirm before the auction decides" in {
      for (
        (answer, denial) <- List(
          Authority.NotAdministrator -> Denial.NotAdministrator,
          Authority.MeetupNotFound -> Denial.MeetupNotFound,
          Authority.Unavailable -> Denial.Unavailable
        )
      ) {
        val auctions = Auctions(Inspection.Absent)
        AuctionCommands(auctions, noLots, Meetups(answer)).draft(meetup, op(1), person).futureValue shouldBe
          Left(denial)
        auctions.commands shouldBe empty
      }
    }

    "drafts the auction derived from the meetup once meetups confirms the administrator" in {
      val auctions = Auctions(Inspection.Absent)
      AuctionCommands(auctions, noLots, Meetups(Authority.Granted)).draft(meetup, op(1), person).futureValue shouldBe
        Right(Drafted(auctionOfMeetup, alreadyExisted = false))
      auctions.commands shouldBe List(DraftAuction(meetup, op(1)))
    }

    "answers a registry command on an auction without a journal with AuctionNotFound before meetups" in {
      val meetups = Meetups(Authority.Granted)
      val commands = AuctionCommands(Auctions(Inspection.Absent), noLots, meetups)
      commands.addLot(auctionOfMeetup, lot, op(2), person).futureValue shouldBe Left(Denial.AuctionNotFound)
      commands.removeLot(auctionOfMeetup, lot, op(2), person).futureValue shouldBe
        Left(RemovalRefusal.Denied(Denial.AuctionNotFound))
      meetups.asked shouldBe 0
    }

    "adds a lot to the registry and then drafts it in the auction with the same op_id" in {
      val auctions = Auctions(Inspection.Present(meetup))
      val lots = Lots(Right(Envelope(1, op(2), LotEvent.LotDrafted(auctionOfMeetup))))
      AuctionCommands(auctions, lots, Meetups(Authority.Granted))
        .addLot(auctionOfMeetup, lot, op(2), person)
        .futureValue shouldBe Right(())
      auctions.commands shouldBe List(AddLot(lot, op(2)))
      lots.drafted shouldBe List(lot.value -> DraftLot(auctionOfMeetup, op(2)))
    }

    "accepts a lot that was already born, as after RemoveLot" in {
      val lots = Lots(Left(DraftLotRejected.LotAlreadyExists), bornIn = Some(auctionOfMeetup))
      AuctionCommands(Auctions(Inspection.Present(meetup)), lots, Meetups(Authority.Granted))
        .addLot(auctionOfMeetup, lot, op(2), person)
        .futureValue shouldBe Right(())
    }

    "refuses a lot born in another auction and leaves the registry untouched" in {
      val auctions = Auctions(Inspection.Present(meetup))
      val lots = Lots(Left(DraftLotRejected.LotAlreadyExists), bornIn = Some(auctionId(9)))
      AuctionCommands(auctions, lots, Meetups(Authority.Granted))
        .addLot(auctionOfMeetup, lot, op(2), person)
        .futureValue shouldBe Left(Denial.LotOfAnotherAuction)
      auctions.commands shouldBe empty
    }

    "finishes drafting the lot of a repeated addition without asking meetups, so an interrupted addition completes" in {
      val original = AuctionEnvelope(2, op(2), AuctionEvent.LotAdded(lot))
      val lots = Lots(Right(Envelope(1, op(2), LotEvent.LotDrafted(auctionOfMeetup))))
      val meetups = Meetups(Authority.NotAdministrator)
      AuctionCommands(Auctions(Inspection.Repeated(original)), lots, meetups)
        .addLot(auctionOfMeetup, lot, op(2), person)
        .futureValue shouldBe Right(())
      meetups.asked shouldBe 0
      lots.drafted shouldBe List(lot.value -> DraftLot(auctionOfMeetup, op(2)))
    }

    "refuses a registry command that meetups does not confirm and touches neither the auction nor the lot" in {
      val auctions = Auctions(Inspection.Present(meetup))
      val commands = AuctionCommands(auctions, noLots, Meetups(Authority.NotAdministrator))
      commands.addLot(auctionOfMeetup, lot, op(2), person).futureValue shouldBe Left(Denial.NotAdministrator)
      commands.removeLot(auctionOfMeetup, lot, op(2), person).futureValue shouldBe
        Left(RemovalRefusal.Denied(Denial.NotAdministrator))
      auctions.commands shouldBe empty
    }

    "passes LotNotInAuction from the auction through as a refusal of the removal" in {
      val auctions = Auctions(Inspection.Present(meetup))
      auctions.removeAnswer = Left(RemoveLotRejected.LotNotInAuction)
      AuctionCommands(auctions, noLots, Meetups(Authority.Granted))
        .removeLot(auctionOfMeetup, lot, op(2), person)
        .futureValue shouldBe Left(RemovalRefusal.LotNotInAuction)
    }
  }
}
