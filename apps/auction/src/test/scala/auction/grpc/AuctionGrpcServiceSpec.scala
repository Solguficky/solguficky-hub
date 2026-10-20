package auction.grpc

import auction.aggregate.AddLot
import auction.aggregate.AdvanceLotAsk
import auction.aggregate.AdvanceLotAskRejected
import auction.aggregate.Auction
import auction.aggregate.AuctionEnvelope
import auction.aggregate.AuctionEvent
import auction.aggregate.AuctionCommands
import auction.aggregate.AuctionFixtures
import auction.aggregate.AuctionState
import auction.aggregate.Authority
import auction.aggregate.Standings
import auction.aggregate.Correlation
import auction.aggregate.DeselectForFinal
import auction.aggregate.CancelAuction
import auction.aggregate.CloseAuctionLot
import auction.aggregate.CloseAuctionLotRejected
import auction.aggregate.DiscardAuction
import auction.aggregate.DraftAuction
import auction.aggregate.FinalChoiceRejected
import auction.aggregate.FreezeFinalLineup
import auction.aggregate.FreezeFinalLineupRejected
import auction.aggregate.Inspection
import auction.aggregate.MeetupAuthority
import auction.aggregate.LotEnding
import auction.aggregate.MeetupId
import auction.aggregate.RemoveLot
import auction.aggregate.RemoveLotRejected
import auction.aggregate.ScheduleAuction
import auction.aggregate.ScheduleAuctionLot
import auction.aggregate.ScheduleAuctionLotRejected
import auction.aggregate.SelectForFinal
import auction.aggregate.StartFinal
import auction.aggregate.StartFinalRejected
import auction.aggregate.StartNextLot
import auction.aggregate.StartNextLotRejected
import auction.aggregate.StartPrebidding
import auction.catalog.CardEdit
import auction.catalog.CardStanding
import auction.catalog.LotCard
import auction.catalog.LotCatalogCommands
import auction.catalog.LotCatalogStore
import auction.catalog.LotId
import auction.prediction.Answer
import auction.prediction.Forecast
import auction.prediction.MyPredictions
import auction.prediction.Nomination
import auction.prediction.PredictionGateway
import auction.prediction.PredictionRound
import auction.prediction.Predictions
import auction.prediction.RoundStatus
import auction.prediction.SubmitForecast
import auction.prediction.SubmitRejected
import auction.catalog.LotImage
import auction.catalog.NewCard
import auction.entity.AuctionAnswer
import auction.entity.AuctionGateway
import auction.entity.Initiator
import auction.entity.LotEntity
import auction.entity.LotGateway
import auction.contract.LotValues
import auction.lot.AdvanceAsk
import auction.lot.AdvanceAskRejected
import auction.lot.AuctionId
import auction.lot.BidId
import auction.lot.BidSource
import auction.lot.DraftLot
import auction.lot.DraftLotRejected
import auction.lot.Envelope
import auction.lot.LotEvent
import auction.lot.LotState
import auction.lot.MarkForFinalRejected
import auction.lot.UnmarkForFinalRejected
import auction.lot.OpId
import auction.lot.LotFixtures
import auction.lot.LotFixtures.*
import auction.lot.ParticipantId
import auction.lot.Phase
import auction.lot.PlaceBid
import auction.lot.PlaceBidRejected
import auction.lot.CurrencyCode
import auction.lot.Money
import auction.lot.Sale
import auction.lot.ScheduleLotRejected
import auction.lot.SetProxyLimit
import auction.lot.SetProxyLimitRejected
import auction.lot.StepPolicyInput
import auction.lot.UnsoldReason
import auction.lot.WithdrawProxyLimit
import auction.lot.WithdrawProxyLimitRejected
import auction.naming.Alias
import auction.naming.ChooseResult
import auction.naming.ChosenName
import auction.naming.DisplayNameCommands
import auction.naming.DisplayNameStore
import auction.naming.StoredName
import auction.naming.TelegramUsername
import auction.onboarding.FaqAcknowledgements
import auction.projection.AuctionListing
import auction.projection.AuctionSnapshotView
import auction.projection.AuctionViews
import auction.projection.AuctionWatchView
import auction.projection.AuctionWatchViews
import auction.projection.DayLotStatisticsView
import auction.projection.FinalBids
import auction.projection.LotImageView
import auction.projection.BidRecord
import auction.projection.LotSnapshotView
import auction.projection.LotStatisticsView
import auction.projection.LotViews
import auction.v1.auction.BidSource as BidSourceMessage
import auction.v1.auction.Money as MoneyMessage
import auction.v1.auction.StepPolicy as StepPolicyMessage
import auction.v1.auction as model
import auction.v1.auction_service as wire
import ch.qos.logback.classic.Logger as LogbackLogger
import ch.qos.logback.classic.spi.ILoggingEvent
import ch.qos.logback.core.read.ListAppender
import com.google.protobuf.ByteString
import identity.v1.access.AccessRight as AccessRightMessage
import io.grpc.Status
import org.apache.pekko.actor.testkit.typed.scaladsl.ActorTestKit
import org.apache.pekko.grpc.GrpcServiceException
import org.apache.pekko.stream.Materializer
import org.apache.pekko.stream.scaladsl.Sink
import org.apache.pekko.stream.scaladsl.SinkQueueWithCancel
import org.apache.pekko.stream.scaladsl.Source
import org.apache.pekko.pattern.AskTimeoutException
import auction.raffle.CancelRegistration
import auction.raffle.Draw
import auction.raffle.Raffle
import auction.raffle.RaffleGateway
import auction.raffle.RaffleState
import auction.raffle.RaffleTerms
import auction.raffle.Randomness
import auction.raffle.Register
import auction.raffle.RegistrationRejected
import auction.raffle.Seed
import auction.watch.AuctionChanges
import auction.watch.ChangeRegistry
import org.scalatest.BeforeAndAfterAll
import org.scalatest.concurrent.ScalaFutures
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec
import org.slf4j.LoggerFactory

import java.time.Clock
import java.time.Duration
import java.time.Instant
import java.util.UUID
import scala.annotation.tailrec
import scala.concurrent.ExecutionContext
import scala.concurrent.Future
import scala.jdk.CollectionConverters.*

final class AuctionGrpcServiceSpec extends AnyWordSpec with Matchers with ScalaFutures with BeforeAndAfterAll {

  import RequestMappingSpec.*

  private given ExecutionContext = ExecutionContext.parasitic

  /** Шлюз, до которого запрос не должен дойти: любой вызов, который тест не переопределил, роняет тест. */
  private class Gateway extends LotGateway {
    def draftLot(lotId: UUID, command: DraftLot, initiator: Initiator): Future[Either[DraftLotRejected, Envelope]] =
      fail("the lot was reached")

    def auctionOf(lotId: UUID): Future[Option[AuctionId]] = fail("the lot was reached")

    def stateOf(lotId: UUID): Future[LotState] = fail("the lot was reached")

    def placeBid(
        lotId: UUID,
        command: PlaceBid,
        initiator: Initiator
    ): Future[Either[PlaceBidRejected, LotEntity.Recorded]] =
      fail("the lot was reached")

    def setProxyLimit(
        lotId: UUID,
        command: SetProxyLimit,
        initiator: Initiator
    ): Future[Either[SetProxyLimitRejected, LotEntity.Recorded]] = fail("the lot was reached")

    def withdrawProxyLimit(
        lotId: UUID,
        command: WithdrawProxyLimit,
        initiator: Initiator
    ): Future[Either[WithdrawProxyLimitRejected, Envelope]] = fail("the lot was reached")
  }

  private object Unreachable extends Gateway

  /** Аукцион, в котором родились лоты этих тестов. */
  private val TheAuction = auctionId(1)

  private val ViewerId = ParticipantId(UUID.fromString(identity))

  /** Лот, который родился в `TheAuction`; команды, которые тест не переопределил, роняют тест. */
  private class Born extends Gateway {
    override def auctionOf(lotId: UUID): Future[Option[AuctionId]] = Future.successful(Some(TheAuction))
  }

  /**
   * Имена в памяти. Заморозка падает первые `failingFreezes` раз и считает каждый вызов; уникальность псевдонима
   * держится по ключу, как индекс базы.
   */
  private class Names(initial: Map[ParticipantId, ChosenName] = Map.empty, failingFreezes: Int = 0)
      extends DisplayNameStore {
    var chosen: Map[ParticipantId, ChosenName] = initial
    var frozen: Set[ParticipantId] = Set.empty
    var freezes: Int = 0

    def choose(auction: AuctionId, participant: ParticipantId, name: ChosenName): Future[ChooseResult] =
      Future.successful {
        if (frozen(participant) && chosen.contains(participant)) ChooseResult.Frozen(chosen(participant))
        else if (chosen.exists((other, held) => other != participant && sameAlias(held, name))) ChooseResult.AliasTaken
        else {
          chosen += participant -> name
          ChooseResult.Written
        }
      }

    def freeze(auction: AuctionId, participant: ParticipantId): Future[Boolean] = {
      freezes += 1
      // Как UPDATE базы: без строки выбора замораживать нечего.
      if (freezes <= failingFreezes) Future.failed(IllegalStateException("database is down"))
      else if (!chosen.contains(participant)) Future.successful(false)
      else {
        frozen += participant
        Future.successful(true)
      }
    }

    def find(auction: AuctionId, participants: Set[ParticipantId]): Future[Map[ParticipantId, StoredName]] =
      Future.successful(
        chosen.view
          .filterKeys(participants)
          .map((participant, name) => participant -> StoredName(name, frozen(participant)))
          .toMap
      )

    def all(auction: AuctionId): Future[Map[ParticipantId, StoredName]] =
      Future.successful(chosen.map((participant, name) => participant -> StoredName(name, frozen(participant))))

    private def sameAlias(held: ChosenName, wanted: ChosenName): Boolean =
      (held, wanted) match {
        case (ChosenName.Pseudonym(a), ChosenName.Pseudonym(b)) => a.key == b.key
        case _ => false
      }
  }

  private def named: Map[ParticipantId, ChosenName] =
    Map(ViewerId -> ChosenName.Telegram(TelegramUsername.from("vasya").getOrElse(fail("not a username"))))

  /** Хранилище имён, до которого запрос не должен дойти. */
  private object UntouchableNames extends DisplayNameStore {
    private def touched = fail("the display name store was touched")
    def choose(auction: AuctionId, participant: ParticipantId, name: ChosenName) = touched
    def freeze(auction: AuctionId, participant: ParticipantId) = touched
    def find(auction: AuctionId, participants: Set[ParticipantId]) = touched
    def all(auction: AuctionId) = touched
  }

  private val accepted: LotEntity.Recorded =
    LotEntity.Recorded(Envelope(4, LotFixtures.op(1), manual(bid(7), 1, 150, None)), lotVersion = 5)

  private object UntouchableStore extends LotCatalogStore {
    private def touched = fail("the catalog store was touched")
    def insertIfAbsent(card: NewCard): Future[Option[LotCard]] = touched
    def update(edit: CardEdit): Future[Option[LotCard]] = touched
    def find(lotId: LotId): Future[Option[LotCard]] = touched
  }

  private def answering(outcome: Future[Either[PlaceBidRejected, LotEntity.Recorded]]): LotGateway =
    new Born {
      override def placeBid(
          lotId: UUID,
          command: PlaceBid,
          initiator: Initiator
      ): Future[Either[PlaceBidRejected, LotEntity.Recorded]] = outcome
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
    def statistics(auctionId: UUID): Future[List[LotStatisticsView]] = fail("the statistics were read")
    def dayStatistics(auctionId: UUID, from: Instant, until: Instant): Future[List[DayLotStatisticsView]] =
      fail("the day statistics were read")
  }

  private object UntouchableViews extends Views

  /** Шлюз аукциона: команда, которую тест не переопределил, роняет тест. */
  private class Auctions extends AuctionGateway {
    def inspect(auctionId: AuctionId, opId: OpId): Future[Inspection] = fail("the auction was reached")
    def get(auctionId: AuctionId): Future[Auction] = fail("the auction was reached")
    def draft(auctionId: AuctionId, command: DraftAuction, initiator: Initiator): Future[AuctionAnswer] =
      fail("the auction was reached")
    def addLot(auctionId: AuctionId, command: AddLot, initiator: Initiator) = fail("the auction was reached")
    def removeLot(auctionId: AuctionId, command: RemoveLot, initiator: Initiator) = fail("the auction was reached")
    def schedule(auctionId: AuctionId, command: ScheduleAuction, initiator: Initiator) =
      fail("the auction was reached")
    def startPrebidding(auctionId: AuctionId, command: StartPrebidding, initiator: Initiator) =
      fail("the auction was reached")
    def discard(auctionId: AuctionId, command: DiscardAuction, initiator: Initiator) =
      fail("the auction was reached")
    def cancel(auctionId: AuctionId, command: CancelAuction, initiator: Initiator) =
      fail("the auction was reached")
    def scheduleLot(
        auctionId: AuctionId,
        command: ScheduleAuctionLot,
        initiator: Initiator
    ): Future[Either[ScheduleAuctionLotRejected, Unit]] = fail("the auction was reached")
    def selectForFinal(
        auctionId: AuctionId,
        command: SelectForFinal,
        initiator: Initiator
    ): Future[Either[FinalChoiceRejected[MarkForFinalRejected], Unit]] = fail("the auction was reached")
    def deselectForFinal(
        auctionId: AuctionId,
        command: DeselectForFinal,
        initiator: Initiator
    ): Future[Either[FinalChoiceRejected[UnmarkForFinalRejected], Unit]] = fail("the auction was reached")
    def freezeFinalLineup(
        auctionId: AuctionId,
        command: FreezeFinalLineup,
        initiator: Initiator
    ): Future[Either[FreezeFinalLineupRejected, AuctionAnswer]] = fail("the auction was reached")
    def startFinal(
        auctionId: AuctionId,
        command: StartFinal,
        initiator: Initiator
    ): Future[Either[StartFinalRejected, AuctionAnswer]] = fail("the auction was reached")
    def startNextLot(
        auctionId: AuctionId,
        command: StartNextLot,
        initiator: Initiator
    ): Future[Either[StartNextLotRejected, LotId]] = fail("the auction was reached")
    def advanceAsk(
        auctionId: AuctionId,
        command: AdvanceLotAsk,
        initiator: Initiator
    ): Future[Either[AdvanceLotAskRejected, Unit]] = fail("the auction was reached")
    def closeLot(
        auctionId: AuctionId,
        command: CloseAuctionLot,
        initiator: Initiator
    ): Future[Either[CloseAuctionLotRejected, LotEnding]] = fail("the auction was reached")
  }

  private val NoMeetups: MeetupAuthority = (_, _, _) => fail("meetups was asked")

  private val granted: MeetupAuthority = (_, _, _) => Future.successful(Authority.Granted(Standings.published))

  /** Человек в зале, за которого помощник заносит ставку, и его имя в аукционе. */
  private val RoomId = ParticipantId(UUID.fromString("01890a5d-ac99-7aaa-8bbb-dddddddddddd"))

  private def roomNamed: Map[ParticipantId, ChosenName] =
    named + (RoomId -> ChosenName.Telegram(TelegramUsername.from("petya").getOrElse(fail("not a username"))))

  private def floorBid: wire.PlaceBidRequest =
    validBid.withSource(BidSourceMessage.BID_SOURCE_FLOOR).withParticipantId(RoomId.value.toString)

  /** Аукцион сходки запросов `meetupId`: команды финала называют его каноническим UUIDv5. */
  private val meetupAuctionId = Auction.idOf(MeetupId(UUID.fromString(meetupId))).value.toString

  private object UntouchableAuctionViews extends AuctionViews {
    def byId(auctionId: UUID): Future[Option[AuctionSnapshotView]] = fail("an auction was read by id")
    def byMeetup(meetup: MeetupId): Future[Option[AuctionSnapshotView]] = fail("the auction read model was touched")
    def page(listing: AuctionListing, after: Option[UUID], limit: Int): Future[List[AuctionSnapshotView]] =
      fail("the auction read model was touched")
  }

  private def service(
      lots: LotGateway,
      catalog: LotCatalogCommands = LotCatalogCommands(UntouchableStore, _ => fail("the lot was asked")),
      faq: FaqAcknowledgements = UntouchableFaq,
      views: LotViews = UntouchableViews,
      auctions: AuctionCommands = AuctionCommands(new Auctions, Unreachable, NoMeetups),
      auctionViews: AuctionViews = UntouchableAuctionViews,
      names: DisplayNameStore = Names(named),
      clock: Clock = Clock.systemUTC(),
      raffles: RaffleGateway = AuctionGrpcService.NoRaffles,
      raffleNames: AuctionId => Future[Map[Int, String]] = _ => Future.successful(Map.empty),
      watchViews: AuctionWatchViews = _ => fail("the watch read model was touched"),
      changes: AuctionChanges = AuctionGrpcService.NoChanges,
      caller: Option[Caller] = None,
      predictions: PredictionGateway = AuctionGrpcService.NoPredictions,
      placeBidsRight: ParticipantId => Future[Boolean] = _ => Future.successful(true),
      notes: OperationNotes = OperationNotes.discarded,
      finalBids: FinalBids = FinalBids.empty
  ) =
    AuctionGrpcService(
      lots,
      catalog,
      faq,
      views,
      auctions,
      auctionViews,
      DisplayNameCommands(names),
      clock = clock,
      overdueGrace = Duration.ofMinutes(2),
      raffles = raffles,
      raffleNames = raffleNames,
      watchViews = watchViews,
      changes = changes,
      caller = caller,
      predictions = predictions,
      placeBidsRight = placeBidsRight,
      notes = notes,
      finalBids = finalBids
    )

  /**
   * Аукцион сходки с лотами в реестре, как его видят команды ведущего: окно `op_id` пусто, entity отдаёт аукцион
   * целиком. Без аргументов — аукцион лота `Born`, `TheAuction`.
   */
  private def registered(registry: UUID*): Auctions = {
    val console = consoleOf(registry*)
    new Auctions {
      override def inspect(auctionId: AuctionId, opId: OpId) =
        Future.successful(Inspection.Present(MeetupId(UUID.fromString(meetupId)), registryOpen = false))
      override def get(auctionId: AuctionId) = console.get(auctionId)
    }
  }

  /**
   * Аукцион команд ведущего, который решает ask настоящим `Auction.decide` по своему реестру, а лот отвечает `lot`: так
   * тест проходит тот же путь «аукцион — прокси к лоту», что entity аукциона.
   */
  private def askingThrough(
      registry: UUID*
  )(lot: (AdvanceAsk, Initiator) => Either[AdvanceAskRejected, Unit]): Auctions = {
    val known = registered(registry*)
    new Auctions {
      override def inspect(auctionId: AuctionId, opId: OpId) = known.inspect(auctionId, opId)
      override def get(auctionId: AuctionId) = known.get(auctionId)
      override def advanceAsk(auctionId: AuctionId, command: AdvanceLotAsk, initiator: Initiator) =
        known
          .get(auctionId)
          .map(Auction.decide(_, command).flatMap(ask => lot(ask, initiator).left.map(AdvanceLotAskRejected.ByLot(_))))
    }
  }

  /** Аукцион сходки в онлайн-торгах с лотами в реестре — то, что пульт читает у entity. */
  private def consoleOf(registry: UUID*): Auctions = {
    val meetup = MeetupId(UUID.fromString(meetupId))
    val added = registry.toList.zipWithIndex.map { (lot, index) =>
      AuctionEnvelope(index + 2L, LotFixtures.op(index + 2), AuctionEvent.LotAdded(LotId(lot)))
    }
    val next = registry.size + 2
    val running = Auction.replay(
      Auction.initial,
      AuctionEnvelope(1, LotFixtures.op(1), AuctionEvent.AuctionDrafted(meetup)) :: added ++ List(
        AuctionEnvelope(next, LotFixtures.op(next), AuctionEvent.AuctionScheduled(AuctionFixtures.config())),
        AuctionEnvelope(next + 1, LotFixtures.op(next + 1), AuctionEvent.PrebiddingStarted)
      )
    )
    new Auctions {
      override def get(auctionId: AuctionId) = Future.successful(running)
    }
  }

  // Пока SLF4J инициализирует backend, он отдаёт SubstituteLogger, и приведение к logback падает (как в GrpcBoundarySpec).
  private def serviceLogger: LogbackLogger = {
    @tailrec
    def resolve(attemptsLeft: Int): LogbackLogger =
      LoggerFactory.getLogger(classOf[AuctionGrpcService].getName) match {
        case logback: LogbackLogger => logback
        case _ if attemptsLeft > 0 =>
          Thread.sleep(50)
          resolve(attemptsLeft - 1)
        case other => fail(s"slf4j did not settle on logback: ${other.getClass.getName}")
      }
    resolve(attemptsLeft = 40)
  }

  private def statusOf(call: Future[?]): Status.Code =
    call.failed.futureValue match {
      case refused: GrpcServiceException => refused.status.getCode
      case other => fail(s"expected a status, got $other")
    }

  /** Розыгрыш в памяти: отвечает тем, что задал тест, и помнит команды, которые до него дошли. */
  private final class Raffles(raffle: Raffle, refusal: Option[RegistrationRejected] = None) extends RaffleGateway {
    var reached: Vector[Any] = Vector.empty
    private def answer(command: Any) = {
      reached :+= command
      Future.successful(refusal.toLeft(raffle))
    }
    def register(auction: AuctionId, command: Register) = answer(command)
    def cancel(auction: AuctionId, command: CancelRegistration) = answer(command)
    def get(auction: AuctionId) = Future.successful(raffle)
  }

  private val raffleSeed = Seed.fromHex("46fb9863b7178feb348aa621d658c5b41b848e398494830bac4837e0b0f539ae").get
  private val raffleTerms = RaffleTerms(Instant.parse("2099-10-28T18:00:00Z"), raffleSeed, 42L)
  private def raffleAuction = Auction.idOf(MeetupId(UUID.fromString(meetupId))).value.toString
  private val raffleOp = "01890a5d-ac98-7c2b-9f3a-0d1b2c3d4e07"
  private def registration = wire.RegisterForRaffleRequest(Some(viewer), raffleAuction, raffleOp)

  /** Игра в памяти: отвечает тем, что задал тест, и помнит, что до неё дошло и чьи прогнозы у неё спросили. */
  private final class Games(
      answer: Either[SubmitRejected, Forecast],
      sent: Option[Either[SubmitRejected.OpIdTaken.type, Forecast]] = None
  ) extends PredictionGateway {
    var reached: Vector[SubmitForecast] = Vector.empty
    var asked: Vector[ParticipantId] = Vector.empty
    def submit(auction: AuctionId, command: SubmitForecast) = {
      reached :+= command
      Future.successful(answer)
    }
    def mine(auction: AuctionId, participant: ParticipantId) = {
      asked :+= participant
      val open = Predictions(RoundStatus.Open, RoundStatus.NotOpen, cancelled = false)
      Future.successful(MyPredictions(open, answer.toOption.map(found => found.round -> found).toMap))
    }
    def recall(auction: AuctionId, participant: ParticipantId, round: PredictionRound, opId: OpId) =
      Future.successful(sent)
  }

  /** Аукцион сходки, запланированный с `lot` в реестре: раунд каталога может быть открыт. */
  private def scheduledWithLot: AuctionCommands = {
    val planned = Auction.replay(
      Auction.initial,
      List(
        AuctionEnvelope(1, LotFixtures.op(1), AuctionEvent.AuctionDrafted(MeetupId(UUID.fromString(meetupId)))),
        AuctionEnvelope(2, LotFixtures.op(2), AuctionEvent.LotAdded(LotId(UUID.fromString(lot)))),
        AuctionEnvelope(3, LotFixtures.op(3), AuctionEvent.AuctionScheduled(AuctionFixtures.config()))
      )
    )
    AuctionCommands(
      new Auctions { override def get(auctionId: AuctionId) = Future.successful(planned) },
      Unreachable,
      NoMeetups
    )
  }

  private val guess = Forecast
    .parse(
      PredictionRound.Catalog,
      List(
        Nomination.MostExpensiveLot -> Answer.Lot(LotId(UUID.fromString(lot))),
        Nomination.TotalBids -> Answer.Number(120)
      )
    )
    .toOption
    .get

  private def predictionOf(lotId: String) = wire.SubmitPredictionRequest(
    Some(viewer),
    raffleAuction,
    wire.PredictionRound.PREDICTION_ROUND_CATALOG,
    List(
      wire.PredictionAnswer(
        model.PredictionNomination.PREDICTION_NOMINATION_TOTAL_BIDS,
        wire.PredictionAnswer.Answer.Number(120)
      ),
      wire.PredictionAnswer(
        model.PredictionNomination.PREDICTION_NOMINATION_MOST_EXPENSIVE_LOT,
        wire.PredictionAnswer.Answer.LotId(lotId)
      )
    ),
    raffleOp
  )

  "the predictions at the grpc boundary" should {

    "refuses a viewer without the right to bid, a malformed answer, a foreign lot and a missing name before the game" in {
      val games = Games(Right(guess))
      def call(names: DisplayNameStore = Names(named)) =
        service(Unreachable, auctions = scheduledWithLot, names = names, predictions = games)
      val hubOnly = viewer.withRights(Seq(AccessRightMessage.ACCESS_RIGHT_ACCESS_HUB))
      statusOf(call().submitPrediction(predictionOf(lot).withViewer(hubOnly))) shouldBe Status.Code.PERMISSION_DENIED
      statusOf(call().getMyPredictions(wire.GetMyPredictionsRequest(Some(hubOnly), raffleAuction))) shouldBe
        Status.Code.PERMISSION_DENIED
      val numberForLot = predictionOf(lot).withAnswers(
        List(
          wire.PredictionAnswer(
            model.PredictionNomination.PREDICTION_NOMINATION_MOST_EXPENSIVE_LOT,
            wire.PredictionAnswer.Answer.Number(5)
          )
        )
      )
      statusOf(call().submitPrediction(numberForLot)) shouldBe Status.Code.INVALID_ARGUMENT
      val finalInCatalog = predictionOf(lot).withRound(wire.PredictionRound.PREDICTION_ROUND_FINAL)
      statusOf(call().submitPrediction(finalInCatalog)) shouldBe Status.Code.INVALID_ARGUMENT
      val stranger = "01890a5d-ac97-7c2b-9f3a-0d1b2c3d4e60"
      val foreign = call().submitPrediction(predictionOf(stranger)).futureValue.getRefused.getLotNotInRound
      foreign.lotId shouldBe stranger
      foreign.nomination shouldBe model.PredictionNomination.PREDICTION_NOMINATION_MOST_EXPENSIVE_LOT
      call(names = Names())
        .submitPrediction(predictionOf(lot))
        .futureValue
        .getRefused
        .reason
        .isDisplayNameNotChosen shouldBe
        true
      games.reached shouldBe empty
    }

    "accepts the viewer's prediction in nomination order and reads back only the viewer's own" in {
      val games = Games(Right(guess))
      val answered = service(Unreachable, auctions = scheduledWithLot, predictions = games)
      val accepted = answered.submitPrediction(predictionOf(lot)).futureValue.getAccepted
      accepted.round shouldBe wire.PredictionRound.PREDICTION_ROUND_CATALOG
      accepted.answers.map(_.nomination) shouldBe List(
        model.PredictionNomination.PREDICTION_NOMINATION_MOST_EXPENSIVE_LOT,
        model.PredictionNomination.PREDICTION_NOMINATION_TOTAL_BIDS
      )
      games.reached shouldBe Vector(SubmitForecast(ViewerId, guess, OpId(UUID.fromString(raffleOp))))

      val mine = answered.getMyPredictions(wire.GetMyPredictionsRequest(Some(viewer), raffleAuction)).futureValue
      mine.rounds.map(round => round.round -> round.status) shouldBe List(
        wire.PredictionRound.PREDICTION_ROUND_CATALOG -> wire.PredictionRoundStatus.PREDICTION_ROUND_STATUS_OPEN,
        wire.PredictionRound.PREDICTION_ROUND_FINAL -> wire.PredictionRoundStatus.PREDICTION_ROUND_STATUS_NOT_OPEN
      )
      mine.rounds.head.answers should have size 2
      games.asked shouldBe Vector(ViewerId)
    }

    "answers a repeat of an accepted op_id with its prediction even after its lot left the registry" in {
      val stranger = "01890a5d-ac97-7c2b-9f3a-0d1b2c3d4e60"
      val games = Games(Left(SubmitRejected.RoundClosed), sent = Some(Right(guess)))
      service(Unreachable, auctions = scheduledWithLot, predictions = games)
        .submitPrediction(predictionOf(stranger))
        .futureValue
        .getAccepted
        .answers should have size 2
      games.reached shouldBe empty
    }

    "answers a closed round as a value and a foreign op_id as already existing" in {
      service(Unreachable, auctions = scheduledWithLot, predictions = Games(Left(SubmitRejected.RoundClosed)))
        .submitPrediction(predictionOf(lot))
        .futureValue
        .getRefused
        .reason
        .isRoundClosed shouldBe true
      statusOf(
        service(Unreachable, auctions = scheduledWithLot, predictions = Games(Left(SubmitRejected.OpIdTaken)))
          .submitPrediction(predictionOf(lot))
      ) shouldBe Status.Code.ALREADY_EXISTS
    }
  }

  "the raffle at the grpc boundary" should {

    "refuses a viewer without the right to bid and a participant without a chosen name before the raffle" in {
      val raffles = Raffles(Raffle(RaffleState.Open(raffleTerms, Vector.empty), Map.empty))
      val hubOnly = viewer.withRights(Seq(AccessRightMessage.ACCESS_RIGHT_ACCESS_HUB))
      statusOf(service(Unreachable, raffles = raffles).registerForRaffle(registration.withViewer(hubOnly))) shouldBe
        Status.Code.PERMISSION_DENIED
      statusOf(
        service(Unreachable, raffles = raffles).getRaffle(wire.GetRaffleRequest(Some(hubOnly), raffleAuction))
      ) shouldBe
        Status.Code.PERMISSION_DENIED
      service(Unreachable, names = Names(), raffles = raffles)
        .registerForRaffle(registration)
        .futureValue
        .getRefused
        .reason
        .isDisplayNameNotChosen shouldBe true
      raffles.reached shouldBe empty
    }

    "accepts a registration with the commitment and the round and without the seed" in {
      val raffles = Raffles(Raffle(RaffleState.Open(raffleTerms, Vector(ViewerId)), Map.empty))
      val accepted = service(Unreachable, raffles = raffles).registerForRaffle(registration).futureValue.getAccepted
      accepted.status shouldBe wire.RaffleStatus.RAFFLE_STATUS_OPEN
      accepted.registered shouldBe true
      accepted.commitment shouldBe raffleSeed.commitment
      accepted.beaconRound shouldBe 42L
      accepted.reveal shouldBe None
      accepted.drawnAt shouldBe None
      accepted.toProtoString should not include raffleSeed.hex
      raffles.reached shouldBe Vector(Register(ViewerId, OpId(UUID.fromString(raffleOp))))
    }

    "answers a closed registration and a foreign op_id the way the contract names them" in {
      val closed = Raffles(Raffle(RaffleState.Initial, Map.empty), Some(RegistrationRejected.RegistrationClosed))
      service(Unreachable, raffles = closed)
        .cancelRaffleRegistration(
          wire.CancelRaffleRegistrationRequest(Some(viewer), raffleAuction, "01890a5d-ac98-7c2b-9f3a-0d1b2c3d4e08")
        )
        .futureValue
        .getRefused
        .reason
        .isRegistrationClosed shouldBe true
      val taken = Raffles(Raffle(RaffleState.Initial, Map.empty), Some(RegistrationRejected.OpIdTaken))
      statusOf(
        service(Unreachable, raffles = taken).registerForRaffle(registration)
      ) shouldBe Status.Code.ALREADY_EXISTS
    }

    "reveals a drawn raffle with the ticket names of the snapshot and answers no raffle with an empty response" in {
      val randomness =
        Randomness.fromHex("d7941e7b5bcaf8742bfc7136d38c5ab8274286629ffe43081dbda1f05d798300").get
      val drawn = Raffle(
        RaffleState
          .Drawn(raffleTerms, Vector(ParticipantId(UUID.fromString(lot)), ViewerId), randomness, Instant.EPOCH),
        Map.empty
      )
      val read = service(Unreachable, raffles = Raffles(drawn), raffleNames = _ => Future.successful(Map(1 -> "Кот*")))
        .getRaffle(wire.GetRaffleRequest(Some(viewer), raffleAuction))
        .futureValue
        .getRaffle
      read.status shouldBe wire.RaffleStatus.RAFFLE_STATUS_DRAWN
      read.tickets shouldBe Seq(wire.RaffleTicket(1, Some("Кот*")), wire.RaffleTicket(2, None))
      read.myTicket shouldBe Some(2)
      read.drawnAt shouldBe Some(Instant.EPOCH.toString)
      read.getReveal.seed shouldBe raffleSeed.hex
      read.getReveal.winningTicket shouldBe Some(Draw.winner(raffleSeed, 2, randomness))
      service(Unreachable, raffles = Raffles(Raffle.initial))
        .getRaffle(wire.GetRaffleRequest(Some(viewer), raffleAuction))
        .futureValue
        .raffle shouldBe None
    }
  }

  /** Потоки — единственное, чему в сьюте нужна система: остальное здесь — `Future` без материализации. */
  private lazy val streams = ActorTestKit("auction-grpc-service-streams")

  override protected def afterAll(): Unit = streams.shutdownTestKit()

  /** Поток, который тест тянет сам: следующее сообщение читается только по `pull`. */
  private def watching(source: Source[wire.AuctionWatch, ?]): SinkQueueWithCancel[wire.AuctionWatch] =
    source.runWith(Sink.queue[wire.AuctionWatch]())(using Materializer(streams.system))

  private def statusOfNext(queue: SinkQueueWithCancel[wire.AuctionWatch]): Status.Code = statusOf(queue.pull())

  private val watchedAuction = Auction.idOf(MeetupId(UUID.fromString(meetupId))).value

  private def watchedIn(state: AuctionState, lots: Set[LotId] = Set.empty): AuctionSnapshotView =
    AuctionSnapshotView(watchedAuction, Auction(state, Some(MeetupId(UUID.fromString(meetupId))), lots, Map.empty))

  private def watch = wire.WatchAuctionRequest(Some(viewer), watchedAuction.toString)

  "the auction stream at the grpc boundary" should {

    "refuses a malformed request and a viewer without the right to bid before the read model" in {
      val hubOnly = viewer.withRights(Seq(AccessRightMessage.ACCESS_RIGHT_ACCESS_HUB))
      statusOfNext(watching(service(Unreachable).watchAuction(watch.withAuctionId("auction")))) shouldBe
        Status.Code.INVALID_ARGUMENT
      statusOfNext(watching(service(Unreachable).watchAuction(watch.clearViewer))) shouldBe
        Status.Code.INVALID_ARGUMENT
      statusOfNext(watching(service(Unreachable).watchAuction(watch.withViewer(hubOnly)))) shouldBe
        Status.Code.PERMISSION_DENIED
    }

    "answers an auction the read model does not know with not found" in {
      val unknown = service(Unreachable, watchViews = _ => Future.successful(None))
      statusOfNext(watching(unknown.watchAuction(watch))) shouldBe Status.Code.NOT_FOUND
    }

    "sends the state at subscription and then only the states that changed" in {
      val registry = ChangeRegistry()
      @volatile var current: Option[AuctionWatchView] = Some(AuctionWatchView(watchedIn(AuctionState.Draft), Nil))
      val stream = watching(
        service(Unreachable, watchViews = _ => Future.successful(current), changes = registry).watchAuction(watch)
      )
      stream.pull().futureValue.map(_.getAuction.status.isDraft) shouldBe Some(true)

      // Повод без изменения сообщения не даёт: следующее сообщение — уже новое состояние, а не повтор черновика.
      registry.changed(watchedAuction)
      current = Some(AuctionWatchView(watchedIn(AuctionState.Scheduled(AuctionFixtures.config())), Nil))
      registry.changed(watchedAuction)
      stream.pull().futureValue.map(_.getAuction.status.isScheduled) shouldBe Some(true)
      stream.cancel()
    }

    "ends the stream with not found when the auction is discarded mid-stream" in {
      val registry = ChangeRegistry()
      @volatile var current: Option[AuctionWatchView] = Some(AuctionWatchView(watchedIn(AuctionState.Draft), Nil))
      val stream = watching(
        service(Unreachable, watchViews = _ => Future.successful(current), changes = registry).watchAuction(watch)
      )
      stream.pull().futureValue.map(_.getAuction.status.isDraft) shouldBe Some(true)

      current = None
      registry.changed(watchedAuction)

      statusOfNext(stream) shouldBe Status.Code.NOT_FOUND
    }

    "closes the stream after the message with the finished auction" in {
      val finished =
        AuctionWatchView(watchedIn(AuctionState.Finished(AuctionFixtures.config(), LotFixtures.op(9))), Nil)
      val stream =
        watching(service(Unreachable, watchViews = _ => Future.successful(Some(finished))).watchAuction(watch))
      stream.pull().futureValue.map(_.getAuction.status.isFinished) shouldBe Some(true)
      stream.pull().futureValue shouldBe None
    }

    "carries the lineup in its order and the active lot without anyone's proxy limit" in {
      val first = LotId(UUID.fromString("01890a5d-ac97-7c2b-9f3a-0d1b2c3d4e01"))
      val second = LotId(UUID.fromString("01890a5d-ac97-7c2b-9f3a-0d1b2c3d4e02"))
      val watcher = ParticipantId(UUID.fromString(identity))
      val live = trading(price = 700, phase = Phase.Live, closesAt = None, limits = Map(watcher -> limit(900, 3)))
      val state =
        AuctionState.Final(AuctionFixtures.config(), LotFixtures.op(9), List(second, first), List(second), Nil)
      val view = AuctionWatchView(
        watchedIn(state, Set(first, second)),
        List(
          LotSnapshotView(second.value, watchedAuction, 7, live, None, bidCount = 5),
          LotSnapshotView(first.value, watchedAuction, 4, held(price = 300, leader = participant(2)), None)
        )
      )
      val message = watching(service(Unreachable, watchViews = _ => Future.successful(Some(view))).watchAuction(watch))
        .pull()
        .futureValue
        .getOrElse(fail("the stream sent nothing"))
      message.getAuction.status.isInFinal shouldBe true
      message.lineup.map(_.id) shouldBe Seq(second.value.toString, first.value.toString)
      message.getActiveLot.id shouldBe second.value.toString
      message.getActiveLot.getTrading.getCurrentPrice.minorUnits shouldBe 700
      message.getActiveLot.viewerProxyLimit shouldBe None
      message.lineup.flatMap(_.viewerProxyLimit) shouldBe empty
    }
  }

  "auction grpc service" should {

    "refuses FAQ requests without a valid viewer or the right to bid before storage" in {
      val auction = service(Unreachable)
      statusOf(auction.getFaqAcknowledgement(wire.GetFaqAcknowledgementRequest())) shouldBe Status.Code.INVALID_ARGUMENT
      statusOf(auction.acknowledgeFaq(wire.AcknowledgeFaqRequest())) shouldBe Status.Code.INVALID_ARGUMENT
      val hubOnly = viewer.withRights(Seq(AccessRightMessage.ACCESS_RIGHT_ACCESS_HUB))
      statusOf(
        auction.getFaqAcknowledgement(wire.GetFaqAcknowledgementRequest(Some(hubOnly)))
      ) shouldBe Status.Code.PERMISSION_DENIED
      statusOf(auction.acknowledgeFaq(wire.AcknowledgeFaqRequest(Some(hubOnly)))) shouldBe Status.Code.PERMISSION_DENIED
      statusOf(
        auction.acknowledgeFaq(wire.AcknowledgeFaqRequest(Some(viewer.withIdentityId("bad"))))
      ) shouldBe Status.Code.INVALID_ARGUMENT
      val unknown = viewer.withRights(Seq(AccessRightMessage.Unrecognized(999)))
      statusOf(
        auction.getFaqAcknowledgement(wire.GetFaqAcknowledgementRequest(Some(unknown)))
      ) shouldBe Status.Code.PERMISSION_DENIED
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
      val auction = service(Unreachable, faq = faq)
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
      val auction = service(Unreachable, faq = faq)
      auction.getFaqAcknowledgement(wire.GetFaqAcknowledgementRequest(Some(viewer))).failed.futureValue shouldBe failure
      auction.acknowledgeFaq(wire.AcknowledgeFaqRequest(Some(viewer))).failed.futureValue shouldBe failure
    }

    "refuses a bid from a viewer without the right to bid before reaching the lot" in {
      val withoutAuction = Seq(
        Seq.empty,
        Seq(AccessRightMessage.ACCESS_RIGHT_ACCESS_HUB),
        Seq(
          AccessRightMessage.ACCESS_RIGHT_ACCESS_HUB,
          AccessRightMessage.ACCESS_RIGHT_MANAGE_MEMBERS,
          AccessRightMessage.ACCESS_RIGHT_MANAGE_MEETUPS,
          AccessRightMessage.ACCESS_RIGHT_ADMIT_BIDDERS,
          AccessRightMessage.ACCESS_RIGHT_GRANT_ADMINS,
          AccessRightMessage.ACCESS_RIGHT_RUN_AUCTIONS
        )
      )
      withoutAuction.foreach { rights =>
        val request = validBid.withViewer(viewer.withRights(rights))
        statusOf(service(Unreachable).placeBid(request)) shouldBe Status.Code.PERMISSION_DENIED
      }
    }

    "refuses a bid and a proxy limit to a holder of every administrative right without the right to bid" in {
      val administrative = viewer.withRights(
        Seq(
          AccessRightMessage.ACCESS_RIGHT_MANAGE_MEMBERS,
          AccessRightMessage.ACCESS_RIGHT_MANAGE_MEETUPS,
          AccessRightMessage.ACCESS_RIGHT_ADMIT_BIDDERS,
          AccessRightMessage.ACCESS_RIGHT_GRANT_ADMINS,
          AccessRightMessage.ACCESS_RIGHT_RUN_AUCTIONS
        )
      )
      statusOf(service(Unreachable).placeBid(validBid.withViewer(administrative))) shouldBe
        Status.Code.PERMISSION_DENIED
      statusOf(service(Unreachable).setProxyLimit(validLimit.withViewer(administrative))) shouldBe
        Status.Code.PERMISSION_DENIED
    }

    "refuses a malformed bid with INVALID_ARGUMENT before reaching the lot" in {
      statusOf(service(Unreachable).placeBid(validBid.clearViewer)) shouldBe Status.Code.INVALID_ARGUMENT
      statusOf(service(Unreachable).placeBid(validBid.withAmount(MoneyMessage(1, "rub")))) shouldBe
        Status.Code.INVALID_ARGUMENT
    }

    "sends the viewer's bid to the addressed lot as a participant" in {
      var seen = Option.empty[(UUID, PlaceBid, Initiator)]
      val recording = new Born {
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

    "answers DEADLINE_EXCEEDED when the lot does not tell its auction in time, without placing the bid" in {
      val silent = new Gateway {
        override def auctionOf(lotId: UUID) = Future.failed(new AskTimeoutException("no reply"))
      }
      statusOf(service(silent, names = UntouchableNames).placeBid(validBid)) shouldBe Status.Code.DEADLINE_EXCEEDED
    }

    "answers NOT_FOUND to a bid on a lot that was never drafted without asking for the name" in {
      val unborn = new Gateway {
        override def auctionOf(lotId: UUID) = Future.successful(None)
      }
      statusOf(service(unborn, names = UntouchableNames).placeBid(validBid)) shouldBe Status.Code.NOT_FOUND
    }

    "refuses a bid of a participant without a chosen name with DisplayNameNotChosen before reaching the lot" in {
      val response = service(new Born, names = Names()).placeBid(validBid).futureValue
      response.getRefused.reason.isDisplayNameNotChosen shouldBe true
    }

    "asks for the name in the auction of the lot, not in another one" in {
      val elsewhere = new Born {
        override def auctionOf(lotId: UUID) = Future.successful(Some(auctionId(2)))
      }
      val store = new Names(named) {
        override def find(auction: AuctionId, participants: Set[ParticipantId]) =
          if (auction == auctionId(2)) Future.successful(Map.empty) else super.find(auction, participants)
      }
      service(elsewhere, names = store).placeBid(validBid).futureValue.getRefused.reason.isDisplayNameNotChosen shouldBe
        true
    }

    "freezes the name after an accepted bid and leaves it free after a refused one" in {
      val refusedNames = Names(named)
      service(answering(Future.successful(Left(PlaceBidRejected.LotNotOpen))), names = refusedNames)
        .placeBid(validBid)
        .futureValue
      refusedNames.freezes shouldBe 0
      val acceptedNames = Names(named)
      service(answering(Future.successful(Right(accepted))), names = acceptedNames)
        .placeBid(validBid)
        .futureValue
        .getAccepted
        .bidId shouldBe bid(7).value.toString
      acceptedNames.frozen shouldBe Set(ViewerId)
    }

    "repeats a failing freeze and answers the accepted bid when a later attempt succeeds" in {
      val store = Names(named, failingFreezes = AuctionGrpcService.FreezeAttempts - 1)
      service(answering(Future.successful(Right(accepted))), names = store)
        .placeBid(validBid)
        .futureValue
        .outcome
        .isAccepted shouldBe true
      store.freezes shouldBe AuctionGrpcService.FreezeAttempts
      store.frozen shouldBe Set(ViewerId)
    }

    "answers the accepted bid even when every freeze attempt fails, and stops after the last attempt" in {
      val store = Names(named, failingFreezes = Int.MaxValue)
      service(answering(Future.successful(Right(accepted))), names = store)
        .placeBid(validBid)
        .futureValue
        .outcome
        .isAccepted shouldBe true
      store.freezes shouldBe AuctionGrpcService.FreezeAttempts
      store.frozen shouldBe empty
    }

    "writes exhausted freeze attempts as one event with the call's request_id and without the exception message" in {
      val appender = new ListAppender[ILoggingEvent]()
      val logger = serviceLogger
      appender.start()
      logger.addAppender(appender)
      try {
        val store = Names(named, failingFreezes = Int.MaxValue)
        service(answering(Future.successful(Right(accepted))), names = store)
          .within(Correlation(Some("req-7"), Some("place_bid")))
          .placeBid(validBid)
          .futureValue
          .outcome
          .isAccepted shouldBe true
        val events = appender.list.asScala.toList
        events should have size 1
        val entry = events.head.getArgumentArray.head.toString
        entry should include(s"operation=${AuctionGrpcService.FreezeOperation}")
        entry should include("request_id=req-7")
        entry should include("use_case=place_bid")
        entry should include("error=java.lang.IllegalStateException")
        entry should not include "database is down"
      } finally {
        logger.detachAppender(appender)
        appender.stop()
      }
    }

    "answers a catalog command from a non-administrator with NotAdmin before touching the store" in {
      val upload = wire.LotImageUpload(ByteString.copyFrom(Array[Byte](0xff.toByte, 0xd8.toByte, 0xff.toByte)))
      val request = wire.CreateLotCardRequest(Some(viewer), lot, "Лот", "", Some(upload))
      service(Unreachable).createLotCard(request).futureValue.getRefused.reason.isNotAdmin shouldBe true
      val edit = wire.EditLotCardRequest(Some(viewer), lot, "Лот", "").withReplaceImage(upload)
      service(Unreachable).editLotCard(edit).futureValue.getRefused.reason.isNotAdmin shouldBe true
    }

    "answers an oversized image from an administrator with the limit before touching the store" in {
      val admin = viewer.addRights(AccessRightMessage.ACCESS_RIGHT_RUN_AUCTIONS)
      val oversized = wire.LotImageUpload(ByteString.copyFrom(Array.fill[Byte](LotImage.MaxBytes + 1)(0)))
      val edit = wire.EditLotCardRequest(Some(admin), lot, "Лот", "").withReplaceImage(oversized)
      service(Unreachable).editLotCard(edit).futureValue.getRefused.reason.imageTooLarge shouldBe
        Some(wire.ImageTooLarge(LotImage.MaxBytes.toLong))
    }

    "refuses to edit the card of a closed lot before touching the store" in {
      val admin = viewer.addRights(AccessRightMessage.ACCESS_RIGHT_RUN_AUCTIONS)
      val commands = LotCatalogCommands(UntouchableStore, _ => Future.successful(CardStanding.Closed))
      val edit = wire.EditLotCardRequest(Some(admin), lot, "Новое", "текст")
      service(Unreachable, commands).editLotCard(edit).futureValue.getRefused.reason.isCardClosed shouldBe true
    }

    "answers DEADLINE_EXCEEDED when the lot does not answer an edit and leaves the card" in {
      val admin = viewer.addRights(AccessRightMessage.ACCESS_RIGHT_RUN_AUCTIONS)
      val commands =
        LotCatalogCommands(UntouchableStore, _ => Future.failed(new java.util.concurrent.TimeoutException("ask")))
      val edit = wire.EditLotCardRequest(Some(admin), lot, "Новое", "")
      statusOf(service(Unreachable, commands).editLotCard(edit)) shouldBe Status.Code.DEADLINE_EXCEEDED
    }

    "refuses an image read from a viewer without the right to bid or of a wrong form before the read model" in {
      val hubOnly = Some(viewer.withRights(Seq(AccessRightMessage.ACCESS_RIGHT_ACCESS_HUB)))
      statusOf(service(Unreachable).getLotImage(wire.GetLotImageRequest(hubOnly, lot))) shouldBe
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

    "refuses a proxy limit and its withdrawal from a viewer without the right to bid before reaching the lot" in {
      val hubOnly = viewer.withRights(Seq(AccessRightMessage.ACCESS_RIGHT_ACCESS_HUB))
      statusOf(
        service(Unreachable).setProxyLimit(validLimit.withViewer(hubOnly))
      ) shouldBe Status.Code.PERMISSION_DENIED
      statusOf(service(Unreachable).withdrawProxyLimit(validWithdrawal.withViewer(hubOnly))) shouldBe
        Status.Code.PERMISSION_DENIED
    }

    "refuses a malformed proxy limit with INVALID_ARGUMENT before reaching the lot" in {
      statusOf(service(Unreachable).setProxyLimit(validLimit.clearMax)) shouldBe Status.Code.INVALID_ARGUMENT
      statusOf(service(Unreachable).withdrawProxyLimit(validWithdrawal.withOpId("x"))) shouldBe
        Status.Code.INVALID_ARGUMENT
    }

    "sends the viewer's proxy limit to the addressed lot as the participant's own limit" in {
      var seen = Option.empty[(UUID, SetProxyLimit, Initiator)]
      val recording = new Born {
        override def setProxyLimit(lotId: UUID, command: SetProxyLimit, initiator: Initiator) = {
          seen = Some((lotId, command, initiator))
          Future.successful(Left(SetProxyLimitRejected.ProxyBelowCurrentPrice(money(150))))
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
      val missing = new Born {
        override def setProxyLimit(lotId: UUID, command: SetProxyLimit, initiator: Initiator) =
          Future.successful(Left(SetProxyLimitRejected.LotNotFound))
      }
      statusOf(service(missing).setProxyLimit(validLimit)) shouldBe Status.Code.NOT_FOUND
    }

    "refuses a proxy limit of a participant without a chosen name with DisplayNameNotChosen before reaching the lot" in {
      val response = service(new Born, names = Names()).setProxyLimit(validLimit).futureValue
      response.getRefused.reason.isDisplayNameNotChosen shouldBe true
    }

    "freezes the name after an accepted proxy limit and leaves it free after a refused one" in {
      def limiting(outcome: Either[SetProxyLimitRejected, LotEntity.Recorded]) = new Born {
        override def setProxyLimit(lotId: UUID, command: SetProxyLimit, initiator: Initiator) =
          Future.successful(outcome)
      }
      val refusedNames = Names(named)
      service(limiting(Left(SetProxyLimitRejected.ProxyBelowCurrentPrice(money(150)))), names = refusedNames)
        .setProxyLimit(validLimit)
        .futureValue
      refusedNames.freezes shouldBe 0
      val set = Envelope(5, LotFixtures.op(2), LotEvent.ProxyLimitSet(participant(1), money(200)))
      val acceptedNames = Names(named)
      service(limiting(Right(LotEntity.Recorded(set, lotVersion = 6))), names = acceptedNames)
        .setProxyLimit(validLimit)
        .futureValue
        .getAccepted
        .lotVersion shouldBe 6L
      acceptedNames.frozen shouldBe Set(ViewerId)
    }

    "refuses a read from a viewer without the right to bid before touching the read model" in {
      val hubOnly = Some(viewer.withRights(Seq(AccessRightMessage.ACCESS_RIGHT_ACCESS_HUB)))
      statusOf(service(Unreachable).getLot(wire.GetLotRequest(hubOnly, lot))) shouldBe Status.Code.PERMISSION_DENIED
      statusOf(service(Unreachable).listAuctionLots(wire.ListAuctionLotsRequest(hubOnly, lot))) shouldBe
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

    "shows the administrator the lots of the console with their bids, the mark, the held finalist and the overdue lot" in {
      val meetupAuction = Auction.idOf(MeetupId(UUID.fromString(meetupId))).value
      val (marked, late, finalist) = (new UUID(7L, 1L), new UUID(7L, 2L), new UUID(7L, 3L))
      val registry = new Views {
        override def registryPage(auctionId: UUID, after: Option[UUID], limit: Int) =
          Future.successful(
            List(
              LotSnapshotView(
                marked,
                auctionId,
                4,
                trading(price = 300, closesAt = Some(deadline.plusSeconds(3600)), markedForFinal = true),
                None,
                bidCount = 3
              ),
              LotSnapshotView(late, auctionId, 2, trading(price = 100, closesAt = Some(deadline)), None),
              LotSnapshotView(finalist, auctionId, 6, held(price = 500, leader = participant(2)), None, bidCount = 4)
            )
          )
      }
      val meetups: MeetupAuthority = (_, _, _) => Future.successful(Authority.Granted(Standings.published))
      val console = service(
        Unreachable,
        views = registry,
        auctions = AuctionCommands(consoleOf(marked, late, finalist), Unreachable, meetups),
        clock = Clock.fixed(deadline.plusSeconds(600), java.time.ZoneOffset.UTC)
      ).getAuctionConsole(wire.GetAuctionConsoleRequest(Some(viewer), meetupAuction.toString)).futureValue.getConsole

      console.getAuction.status.isPrebidding shouldBe true
      console.lots.map(entry => (entry.getLot.id, entry.getLot.bidCount, entry.markedForFinal, entry.overdue)) shouldBe
        Seq((marked.toString, 3L, true, false), (late.toString, 0L, false, true), (finalist.toString, 4L, true, false))
    }

    "refuses the console to a viewer whom the meetup does not confirm and reads no lot" in {
      val meetupAuction = Auction.idOf(MeetupId(UUID.fromString(meetupId))).value
      val stranger: MeetupAuthority = (_, _, _) => Future.successful(Authority.NotAdministrator)
      service(
        Unreachable,
        auctions = AuctionCommands(consoleOf(new UUID(7L, 1L), new UUID(7L, 2L)), Unreachable, stranger)
      ).getAuctionConsole(wire.GetAuctionConsoleRequest(Some(viewer), meetupAuction.toString))
        .futureValue
        .getRefused
        .reason
        .isNotMeetupAdministrator shouldBe true
    }

    "answers NOT_FOUND for the console of an auction without a journal, before asking meetups" in {
      val meetupAuction = Auction.idOf(MeetupId(UUID.fromString(meetupId))).value
      val absent = new Auctions {
        override def get(auctionId: AuctionId) = Future.successful(Auction.initial)
      }
      statusOf(
        service(Unreachable, auctions = AuctionCommands(absent, Unreachable, NoMeetups))
          .getAuctionConsole(wire.GetAuctionConsoleRequest(Some(viewer), meetupAuction.toString))
      ) shouldBe Status.Code.NOT_FOUND
    }

    "answers a mark after the deadline with the DeadlinePassed refusal, not with a status" in {
      val meetupAuction = Auction.idOf(MeetupId(UUID.fromString(meetupId))).value
      val late = new Auctions {
        override def inspect(auctionId: AuctionId, opId: OpId) =
          Future.successful(Inspection.Present(MeetupId(UUID.fromString(meetupId)), registryOpen = false))
        override def selectForFinal(auctionId: AuctionId, command: SelectForFinal, initiator: Initiator) =
          Future.successful(Left(FinalChoiceRejected.ByLot(MarkForFinalRejected.DeadlinePassed)))
        override def deselectForFinal(auctionId: AuctionId, command: DeselectForFinal, initiator: Initiator) =
          Future.successful(Left(FinalChoiceRejected.ByLot(UnmarkForFinalRejected.DeadlinePassed)))
      }
      val granted: MeetupAuthority = (_, _, _) => Future.successful(Authority.Granted(Standings.published))
      val auction = service(Unreachable, auctions = AuctionCommands(late, Unreachable, granted))
      auction
        .selectForFinal(wire.SelectForFinalRequest(Some(viewer), meetupAuction.toString, lot, op))
        .futureValue
        .getRefused
        .reason
        .isDeadlinePassed shouldBe true
      auction
        .deselectForFinal(wire.DeselectForFinalRequest(Some(viewer), meetupAuction.toString, lot, op))
        .futureValue
        .getRefused
        .reason
        .isDeadlinePassed shouldBe true
    }

    "carries the bid count of the read model in the snapshot of a lot" in {
      val counted = new Views {
        override def find(lotId: UUID) =
          Future.successful(
            Some(LotSnapshotView(lotId, auctionId(1).value, 3, trading(price = 120), None, bidCount = 2))
          )
      }
      service(Unreachable, views = counted)
        .getLot(wire.GetLotRequest(Some(viewer), lot))
        .futureValue
        .bidCount shouldBe 2
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

    "refuses a history read without the right to bid or with a forged token before touching the read model" in {
      val hubOnly = Some(viewer.withRights(Seq(AccessRightMessage.ACCESS_RIGHT_ACCESS_HUB)))
      val auction = service(Unreachable)
      statusOf(auction.listLotHistory(wire.ListLotHistoryRequest(hubOnly, lot))) shouldBe Status.Code.PERMISSION_DENIED
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
      val granted: MeetupAuthority = (_, _, _) => Future.successful(Authority.Granted(Standings.published))
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
      // Корень аукциона читает только аукцион сходки, UUIDv5.
      statusOf(auction.getAuction(wire.GetAuctionRequest(Some(viewer), lot))) shouldBe Status.Code.INVALID_ARGUMENT
    }

    "answers an auction by id, showing a draft to the hub bot only" in {
      val meetup = MeetupId(UUID.fromString(meetupId))
      val id = Auction.idOf(meetup).value
      def views(state: AuctionState) = new AuctionViews {
        def byId(auctionId: UUID) =
          Future.successful(
            Option.when(auctionId == id)(AuctionSnapshotView(id, Auction(state, Some(meetup), Set.empty, Map.empty)))
          )
        def byMeetup(meetup: MeetupId) = fail("a meetup auction was read")
        def page(listing: AuctionListing, after: Option[UUID], limit: Int) = fail("a list was read")
      }
      def read(state: AuctionState, caller: Option[Caller], auction: String = id.toString) =
        service(Unreachable, auctionViews = views(state), caller = caller)
          .getAuction(wire.GetAuctionRequest(Some(viewer), auction))
          .futureValue
          .auction
      read(AuctionState.Draft, Some(Caller.HubBot)).map(_.status.isDraft) shouldBe Some(true)
      read(AuctionState.Draft, Some(Caller.AuctionBot)) shouldBe None
      read(AuctionState.Draft, None) shouldBe None
      val scheduled = AuctionState.Scheduled(AuctionFixtures.config())
      read(scheduled, Some(Caller.AuctionBot)).map(_.id) shouldBe Some(id.toString)
      read(scheduled, Some(Caller.HubBot)).map(_.id) shouldBe Some(id.toString)
      val other = Auction.idOf(MeetupId(UUID.fromString(lot))).value.toString
      read(scheduled, Some(Caller.HubBot), other) shouldBe None
    }

    "answers a meetup without an auction with an empty response, not an error" in {
      val none = new AuctionViews {
        def byId(auctionId: UUID): Future[Option[AuctionSnapshotView]] = fail("an auction was read by id")
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
        def byId(auctionId: UUID): Future[Option[AuctionSnapshotView]] = fail("an auction was read by id")
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
      val granted: MeetupAuthority = (_, _, _) => Future.successful(Authority.Granted(Standings.published))
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

    "sends the conditions of a lot through the auction and answers its refusals as values" in {
      val meetup = MeetupId(UUID.fromString(meetupId))
      val auctionId = Auction.idOf(meetup).value.toString
      var received = List.empty[ScheduleAuctionLot]
      var answer: Either[ScheduleAuctionLotRejected, Unit] = Right(())
      val present = new Auctions {
        override def inspect(auctionId: AuctionId, opId: OpId) =
          Future.successful(Inspection.Present(meetup, registryOpen = true))
        override def scheduleLot(auctionId: AuctionId, command: ScheduleAuctionLot, initiator: Initiator) = {
          received :+= command
          Future.successful(answer)
        }
      }
      val granted: MeetupAuthority = (_, _, _) => Future.successful(Authority.Granted(Standings.published))
      val auction = service(Unreachable, auctions = AuctionCommands(present, Unreachable, granted))
      val request = wire.ScheduleLotRequest(
        Some(viewer),
        auctionId,
        lot,
        op,
        Some(MoneyMessage(500000, "RUB")),
        Some(StepPolicyMessage(StepPolicyMessage.Policy.Fixed(MoneyMessage(25000, "RUB"))))
      )

      auction.scheduleLot(request).futureValue.outcome.isAccepted shouldBe true
      received shouldBe List(
        ScheduleAuctionLot(
          LotId(UUID.fromString(lot)),
          Money(500000, CurrencyCode("RUB")),
          StepPolicyInput.Fixed(Money(25000, CurrencyCode("RUB"))),
          OpId(UUID.fromString(op))
        )
      )
      answer = Left(ScheduleAuctionLotRejected.LotsFrozen)
      auction.scheduleLot(request).futureValue.getRefused.reason.isLotsFrozen shouldBe true
      answer = Left(ScheduleAuctionLotRejected.LotNotInAuction)
      auction.scheduleLot(request).futureValue.getRefused.reason.isLotNotInAuction shouldBe true
      answer = Left(ScheduleAuctionLotRejected.ByLot(ScheduleLotRejected.SchedulingClosed))
      auction.scheduleLot(request).futureValue.getRefused.reason.isSchedulingClosed shouldBe true
      answer = Left(ScheduleAuctionLotRejected.ByLot(ScheduleLotRejected.OpIdTaken))
      statusOf(auction.scheduleLot(request)) shouldBe Status.Code.ALREADY_EXISTS
    }

    "refuses the conditions of a lot by a viewer meetups does not confirm, as a value and without the auction" in {
      val meetup = MeetupId(UUID.fromString(meetupId))
      val present = new Auctions {
        override def inspect(auctionId: AuctionId, opId: OpId) =
          Future.successful(Inspection.Present(meetup, registryOpen = true))
      }
      val denied: MeetupAuthority = (_, _, _) => Future.successful(Authority.NotAdministrator)
      service(Unreachable, auctions = AuctionCommands(present, Unreachable, denied))
        .scheduleLot(
          wire.ScheduleLotRequest(
            Some(viewer),
            Auction.idOf(meetup).value.toString,
            lot,
            op,
            Some(MoneyMessage(500000, "RUB")),
            Some(StepPolicyMessage(StepPolicyMessage.Policy.Fixed(MoneyMessage(25000, "RUB"))))
          )
        )
        .futureValue
        .getRefused
        .reason
        .isNotMeetupAdministrator shouldBe true
    }

    "refuses the conditions of a lot without a price or a step before asking the auction" in {
      val auctionId = Auction.idOf(MeetupId(UUID.fromString(meetupId))).value.toString
      val auction = service(Unreachable)
      val price = Some(MoneyMessage(500000, "RUB"))
      val step = Some(StepPolicyMessage(StepPolicyMessage.Policy.Fixed(MoneyMessage(25000, "RUB"))))
      statusOf(auction.scheduleLot(wire.ScheduleLotRequest(Some(viewer), auctionId, lot, op, None, step))) shouldBe
        Status.Code.INVALID_ARGUMENT
      statusOf(auction.scheduleLot(wire.ScheduleLotRequest(Some(viewer), auctionId, lot, op, price, None))) shouldBe
        Status.Code.INVALID_ARGUMENT
      statusOf(
        auction.scheduleLot(wire.ScheduleLotRequest(Some(viewer), auctionId, lot, op, price, Some(StepPolicyMessage())))
      ) shouldBe Status.Code.INVALID_ARGUMENT
      // Условия задаются только лоту аукциона сходки, UUIDv5.
      statusOf(auction.scheduleLot(wire.ScheduleLotRequest(Some(viewer), lot, lot, op, price, step))) shouldBe
        Status.Code.INVALID_ARGUMENT
    }

    "answers a scheduled auction and an auction in prebidding with their config and status" in {
      val meetup = MeetupId(UUID.fromString(meetupId))
      val id = Auction.idOf(meetup).value
      def read(state: AuctionState): wire.AuctionSnapshot = {
        val views = new AuctionViews {
          def byId(auctionId: UUID): Future[Option[AuctionSnapshotView]] = fail("an auction was read by id")
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

    "refuses name requests of a wrong form or without the right to bid before the store" in {
      val auction = service(Unreachable, names = UntouchableNames)
      val choose = wire.ChooseDisplayNameRequest(Some(viewer), lot).withAlias("Кот")
      val hubOnly = viewer.withRights(Seq(AccessRightMessage.ACCESS_RIGHT_ACCESS_HUB))
      statusOf(auction.chooseDisplayName(choose.withViewer(hubOnly))) shouldBe Status.Code.PERMISSION_DENIED
      statusOf(auction.chooseDisplayName(choose.clearChoice)) shouldBe Status.Code.INVALID_ARGUMENT
      statusOf(auction.chooseDisplayName(choose.withAuctionId("auction"))) shouldBe Status.Code.INVALID_ARGUMENT
      // Непустая строка, какой Telegram ником не присылает, — форма, а не отказ выбора.
      statusOf(auction.chooseDisplayName(choose.withTelegramUsername("not a nick"))) shouldBe
        Status.Code.INVALID_ARGUMENT
      val names = wire.GetDisplayNamesRequest(Some(viewer), lot, Seq(identity))
      statusOf(auction.getDisplayNames(names.withViewer(hubOnly))) shouldBe Status.Code.PERMISSION_DENIED
      statusOf(auction.getDisplayNames(names.withParticipantIds(Seq("someone")))) shouldBe Status.Code.INVALID_ARGUMENT
    }

    "answers a chosen name ready to show and each refusal of the choice as a value" in {
      val other = ParticipantId(UUID.fromString(lot))
      val taken = Map(other -> ChosenName.Pseudonym(Alias("Пёс").getOrElse(fail("not an alias"))))
      val auction = service(Unreachable, names = Names(taken))
      val choose = wire.ChooseDisplayNameRequest(Some(viewer), lot)
      auction.chooseDisplayName(choose.withAlias("Кот")).futureValue.getAccepted shouldBe
        wire.DisplayName("Кот*", wire.DisplayNameKind.DISPLAY_NAME_KIND_ALIAS)
      auction.chooseDisplayName(choose.withTelegramUsername("vasya")).futureValue.getAccepted shouldBe
        wire.DisplayName("@vasya", wire.DisplayNameKind.DISPLAY_NAME_KIND_TELEGRAM_USERNAME)
      auction
        .chooseDisplayName(choose.withTelegramUsername(""))
        .futureValue
        .getRefused
        .reason
        .isUsernameMissing shouldBe
        true
      auction.chooseDisplayName(choose.withAlias("К*т")).futureValue.getRefused.reason.isAliasInvalid shouldBe true
      auction.chooseDisplayName(choose.withAlias("пёс")).futureValue.getRefused.reason.isAliasTaken shouldBe true
    }

    "refuses another name after the freeze and accepts the same one again" in {
      val store = Names(named)
      val auction = service(answering(Future.successful(Right(accepted))), names = store)
      auction.placeBid(validBid).futureValue.outcome.isAccepted shouldBe true
      val choose = wire.ChooseDisplayNameRequest(Some(viewer), lot)
      auction.chooseDisplayName(choose.withAlias("Кот")).futureValue.getRefused.reason.isNameFrozen shouldBe true
      auction.chooseDisplayName(choose.withTelegramUsername("vasya")).futureValue.getAccepted shouldBe
        wire.DisplayName("@vasya", wire.DisplayNameKind.DISPLAY_NAME_KIND_TELEGRAM_USERNAME, frozen = true)
      auction
        .getDisplayNames(wire.GetDisplayNamesRequest(Some(viewer), lot, Seq(identity)))
        .futureValue
        .names(identity)
        .frozen shouldBe true
    }

    "answers every requested participant and a placeholder for one without a choice" in {
      val silent = "01890a5d-ac96-774b-bcce-b302099a8999"
      val answer = service(Unreachable)
        .getDisplayNames(wire.GetDisplayNamesRequest(Some(viewer), lot, Seq(identity, silent, identity)))
        .futureValue
      answer.names.keySet shouldBe Set(identity, silent)
      answer
        .names(identity) shouldBe wire.DisplayName("@vasya", wire.DisplayNameKind.DISPLAY_NAME_KIND_TELEGRAM_USERNAME)
      answer.names(silent).kind shouldBe wire.DisplayNameKind.DISPLAY_NAME_KIND_PLACEHOLDER
      answer.names(silent).text shouldBe "Участник 8999"
    }

    "refuses the auction names to a viewer who may not run auctions before the store" in {
      val auction = service(Unreachable, names = UntouchableNames)
      val names = wire.ListAuctionNamesRequest(Some(viewer), lot)
      statusOf(auction.listAuctionNames(names)) shouldBe Status.Code.PERMISSION_DENIED
    }

    "rejects a malformed auction id in the auction names request" in {
      val auction = service(Unreachable, names = UntouchableNames)
      val assistant = viewer.withRights(Seq(AccessRightMessage.ACCESS_RIGHT_RUN_AUCTIONS))
      val names = wire.ListAuctionNamesRequest(Some(assistant), "auction")
      statusOf(auction.listAuctionNames(names)) shouldBe Status.Code.INVALID_ARGUMENT
    }

    "answers the assistant the names of bidders only, final bidders first and the latest first" in {
      def participant(tail: String) = ParticipantId(UUID.fromString(s"01890a5d-ac96-774b-bcce-b302099a$tail"))
      def alias(raw: String) = ChosenName.Pseudonym(Alias(raw).getOrElse(fail("not an alias")))
      val (bid, barred, silent) = (participant("8001"), participant("8002"), participant("8003"))
      val chosen = Map(bid -> alias("Боря"), barred -> alias("Аня"), silent -> alias("Вера"))
      val assistant = viewer.withRights(Seq(AccessRightMessage.ACCESS_RIGHT_RUN_AUCTIONS))
      val holds: ParticipantId => Future[Boolean] = {
        case id if id == bid => Future.successful(true)
        case id if id == barred => Future.successful(false)
        case _ => Future.failed(IllegalStateException("identity is down"))
      }
      val moments = Map(
        bid -> Instant.parse("2026-10-18T20:00:00Z"),
        silent -> Instant.parse("2026-10-18T19:00:00Z")
      )
      val answer = service(
        Unreachable,
        names = Names(chosen),
        placeBidsRight = holds,
        finalBids = new FinalBids {
          def lastBids(auction: AuctionId) = Future.successful(moments)
        }
      ).listAuctionNames(wire.ListAuctionNamesRequest(Some(assistant), lot)).futureValue

      // Заблокированного Identity в списке нет, а не ответившего — есть; ставившие в финале идут сверху.
      answer.names.map(name => name.participantId -> name.name.map(_.text)) shouldBe Seq(
        bid.value.toString -> Some("Боря*"),
        silent.value.toString -> Some("Вера*")
      )
    }

    "answers an empty list for an auction without chosen names" in {
      val assistant = viewer.withRights(Seq(AccessRightMessage.ACCESS_RIGHT_RUN_AUCTIONS))
      service(Unreachable, names = Names(Map.empty))
        .listAuctionNames(wire.ListAuctionNamesRequest(Some(assistant), lot))
        .futureValue
        .names shouldBe empty
    }

    "answers the administrator the statistics of every lot of the registry" in {
      val meetupAuction = Auction.idOf(MeetupId(UUID.fromString(meetupId))).value
      val (busy, quiet) = (new UUID(7L, 1L), new UUID(7L, 2L))
      val lastBid = deadline.minusSeconds(60)
      val read = new Views {
        override def statistics(auctionId: UUID) =
          if (auctionId != meetupAuction) fail(s"statistics of $auctionId")
          else
            Future.successful(
              List(
                LotStatisticsView(busy, trading(price = 450), Some(money(300)), 5, 3, Some(lastBid)),
                LotStatisticsView(quiet, trading(price = 300), Some(money(300)), 0, 1, None)
              )
            )
      }
      val granted: MeetupAuthority = (_, _, _) => Future.successful(Authority.Granted(Standings.published))
      val lots = service(
        Unreachable,
        views = read,
        auctions = AuctionCommands(consoleOf(busy, quiet), Unreachable, granted)
      ).getAuctionLotStatistics(wire.GetAuctionLotStatisticsRequest(Some(viewer), meetupAuction.toString))
        .futureValue
        .getStatistics
        .lots

      lots.map(lot => (lot.lotId, lot.bidCount, lot.uniqueParticipantCount, lot.priceGrowth, lot.lastBidAt)) shouldBe
        Seq(
          (busy.toString, 5L, 3L, Some(LotValues.money(money(150))), Some(lastBid.toString)),
          (quiet.toString, 0L, 1L, Some(LotValues.money(money(0))), None)
        )
    }

    "refuses the statistics to a viewer whom the meetup does not confirm and reads no lot" in {
      val meetupAuction = Auction.idOf(MeetupId(UUID.fromString(meetupId))).value
      val stranger: MeetupAuthority = (_, _, _) => Future.successful(Authority.NotAdministrator)
      service(Unreachable, auctions = AuctionCommands(consoleOf(new UUID(7L, 1L)), Unreachable, stranger))
        .getAuctionLotStatistics(wire.GetAuctionLotStatisticsRequest(Some(viewer), meetupAuction.toString))
        .futureValue
        .getRefused
        .reason
        .isNotMeetupAdministrator shouldBe true
    }

    "answers UNAVAILABLE on the statistics when meetups cannot confirm the administrator" in {
      val meetupAuction = Auction.idOf(MeetupId(UUID.fromString(meetupId))).value
      val silent: MeetupAuthority = (_, _, _) => Future.successful(Authority.Unavailable)
      statusOf(
        service(Unreachable, auctions = AuctionCommands(consoleOf(new UUID(7L, 1L)), Unreachable, silent))
          .getAuctionLotStatistics(wire.GetAuctionLotStatisticsRequest(Some(viewer), meetupAuction.toString))
      ) shouldBe Status.Code.UNAVAILABLE
    }

    "answers NOT_FOUND for the statistics of an auction without a journal, before asking meetups" in {
      val meetupAuction = Auction.idOf(MeetupId(UUID.fromString(meetupId))).value
      val absent = new Auctions {
        override def get(auctionId: AuctionId) = Future.successful(Auction.initial)
      }
      statusOf(
        service(Unreachable, auctions = AuctionCommands(absent, Unreachable, NoMeetups))
          .getAuctionLotStatistics(wire.GetAuctionLotStatisticsRequest(Some(viewer), meetupAuction.toString))
      ) shouldBe Status.Code.NOT_FOUND
    }

    "answers INVALID_ARGUMENT on statistics without a viewer or an auction, before the auction" in {
      statusOf(service(Unreachable).getAuctionLotStatistics(wire.GetAuctionLotStatisticsRequest())) shouldBe
        Status.Code.INVALID_ARGUMENT
    }

    "answers UNIMPLEMENTED on invoices until the invoice slice" in {
      val auction = service(Unreachable)
      statusOf(auction.markInvoicePaid(wire.MarkInvoicePaidRequest())) shouldBe Status.Code.UNIMPLEMENTED
      statusOf(auction.markInvoiceHandedOver(wire.MarkInvoiceHandedOverRequest())) shouldBe Status.Code.UNIMPLEMENTED
      statusOf(auction.chooseFulfillment(wire.ChooseFulfillmentRequest())) shouldBe Status.Code.UNIMPLEMENTED
      statusOf(auction.listMyInvoices(wire.ListMyInvoicesRequest())) shouldBe Status.Code.UNIMPLEMENTED
      statusOf(auction.listAuctionInvoices(wire.ListAuctionInvoicesRequest())) shouldBe Status.Code.UNIMPLEMENTED
    }

    "refuses a malformed closing of the auctioneer before reaching meetups or the auction" in {
      statusOf(service(Unreachable).closeLot(wire.CloseLotRequest())) shouldBe Status.Code.INVALID_ARGUMENT
    }

    "answers the closing of the auctioneer with the sale, the closing without a sale and the refusals as values" in {
      val answers = new java.util.concurrent.ConcurrentLinkedQueue[Either[CloseAuctionLotRejected, LotEnding]]()
      val closing = new Auctions {
        override def inspect(auctionId: AuctionId, opId: OpId) =
          Future.successful(Inspection.Present(MeetupId(UUID.fromString(meetupId)), registryOpen = false))
        override def closeLot(auctionId: AuctionId, command: CloseAuctionLot, initiator: Initiator) =
          Future.successful(answers.poll())
      }
      val auction = service(Unreachable, auctions = AuctionCommands(closing, Unreachable, granted))
      val request = wire.CloseLotRequest(Some(viewer), meetupAuctionId, lot, op)
      val sale =
        Sale(RoomId, Money(150, CurrencyCode("RUB")), BidId(UUID.fromString(op)), Instant.parse("2026-10-13T10:00:00Z"))
      answers.add(Right(LotEnding.Sold(sale)))
      val sold = auction.closeLot(request).futureValue.getAccepted.getSold
      sold.winnerId shouldBe RoomId.value.toString
      sold.price.map(_.minorUnits) shouldBe Some(150)
      sold.soldAt shouldBe "2026-10-13T10:00:00Z"

      answers.add(Right(LotEnding.Unsold(UnsoldReason.NoBids)))
      auction.closeLot(request).futureValue.getAccepted.result.isUnsold shouldBe true
      answers.add(Left(CloseAuctionLotRejected.LotNotOpen))
      auction.closeLot(request).futureValue.getRefused.reason.isLotNotOpen shouldBe true
      answers.add(Left(CloseAuctionLotRejected.DeadlineNotReached))
      auction.closeLot(request).futureValue.getRefused.reason.isDeadlineNotReached shouldBe true
      answers.add(Left(CloseAuctionLotRejected.LotNotInAuction))
      auction.closeLot(request).futureValue.getRefused.reason.isLotNotInAuction shouldBe true
      answers.add(Left(CloseAuctionLotRejected.OpIdTaken))
      statusOf(auction.closeLot(request)) shouldBe Status.Code.ALREADY_EXISTS

      val stranger: MeetupAuthority = (_, _, _) => Future.successful(Authority.NotAdministrator)
      service(Unreachable, auctions = AuctionCommands(closing, Unreachable, stranger))
        .closeLot(request)
        .futureValue
        .getRefused
        .reason
        .isNotMeetupAdministrator shouldBe true
    }

    "answers the ask of the auctioneer after the right and the registry, with the operator on the lot" in {
      val asked = new java.util.concurrent.atomic.AtomicReference[Option[Initiator]](None)
      val auctions = askingThrough(UUID.fromString(lot)) { (command, initiator) =>
        asked.set(Some(initiator))
        if (command.newAsk.minorUnits > 1000) Right(())
        else Left(AdvanceAskRejected.AskBelowCurrentPrice(Money(1000, CurrencyCode("RUB"))))
      }
      val auction = service(Unreachable, auctions = AuctionCommands(auctions, Unreachable, granted))
      val request = wire.AdvanceAskRequest(Some(viewer), meetupAuctionId, lot, op, Some(MoneyMessage(1500, "RUB")))

      auction.advanceAsk(request).futureValue shouldBe
        wire.AdvanceAskResponse().withAccepted(wire.AskAdvanceAccepted())
      asked.get shouldBe Some(Initiator.Operator(ViewerId))
      auction.advanceAsk(request.withNewAsk(MoneyMessage(900, "RUB"))).futureValue shouldBe
        wire
          .AdvanceAskResponse()
          .withRefused(
            wire.AdvanceAskRefusal(
              wire.AdvanceAskRefusal.Reason.AskBelowCurrentPrice(
                wire.AskBelowCurrentPrice(Some(MoneyMessage(1000, "RUB")))
              )
            )
          )
    }

    "refuses the ask of a stranger and of a lot outside the registry without reaching the lot" in {
      val request = wire.AdvanceAskRequest(Some(viewer), meetupAuctionId, lot, op, Some(MoneyMessage(1500, "RUB")))
      val stranger: MeetupAuthority = (_, _, _) => Future.successful(Authority.NotAdministrator)
      val unreached = (_: AdvanceAsk, _: Initiator) => fail("the lot was reached")

      service(
        Unreachable,
        auctions = AuctionCommands(askingThrough(UUID.fromString(lot))(unreached), Unreachable, stranger)
      )
        .advanceAsk(request)
        .futureValue shouldBe
        wire
          .AdvanceAskResponse()
          .withRefused(
            wire.AdvanceAskRefusal(wire.AdvanceAskRefusal.Reason.NotMeetupAdministrator(wire.NotMeetupAdministrator()))
          )
      service(Unreachable, auctions = AuctionCommands(askingThrough(new UUID(7L, 1L))(unreached), Unreachable, granted))
        .advanceAsk(request)
        .futureValue shouldBe
        wire
          .AdvanceAskResponse()
          .withRefused(wire.AdvanceAskRefusal(wire.AdvanceAskRefusal.Reason.LotNotInAuction(wire.LotNotInAuction())))
    }

    "answers INVALID_ARGUMENT on the commands of the final without a viewer, before the auction" in {
      val auction = service(Unreachable)
      statusOf(auction.freezeFinalLineup(wire.FreezeFinalLineupRequest())) shouldBe Status.Code.INVALID_ARGUMENT
      statusOf(auction.startFinal(wire.StartFinalRequest())) shouldBe Status.Code.INVALID_ARGUMENT
      statusOf(auction.startNextLot(wire.StartNextLotRequest())) shouldBe Status.Code.INVALID_ARGUMENT
      val malformed = wire.FreezeFinalLineupRequest(Some(viewer), meetupAuctionId, op, List("not-a-lot"))
      statusOf(auction.freezeFinalLineup(malformed)) shouldBe Status.Code.INVALID_ARGUMENT
    }

    "answers the commands of the final with their values: the lineup, the start and the lot of the final" in {
      val finalLot = LotId(UUID.fromString(lot))
      val running = new Auctions {
        override def inspect(auctionId: AuctionId, opId: OpId) =
          Future.successful(Inspection.Present(MeetupId(UUID.fromString(meetupId)), registryOpen = false))
        override def freezeFinalLineup(auctionId: AuctionId, command: FreezeFinalLineup, initiator: Initiator) =
          Future.successful(
            if (command.order == List(finalLot)) Right(AuctionAnswer.Unchanged)
            else Left(FreezeFinalLineupRejected.LineupMismatch(Set(finalLot)))
          )
        override def startFinal(auctionId: AuctionId, command: StartFinal, initiator: Initiator) =
          Future.successful(Left(StartFinalRejected.LineupNotFrozen))
        override def startNextLot(auctionId: AuctionId, command: StartNextLot, initiator: Initiator) =
          Future.successful(Right(finalLot))
      }
      val granted: MeetupAuthority = (_, _, _) => Future.successful(Authority.Granted(Standings.published))
      val auction = service(Unreachable, auctions = AuctionCommands(running, Unreachable, granted))
      auction
        .freezeFinalLineup(wire.FreezeFinalLineupRequest(Some(viewer), meetupAuctionId, op, List(lot)))
        .futureValue
        .outcome
        .isAccepted shouldBe true
      auction
        .freezeFinalLineup(wire.FreezeFinalLineupRequest(Some(viewer), meetupAuctionId, op, Nil))
        .futureValue
        .getRefused
        .getLineupMismatch
        .heldLotIds shouldBe List(lot)
      auction
        .startFinal(wire.StartFinalRequest(Some(viewer), meetupAuctionId, op))
        .futureValue
        .getRefused
        .reason
        .isLineupNotFrozen shouldBe true
      auction
        .startNextLot(wire.StartNextLotRequest(Some(viewer), meetupAuctionId, op))
        .futureValue
        .getAccepted
        .lotId shouldBe lot
    }

    "answers UNAVAILABLE on a lineup the auction does not know yet, so that the console repeats it" in {
      val asking = new Auctions {
        override def inspect(auctionId: AuctionId, opId: OpId) =
          Future.successful(Inspection.Present(MeetupId(UUID.fromString(meetupId)), registryOpen = false))
        override def freezeFinalLineup(auctionId: AuctionId, command: FreezeFinalLineup, initiator: Initiator) =
          Future.successful(Left(FreezeFinalLineupRejected.LineupUnknown))
      }
      val granted: MeetupAuthority = (_, _, _) => Future.successful(Authority.Granted(Standings.published))
      statusOf(
        service(Unreachable, auctions = AuctionCommands(asking, Unreachable, granted))
          .freezeFinalLineup(wire.FreezeFinalLineupRequest(Some(viewer), meetupAuctionId, op, List(lot)))
      ) shouldBe Status.Code.UNAVAILABLE
    }

    "places a floor bid for the person in the room, entered by the assistant with the right of the meetup" in {
      val placed = new java.util.concurrent.atomic.AtomicReference[Option[(PlaceBid, Initiator)]](None)
      val lots = new Born {
        override def placeBid(lotId: UUID, command: PlaceBid, initiator: Initiator) = {
          placed.set(Some(command -> initiator))
          Future.successful(Right(accepted))
        }
      }
      // У помощника нет права ставить: ставит человек в зале, а помощнику нужно право вести аукцион.
      val assistant = viewer.withRights(Seq(AccessRightMessage.ACCESS_RIGHT_RUN_AUCTIONS))
      val request = floorBid.withViewer(assistant)
      val asked = new java.util.concurrent.atomic.AtomicReference[List[ParticipantId]](Nil)
      val identity: ParticipantId => Future[Boolean] = participant => {
        asked.updateAndGet(_ :+ participant)
        Future.successful(true)
      }

      service(
        lots,
        auctions = AuctionCommands(registered(), Unreachable, granted),
        names = Names(roomNamed),
        placeBidsRight = identity
      )
        .placeBid(request)
        .futureValue
        .outcome
        .isAccepted shouldBe true
      placed.get shouldBe Some(
        PlaceBid(RoomId, Money(150, CurrencyCode("RUB")), OpId(UUID.fromString(op)), BidSource.Floor) ->
          Initiator.Operator(ViewerId)
      )
      asked.get shouldBe List(RoomId)
    }

    "refuses a floor bid for a person in the room without place_bids before the name and the lot" in {
      service(
        new Born,
        auctions = AuctionCommands(registered(), Unreachable, granted),
        names = Names(roomNamed),
        placeBidsRight = _ => Future.successful(false)
      )
        .placeBid(floorBid)
        .futureValue shouldBe ResponseMapping.participantCannotBid
    }

    "takes a floor bid while Identity does not answer about the person in the room" in {
      val lots = new Born {
        override def placeBid(lotId: UUID, command: PlaceBid, initiator: Initiator) =
          Future.successful(Right(accepted))
      }

      service(
        lots,
        auctions = AuctionCommands(registered(), Unreachable, granted),
        names = Names(roomNamed),
        placeBidsRight = _ => Future.failed(new IllegalStateException("identity is silent"))
      )
        .placeBid(floorBid)
        .futureValue
        .outcome
        .isAccepted shouldBe true
    }

    "names the source of a bid in the record of the operation" in {
      val lots = new Born {
        override def placeBid(lotId: UUID, command: PlaceBid, initiator: Initiator) =
          Future.successful(Right(accepted))
      }
      val floor = OperationNotes()
      val bot = OperationNotes()

      service(
        lots,
        auctions = AuctionCommands(registered(), Unreachable, granted),
        names = Names(roomNamed),
        notes = floor
      ).placeBid(floorBid).futureValue
      service(lots, notes = bot).placeBid(validBid).futureValue

      floor.all shouldBe Map("source" -> "FLOOR")
      bot.all shouldBe Map("source" -> "BOT")
    }

    "refuses a floor bid of a stranger to the meetup without reaching the lot" in {
      val stranger: MeetupAuthority = (_, _, _) => Future.successful(Authority.NotAdministrator)

      service(new Born, auctions = AuctionCommands(registered(), Unreachable, stranger))
        .placeBid(floorBid)
        .futureValue shouldBe
        wire
          .PlaceBidResponse()
          .withRefused(
            wire.PlaceBidRefusal(wire.PlaceBidRefusal.Reason.NotMeetupAdministrator(wire.NotMeetupAdministrator()))
          )
    }

    "refuses a floor bid for a person in the room without a name, though the assistant has one" in {
      service(new Born, auctions = AuctionCommands(registered(), Unreachable, granted))
        .placeBid(floorBid)
        .futureValue shouldBe ResponseMapping.displayNameNotChosen
    }

    "answers UNAVAILABLE on a floor bid while the right of the assistant cannot be checked" in {
      val silent: MeetupAuthority = (_, _, _) => Future.successful(Authority.Unavailable)

      statusOf(
        service(new Born, auctions = AuctionCommands(registered(), Unreachable, silent)).placeBid(floorBid)
      ) shouldBe
        Status.Code.UNAVAILABLE
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
