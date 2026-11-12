package auction.aggregate

import auction.aggregate.AuctionFixtures.config
import auction.aggregate.AuctionFixtures.configInput
import auction.catalog.LotId
import auction.entity.AuctionAnswer
import auction.entity.AuctionGateway
import auction.entity.Initiator
import auction.entity.LotEntity
import auction.entity.LotGateway
import auction.entity.OpeningRejected
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

    var known: Option[Auction] = None

    def get(auctionId: AuctionId): Future[Auction] = Future.successful(known.getOrElse(fail("the auction was read")))

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

    var saveSetAnswer: Either[SaveLotSetRejected, AuctionAnswer] = Right(AuctionAnswer.Unchanged)

    def saveLotSet(auctionId: AuctionId, command: SaveLotSet, initiator: Initiator) = {
      commands :+= command
      Future.successful(saveSetAnswer)
    }

    var deleteSetAnswer: Either[DeleteLotSetRejected, AuctionAnswer] = Right(AuctionAnswer.Unchanged)

    def deleteLotSet(auctionId: AuctionId, command: DeleteLotSet, initiator: Initiator) = {
      commands :+= command
      Future.successful(deleteSetAnswer)
    }

    var scheduleAnswer: Either[ScheduleAuctionRejected, AuctionAnswer] = Right(AuctionAnswer.Unchanged)
    var startAnswer: Either[OpeningRejected, AuctionAnswer] = Right(AuctionAnswer.Unchanged)

    def schedule(auctionId: AuctionId, command: ScheduleAuction, initiator: Initiator) = {
      commands :+= command
      Future.successful(scheduleAnswer)
    }

    def startPrebidding(auctionId: AuctionId, command: StartPrebidding, initiator: Initiator) = {
      commands :+= command
      Future.successful(startAnswer)
    }

    var discardAnswer: Either[DiscardAuctionRejected, AuctionAnswer] = Right(AuctionAnswer.Unchanged)

    def discard(auctionId: AuctionId, command: DiscardAuction, initiator: Initiator) = {
      commands :+= command
      Future.successful(discardAnswer)
    }

    var visibilityAnswer: Either[VisibilityRejected, AuctionAnswer] = Right(AuctionAnswer.Unchanged)

    def changeVisibility(auctionId: AuctionId, command: ChangeVisibility, initiator: Initiator) = {
      commands :+= command
      Future.successful(visibilityAnswer)
    }

    var finalTimeAnswer: Either[FinalTimeRejected, AuctionAnswer] = Right(AuctionAnswer.Unchanged)

    def setFinalTime(auctionId: AuctionId, command: SetFinalTime, initiator: Initiator) = {
      commands :+= command
      Future.successful(finalTimeAnswer)
    }

    var instructionsAnswer: Either[PaymentInstructionsRejected, AuctionAnswer] = Right(AuctionAnswer.Unchanged)

    def setPaymentInstructions(auctionId: AuctionId, command: SetPaymentInstructions, initiator: Initiator) = {
      commands :+= command
      Future.successful(instructionsAnswer)
    }

    var promoAnswer: Either[PromoVideoRejected, AuctionAnswer] = Right(AuctionAnswer.Unchanged)

    def setPromoVideo(auctionId: AuctionId, command: SetPromoVideo, initiator: Initiator) = {
      commands :+= command
      Future.successful(promoAnswer)
    }

    var createPeriodAnswer: Either[CreateHappyHourPeriodRejected, AuctionAnswer] = Right(AuctionAnswer.Unchanged)

    def createHappyHourPeriod(auctionId: AuctionId, command: CreateHappyHourPeriod, initiator: Initiator) = {
      commands :+= command
      Future.successful(createPeriodAnswer)
    }

    var deletePeriodAnswer: Either[DeleteHappyHourPeriodRejected, AuctionAnswer] = Right(AuctionAnswer.Unchanged)

    def deleteHappyHourPeriod(auctionId: AuctionId, command: DeleteHappyHourPeriod, initiator: Initiator) = {
      commands :+= command
      Future.successful(deletePeriodAnswer)
    }

    var termsAnswer: Either[SetHappyHourLotTermsRejected, AuctionAnswer] = Right(AuctionAnswer.Unchanged)
    var regularsSeen: Vector[Option[LotRegulars]] = Vector.empty

    def setHappyHourLotTerms(
        auctionId: AuctionId,
        command: SetHappyHourLotTerms,
        regulars: Option[LotRegulars],
        initiator: Initiator
    ) = {
      commands :+= command
      regularsSeen :+= regulars
      Future.successful(termsAnswer)
    }

    var clearTermsAnswer: Either[ClearHappyHourLotTermsRejected, AuctionAnswer] = Right(AuctionAnswer.Unchanged)

    def clearHappyHourLotTerms(auctionId: AuctionId, command: ClearHappyHourLotTerms, initiator: Initiator) = {
      commands :+= command
      Future.successful(clearTermsAnswer)
    }

    var layoutAnswer: Either[LotLayoutRejected, AuctionAnswer] = Right(AuctionAnswer.Unchanged)

    def setLotLayout(auctionId: AuctionId, command: SetLotLayout, initiator: Initiator) = {
      commands :+= command
      Future.successful(layoutAnswer)
    }

    var cancelAnswer: Either[CancelAuctionRejected, AuctionAnswer] = Right(AuctionAnswer.Unchanged)

    def cancel(auctionId: AuctionId, command: CancelAuction, initiator: Initiator) = {
      commands :+= command
      Future.successful(cancelAnswer)
    }

    var planAnswer: Either[ScheduleAuctionLotRejected, Unit] = Right(())

    def scheduleLot(auctionId: AuctionId, command: ScheduleAuctionLot, initiator: Initiator) = {
      commands :+= command
      Future.successful(planAnswer)
    }

    var removalAnswer: Either[ParticipantRemovalRejected, Long] = Right(7)

    def removeParticipant(auctionId: AuctionId, command: RemoveLotParticipant, initiator: Initiator) = {
      commands :+= command
      Future.successful(removalAnswer)
    }

    var previewAnswer: Either[ParticipantRemovalRejected, LotEntity.RemovalPreview] =
      Left(ParticipantRemovalRejected.LotNotInAuction)

    def previewParticipantRemoval(auctionId: AuctionId, command: PreviewLotParticipantRemoval) = {
      commands :+= command
      Future.successful(previewAnswer)
    }

    var selectAnswer: Either[FinalChoiceRejected[MarkForFinalRejected], Unit] = Right(())
    var deselectAnswer: Either[FinalChoiceRejected[UnmarkForFinalRejected], Unit] = Right(())

    def selectForFinal(auctionId: AuctionId, command: SelectForFinal, initiator: Initiator) = {
      commands :+= command
      Future.successful(selectAnswer)
    }

    def deselectForFinal(auctionId: AuctionId, command: DeselectForFinal, initiator: Initiator) = {
      commands :+= command
      Future.successful(deselectAnswer)
    }

    var launchAnswer: Either[LaunchStepWindowRejected, AuctionAnswer] = Right(AuctionAnswer.Unchanged)

    def launchStepWindow(auctionId: AuctionId, command: LaunchStepWindow, initiator: Initiator) = {
      commands :+= command
      Future.successful(launchAnswer)
    }

    var askAnswer: Either[AdvanceLotAskRejected, Unit] = Right(())

    def advanceAsk(auctionId: AuctionId, command: AdvanceLotAsk, initiator: Initiator) = {
      commands :+= command
      Future.successful(askAnswer)
    }

    var freezeAnswer: Either[FreezeFinalLineupRejected, AuctionAnswer] = Right(AuctionAnswer.Unchanged)
    var finalAnswer: Either[StartFinalRejected, AuctionAnswer] = Right(AuctionAnswer.Unchanged)
    var nextAnswer: Either[StartNextLotRejected, LotId] = Right(lot)

    def freezeFinalLineup(auctionId: AuctionId, command: FreezeFinalLineup, initiator: Initiator) = {
      commands :+= command
      Future.successful(freezeAnswer)
    }

    def startFinal(auctionId: AuctionId, command: StartFinal, initiator: Initiator) = {
      commands :+= command
      Future.successful(finalAnswer)
    }

    def startNextLot(auctionId: AuctionId, command: StartNextLot, initiator: Initiator) = {
      commands :+= command
      Future.successful(nextAnswer)
    }

    var closeAnswer: Either[CloseAuctionLotRejected, LotEnding] = Right(LotEnding.Unsold(UnsoldReason.NoBids))
    var closeInitiator: Option[Initiator] = None

    def closeLot(auctionId: AuctionId, command: CloseAuctionLot, initiator: Initiator) = {
      commands :+= command
      closeInitiator = Some(initiator)
      Future.successful(closeAnswer)
    }
  }

  private class Lots(answer: Either[DraftLotRejected, Envelope], bornIn: Option[AuctionId] = None) extends LotGateway {
    var drafted: List[(UUID, DraftLot)] = Nil
    def draftLot(lotId: UUID, command: DraftLot, initiator: Initiator) = {
      drafted :+= lotId -> command
      Future.successful(answer)
    }
    def auctionOf(lotId: UUID) = Future.successful(bornIn)
    def stateOf(lotId: UUID): Future[LotState] = fail("the lot state was read")
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

  private def granted: Meetups = Meetups(Authority.Granted(Standings.published))

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
      AuctionCommands(auctions, noLots, Meetups(Authority.Granted(Standings.published)))
        .draft(meetup, op(1), person)
        .futureValue shouldBe
        Right(Drafted(auctionOfMeetup, alreadyExisted = false))
      auctions.commands shouldBe List(DraftAuction(meetup, op(1)))
    }

    "answers a registry command on an auction without a journal with AuctionNotFound before meetups" in {
      val meetups = Meetups(Authority.Granted(Standings.published))
      val commands = AuctionCommands(Auctions(Inspection.Absent), noLots, meetups)
      commands.addLot(auctionOfMeetup, lot, op(2), person).futureValue shouldBe Left(Denial.AuctionNotFound)
      commands.removeLot(auctionOfMeetup, lot, op(2), person).futureValue shouldBe
        Left(RemovalRefusal.Denied(Denial.AuctionNotFound))
      meetups.asked shouldBe 0
    }

    "adds a lot to the registry and then drafts it in the auction with the same op_id" in {
      val auctions = Auctions(Inspection.Present(meetup, registryOpen = true))
      val lots = Lots(Right(Envelope(1, op(2), LotEvent.LotDrafted(auctionOfMeetup))))
      AuctionCommands(auctions, lots, Meetups(Authority.Granted(Standings.published)))
        .addLot(auctionOfMeetup, lot, op(2), person)
        .futureValue shouldBe Right(())
      auctions.commands shouldBe List(AddLot(lot, op(2)))
      lots.drafted shouldBe List(lot.value -> DraftLot(auctionOfMeetup, op(2)))
    }

    "accepts a lot that was already born, as after RemoveLot" in {
      val lots = Lots(Left(DraftLotRejected.LotAlreadyExists), bornIn = Some(auctionOfMeetup))
      AuctionCommands(
        Auctions(Inspection.Present(meetup, registryOpen = true)),
        lots,
        Meetups(Authority.Granted(Standings.published))
      )
        .addLot(auctionOfMeetup, lot, op(2), person)
        .futureValue shouldBe Right(())
    }

    "refuses a lot that a repeated op_id drafted in another auction and leaves the registry untouched" in {
      val auctions = Auctions(Inspection.Present(meetup, registryOpen = true))
      val lots = Lots(Right(Envelope(1, op(2), LotEvent.LotDrafted(auctionId(9)))))
      AuctionCommands(auctions, lots, Meetups(Authority.Granted(Standings.published)))
        .addLot(auctionOfMeetup, lot, op(2), person)
        .futureValue shouldBe Left(Denial.LotOfAnotherAuction)
      auctions.commands shouldBe empty
    }

    "refuses a lot born in another auction and leaves the registry untouched" in {
      val auctions = Auctions(Inspection.Present(meetup, registryOpen = true))
      val lots = Lots(Left(DraftLotRejected.LotAlreadyExists), bornIn = Some(auctionId(9)))
      AuctionCommands(auctions, lots, Meetups(Authority.Granted(Standings.published)))
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
      AuctionCommands(auctions, noLots, Meetups(Authority.Granted(Standings.published)))
        .removeLot(auctionOfMeetup, lot, op(2), person)
        .futureValue shouldBe Left(RemovalRefusal.LotNotInAuction)
    }

    "refuses a lot before it is born once the registry is frozen" in {
      val auctions = Auctions(Inspection.Present(meetup, registryOpen = false))
      AuctionCommands(auctions, noLots, Meetups(Authority.Granted(Standings.published)))
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

    "checks the right before the name of a lot set and touches no auction without it" in {
      val auctions = Auctions(Inspection.Present(meetup, registryOpen = true))
      val set = LotSetId(new UUID(6L, 1L))
      AuctionCommands(auctions, noLots, Meetups(Authority.NotAdministrator))
        .saveLotSet(auctionOfMeetup, set, " ", List(lot), op(2), person)
        .futureValue shouldBe Left(LotSetRefusal.Denied(Denial.NotAdministrator))
      AuctionCommands(auctions, noLots, granted)
        .saveLotSet(auctionOfMeetup, set, " ", List(lot), op(2), person)
        .futureValue shouldBe Left(LotSetRefusal.NameEmpty)
      auctions.commands shouldBe empty
    }

    "passes the refusals of a lot set from the auction through" in {
      val auctions = Auctions(Inspection.Present(meetup, registryOpen = true))
      val set = LotSetId(new UUID(6L, 1L))
      val commands = AuctionCommands(auctions, noLots, granted)
      auctions.saveSetAnswer = Left(SaveLotSetRejected.LotInAnotherSet(lot, LotSetId(new UUID(6L, 2L))))
      commands.saveLotSet(auctionOfMeetup, set, "Сет", List(lot), op(2), person).futureValue shouldBe
        Left(LotSetRefusal.LotInAnotherSet(lot, LotSetId(new UUID(6L, 2L))))
      auctions.saveSetAnswer = Left(SaveLotSetRejected.LotsFrozen)
      commands.saveLotSet(auctionOfMeetup, set, "Сет", List(lot), op(3), person).futureValue shouldBe
        Left(LotSetRefusal.Denied(Denial.LotsFrozen))
      auctions.deleteSetAnswer = Left(DeleteLotSetRejected.LotSetNotFound)
      commands.deleteLotSet(auctionOfMeetup, set, op(4), person).futureValue shouldBe
        Left(LotSetRefusal.LotSetNotFound)
    }

    "answers a lot of the discarded birth as a lot of another auction" in {
      val auctions = Auctions(Inspection.Present(meetup, registryOpen = true))
      auctions.addAnswer = Left(AddLotRejected.LotOfDiscardedAuction)
      AuctionCommands(auctions, Lots(Left(DraftLotRejected.LotAlreadyExists), Some(auctionOfMeetup)), granted)
        .addLot(auctionOfMeetup, lot, op(2), person)
        .futureValue shouldBe Left(Denial.LotOfAnotherAuction)
    }

    "answers scheduling and opening of an auction without a journal with AuctionNotFound before meetups" in {
      val meetups = Meetups(Authority.Granted(Standings.published))
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

    "passes the refusals of the auction and of the trading slot through as refusals of scheduling and opening" in {
      val auctions = Auctions(Inspection.Present(meetup, registryOpen = true))
      val commands = AuctionCommands(auctions, noLots, granted)
      auctions.scheduleAnswer = Left(ScheduleAuctionRejected.ConfigInvalid(ConfigInvalid.ClosesAtMissing))
      commands.schedule(auctionOfMeetup, configInput(), op(2), person).futureValue shouldBe
        Left(SchedulingRefusal.ConfigInvalid(ConfigInvalid.ClosesAtMissing))
      auctions.scheduleAnswer = Left(ScheduleAuctionRejected.AuctionAlreadyStarted)
      commands.schedule(auctionOfMeetup, configInput(), op(3), person).futureValue shouldBe
        Left(SchedulingRefusal.AuctionAlreadyStarted)
      auctions.startAnswer = Left(OpeningRejected.ByAuction(StartPrebiddingRejected.AuctionNotScheduled))
      commands.startPrebidding(auctionOfMeetup, op(4), person).futureValue shouldBe
        Left(OpeningRefusal.AuctionNotScheduled)
      val holder = AuctionId(java.util.UUID.fromString("0190f2a0-0000-7000-8000-000000000021"))
      auctions.startAnswer = Left(OpeningRejected.AnotherAuctionActive(holder))
      commands.startPrebidding(auctionOfMeetup, op(5), person).futureValue shouldBe
        Left(OpeningRefusal.AnotherAuctionActive(holder))
      auctions.startAnswer = Left(OpeningRejected.SlotUnavailable)
      commands.startPrebidding(auctionOfMeetup, op(6), person).futureValue shouldBe Left(OpeningRefusal.SlotUnavailable)
    }

    "answers a discard of an auction without a journal with AuctionNotFound before meetups" in {
      val meetups = Meetups(Authority.Granted(Standings.published))
      AuctionCommands(Auctions(Inspection.Absent), noLots, meetups)
        .discard(auctionOfMeetup, op(2), person)
        .futureValue shouldBe Left(DiscardRefusal.Denied(Denial.AuctionNotFound))
      meetups.asked shouldBe 0
    }

    "refuses a discard that meetups does not confirm and does not reach the auction" in {
      for (
        (answer, denial) <- List(
          Authority.NotAdministrator -> Denial.NotAdministrator,
          Authority.MeetupNotFound -> Denial.MeetupNotFound,
          Authority.Unavailable -> Denial.Unavailable
        )
      ) {
        val auctions = Auctions(Inspection.Present(meetup, registryOpen = true))
        AuctionCommands(auctions, noLots, Meetups(answer)).discard(auctionOfMeetup, op(2), person).futureValue shouldBe
          Left(DiscardRefusal.Denied(denial))
        auctions.commands shouldBe empty
      }
    }

    "refuses the commands of a cancelled meetup before the auction, except discarding and cancelling it" in {
      val cancelled = Meetups(Authority.Granted(Standings.cancelled))
      val absent = Auctions(Inspection.Absent)
      AuctionCommands(absent, noLots, cancelled).draft(meetup, op(2), person).futureValue shouldBe
        Left(Denial.MeetupCancelled)
      absent.commands shouldBe empty
      val auctions = Auctions(Inspection.Present(meetup, registryOpen = true))
      val commands = AuctionCommands(auctions, noLots, cancelled)
      commands.addLot(auctionOfMeetup, lot, op(3), person).futureValue shouldBe Left(Denial.MeetupCancelled)
      commands.startPrebidding(auctionOfMeetup, op(4), person).futureValue shouldBe
        Left(OpeningRefusal.Denied(Denial.MeetupCancelled))
      commands.schedule(auctionOfMeetup, configInput(), op(5), person).futureValue shouldBe
        Left(SchedulingRefusal.Denied(Denial.MeetupCancelled))
      commands.closeLot(auctionOfMeetup, lot, op(6), person).futureValue shouldBe
        Left(ClosingRefusal.Denied(Denial.MeetupCancelled))
      auctions.commands shouldBe empty
      commands.discard(auctionOfMeetup, op(7), person).futureValue shouldBe Right(())
      commands.cancel(auctionOfMeetup, op(8), person).futureValue shouldBe Right(())
      auctions.commands shouldBe List(DiscardAuction(op(7)), CancelAuction(op(8)))
    }

    "refuses opening the prebidding of a hidden meetup and opens it once the meetup is published again" in {
      val auctions = Auctions(Inspection.Present(meetup, registryOpen = true))
      AuctionCommands(auctions, noLots, Meetups(Authority.Granted(Standings.hidden)))
        .startPrebidding(auctionOfMeetup, op(2), person)
        .futureValue shouldBe Left(OpeningRefusal.Denied(Denial.MeetupHidden))
      // Скрытие закрывает только открытие торгов: реестр и планирование идут.
      AuctionCommands(auctions, noLots, Meetups(Authority.Granted(Standings.hidden)))
        .schedule(auctionOfMeetup, configInput(), op(3), person)
        .futureValue shouldBe Right(())
      AuctionCommands(auctions, noLots, granted).startPrebidding(auctionOfMeetup, op(4), person).futureValue shouldBe
        Right(())
      auctions.commands shouldBe List(ScheduleAuction(configInput(), op(3)), StartPrebidding(op(4)))
    }

    "reads an answer of meetups without the state of the meetup as unavailable for commands, not for reading" in {
      val unknown = Meetups(Authority.Granted(None))
      val auctions = Auctions(Inspection.Present(meetup, registryOpen = true))
      val commands = AuctionCommands(auctions, noLots, unknown)
      commands.startPrebidding(auctionOfMeetup, op(2), person).futureValue shouldBe
        Left(OpeningRefusal.Denied(Denial.Unavailable))
      commands.draft(meetup, op(3), person).futureValue shouldBe Left(Denial.Unavailable)
      auctions.commands shouldBe empty
      commands.authorize(meetup, person).futureValue shouldBe Right(())
    }

    "authorizes a command that the auction does not write through the gate it names" in {
      val commands =
        AuctionCommands(Auctions(Inspection.Absent), noLots, Meetups(Authority.Granted(Standings.cancelled)))
      commands.authorize(meetup, person).futureValue shouldBe Right(())
      commands.authorize(meetup, person, MeetupGate.NotCancelled).futureValue shouldBe Left(Denial.MeetupCancelled)
    }

    "answers a repeated command of a cancelled meetup from the window before asking meetups" in {
      val original = AuctionEnvelope(1, op(1), AuctionEvent.AuctionDrafted(meetup))
      val meetups = Meetups(Authority.Granted(Standings.cancelled))
      AuctionCommands(Auctions(Inspection.Repeated(original)), noLots, meetups)
        .draft(meetup, op(1), person)
        .futureValue shouldBe Right(Drafted(auctionOfMeetup, alreadyExisted = false))
      meetups.asked shouldBe 0
    }

    "discards the auction once meetups confirms the administrator and passes its refusal through" in {
      val auctions = Auctions(Inspection.Present(meetup, registryOpen = false))
      val commands = AuctionCommands(auctions, noLots, granted)
      commands.discard(auctionOfMeetup, op(2), person).futureValue shouldBe Right(())
      auctions.discardAnswer = Left(DiscardAuctionRejected.AuctionAlreadyStarted)
      commands.discard(auctionOfMeetup, op(3), person).futureValue shouldBe
        Left(DiscardRefusal.AuctionAlreadyStarted)
      auctions.commands shouldBe List(DiscardAuction(op(2)), DiscardAuction(op(3)))
    }

    "answers a repeated discard from the window without asking meetups or the auction" in {
      val auctions = Auctions(Inspection.Repeated(AuctionEnvelope(3, op(3), AuctionEvent.AuctionDiscarded)))
      val meetups = Meetups(Authority.NotAdministrator)
      AuctionCommands(auctions, noLots, meetups).discard(auctionOfMeetup, op(3), person).futureValue shouldBe Right(())
      meetups.asked shouldBe 0
      auctions.commands shouldBe empty
    }

    "answers a cancel of an auction without a journal with AuctionNotFound before meetups" in {
      val meetups = Meetups(Authority.Granted(Standings.published))
      AuctionCommands(Auctions(Inspection.Absent), noLots, meetups)
        .cancel(auctionOfMeetup, op(2), person)
        .futureValue shouldBe Left(CancellationRefusal.Denied(Denial.AuctionNotFound))
      meetups.asked shouldBe 0
    }

    "refuses a cancel that meetups does not confirm and does not reach the auction" in {
      for (
        (answer, denial) <- List(
          Authority.NotAdministrator -> Denial.NotAdministrator,
          Authority.MeetupNotFound -> Denial.MeetupNotFound,
          Authority.Unavailable -> Denial.Unavailable
        )
      ) {
        val auctions = Auctions(Inspection.Present(meetup, registryOpen = false))
        AuctionCommands(auctions, noLots, Meetups(answer)).cancel(auctionOfMeetup, op(2), person).futureValue shouldBe
          Left(CancellationRefusal.Denied(denial))
        auctions.commands shouldBe empty
      }
    }

    "cancels the auction once meetups confirms the administrator and passes its refusals through" in {
      val auctions = Auctions(Inspection.Present(meetup, registryOpen = false))
      val commands = AuctionCommands(auctions, noLots, granted)
      commands.cancel(auctionOfMeetup, op(2), person).futureValue shouldBe Right(())
      auctions.cancelAnswer = Left(CancelAuctionRejected.AuctionNotStarted)
      commands.cancel(auctionOfMeetup, op(3), person).futureValue shouldBe Left(CancellationRefusal.AuctionNotStarted)
      auctions.cancelAnswer = Left(CancelAuctionRejected.AuctionAlreadyFinished)
      commands.cancel(auctionOfMeetup, op(4), person).futureValue shouldBe
        Left(CancellationRefusal.AuctionAlreadyFinished)
      auctions.commands shouldBe List(CancelAuction(op(2)), CancelAuction(op(3)), CancelAuction(op(4)))
    }

    "passes a repeated cancel to the auction without meetups so that it withdraws the lots that did not answer" in {
      val auctions = Auctions(Inspection.Repeated(AuctionEnvelope(6, op(6), AuctionEvent.AuctionCancelled)))
      val meetups = Meetups(Authority.NotAdministrator)
      AuctionCommands(auctions, noLots, meetups).cancel(auctionOfMeetup, op(6), person).futureValue shouldBe Right(())
      meetups.asked shouldBe 0
      auctions.commands shouldBe List(CancelAuction(op(6)))
    }

    "answers an op_id of another command on a cancel without asking meetups or the auction" in {
      val auctions = Auctions(Inspection.Repeated(AuctionEnvelope(4, op(4), AuctionEvent.PrebiddingStarted)))
      val meetups = Meetups(Authority.NotAdministrator)
      AuctionCommands(auctions, noLots, meetups).cancel(auctionOfMeetup, op(4), person).futureValue shouldBe Right(())
      meetups.asked shouldBe 0
      auctions.commands shouldBe empty
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
      val meetups = Meetups(Authority.Granted(Standings.published))
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
      val meetups = Meetups(Authority.Granted(Standings.published))
      AuctionCommands(auctions, noLots, meetups)
        .scheduleLot(auctionOfMeetup, lot, money(5000), step, op(2), person)
        .futureValue shouldBe Left(LotSchedulingRefusal.ByLot(ScheduleLotRejected.OpIdTaken))
      meetups.asked shouldBe 0
      auctions.commands shouldBe empty
    }

    "sends a mark and an unmark to the auction once meetups confirms the administrator" in {
      val auctions = Auctions(Inspection.Present(meetup, registryOpen = false))
      val commands = AuctionCommands(auctions, noLots, granted)
      commands.selectForFinal(auctionOfMeetup, lot, op(4), person).futureValue shouldBe Right(())
      commands.deselectForFinal(auctionOfMeetup, lot, op(5), person).futureValue shouldBe Right(())
      auctions.commands shouldBe List(SelectForFinal(lot, op(4)), DeselectForFinal(lot, op(5)))
    }

    "refuses a choice of a finalist that meetups does not confirm and does not reach the auction" in {
      for (
        (answer, denial) <- List(
          Authority.NotAdministrator -> Denial.NotAdministrator,
          Authority.MeetupNotFound -> Denial.MeetupNotFound,
          Authority.Unavailable -> Denial.Unavailable
        )
      ) {
        val auctions = Auctions(Inspection.Present(meetup, registryOpen = false))
        val commands = AuctionCommands(auctions, noLots, Meetups(answer))
        commands.selectForFinal(auctionOfMeetup, lot, op(4), person).futureValue shouldBe
          Left(FinalChoiceRefusal.Denied(denial))
        commands.deselectForFinal(auctionOfMeetup, lot, op(4), person).futureValue shouldBe
          Left(FinalChoiceRefusal.Denied(denial))
        auctions.commands shouldBe empty
      }
    }

    "passes the refusals of the auction and of the lot through as refusals of the choice" in {
      val auctions = Auctions(Inspection.Present(meetup, registryOpen = false))
      val commands = AuctionCommands(auctions, noLots, granted)
      for (
        (answer, refusal) <- List(
          FinalChoiceRejected.NotInPrebidding -> FinalChoiceRefusal.NotInPrebidding,
          FinalChoiceRejected.LotNotInAuction -> FinalChoiceRefusal.LotNotInAuction,
          FinalChoiceRejected.SelectionNotApplicable -> FinalChoiceRefusal.SelectionNotApplicable,
          FinalChoiceRejected.AuctionNotFound -> FinalChoiceRefusal.Denied(Denial.AuctionNotFound),
          FinalChoiceRejected.ByLot(MarkForFinalRejected.DeadlinePassed) ->
            FinalChoiceRefusal.ByLot(MarkForFinalRejected.DeadlinePassed)
        )
      ) {
        auctions.selectAnswer = Left(answer)
        commands.selectForFinal(auctionOfMeetup, lot, op(4), person).futureValue shouldBe Left(refusal)
      }
      auctions.deselectAnswer = Left(FinalChoiceRejected.ByLot(UnmarkForFinalRejected.DeadlinePassed))
      commands.deselectForFinal(auctionOfMeetup, lot, op(5), person).futureValue shouldBe
        Left(FinalChoiceRefusal.ByLot(UnmarkForFinalRejected.DeadlinePassed))
    }

    "sends a removal of a participant and its preview to the auction once meetups confirms the administrator" in {
      val auctions = Auctions(Inspection.Present(meetup, registryOpen = false))
      auctions.known = Some(Auction(AuctionState.Prebidding(config(), op(3)), Some(meetup), Set(lot), Map.empty))
      val commands = AuctionCommands(auctions, noLots, granted)
      val removal = RemoveLotParticipant(lot, participant(3), 12, op(4))
      val preview = PreviewLotParticipantRemoval(lot, participant(3))

      commands.removeParticipant(auctionOfMeetup, removal, person).futureValue shouldBe Right(7)
      commands.previewParticipantRemoval(auctionOfMeetup, preview, person).futureValue shouldBe
        Left(ParticipantRemovalRefusal.LotNotInAuction)
      auctions.commands shouldBe List(removal, preview)
    }

    "refuses a removal and its preview that meetups does not confirm and does not reach the auction" in {
      for (
        (answer, denial) <- List(
          Authority.NotAdministrator -> Denial.NotAdministrator,
          Authority.MeetupNotFound -> Denial.MeetupNotFound,
          Authority.Granted(Standings.cancelled) -> Denial.MeetupCancelled
        )
      ) {
        val auctions = Auctions(Inspection.Present(meetup, registryOpen = false))
        auctions.known = Some(Auction(AuctionState.Prebidding(config(), op(3)), Some(meetup), Set(lot), Map.empty))
        val commands = AuctionCommands(auctions, noLots, Meetups(answer))
        commands
          .removeParticipant(auctionOfMeetup, RemoveLotParticipant(lot, participant(3), 12, op(4)), person)
          .futureValue shouldBe Left(ParticipantRemovalRefusal.Denied(denial))
        commands
          .previewParticipantRemoval(auctionOfMeetup, PreviewLotParticipantRemoval(lot, participant(3)), person)
          .futureValue shouldBe Left(ParticipantRemovalRefusal.Denied(denial))
        auctions.commands shouldBe empty
      }
    }

    "refuses a removal under the op_id of another auction command and passes the refusals of the auction and the lot" in {
      val started = AuctionEnvelope(3, op(3), AuctionEvent.PrebiddingStarted)
      val removal = RemoveLotParticipant(lot, participant(3), 12, op(3))
      AuctionCommands(Auctions(Inspection.Repeated(started)), noLots, granted)
        .removeParticipant(auctionOfMeetup, removal, person)
        .futureValue shouldBe Left(ParticipantRemovalRefusal.ByLot(RemoveParticipantRejected.OpIdTaken))
      val auctions = Auctions(Inspection.Present(meetup, registryOpen = false))
      val commands = AuctionCommands(auctions, noLots, granted)
      for (
        (answer, refusal) <- List(
          ParticipantRemovalRejected.LineupFrozen -> ParticipantRemovalRefusal.LineupFrozen,
          ParticipantRemovalRejected.NotInPrebidding -> ParticipantRemovalRefusal.NotInPrebidding,
          ParticipantRemovalRejected.AuctionNotFound -> ParticipantRemovalRefusal.Denied(Denial.AuctionNotFound),
          ParticipantRemovalRejected.ByLot(RemoveParticipantRejected.LotChanged) ->
            ParticipantRemovalRefusal.ByLot(RemoveParticipantRejected.LotChanged)
        )
      ) {
        auctions.removalAnswer = Left(answer)
        commands.removeParticipant(auctionOfMeetup, removal.copy(opId = op(4)), person).futureValue shouldBe
          Left(refusal)
      }
    }

    "answers a choice of a finalist on an auction without a journal with AuctionNotFound before meetups" in {
      val meetups = Meetups(Authority.Granted(Standings.published))
      AuctionCommands(Auctions(Inspection.Absent), noLots, meetups)
        .selectForFinal(auctionOfMeetup, lot, op(4), person)
        .futureValue shouldBe Left(FinalChoiceRefusal.Denied(Denial.AuctionNotFound))
      meetups.asked shouldBe 0
    }

    // Как у `ScheduleLot`: аукцион выбор не записывает, и его окно знает такой `op_id` только под другой командой.
    "refuses a choice under the op_id of another auction command without asking meetups or the auction" in {
      val started = AuctionEnvelope(3, op(3), AuctionEvent.PrebiddingStarted)
      val auctions = Auctions(Inspection.Repeated(started))
      val meetups = Meetups(Authority.Granted(Standings.published))
      val commands = AuctionCommands(auctions, noLots, meetups)
      commands.selectForFinal(auctionOfMeetup, lot, op(3), person).futureValue shouldBe
        Left(FinalChoiceRefusal.ByLot(MarkForFinalRejected.OpIdTaken))
      commands.deselectForFinal(auctionOfMeetup, lot, op(3), person).futureValue shouldBe
        Left(FinalChoiceRefusal.ByLot(UnmarkForFinalRejected.OpIdTaken))
      meetups.asked shouldBe 0
      auctions.commands shouldBe empty
    }

    "sends the commands of the final to the auction only after meetups confirms the administrator" in {
      val auctions = Auctions(Inspection.Present(meetup, registryOpen = false))
      val commands = AuctionCommands(auctions, noLots, granted)
      commands.freezeFinalLineup(auctionOfMeetup, List(lot), op(6), person).futureValue shouldBe Right(())
      commands.startFinal(auctionOfMeetup, op(7), person).futureValue shouldBe Right(())
      commands.startNextLot(auctionOfMeetup, op(8), person).futureValue shouldBe Right(lot)
      auctions.commands shouldBe List(FreezeFinalLineup(List(lot), op(6)), StartFinal(op(7)), StartNextLot(op(8)))
    }

    "refuses the commands of the final that meetups does not confirm and does not reach the auction" in {
      val auctions = Auctions(Inspection.Present(meetup, registryOpen = false))
      val commands = AuctionCommands(auctions, noLots, Meetups(Authority.NotAdministrator))
      commands.freezeFinalLineup(auctionOfMeetup, List(lot), op(6), person).futureValue shouldBe
        Left(LineupRefusal.Denied(Denial.NotAdministrator))
      commands.startFinal(auctionOfMeetup, op(7), person).futureValue shouldBe
        Left(FinalStartRefusal.Denied(Denial.NotAdministrator))
      commands.startNextLot(auctionOfMeetup, op(8), person).futureValue shouldBe
        Left(NextLotRefusal.Denied(Denial.NotAdministrator))
      auctions.commands shouldBe empty
    }

    "passes the refusals of the auction through the commands of the final" in {
      val auctions = Auctions(Inspection.Present(meetup, registryOpen = false))
      val commands = AuctionCommands(auctions, noLots, granted)
      auctions.freezeAnswer = Left(FreezeFinalLineupRejected.LineupMismatch(Set(lot)))
      commands.freezeFinalLineup(auctionOfMeetup, Nil, op(6), person).futureValue shouldBe
        Left(LineupRefusal.LineupMismatch(Set(lot)))
      auctions.freezeAnswer = Left(FreezeFinalLineupRejected.LineupUnknown)
      commands.freezeFinalLineup(auctionOfMeetup, Nil, op(6), person).futureValue shouldBe
        Left(LineupRefusal.LineupUnknown)
      auctions.finalAnswer = Left(StartFinalRejected.LineupNotFrozen)
      commands.startFinal(auctionOfMeetup, op(7), person).futureValue shouldBe Left(FinalStartRefusal.LineupNotFrozen)
      auctions.nextAnswer = Left(StartNextLotRejected.AnotherLotActive(lot))
      commands.startNextLot(auctionOfMeetup, op(8), person).futureValue shouldBe
        Left(NextLotRefusal.AnotherLotActive(lot))
    }

    "answers the commands of the final on an auction without a journal with AuctionNotFound before meetups" in {
      val meetups = Meetups(Authority.Granted(Standings.published))
      val commands = AuctionCommands(Auctions(Inspection.Absent), noLots, meetups)
      commands.freezeFinalLineup(auctionOfMeetup, List(lot), op(6), person).futureValue shouldBe
        Left(LineupRefusal.Denied(Denial.AuctionNotFound))
      commands.startFinal(auctionOfMeetup, op(7), person).futureValue shouldBe
        Left(FinalStartRefusal.Denied(Denial.AuctionNotFound))
      commands.startNextLot(auctionOfMeetup, op(8), person).futureValue shouldBe
        Left(NextLotRefusal.Denied(Denial.AuctionNotFound))
      meetups.asked shouldBe 0
    }

    // Повтор следующего лота отвечает лотом исходной активации из окна аукциона, без Meetups и без entity.
    "answers a repeated next lot with the lot of the original activation and another command with OpIdTaken" in {
      val activated = AuctionEnvelope(9, op(8), AuctionEvent.FinalLotActivated(lot))
      val meetups = Meetups(Authority.Granted(Standings.published))
      val auctions = Auctions(Inspection.Repeated(activated))
      AuctionCommands(auctions, noLots, meetups).startNextLot(auctionOfMeetup, op(8), person).futureValue shouldBe
        Right(lot)
      val started = AuctionEnvelope(8, op(7), AuctionEvent.FinalStarted)
      AuctionCommands(Auctions(Inspection.Repeated(started)), noLots, meetups)
        .startNextLot(auctionOfMeetup, op(7), person)
        .futureValue shouldBe Left(NextLotRefusal.OpIdTaken)
      meetups.asked shouldBe 0
      auctions.commands shouldBe empty
    }

    "sends the closing of the auctioneer to the auction in his name once meetups confirms the administrator" in {
      val auctions = Auctions(Inspection.Present(meetup, registryOpen = false))
      val commands = AuctionCommands(auctions, noLots, granted)
      commands.closeLot(auctionOfMeetup, lot, op(9), person).futureValue shouldBe
        Right(LotEnding.Unsold(UnsoldReason.NoBids))
      auctions.commands shouldBe List(CloseAuctionLot(lot, op(9)))
      auctions.closeInitiator shouldBe Some(Initiator.Operator(person))

      auctions.closeAnswer = Left(CloseAuctionLotRejected.LotNotOpen)
      commands.closeLot(auctionOfMeetup, lot, op(10), person).futureValue shouldBe
        Left(ClosingRefusal.Rejected(CloseAuctionLotRejected.LotNotOpen))
      auctions.closeAnswer = Left(CloseAuctionLotRejected.AuctionNotFound)
      commands.closeLot(auctionOfMeetup, lot, op(11), person).futureValue shouldBe
        Left(ClosingRefusal.Denied(Denial.AuctionNotFound))
    }

    // Своего события под `op_id` ведущего аукцион не пишет: `op_id` в его окне — заведомо другая команда.
    "refuses a closing under the op_id of another auction command and a stranger without reaching the auction" in {
      val started = AuctionEnvelope(8, op(7), AuctionEvent.FinalStarted)
      val repeated = Auctions(Inspection.Repeated(started))
      val meetups = Meetups(Authority.Granted(Standings.published))
      AuctionCommands(repeated, noLots, meetups).closeLot(auctionOfMeetup, lot, op(7), person).futureValue shouldBe
        Left(ClosingRefusal.Rejected(CloseAuctionLotRejected.OpIdTaken))
      meetups.asked shouldBe 0
      AuctionCommands(Auctions(Inspection.Absent), noLots, meetups)
        .closeLot(auctionOfMeetup, lot, op(9), person)
        .futureValue shouldBe Left(ClosingRefusal.Denied(Denial.AuctionNotFound))
      val stranger = Auctions(Inspection.Present(meetup, registryOpen = false))
      AuctionCommands(stranger, noLots, Meetups(Authority.NotAdministrator))
        .closeLot(auctionOfMeetup, lot, op(9), person)
        .futureValue shouldBe Left(ClosingRefusal.Denied(Denial.NotAdministrator))
      repeated.commands shouldBe empty
      stranger.commands shouldBe empty
    }

    "passes a repeated step window launch to the auction without asking meetups and answers the original window" in {
      val window = StepWindowConfig(deadline, deadline.plusSeconds(3600), money(1), Set(lot))
      val original = AuctionEnvelope(5, op(7), AuctionEvent.StepWindowLaunched(window))
      val repeated = Auctions(Inspection.Repeated(original))
      repeated.launchAnswer = Right(AuctionAnswer.Written(original))
      val meetups = Meetups(Authority.NotAdministrator)
      val command = LaunchStepWindow(None, deadline.plusSeconds(3600), money(1), List(lot), op(7))

      AuctionCommands(repeated, noLots, meetups).launchStepWindow(auctionOfMeetup, command, person).futureValue shouldBe
        Right(window)
      meetups.asked shouldBe 0
      repeated.commands shouldBe List(command)
    }

    "refuses a launch under the op_id of another auction command, an absent auction and a stranger" in {
      val command = LaunchStepWindow(None, deadline, money(1), List(lot), op(7))
      val taken = Auctions(Inspection.Repeated(AuctionEnvelope(4, op(7), AuctionEvent.PrebiddingStarted)))
      AuctionCommands(taken, noLots, granted).launchStepWindow(auctionOfMeetup, command, person).futureValue shouldBe
        Left(LaunchRefusal.OpIdTaken)
      AuctionCommands(Auctions(Inspection.Absent), noLots, granted)
        .launchStepWindow(auctionOfMeetup, command, person)
        .futureValue shouldBe Left(LaunchRefusal.Denied(Denial.AuctionNotFound))
      val stranger = Auctions(Inspection.Present(meetup, registryOpen = false))
      AuctionCommands(stranger, noLots, Meetups(Authority.NotAdministrator))
        .launchStepWindow(auctionOfMeetup, command, person)
        .futureValue shouldBe Left(LaunchRefusal.Denied(Denial.NotAdministrator))
      stranger.commands shouldBe empty
    }

    "hands a granted launch to the auction as the administrator and returns the recorded window" in {
      val window = StepWindowConfig(deadline, deadline.plusSeconds(3600), money(1), Set(lot))
      val auctions = Auctions(Inspection.Present(meetup, registryOpen = false))
      auctions.launchAnswer =
        Right(AuctionAnswer.Written(AuctionEnvelope(5, op(7), AuctionEvent.StepWindowLaunched(window))))
      val command = LaunchStepWindow(None, deadline.plusSeconds(3600), money(1), List(lot), op(7))

      AuctionCommands(auctions, noLots, granted).launchStepWindow(auctionOfMeetup, command, person).futureValue shouldBe
        Right(window)
      auctions.commands shouldBe List(command)
      auctions.launchAnswer = Left(LaunchStepWindowRejected.LotNotOpen(lot))
      AuctionCommands(auctions, noLots, granted).launchStepWindow(auctionOfMeetup, command, person).futureValue shouldBe
        Left(LaunchRefusal.Rejected(LaunchStepWindowRejected.LotNotOpen(lot)))
    }

    // ADR-047, дополнение 2026-10-27: период «Счастливых часов» — команда администратора.
    "answers a repeated happy hour period with the original period without asking meetups or the auction" in {
      val period = HappyHourPeriod(HappyHourPeriod.idOf(op(7)), deadline, deadline.plusSeconds(3600))
      val repeated =
        Auctions(Inspection.Repeated(AuctionEnvelope(5, op(7), AuctionEvent.HappyHourPeriodCreated(period))))
      val meetups = Meetups(Authority.NotAdministrator)
      val command = CreateHappyHourPeriod(period.from, period.until, op(7))

      AuctionCommands(repeated, noLots, meetups)
        .createHappyHourPeriod(auctionOfMeetup, command, person)
        .futureValue shouldBe Right(period)
      meetups.asked shouldBe 0
      repeated.commands shouldBe empty
    }

    "hands a granted happy hour period to the auction and refuses one the meetup does not admit" in {
      val period = HappyHourPeriod(HappyHourPeriod.idOf(op(7)), deadline, deadline.plusSeconds(3600))
      val command = CreateHappyHourPeriod(period.from, period.until, op(7))
      val auctions = Auctions(Inspection.Present(meetup, registryOpen = false))
      auctions.createPeriodAnswer =
        Right(AuctionAnswer.Written(AuctionEnvelope(5, op(7), AuctionEvent.HappyHourPeriodCreated(period))))

      AuctionCommands(auctions, noLots, granted)
        .createHappyHourPeriod(auctionOfMeetup, command, person)
        .futureValue shouldBe
        Right(period)
      auctions.commands shouldBe List(command)
      auctions.createPeriodAnswer = Left(CreateHappyHourPeriodRejected.PeriodInPast)
      AuctionCommands(auctions, noLots, granted)
        .createHappyHourPeriod(auctionOfMeetup, command, person)
        .futureValue shouldBe
        Left(HappyHourRefusal.Rejected(CreateHappyHourPeriodRejected.PeriodInPast))
      val cancelled = Auctions(Inspection.Present(meetup, registryOpen = false))
      AuctionCommands(cancelled, noLots, Meetups(Authority.Granted(Standings.cancelled)))
        .createHappyHourPeriod(auctionOfMeetup, command, person)
        .futureValue shouldBe Left(HappyHourRefusal.Denied(Denial.MeetupCancelled))
      cancelled.commands shouldBe empty
    }

    "refuses a happy hour period under the op_id of another auction command and on an absent auction" in {
      val command = CreateHappyHourPeriod(deadline, deadline.plusSeconds(3600), op(7))
      val taken = Auctions(Inspection.Repeated(AuctionEnvelope(4, op(7), AuctionEvent.PrebiddingStarted)))

      AuctionCommands(taken, noLots, granted)
        .createHappyHourPeriod(auctionOfMeetup, command, person)
        .futureValue shouldBe
        Left(HappyHourRefusal.OpIdTaken)
      AuctionCommands(Auctions(Inspection.Absent), noLots, granted)
        .createHappyHourPeriod(auctionOfMeetup, command, person)
        .futureValue shouldBe Left(HappyHourRefusal.Denied(Denial.AuctionNotFound))
    }

    // PER-786: повтор удаления идёт в entity мимо Meetups — дошлёт снятие условий лотам периода.
    "hands a repeated deletion of its own period to the auction without meetups and refuses another deletion" in {
      val period = HappyHourPeriod.idOf(op(7))
      val other = HappyHourPeriod.idOf(op(6))
      val original = AuctionEnvelope(6, op(8), AuctionEvent.HappyHourPeriodDeleted(period))
      val meetups = Meetups(Authority.NotAdministrator)
      val repeated = Auctions(Inspection.Repeated(original))
      repeated.deletePeriodAnswer = Right(AuctionAnswer.Written(original))
      val unrelated = Auctions(Inspection.Repeated(original))

      AuctionCommands(repeated, noLots, meetups)
        .deleteHappyHourPeriod(auctionOfMeetup, DeleteHappyHourPeriod(period, op(8)), person)
        .futureValue shouldBe Right(())
      repeated.commands shouldBe List(DeleteHappyHourPeriod(period, op(8)))
      AuctionCommands(unrelated, noLots, meetups)
        .deleteHappyHourPeriod(auctionOfMeetup, DeleteHappyHourPeriod(other, op(8)), person)
        .futureValue shouldBe Left(HappyHourDeletionRefusal.OpIdTaken)
      unrelated.commands shouldBe empty
      meetups.asked shouldBe 0
    }

    // PER-786: обычные условия лота сверяются до записи, и читает их граница у самого лота.
    "reads the regular terms of the lot after the right and hands them to the auction with the terms" in {
      val lotState = trading(price = 1000, policy = fixedHundred).state
      val lots = new Lots(Left(DraftLotRejected.LotAlreadyExists)) {
        override def stateOf(lotId: UUID): Future[LotState] = Future.successful(lotState)
      }
      val period = HappyHourPeriod.idOf(op(7))
      val command = SetHappyHourLotTerms(period, lot, None, Some(money(600)), op(20))
      val terms = HappyHourTerms(None, Some(money(600)))
      val auctions = Auctions(Inspection.Present(meetup, registryOpen = false))
      auctions.termsAnswer =
        Right(AuctionAnswer.Written(AuctionEnvelope(7, op(20), AuctionEvent.HappyHourLotTermsSet(period, lot, terms))))

      AuctionCommands(auctions, lots, granted)
        .setHappyHourLotTerms(auctionOfMeetup, command, person)
        .futureValue shouldBe Right(lot -> terms)
      auctions.regularsSeen shouldBe Vector(Some(LotRegulars(rub, money(1000), money(100))))
      auctions.termsAnswer = Left(SetHappyHourLotTermsRejected.StartNotLower(money(1000)))
      AuctionCommands(auctions, lots, granted)
        .setHappyHourLotTerms(auctionOfMeetup, command, person)
        .futureValue shouldBe
        Left(HappyHourTermsRefusal.Rejected(SetHappyHourLotTermsRejected.StartNotLower(money(1000))))
      val cancelled = Auctions(Inspection.Present(meetup, registryOpen = false))
      AuctionCommands(cancelled, noLots, Meetups(Authority.Granted(Standings.cancelled)))
        .setHappyHourLotTerms(auctionOfMeetup, command, person)
        .futureValue shouldBe Left(HappyHourTermsRefusal.Denied(Denial.MeetupCancelled))
      cancelled.commands shouldBe empty
    }

    "hands a repeated set of terms to the auction without meetups or the lot and refuses another command's op_id" in {
      val period = HappyHourPeriod.idOf(op(7))
      val terms = HappyHourTerms(Some(money(50)), None)
      val original = AuctionEnvelope(7, op(20), AuctionEvent.HappyHourLotTermsSet(period, lot, terms))
      val command = SetHappyHourLotTerms(period, lot, Some(money(50)), None, op(20))
      val meetups = Meetups(Authority.NotAdministrator)
      val repeated = Auctions(Inspection.Repeated(original))
      repeated.termsAnswer = Right(AuctionAnswer.Written(original))

      AuctionCommands(repeated, noLots, meetups)
        .setHappyHourLotTerms(auctionOfMeetup, command, person)
        .futureValue shouldBe Right(lot -> terms)
      repeated.regularsSeen shouldBe Vector(None)
      val taken = Auctions(Inspection.Repeated(AuctionEnvelope(4, op(20), AuctionEvent.PrebiddingStarted)))
      AuctionCommands(taken, noLots, meetups)
        .setHappyHourLotTerms(auctionOfMeetup, command, person)
        .futureValue shouldBe Left(HappyHourTermsRefusal.OpIdTaken)
      taken.commands shouldBe empty
      meetups.asked shouldBe 0
    }

    "answers a removal of terms the lot does not have as accepted and returns the refusal of the auction" in {
      val command = ClearHappyHourLotTerms(HappyHourPeriod.idOf(op(7)), lot, op(30))
      val auctions = Auctions(Inspection.Present(meetup, registryOpen = false))

      AuctionCommands(auctions, noLots, granted)
        .clearHappyHourLotTerms(auctionOfMeetup, command, person)
        .futureValue shouldBe Right(())
      auctions.clearTermsAnswer = Left(ClearHappyHourLotTermsRejected.PeriodStarted)
      AuctionCommands(auctions, noLots, granted)
        .clearHappyHourLotTerms(auctionOfMeetup, command, person)
        .futureValue shouldBe Left(HappyHourTermsClearingRefusal.Rejected(ClearHappyHourLotTermsRejected.PeriodStarted))
      auctions.commands shouldBe List(command, command)
    }

    "hands a granted deletion to the auction and returns its refusal" in {
      val command = DeleteHappyHourPeriod(HappyHourPeriod.idOf(op(7)), op(8))
      val auctions = Auctions(Inspection.Present(meetup, registryOpen = false))
      auctions.deletePeriodAnswer =
        Right(AuctionAnswer.Written(AuctionEnvelope(6, op(8), AuctionEvent.HappyHourPeriodDeleted(command.period))))

      AuctionCommands(auctions, noLots, granted)
        .deleteHappyHourPeriod(auctionOfMeetup, command, person)
        .futureValue shouldBe
        Right(())
      auctions.deletePeriodAnswer = Left(DeleteHappyHourPeriodRejected.PeriodStarted)
      AuctionCommands(auctions, noLots, granted)
        .deleteHappyHourPeriod(auctionOfMeetup, command, person)
        .futureValue shouldBe
        Left(HappyHourDeletionRefusal.Rejected(DeleteHappyHourPeriodRejected.PeriodStarted))
      auctions.commands shouldBe List(command, command)
    }

    // ADR-040, дополнение 2026-10-19: ориентировочное время финала — команда администратора.
    "hands the estimated time of the final to the auction once meetups confirms the administrator" in {
      val auctions = Auctions(Inspection.Present(meetup, registryOpen = false))
      val at = deadline.plusSeconds(3600)
      AuctionCommands(auctions, noLots, granted)
        .setFinalTime(auctionOfMeetup, Some(at), op(7), person)
        .futureValue shouldBe Right(())
      auctions.commands shouldBe List(SetFinalTime(Some(at), op(7)))
    }

    "answers a repeated estimated time from the window without asking meetups" in {
      val original = AuctionEnvelope(5, op(7), AuctionEvent.FinalTimeSet(deadline))
      val repeated = Auctions(Inspection.Repeated(original))
      val meetups = Meetups(Authority.NotAdministrator)
      AuctionCommands(repeated, noLots, meetups)
        .setFinalTime(auctionOfMeetup, Some(deadline), op(7), person)
        .futureValue shouldBe Right(())
      meetups.asked shouldBe 0
      repeated.commands shouldBe empty
    }

    "refuses the opposite action under the op_id of the time already set or cleared" in {
      val set = Auctions(Inspection.Repeated(AuctionEnvelope(5, op(7), AuctionEvent.FinalTimeSet(deadline))))
      AuctionCommands(set, noLots, granted)
        .setFinalTime(auctionOfMeetup, None, op(7), person)
        .futureValue shouldBe Left(FinalTimeRefusal.OpIdTaken)
      val cleared = Auctions(Inspection.Repeated(AuctionEnvelope(5, op(7), AuctionEvent.FinalTimeCleared)))
      AuctionCommands(cleared, noLots, granted)
        .setFinalTime(auctionOfMeetup, Some(deadline), op(7), person)
        .futureValue shouldBe Left(FinalTimeRefusal.OpIdTaken)
      set.commands shouldBe empty
      cleared.commands shouldBe empty
    }

    // PER-322: текст оплаты — повтор своего текста принимается, другой текст под тем же `op_id` — чужая команда.
    "answers the payment text repeated under its op_id and refuses another text under it" in {
      val text = PaymentInstructions.parse("Карта").get
      val repeated = Auctions(Inspection.Repeated(AuctionEnvelope(5, op(7), AuctionEvent.PaymentInstructionsSet(text))))
      AuctionCommands(repeated, noLots, granted)
        .setPaymentInstructions(auctionOfMeetup, Some(text), op(7), person)
        .futureValue shouldBe Right(())
      AuctionCommands(repeated, noLots, granted)
        .setPaymentInstructions(auctionOfMeetup, PaymentInstructions.parse("Наличными"), op(7), person)
        .futureValue shouldBe Left(PaymentInstructionsRefusal.OpIdTaken)
      AuctionCommands(repeated, noLots, granted)
        .setPaymentInstructions(auctionOfMeetup, None, op(7), person)
        .futureValue shouldBe Left(PaymentInstructionsRefusal.OpIdTaken)
      repeated.commands shouldBe empty
    }

    "hands the payment text to the auction of a cancelled meetup" in {
      val auctions = Auctions(Inspection.Present(meetup, registryOpen = false))
      val text = PaymentInstructions.parse("Карта").get
      AuctionCommands(auctions, noLots, Meetups(Authority.Granted(Standings.cancelled)))
        .setPaymentInstructions(auctionOfMeetup, Some(text), op(7), person)
        .futureValue shouldBe Right(())
      auctions.commands shouldBe List(SetPaymentInstructions(Some(text), op(7)))
    }

    // PER-781: промо-видео — повтор своего видео принимается мимо Meetups и без второго события, другое — чужая команда.
    "hands the promo video to the auction and answers it repeated under its op_id, refusing another one under it" in {
      val video = PromoVideo.parse(4321).get
      val auctions = Auctions(Inspection.Present(meetup, registryOpen = false))
      AuctionCommands(auctions, noLots, granted)
        .setPromoVideo(auctionOfMeetup, Some(video), op(7), person)
        .futureValue shouldBe Right(())
      auctions.commands shouldBe List(SetPromoVideo(Some(video), op(7)))

      val repeated = Auctions(Inspection.Repeated(AuctionEnvelope(5, op(7), AuctionEvent.PromoVideoSet(video))))
      val meetups = Meetups(Authority.NotAdministrator)
      AuctionCommands(repeated, noLots, meetups)
        .setPromoVideo(auctionOfMeetup, Some(video), op(7), person)
        .futureValue shouldBe Right(())
      AuctionCommands(repeated, noLots, meetups)
        .setPromoVideo(auctionOfMeetup, PromoVideo.parse(4322), op(7), person)
        .futureValue shouldBe Left(PromoVideoRefusal.OpIdTaken)
      AuctionCommands(repeated, noLots, meetups)
        .setPromoVideo(auctionOfMeetup, None, op(7), person)
        .futureValue shouldBe Left(PromoVideoRefusal.OpIdTaken)
      meetups.asked shouldBe 0
      repeated.commands shouldBe empty
    }

    "refuses the promo video to whom meetups does not confirm as running the auction" in {
      for (
        (answer, denial) <- List(
          Authority.NotAdministrator -> Denial.NotAdministrator,
          Authority.MeetupNotFound -> Denial.MeetupNotFound,
          Authority.Unavailable -> Denial.Unavailable,
          Authority.Granted(Standings.cancelled) -> Denial.MeetupCancelled
        )
      ) {
        val auctions = Auctions(Inspection.Present(meetup, registryOpen = false))
        AuctionCommands(auctions, noLots, Meetups(answer))
          .setPromoVideo(auctionOfMeetup, PromoVideo.parse(4321), op(7), person)
          .futureValue shouldBe Left(PromoVideoRefusal.Denied(denial))
        auctions.commands shouldBe empty
      }
    }

    "refuses the promo video of an auction without a journal before asking meetups" in {
      val meetups = granted
      AuctionCommands(Auctions(Inspection.Absent), noLots, meetups)
        .setPromoVideo(auctionOfMeetup, None, op(7), person)
        .futureValue shouldBe Left(PromoVideoRefusal.Denied(Denial.AuctionNotFound))
      meetups.asked shouldBe 0
    }

    // PER-719: раскладка ленты — повтор своей раскладки принимается, другая под тем же `op_id` — чужая команда.
    "hands the lot layout to the auction and answers it repeated under its op_id, refusing another one under it" in {
      val books = LotSection(LotSectionId(1).get, LotSectionName("Книги").get, List(lot))
      val layout = LotLayout.of(Nil, List(books)).toOption.get
      val auctions = Auctions(Inspection.Present(meetup, registryOpen = false))
      AuctionCommands(auctions, noLots, granted)
        .setLotLayout(auctionOfMeetup, layout, op(7), person)
        .futureValue shouldBe Right(())
      auctions.commands shouldBe List(SetLotLayout(layout, op(7)))

      val repeated = Auctions(Inspection.Repeated(AuctionEnvelope(5, op(7), AuctionEvent.LotLayoutSet(layout))))
      AuctionCommands(repeated, noLots, granted)
        .setLotLayout(auctionOfMeetup, layout, op(7), person)
        .futureValue shouldBe Right(())
      AuctionCommands(repeated, noLots, granted)
        .setLotLayout(auctionOfMeetup, LotLayout.empty, op(7), person)
        .futureValue shouldBe Left(LotLayoutRefusal.OpIdTaken)
      repeated.commands shouldBe empty
    }

    "refuses the lot layout of a cancelled meetup and answers the refusal of the auction" in {
      val auctions = Auctions(Inspection.Present(meetup, registryOpen = false))
      AuctionCommands(auctions, noLots, Meetups(Authority.Granted(Standings.cancelled)))
        .setLotLayout(auctionOfMeetup, LotLayout.empty, op(7), person)
        .futureValue shouldBe Left(LotLayoutRefusal.Denied(Denial.MeetupCancelled))
      auctions.commands shouldBe empty
      auctions.layoutAnswer = Left(LotLayoutRejected.LotNotInAuction(lot))
      AuctionCommands(auctions, noLots, granted)
        .setLotLayout(auctionOfMeetup, LotLayout.empty, op(8), person)
        .futureValue shouldBe Left(LotLayoutRefusal.LotNotInAuction(lot))
      auctions.layoutAnswer = Left(LotLayoutRejected.FinalAlreadyStarted)
      AuctionCommands(auctions, noLots, granted)
        .setLotLayout(auctionOfMeetup, LotLayout.empty, op(9), person)
        .futureValue shouldBe Left(LotLayoutRefusal.FinalAlreadyStarted)
    }

    "refuses a foreign command that took the op_id of the time" in {
      val auctions = Auctions(Inspection.Present(meetup, registryOpen = false))
      auctions.finalTimeAnswer = Right(AuctionAnswer.Written(AuctionEnvelope(5, op(7), AuctionEvent.PrebiddingStarted)))
      AuctionCommands(auctions, noLots, granted)
        .setFinalTime(auctionOfMeetup, Some(deadline), op(7), person)
        .futureValue shouldBe Left(FinalTimeRefusal.OpIdTaken)
    }

    "refuses an estimated time under the op_id of another auction command, an absent auction and a stranger" in {
      val taken = Auctions(Inspection.Repeated(AuctionEnvelope(4, op(7), AuctionEvent.PrebiddingStarted)))
      AuctionCommands(taken, noLots, granted)
        .setFinalTime(auctionOfMeetup, Some(deadline), op(7), person)
        .futureValue shouldBe Left(FinalTimeRefusal.OpIdTaken)
      AuctionCommands(Auctions(Inspection.Absent), noLots, granted)
        .setFinalTime(auctionOfMeetup, Some(deadline), op(7), person)
        .futureValue shouldBe Left(FinalTimeRefusal.Denied(Denial.AuctionNotFound))
      val stranger = Auctions(Inspection.Present(meetup, registryOpen = false))
      AuctionCommands(stranger, noLots, Meetups(Authority.NotAdministrator))
        .setFinalTime(auctionOfMeetup, Some(deadline), op(7), person)
        .futureValue shouldBe Left(FinalTimeRefusal.Denied(Denial.NotAdministrator))
      stranger.commands shouldBe empty
    }

    "answers the refusal of the auction about the estimated time of the final" in {
      val auctions = Auctions(Inspection.Present(meetup, registryOpen = false))
      val commands = AuctionCommands(auctions, noLots, granted)
      auctions.finalTimeAnswer = Left(FinalTimeRejected.FinalAlreadyStarted)
      commands.setFinalTime(auctionOfMeetup, Some(deadline), op(7), person).futureValue shouldBe
        Left(FinalTimeRefusal.FinalAlreadyStarted)
      auctions.finalTimeAnswer = Left(FinalTimeRejected.AuctionAlreadyFinished)
      commands.setFinalTime(auctionOfMeetup, Some(deadline), op(8), person).futureValue shouldBe
        Left(FinalTimeRefusal.AuctionAlreadyFinished)
      auctions.finalTimeAnswer = Left(FinalTimeRejected.AuctionAlreadyCancelled)
      commands.setFinalTime(auctionOfMeetup, None, op(9), person).futureValue shouldBe
        Left(FinalTimeRefusal.AuctionAlreadyCancelled)
    }

    "grants the console only once meetups confirms the administrator" in {
      AuctionCommands(Auctions(Inspection.Absent), noLots, granted).authorize(meetup, person).futureValue shouldBe
        Right(())
      AuctionCommands(Auctions(Inspection.Absent), noLots, Meetups(Authority.NotAdministrator))
        .authorize(meetup, person)
        .futureValue shouldBe Left(Denial.NotAdministrator)
    }
  }
}
