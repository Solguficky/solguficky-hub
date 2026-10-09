package auction.entity

import auction.aggregate.*
import auction.aggregate.AuctionFixtures.*
import auction.catalog.LotId
import auction.entity.JournalFixtures.*
import auction.lot.CloseLot
import auction.lot.CloseLotRejected
import auction.lot.Decision
import auction.lot.Envelope
import auction.lot.Lot
import auction.lot.LotConfigInput
import auction.lot.LotEvent
import auction.lot.LotFixtures
import auction.lot.LotFixtures.op
import auction.lot.LotFixtures.participant
import auction.lot.LotState
import auction.lot.MarkForFinal
import auction.lot.MarkForFinalRejected
import auction.lot.OpenLot
import auction.lot.OpenLotRejected
import auction.lot.PlaceBid
import auction.lot.Sale
import auction.lot.ScheduleLot
import auction.lot.ScheduleLotRejected
import auction.lot.StepPolicyInput
import auction.lot.StepPolicyInvalid
import auction.lot.UnmarkForFinal
import auction.lot.UnmarkForFinalRejected
import auction.lot.UnsoldReason
import org.apache.pekko.actor.testkit.typed.scaladsl.ActorTestKit
import org.apache.pekko.actor.typed.ActorRef
import org.apache.pekko.cluster.sharding.typed.scaladsl.ClusterSharding
import org.apache.pekko.persistence.testkit.scaladsl.EventSourcedBehaviorTestKit
import org.apache.pekko.persistence.testkit.scaladsl.EventSourcedBehaviorTestKit.SerializationSettings
import org.scalatest.BeforeAndAfterAll
import org.scalatest.BeforeAndAfterEach
import org.scalatest.concurrent.Eventually
import org.scalatest.matchers.should.Matchers
import org.scalatest.time.Seconds
import org.scalatest.time.Span
import org.scalatest.wordspec.AnyWordSpec

import java.time.Clock
import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import java.time.ZoneOffset
import scala.concurrent.Future
import scala.concurrent.Promise
import scala.concurrent.duration.*

/**
 * Синхронная часть entity аукциона на in-memory журнале. Каждое записанное событие проходит настоящий `jackson-json`
 * туда и обратно. Лоты здесь — подмена порта, решающая настоящим ядром лота; рестарт узла на настоящей базе и с
 * настоящими entity лотов — L1 `AuctionOpeningIntegrationSpec`.
 */
final class AuctionEntitySpec
    extends AnyWordSpec
    with Matchers
    with BeforeAndAfterAll
    with BeforeAndAfterEach
    with Eventually {

  private val kit = ActorTestKit("auction-entity", EventSourcedBehaviorTestKit.config.withFallback(localConfig))

  private val serialization =
    SerializationSettings.enabled.withVerifyEquality(true).withVerifyCommands(false).withVerifyState(false)

  private type Kit = EventSourcedBehaviorTestKit[AuctionEntity.Command, StoredAuctionEvent, AuctionEntity.State]

  /**
   * Лоты аукциона: состояние меняет настоящее [[Lot.decide]], поэтому отказ лота в тесте — настоящий. Лот, которого
   * тест не завёл, роняет вопрос. `silent` принимает `OpenLot`, но ответа не отдаёт; `lost` теряет команду целиком;
   * `deaf` не отвечает на вопрос о состоянии; `mute` не отвечает на `CloseLot`. Закрытие лот решает по тем же часам,
   * что и аукцион.
   */
  private final class Lots(initial: Map[LotId, Lot], now: () => Instant) extends AuctionLots {
    private var lots = initial
    private var questions = Vector.empty[LotId]
    private var commands = Vector.empty[(LotId, OpenLot)]
    private var closings = Vector.empty[(LotId, CloseLot)]
    @volatile var silent: Set[LotId] = Set.empty
    @volatile var lost: Set[LotId] = Set.empty
    @volatile var deaf: Set[LotId] = Set.empty
    @volatile var mute: Set[LotId] = Set.empty

    def asked: Vector[LotId] = synchronized(questions)
    def opens: Vector[(LotId, OpenLot)] = synchronized(commands)
    def closes: Vector[(LotId, CloseLot)] = synchronized(closings)
    def stateNow(lot: LotId): LotState = synchronized(lots(lot).state)

    def stateOf(lot: LotId): Future[LotState] = synchronized {
      questions :+= lot
      if (deaf(lot)) Future.failed(new java.util.concurrent.TimeoutException("the lot did not answer"))
      else
        lots.get(lot) match {
          case Some(found) => Future.successful(found.state)
          case None => Future.failed(new AssertionError(s"the auction asked a lot the test did not set up: $lot"))
        }
    }

    def open(lot: LotId, command: OpenLot): Future[Either[OpenLotRejected, Option[Instant]]] = synchronized {
      commands :+= lot -> command
      if (lost(lot)) Promise[Either[OpenLotRejected, Option[Instant]]]().future
      else {
        val answer = Lot.decide(lots(lot), command).map(decision => opening(written(lot, command.opId, decision)))
        if (silent(lot)) Promise[Either[OpenLotRejected, Option[Instant]]]().future else Future.successful(answer)
      }
    }

    def close(lot: LotId, command: CloseLot): Future[Either[CloseLotRejected, Unit]] = synchronized {
      closings :+= lot -> command
      val answer =
        Lot.decide(lots(lot), command, now()).map(decision => written(lot, command.opId, decision)).map(_ => ())
      if (mute(lot)) Future.failed(new java.util.concurrent.TimeoutException("the lot did not answer"))
      else Future.successful(answer)
    }

    /** Ставка участника, как её принял бы лот: событие команды и производные, продление в том числе, — по порядку. */
    def bid(lot: LotId, command: PlaceBid, at: Instant): Unit = synchronized {
      Lot.decide(lots(lot), command, LotFixtures.bid(90), LotFixtures.proxyBid(90), at) match {
        case Right(Decision.Accepted(event, derived)) =>
          val after = (event :: derived).foldLeft(lots(lot)) { (current, each) =>
            Lot.apply(current, Envelope(current.seen.size.toLong + 1, command.opId, each))
          }
          lots = lots.updated(lot, after)
        case other => throw new AssertionError(s"the lot did not take the bid: $other")
      }
    }

    private var conditions = Vector.empty[(LotId, ScheduleLot, Initiator)]

    def plans: Vector[(LotId, ScheduleLot, Initiator)] = synchronized(conditions)

    def schedule(lot: LotId, command: ScheduleLot, initiator: Initiator): Future[Either[ScheduleLotRejected, Unit]] =
      synchronized {
        conditions :+= (lot, command, initiator)
        if (lost(lot)) Promise[Either[ScheduleLotRejected, Unit]]().future
        else
          Future.successful(
            Lot.decide(lots(lot), command).map(decision => written(lot, command.opId, decision)).map(_ => ())
          )
      }

    private var choices = Vector.empty[(LotId, Any, Initiator)]

    def chosen: Vector[(LotId, Any, Initiator)] = synchronized(choices)

    def mark(lot: LotId, command: MarkForFinal, initiator: Initiator): Future[Either[MarkForFinalRejected, Unit]] =
      synchronized {
        choices :+= (lot, command, initiator)
        if (lost(lot)) Promise[Either[MarkForFinalRejected, Unit]]().future
        else
          Future.successful(
            Lot.decide(lots(lot), command, now()).map(decision => written(lot, command.opId, decision)).map(_ => ())
          )
      }

    def unmark(
        lot: LotId,
        command: UnmarkForFinal,
        initiator: Initiator
    ): Future[Either[UnmarkForFinalRejected, Unit]] =
      synchronized {
        choices :+= (lot, command, initiator)
        if (lost(lot)) Promise[Either[UnmarkForFinalRejected, Unit]]().future
        else
          Future.successful(
            Lot.decide(lots(lot), command, now()).map(decision => written(lot, command.opId, decision)).map(_ => ())
          )
      }

    private def opening(event: LotEvent): Option[Instant] =
      event match {
        case opened: LotEvent.LotOpened => opened.deadline
        case other => throw new AssertionError(s"the lot opened with $other")
      }

    /** Принятое событие ложится в лот следующим номером; повтор отдаёт исходное. */
    private def written(lot: LotId, opId: auction.lot.OpId, decision: Decision): LotEvent =
      decision match {
        case Decision.Accepted(event, _) =>
          val current = lots(lot)
          val sequence = current.seen.size.toLong + 1
          lots = lots.updated(lot, Lot.apply(current, Envelope(sequence, opId, event)))
          event
        case Decision.Repeated(original) => original.event
      }
  }

  /** Часы, которые тест переставляет: аукцион и лот видят одно время. */
  private final class MovableClock(var instant0: Instant) extends Clock {
    override def instant(): Instant = instant0
    override def getZone: ZoneId = ZoneOffset.UTC
    override def withZone(zone: ZoneId): Clock = this
  }

  private val meetup = MeetupId(uuid(10))
  private val lot = LotId(uuid(11))
  private val other = LotId(uuid(12))
  private val administrator: Initiator = Initiator.Operator(participant(1))

  private var lots: Lots = scala.compiletime.uninitialized
  private var entity: Kit = scala.compiletime.uninitialized
  private var time: MovableClock = scala.compiletime.uninitialized

  private def entityOf(
      lots: Lots,
      snapshotEvery: Int = AuctionEntity.DefaultSnapshotEvery,
      recheckEvery: FiniteDuration = AuctionEntity.DefaultRecheckEvery,
      shard: Option[ActorRef[ClusterSharding.ShardCommand]] = None
  ): Kit =
    EventSourcedBehaviorTestKit(
      kit.system,
      AuctionEntity("auction-1", time, sequentialIds(), lots, snapshotEvery, recheckEvery, shard),
      serialization
    )

  /** `lot` с условиями торгов, `other` — без них: первый откроется, второй отклонит открытие. */
  override protected def beforeEach(): Unit = {
    time = MovableClock(decidedAt)
    lots = Lots(Map(lot -> LotFixtures.scheduled(), other -> LotFixtures.drafted), () => time.instant())
    entity = entityOf(lots)
  }

  override protected def afterAll(): Unit = kit.shutdownTestKit()

  private def draft(opN: Int) =
    entity.runCommand[AuctionAnswer](AuctionEntity.Draft(DraftAuction(meetup, op(opN)), administrator, _))

  private def add(opN: Int, added: LotId = lot) =
    entity.runCommand[Either[AddLotRejected, AuctionAnswer]](
      AuctionEntity.Add(AddLot(added, op(opN)), administrator, _)
    )

  private def schedule(opN: Int, input: AuctionConfigInput = configInput()) =
    entity.runCommand[Either[ScheduleAuctionRejected, AuctionAnswer]](
      AuctionEntity.Schedule(ScheduleAuction(input, op(opN)), administrator, _)
    )

  private def start(opN: Int) =
    entity.runCommand[Either[StartPrebiddingRejected, AuctionAnswer]](
      AuctionEntity.Start(StartPrebidding(op(opN)), administrator, _)
    )

  private def discard(opN: Int) =
    entity.runCommand[Either[DiscardAuctionRejected, AuctionAnswer]](
      AuctionEntity.Discard(DiscardAuction(op(opN)), administrator, _)
    )

  private def roster: LotRoster = entity.runCommand[LotRoster](AuctionEntity.Roster(_)).reply

  private val step = StepPolicyInput.Fixed(LotFixtures.money(250))

  /**
   * Ответ на условия торгов приходит после ответа лота, вторым сообщением entity, поэтому его ждёт проба, а не
   * `runCommand` с ответом. Возвращает события, записанные самой командой, и пробу.
   */
  private def plan(opN: Int, planned: LotId = other, policy: StepPolicyInput = step) = {
    val answer = kit.createTestProbe[Either[ScheduleAuctionLotRejected, Unit]]()
    val command = ScheduleAuctionLot(planned, LotFixtures.money(5000), policy, op(opN))
    (entity.runCommand(AuctionEntity.PlanLot(command, administrator, answer.ref)).events, answer)
  }

  /** Отметка и снятие: ответ, как у условий, приходит после ответа лота, и его ждёт проба. */
  private def select(opN: Int, chosen: LotId = lot) = {
    val answer = kit.createTestProbe[Either[FinalChoiceRejected[MarkForFinalRejected], Unit]]()
    (entity.runCommand(AuctionEntity.Select(SelectForFinal(chosen, op(opN)), administrator, answer.ref)).events, answer)
  }

  private def deselect(opN: Int, chosen: LotId = lot) = {
    val answer = kit.createTestProbe[Either[FinalChoiceRejected[UnmarkForFinalRejected], Unit]]()
    val command = DeselectForFinal(chosen, op(opN))
    (entity.runCommand(AuctionEntity.Deselect(command, administrator, answer.ref)).events, answer)
  }

  private def markedNow(chosen: LotId): Boolean =
    lots.stateNow(chosen) match {
      case LotState.Trading(trading) => trading.markedForFinal
      case other => fail(s"the lot is not trading: $other")
    }

  /** Аукцион с реестром `registry`, запланированный на неделю Ф-4: события 1…N+2, старт — следующим `op_id`. */
  private def scheduledWith(registry: LotId*): Int = {
    draft(1)
    registry.zipWithIndex.foreach((added, index) => add(index + 2, added))
    schedule(registry.size + 2).reply.isRight shouldBe true
    registry.size + 3
  }

  "auction entity" should {

    "records the birth once and answers a repeated op_id with the original envelope" in {
      val born = draft(1)
      born.events should have size 1
      born.reply shouldBe AuctionAnswer.Written(AuctionEnvelope(1, op(1), AuctionEvent.AuctionDrafted(meetup)))
      draft(1).events shouldBe empty
      draft(1).reply shouldBe born.reply
      draft(2).reply shouldBe AuctionAnswer.Unchanged
      draft(2).events shouldBe empty
    }

    "keeps the meetup and the registry over a restart and numbers events by their journal position" in {
      draft(1)
      add(2).reply shouldBe Right(AuctionAnswer.Written(AuctionEnvelope(2, op(2), AuctionEvent.LotAdded(lot))))
      val restarted = entity.restart().state
      restarted.sequence shouldBe 2
      restarted.auction.meetup shouldBe Some(meetup)
      restarted.auction.lots shouldBe Set(lot)
      add(2).events shouldBe empty
    }

    "inspects without writing: absent before the birth, the meetup after it and a repeat by its op_id" in {
      entity.runCommand[Inspection](AuctionEntity.Inspect(op(1), _)).reply shouldBe Inspection.Absent
      draft(1)
      entity.runCommand[Inspection](AuctionEntity.Inspect(op(2), _)).reply shouldBe
        Inspection.Present(meetup, registryOpen = true)
      entity.runCommand[Inspection](AuctionEntity.Inspect(op(1), _)).reply shouldBe
        Inspection.Repeated(AuctionEnvelope(1, op(1), AuctionEvent.AuctionDrafted(meetup)))
    }

    "refuses a registry command before the birth without writing" in {
      val refused = add(1)
      refused.reply shouldBe Left(AddLotRejected.AuctionNotFound)
      refused.events shouldBe empty
    }

    "discards a scheduled auction, keeps it discarded over a restart and lets the same meetup draft it again" in {
      val next = scheduledWith(lot)
      discard(next).reply shouldBe
        Right(AuctionAnswer.Written(AuctionEnvelope(4, op(next), AuctionEvent.AuctionDiscarded)))
      val restarted = entity.restart().state
      restarted.sequence shouldBe 4
      restarted.auction.state shouldBe AuctionState.Initial
      restarted.auction.lots shouldBe empty
      discard(next).events shouldBe empty
      draft(next + 1).reply shouldBe
        AuctionAnswer.Written(AuctionEnvelope(5, op(next + 1), AuctionEvent.AuctionDrafted(meetup)))
      entity.runCommand[Inspection](AuctionEntity.Inspect(op(next + 2), _)).reply shouldBe
        Inspection.Present(meetup, registryOpen = true)
    }

    "refuses to discard an auction that was never drafted or whose prebidding started, without writing" in {
      discard(1).reply shouldBe Left(DiscardAuctionRejected.AuctionNotFound)
      val next = scheduledWith(lot)
      start(next).reply.isRight shouldBe true
      val refused = discard(next + 1)
      refused.reply shouldBe Left(DiscardAuctionRejected.AuctionAlreadyStarted)
      refused.events shouldBe empty
    }

    "refuses an invalid config without writing and replaces the config on a repeated scheduling" in {
      draft(1)
      val refused = schedule(2, configInput(Some(week.copy(closesAt = None))))
      refused.reply shouldBe Left(ScheduleAuctionRejected.ConfigInvalid(ConfigInvalid.ClosesAtMissing))
      refused.events shouldBe empty
      schedule(3).reply shouldBe
        Right(AuctionAnswer.Written(AuctionEnvelope(2, op(3), AuctionEvent.AuctionScheduled(config()))))
      schedule(4, byAuctioneer).state.auction.state shouldBe
        AuctionState.Scheduled(config(byAuctioneer))
    }

    "opens a scheduled lot with the op_id of the start and the deadline of the config and writes nothing for its answer" in {
      val opening = scheduledWith(lot)
      start(opening).reply shouldBe
        Right(AuctionAnswer.Written(AuctionEnvelope(4, op(opening), AuctionEvent.PrebiddingStarted)))
      eventually(roster.active shouldBe Set(lot))
      lots.opens shouldBe Vector(lot -> OpenLot(Some(closesAt), op(opening)))
      lots.stateNow(lot) shouldBe a[LotState.Trading]
      entity.getState().sequence shouldBe 4
    }

    // Т-21
    "does not count a lot that refused the opening active and keeps answering commands" in {
      val opening = scheduledWith(lot, other)
      start(opening).reply.isRight shouldBe true
      eventually {
        roster.lots shouldBe Map(
          lot -> LotStanding.Active,
          other -> LotStanding.Declined(OpenLotRejected.LotNotScheduled)
        )
      }
      schedule(opening + 1).reply shouldBe Left(ScheduleAuctionRejected.AuctionAlreadyStarted)
      add(opening + 2).reply shouldBe Left(AddLotRejected.LotsFrozen)
    }

    "answers the start and later commands while a lot never answers" in {
      lots.lost = Set(lot)
      val opening = scheduledWith(lot)
      start(opening).reply.isRight shouldBe true
      eventually(roster.lots shouldBe Map(lot -> LotStanding.Opening))
      roster.active shouldBe empty
      entity.runCommand[Auction](AuctionEntity.Get(_)).reply.state shouldBe AuctionState.Prebidding(
        config(),
        op(opening)
      )
    }

    // Т-27
    "asks a lot again after a restart and does not open a lot that had opened before it" in {
      lots.silent = Set(lot)
      val opening = scheduledWith(lot)
      start(opening)
      eventually(roster.lots shouldBe Map(lot -> LotStanding.Opening))
      lots.stateNow(lot) shouldBe a[LotState.Trading]
      entity.restart()
      eventually(roster.active shouldBe Set(lot))
      lots.opens should have size 1
      lots.asked shouldBe Vector(lot, lot)
    }

    // Т-27: команда открытия до лота не дошла
    "opens a lot with the same op_id when it restarted before the lot got the opening" in {
      lots.lost = Set(lot)
      val opening = scheduledWith(lot)
      start(opening)
      eventually(roster.lots shouldBe Map(lot -> LotStanding.Opening))
      lots.lost = Set.empty
      entity.restart()
      eventually(roster.active shouldBe Set(lot))
      lots.opens.map(_._2.opId) shouldBe Vector(op(opening), op(opening))
    }

    "does not start twice on a repeated op_id, leaves an open lot alone and asks an unanswered lot again" in {
      lots.deaf = Set(other)
      val opening = scheduledWith(lot, other)
      val first = start(opening)
      eventually(roster.lots shouldBe Map(lot -> LotStanding.Active, other -> LotStanding.Unanswered))
      lots.deaf = Set.empty
      val repeated = start(opening)
      repeated.events shouldBe empty
      repeated.reply shouldBe first.reply
      eventually(roster.lots(other) shouldBe LotStanding.Declined(OpenLotRejected.LotNotScheduled))
      lots.opens.map(_._1) shouldBe Vector(lot, other)
      start(opening + 1).reply shouldBe Left(StartPrebiddingRejected.AuctionNotScheduled)
    }

    "asks no lot after a restart before prebidding" in {
      scheduledWith(lot)
      entity.restart()
      roster shouldBe LotRoster.empty
      lots.asked shouldBe empty
    }

    "sends the conditions to a lot of its registry in the name of the administrator and writes nothing itself" in {
      draft(1)
      add(2, other)
      val (events, answer) = plan(3)
      answer.expectMessage(Right(()))
      events shouldBe empty
      entity.getState().sequence shouldBe 2
      lots.plans shouldBe Vector(
        (
          other,
          ScheduleLot(
            LotFixtures.money(5000),
            LotConfigInput(LotFixtures.rub, step, LotFixtures.antiSnipe, proxyEnabled = true),
            op(3)
          ),
          administrator
        )
      )
      lots.stateNow(other) shouldBe a[LotState.Scheduled]
    }

    "passes the refusal of the lot through and leaves the lot as it was" in {
      draft(1)
      add(2, other)
      val (_, answer) = plan(3, policy = StepPolicyInput.Fixed(LotFixtures.money(0)))
      answer.expectMessage(
        Left(
          ScheduleAuctionLotRejected.ByLot(ScheduleLotRejected.StepPolicyInvalid(StepPolicyInvalid.StepNotPositive))
        )
      )
      lots.stateNow(other) shouldBe LotState.Draft
    }

    "refuses the conditions of a lot outside its registry without reaching the lot" in {
      draft(1)
      val (_, answer) = plan(2)
      answer.expectMessage(Left(ScheduleAuctionLotRejected.LotNotInAuction))
      lots.plans shouldBe empty
    }

    "refuses new conditions once prebidding started and does not reach the lot" in {
      val opening = scheduledWith(lot, other)
      start(opening).reply.isRight shouldBe true
      val (events, answer) = plan(opening + 1)
      answer.expectMessage(Left(ScheduleAuctionLotRejected.LotsFrozen))
      events shouldBe empty
      lots.plans shouldBe empty
      lots.stateNow(other) shouldBe LotState.Draft
    }

    "marks and unmarks a trading lot of its registry in the name of the administrator and writes nothing itself" in {
      val opening = scheduledWith(lot)
      start(opening).reply.isRight shouldBe true
      eventually(roster.active shouldBe Set(lot))

      val (marking, marked) = select(opening + 1)
      marked.expectMessage(Right(()))
      marking shouldBe empty
      markedNow(lot) shouldBe true

      val (unmarking, unmarked) = deselect(opening + 2)
      unmarked.expectMessage(Right(()))
      unmarking shouldBe empty
      markedNow(lot) shouldBe false
      lots.chosen shouldBe Vector(
        (lot, MarkForFinal(op(opening + 1)), administrator),
        (lot, UnmarkForFinal(op(opening + 2)), administrator)
      )
      entity.getState().sequence shouldBe 4
    }

    "passes DeadlinePassed of the lot through once its deadline came, though the closing has not arrived" in {
      val opening = scheduledWith(lot)
      start(opening).reply.isRight shouldBe true
      eventually(roster.active shouldBe Set(lot))
      time.instant0 = closesAt

      val (_, answer) = select(opening + 1)

      answer.expectMessage(Left(FinalChoiceRejected.ByLot(MarkForFinalRejected.DeadlinePassed)))
      markedNow(lot) shouldBe false
    }

    "refuses a choice of a finalist before prebidding and outside its registry without reaching the lot" in {
      draft(1)
      add(2, lot)
      val (_, early) = select(3)
      early.expectMessage(Left(FinalChoiceRejected.NotInPrebidding))
      schedule(4).reply.isRight shouldBe true
      start(5).reply.isRight shouldBe true
      val (_, outside) = deselect(6, other)
      outside.expectMessage(Left(FinalChoiceRejected.LotNotInAuction))
      lots.chosen shouldBe empty
    }

    "opens a lot that got its conditions right before the start" in {
      val opening = scheduledWith(other)
      val (_, answer) = plan(opening)
      start(opening + 1).reply.isRight shouldBe true
      answer.expectMessage(Right(()))
      eventually(roster.active shouldBe Set(other))
    }

    "stays silent and keeps answering when the lot does not answer the conditions" in {
      lots.lost = Set(other)
      draft(1)
      add(2, other)
      val (_, answer) = plan(3)
      answer.expectNoMessage()
      entity.runCommand[Inspection](AuctionEntity.Inspect(op(4), _)).reply shouldBe
        Inspection.Present(meetup, registryOpen = true)
    }

    "keeps the config and the start of prebidding over a restart from a snapshot" in {
      entity = entityOf(lots, snapshotEvery = 2)
      val opening = scheduledWith(lot)
      start(opening)
      val restarted = entity.restart().state
      restarted.sequence shouldBe 4
      restarted.auction.state shouldBe AuctionState.Prebidding(config(), op(opening))
      restarted.auction.lots shouldBe Set(lot)
    }
    "closes a lot by its deadline once it passed, with the op_id of the closing, and writes nothing itself" in {
      val opening = scheduledWith(lot)
      time.instant0 = closesAt.plusSeconds(1)
      start(opening).reply.isRight shouldBe true
      eventually(roster.lots shouldBe Map(lot -> LotStanding.Closed))
      lots.stateNow(lot) shouldBe LotState.Unsold(UnsoldReason.NoBids)
      lots.closes.map(_._2.opId) shouldBe Vector(LotRoster.closeOpId(op(opening), lot))
      entity.getState().sequence shouldBe 4
    }

    "does not close a lot before its deadline" in {
      val opening = scheduledWith(lot)
      start(opening)
      eventually(roster.active shouldBe Set(lot))
      lots.closes shouldBe empty
      lots.stateNow(lot) shouldBe a[LotState.Trading]
    }

    "does not close a lot that a person closes, however late it is" in {
      draft(1)
      add(2)
      schedule(3, byAuctioneer)
      time.instant0 = closesAt.plusSeconds(86400)
      start(4)
      eventually(roster.active shouldBe Set(lot))
      lots.closes shouldBe empty
    }

    "closes after a restart a lot whose deadline passed while the auction was down" in {
      val opening = scheduledWith(lot)
      start(opening)
      eventually(roster.active shouldBe Set(lot))
      time.instant0 = closesAt.plusSeconds(3600)
      entity.restart()
      eventually(roster.lots shouldBe Map(lot -> LotStanding.Closed))
      lots.stateNow(lot) shouldBe LotState.Unsold(UnsoldReason.NoBids)
    }

    "re-arms the closing on the deadline the lot extended and sells the lot only after that deadline" in {
      val opening = scheduledWith(lot)
      // Таймер старого дедлайна сработает через секунду настоящего времени.
      time.instant0 = closesAt.minusSeconds(1)
      start(opening)
      eventually(roster.active shouldBe Set(lot))
      lots.bid(lot, LotFixtures.placeBid(who = 2, amount = 110, opN = 90), time.instant())
      val extended = closesAt.plus(Duration.ofMinutes(2))
      time.instant0 = closesAt.plusSeconds(1)

      // Лот отказал закрытию по старому дедлайну, аукцион переспросил его и взвёл таймер на новый.
      eventually(timeout(Span(3, Seconds))) {
        lots.closes.size shouldBe 1
        lots.asked.count(_ == lot) shouldBe 2
        roster.active shouldBe Set(lot)
      }
      lots.stateNow(lot) shouldBe a[LotState.Trading]

      time.instant0 = extended.plusSeconds(1)
      entity.restart()
      eventually(roster.lots shouldBe Map(lot -> LotStanding.Closed))
      lots.stateNow(lot) shouldBe
        LotState.Sold(Sale(participant(2), LotFixtures.money(110), LotFixtures.bid(90), extended.plusSeconds(1)))
      lots.closes.map(_._2.opId).distinct shouldBe Vector(LotRoster.closeOpId(op(opening), lot))
    }

    "asks a lot that did not answer the closing again on its own and closes it with the same op_id" in {
      entity = entityOf(lots, recheckEvery = 50.millis)
      lots.mute = Set(lot)
      val opening = scheduledWith(lot)
      time.instant0 = closesAt.plusSeconds(1)
      start(opening)
      eventually(roster.lots shouldBe Map(lot -> LotStanding.Unanswered))
      lots.mute = Set.empty
      // Первое закрытие лот принял, но ответ потерялся: переспрос узнаёт, что лот уже закрыт, и второго не шлёт.
      eventually(timeout(Span(3, Seconds)))(roster.lots shouldBe Map(lot -> LotStanding.Closed))
      lots.closes.map(_._2.opId).distinct shouldBe Vector(LotRoster.closeOpId(op(opening), lot))
    }
    "asks its shard to passivate an auction that was never drafted, so that a stray auction_id is not remembered" in {
      val shard = kit.createTestProbe[ClusterSharding.ShardCommand]()
      entity = entityOf(lots, recheckEvery = 50.millis, shard = Some(shard.ref))
      entity.runCommand[Inspection](AuctionEntity.Inspect(op(1), _)).reply shouldBe Inspection.Absent
      shard.expectMessageType[ClusterSharding.Passivate[?]]
    }

    "does not ask its shard to passivate a drafted, a scheduled or a trading auction" in {
      val shard = kit.createTestProbe[ClusterSharding.ShardCommand]()
      entity = entityOf(lots, recheckEvery = 50.millis, shard = Some(shard.ref))
      draft(1)
      // До рождения аукцион был `Initial`, и ранний тик мог честно попросить пассивации; после рождения — нет.
      Iterator.continually(scala.util.Try(shard.receiveMessage(100.millis))).takeWhile(_.isSuccess).foreach(_ => ())
      shard.expectNoMessage(200.millis)
      val opening = scheduledWith(lot)
      shard.expectNoMessage(200.millis)
      start(opening)
      eventually(roster.active shouldBe Set(lot))
      shard.expectNoMessage(300.millis)
    }
  }
}
