package auction.aggregate

import auction.aggregate.AuctionFixtures.config
import auction.aggregate.AuctionFixtures.configInput
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
  private val step = StepPolicyInput.Fixed(money(250))

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

    var scheduleAnswer: Either[ScheduleAuctionRejected, AuctionAnswer] = Right(AuctionAnswer.Unchanged)
    var startAnswer: Either[StartPrebiddingRejected, AuctionAnswer] = Right(AuctionAnswer.Unchanged)

    def schedule(auctionId: AuctionId, command: ScheduleAuction, initiator: Initiator) = {
      commands :+= command
      Future.successful(scheduleAnswer)
    }

    def startPrebidding(auctionId: AuctionId, command: StartPrebidding, initiator: Initiator) = {
      commands :+= command
      Future.successful(startAnswer)
    }

    var planAnswer: Either[ScheduleAuctionLotRejected, Unit] = Right(())

    def scheduleLot(auctionId: AuctionId, command: ScheduleAuctionLot, initiator: Initiator) = {
      commands :+= command
      Future.successful(planAnswer)
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
    def check(meetup: MeetupId, person: ParticipantId, correlation: Correlation): Future[Authority] = {
      asked += 1
      Future.successful(answer)
    }
  }

  private def granted: Meetups = Meetups(Authority.Granted)

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
      val auctions = Auctions(Inspection.Present(meetup, registryOpen = true))
      val lots = Lots(Right(Envelope(1, op(2), LotEvent.LotDrafted(auctionOfMeetup))))
      AuctionCommands(auctions, lots, Meetups(Authority.Granted))
        .addLot(auctionOfMeetup, lot, op(2), person)
        .futureValue shouldBe Right(())
      auctions.commands shouldBe List(AddLot(lot, op(2)))
      lots.drafted shouldBe List(lot.value -> DraftLot(auctionOfMeetup, op(2)))
    }

    "accepts a lot that was already born, as after RemoveLot" in {
      val lots = Lots(Left(DraftLotRejected.LotAlreadyExists), bornIn = Some(auctionOfMeetup))
      AuctionCommands(Auctions(Inspection.Present(meetup, registryOpen = true)), lots, Meetups(Authority.Granted))
        .addLot(auctionOfMeetup, lot, op(2), person)
        .futureValue shouldBe Right(())
    }

    "refuses a lot that a repeated op_id drafted in another auction and leaves the registry untouched" in {
      val auctions = Auctions(Inspection.Present(meetup, registryOpen = true))
      val lots = Lots(Right(Envelope(1, op(2), LotEvent.LotDrafted(auctionId(9)))))
      AuctionCommands(auctions, lots, Meetups(Authority.Granted))
        .addLot(auctionOfMeetup, lot, op(2), person)
        .futureValue shouldBe Left(Denial.LotOfAnotherAuction)
      auctions.commands shouldBe empty
    }

    "refuses a lot born in another auction and leaves the registry untouched" in {
      val auctions = Auctions(Inspection.Present(meetup, registryOpen = true))
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
      val auctions = Auctions(Inspection.Present(meetup, registryOpen = true))
      val commands = AuctionCommands(auctions, noLots, Meetups(Authority.NotAdministrator))
      commands.addLot(auctionOfMeetup, lot, op(2), person).futureValue shouldBe Left(Denial.NotAdministrator)
      commands.removeLot(auctionOfMeetup, lot, op(2), person).futureValue shouldBe
        Left(RemovalRefusal.Denied(Denial.NotAdministrator))
      auctions.commands shouldBe empty
    }

    "passes LotNotInAuction from the auction through as a refusal of the removal" in {
      val auctions = Auctions(Inspection.Present(meetup, registryOpen = true))
      auctions.removeAnswer = Left(RemoveLotRejected.LotNotInAuction)
      AuctionCommands(auctions, noLots, Meetups(Authority.Granted))
        .removeLot(auctionOfMeetup, lot, op(2), person)
        .futureValue shouldBe Left(RemovalRefusal.LotNotInAuction)
    }

    "refuses a lot before it is born once the registry is frozen" in {
      val auctions = Auctions(Inspection.Present(meetup, registryOpen = false))
      AuctionCommands(auctions, noLots, Meetups(Authority.Granted))
        .addLot(auctionOfMeetup, lot, op(2), person)
        .futureValue shouldBe Left(Denial.LotsFrozen)
      auctions.commands shouldBe empty
    }

    "passes LotsFrozen from an auction that started between the inspection and the command" in {
      val auctions = Auctions(Inspection.Present(meetup, registryOpen = true))
      auctions.addAnswer = Left(AddLotRejected.LotsFrozen)
      auctions.removeAnswer = Left(RemoveLotRejected.LotsFrozen)
      val commands =
        AuctionCommands(auctions, Lots(Left(DraftLotRejected.LotAlreadyExists), Some(auctionOfMeetup)), granted)
      commands.addLot(auctionOfMeetup, lot, op(2), person).futureValue shouldBe Left(Denial.LotsFrozen)
      commands.removeLot(auctionOfMeetup, lot, op(3), person).futureValue shouldBe
        Left(RemovalRefusal.Denied(Denial.LotsFrozen))
    }

    "answers scheduling and opening of an auction without a journal with AuctionNotFound before meetups" in {
      val meetups = Meetups(Authority.Granted)
      val commands = AuctionCommands(Auctions(Inspection.Absent), noLots, meetups)
      commands.schedule(auctionOfMeetup, configInput(), op(2), person).futureValue shouldBe
        Left(SchedulingRefusal.Denied(Denial.AuctionNotFound))
      commands.startPrebidding(auctionOfMeetup, op(3), person).futureValue shouldBe
        Left(OpeningRefusal.Denied(Denial.AuctionNotFound))
      meetups.asked shouldBe 0
    }

    "refuses scheduling and opening that meetups does not confirm and does not reach the auction" in {
      for (
        (answer, denial) <- List(
          Authority.NotAdministrator -> Denial.NotAdministrator,
          Authority.MeetupNotFound -> Denial.MeetupNotFound,
          Authority.Unavailable -> Denial.Unavailable
        )
      ) {
        val auctions = Auctions(Inspection.Present(meetup, registryOpen = true))
        val commands = AuctionCommands(auctions, noLots, Meetups(answer))
        commands.schedule(auctionOfMeetup, configInput(), op(2), person).futureValue shouldBe
          Left(SchedulingRefusal.Denied(denial))
        commands.startPrebidding(auctionOfMeetup, op(3), person).futureValue shouldBe
          Left(OpeningRefusal.Denied(denial))
        auctions.commands shouldBe empty
      }
    }

    "schedules and opens the auction once meetups confirms the administrator" in {
      val auctions = Auctions(Inspection.Present(meetup, registryOpen = true))
      val commands = AuctionCommands(auctions, noLots, granted)
      commands.schedule(auctionOfMeetup, configInput(), op(2), person).futureValue shouldBe Right(())
      commands.startPrebidding(auctionOfMeetup, op(3), person).futureValue shouldBe Right(())
      auctions.commands shouldBe List(ScheduleAuction(configInput(), op(2)), StartPrebidding(op(3)))
    }

    "passes the refusals of the auction through as refusals of scheduling and opening" in {
      val auctions = Auctions(Inspection.Present(meetup, registryOpen = true))
      val commands = AuctionCommands(auctions, noLots, granted)
      auctions.scheduleAnswer = Left(ScheduleAuctionRejected.ConfigInvalid(ConfigInvalid.ClosesAtMissing))
      commands.schedule(auctionOfMeetup, configInput(), op(2), person).futureValue shouldBe
        Left(SchedulingRefusal.ConfigInvalid(ConfigInvalid.ClosesAtMissing))
      auctions.scheduleAnswer = Left(ScheduleAuctionRejected.AuctionAlreadyStarted)
      commands.schedule(auctionOfMeetup, configInput(), op(3), person).futureValue shouldBe
        Left(SchedulingRefusal.AuctionAlreadyStarted)
      auctions.startAnswer = Left(StartPrebiddingRejected.AuctionNotScheduled)
      commands.startPrebidding(auctionOfMeetup, op(4), person).futureValue shouldBe
        Left(OpeningRefusal.AuctionNotScheduled)
    }

    "answers a repeated scheduling from the window without asking meetups or the auction" in {
      val original = AuctionEnvelope(2, op(2), AuctionEvent.AuctionScheduled(config()))
      val auctions = Auctions(Inspection.Repeated(original))
      val meetups = Meetups(Authority.NotAdministrator)
      AuctionCommands(auctions, noLots, meetups)
        .schedule(auctionOfMeetup, configInput(), op(2), person)
        .futureValue shouldBe Right(())
      meetups.asked shouldBe 0
      auctions.commands shouldBe empty
    }

    "sends a repeated opening to the auction without asking meetups, so lots that did not answer are asked again" in {
      val original = AuctionEnvelope(3, op(3), AuctionEvent.PrebiddingStarted)
      val auctions = Auctions(Inspection.Repeated(original))
      auctions.startAnswer = Right(AuctionAnswer.Written(original))
      val meetups = Meetups(Authority.NotAdministrator)
      AuctionCommands(auctions, noLots, meetups).startPrebidding(auctionOfMeetup, op(3), person).futureValue shouldBe
        Right(())
      meetups.asked shouldBe 0
      auctions.commands shouldBe List(StartPrebidding(op(3)))
    }

    "does not reach the auction when an opening repeats the op_id of another command" in {
      val added = AuctionEnvelope(2, op(2), AuctionEvent.LotAdded(lot))
      val auctions = Auctions(Inspection.Repeated(added))
      AuctionCommands(auctions, noLots, Meetups(Authority.NotAdministrator))
        .startPrebidding(auctionOfMeetup, op(2), person)
        .futureValue shouldBe Right(())
      auctions.commands shouldBe empty
    }

    "sends the conditions of a lot to the auction once meetups confirms the administrator" in {
      val auctions = Auctions(Inspection.Present(meetup, registryOpen = true))
      AuctionCommands(auctions, noLots, granted)
        .scheduleLot(auctionOfMeetup, lot, money(5000), step, op(4), person)
        .futureValue shouldBe Right(())
      auctions.commands shouldBe List(ScheduleAuctionLot(lot, money(5000), step, op(4)))
    }

    "answers the conditions of a lot of an auction without a journal with AuctionNotFound before meetups" in {
      val meetups = Meetups(Authority.Granted)
      AuctionCommands(Auctions(Inspection.Absent), noLots, meetups)
        .scheduleLot(auctionOfMeetup, lot, money(5000), step, op(4), person)
        .futureValue shouldBe Left(LotSchedulingRefusal.Denied(Denial.AuctionNotFound))
      meetups.asked shouldBe 0
    }

    "refuses the conditions of a lot that meetups does not confirm and does not reach the auction" in {
      for (
        (answer, denial) <- List(
          Authority.NotAdministrator -> Denial.NotAdministrator,
          Authority.MeetupNotFound -> Denial.MeetupNotFound,
          Authority.Unavailable -> Denial.Unavailable
        )
      ) {
        val auctions = Auctions(Inspection.Present(meetup, registryOpen = true))
        AuctionCommands(auctions, noLots, Meetups(answer))
          .scheduleLot(auctionOfMeetup, lot, money(5000), step, op(4), person)
          .futureValue shouldBe Left(LotSchedulingRefusal.Denied(denial))
        auctions.commands shouldBe empty
      }
    }

    "passes the refusals of the auction and of the lot through as refusals of the conditions" in {
      val auctions = Auctions(Inspection.Present(meetup, registryOpen = true))
      val commands = AuctionCommands(auctions, noLots, granted)
      for (
        (answer, refusal) <- List(
          ScheduleAuctionLotRejected.LotsFrozen -> LotSchedulingRefusal.Denied(Denial.LotsFrozen),
          ScheduleAuctionLotRejected.AuctionNotFound -> LotSchedulingRefusal.Denied(Denial.AuctionNotFound),
          ScheduleAuctionLotRejected.LotNotInAuction -> LotSchedulingRefusal.LotNotInAuction,
          ScheduleAuctionLotRejected.ByLot(ScheduleLotRejected.SchedulingClosed) ->
            LotSchedulingRefusal.ByLot(ScheduleLotRejected.SchedulingClosed)
        )
      ) {
        auctions.planAnswer = Left(answer)
        commands.scheduleLot(auctionOfMeetup, lot, money(5000), step, op(4), person).futureValue shouldBe
          Left(refusal)
      }
    }

    // Аукцион `ScheduleLot` не записывает, поэтому его окно знает такой `op_id` только под другой командой.
    "refuses the conditions of a lot under the op_id of another auction command without asking meetups or the auction" in {
      val added = AuctionEnvelope(2, op(2), AuctionEvent.LotAdded(lot))
      val auctions = Auctions(Inspection.Repeated(added))
      val meetups = Meetups(Authority.Granted)
      AuctionCommands(auctions, noLots, meetups)
        .scheduleLot(auctionOfMeetup, lot, money(5000), step, op(2), person)
        .futureValue shouldBe Left(LotSchedulingRefusal.ByLot(ScheduleLotRejected.OpIdTaken))
      meetups.asked shouldBe 0
      auctions.commands shouldBe empty
    }
  }
}
