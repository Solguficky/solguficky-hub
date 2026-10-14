package auction.results

import auction.catalog.LotId
import auction.entity.JournalFixtures.*
import auction.lot.AuctionId
import auction.lot.ParticipantId
import auction.prediction.Answer
import auction.prediction.Forecast
import auction.prediction.Nomination
import auction.prediction.PredictionRound
import org.apache.pekko.Done
import org.apache.pekko.actor.testkit.typed.scaladsl.ActorTestKit
import org.apache.pekko.actor.typed.ActorRef
import org.apache.pekko.persistence.testkit.scaladsl.EventSourcedBehaviorTestKit
import org.scalatest.BeforeAndAfterAll
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

import scala.concurrent.Future

/**
 * Entity итогов на журнале в памяти: подсчёт пишет строки и событие один раз, неполный снимок подсчёт не начинает,
 * ручная отметка подавляет подсчёт, удаление возвращает пустой лист. Хранилище, снимок и прогнозы — подмены портов.
 */
final class ResultsEntitySpec extends AnyWordSpec with Matchers with BeforeAndAfterAll {

  private val kit = ActorTestKit("results-entity", EventSourcedBehaviorTestKit.config.withFallback(localConfig))

  override protected def afterAll(): Unit = kit.shutdownTestKit()

  private val auctionId = "83a6d0b2-84ed-5444-a77b-dd0338dc84a4"
  private val lotA = LotId(uuid(11))

  private def person(n: Int): ParticipantId = ParticipantId(uuid(100 + n))

  private val sold =
    LotOutcome(lotA, Some(5000), Some(1000), bids = 3, participants = 2, Some(4000), None, None, false, true)

  private val forecast =
    Forecast.parse(PredictionRound.Catalog, List(Nomination.MostExpensiveLot -> Answer.Lot(lotA))).toOption.get

  /** Строки в памяти: пишутся подсчётом, стираются удалением. */
  private final class Store extends ResultsStore {
    @volatile var rows = List.empty[ResultRow]
    @volatile var recorded = 0
    @volatile var discarded = 0

    def record(auction: AuctionId, rows: List[ResultRow]): Future[Unit] = {
      this.rows = this.rows ++ rows
      recorded += 1
      Future.unit
    }

    def read(auction: AuctionId): Future[List[ResultRow]] = Future.successful(rows)

    def erase(participant: ParticipantId): Future[Unit] = Future.unit

    def discard(auction: AuctionId): Future[Unit] = {
      discarded += 1
      rows = Nil
      Future.unit
    }
  }

  /** Снимок исходов, который тест переставляет: `None` — неполный. */
  private final class Outcomes(var snapshot: Option[List[LotOutcome]]) extends ResultsOutcomes {
    def outcomes(auction: AuctionId): Future[Option[List[LotOutcome]]] = Future.successful(snapshot)
  }

  private def forecastsOf(entries: (ParticipantId, Forecast)*): ResultsForecasts =
    new ResultsForecasts {
      private val rounds = entries
        .groupBy(_._2.round)
        .map((round, of) => round -> of.map((participant, forecast) => participant -> forecast).toMap)
      def forecasts(auction: AuctionId): Future[Map[PredictionRound, Map[ParticipantId, Forecast]]] =
        Future.successful(rounds)
    }

  private val names: ResultNames = new ResultNames {
    def names(auction: AuctionId, participants: Set[ParticipantId]): Future[Map[ParticipantId, String]] =
      Future.successful(
        participants.map(participant => participant -> s"@${participant.value.toString.takeRight(4)}").toMap
      )
  }

  private var ids = 0

  private def fresh(): String = {
    ids += 1
    new java.util.UUID(0x83a6d0b284ed5444L, 0xa77bdd0338dc0000L | ids.toLong).toString
  }

  private def spawn(outcomes: Outcomes, forecasts: ResultsForecasts, store: Store, id: String = auctionId) =
    kit.spawn(ResultsEntity(id, clock, sequentialIds(), outcomes, forecasts, names, store))

  private def settle(entity: ActorRef[ResultsEntity.Command]): Either[SettleRefused, Done] = {
    val probe = kit.createTestProbe[Either[SettleRefused, Done]]()
    entity ! ResultsEntity.Settle(probe.ref)
    probe.receiveMessage()
  }

  private def manual(entity: ActorRef[ResultsEntity.Command]): Done = {
    val probe = kit.createTestProbe[Done]()
    entity ! ResultsEntity.RecordManually(probe.ref)
    probe.receiveMessage()
  }

  private def discard(entity: ActorRef[ResultsEntity.Command]): Done = {
    val probe = kit.createTestProbe[Done]()
    entity ! ResultsEntity.Discard(probe.ref)
    probe.receiveMessage()
  }

  private def state(entity: ActorRef[ResultsEntity.Command]): Results = {
    val probe = kit.createTestProbe[Results]()
    entity ! ResultsEntity.Get(probe.ref)
    probe.receiveMessage()
  }

  "results entity" should {

    "count once: write the rows with names and record the event, and never a second time" in {
      val store = Store()
      val entity = spawn(Outcomes(Some(List(sold))), forecastsOf(person(1) -> forecast), store, fresh())
      settle(entity) shouldBe Right(Done)
      state(entity) shouldBe a[Results.Counted]
      store.rows.map(_.name) shouldBe List(s"@${person(1).value.toString.takeRight(4)}")
      store.recorded shouldBe 1
      settle(entity) shouldBe Right(Done)
      store.recorded shouldBe 1
      state(entity) shouldBe a[Results.Counted]
    }

    "not start a count on an incomplete snapshot, and count once the snapshot is complete" in {
      val store = Store()
      val outcomes = Outcomes(None)
      val entity = spawn(outcomes, forecastsOf(person(1) -> forecast), store, fresh())
      settle(entity) shouldBe Left(SettleRefused.NotComplete)
      state(entity) shouldBe Results.Unsettled
      store.rows shouldBe empty
      outcomes.snapshot = Some(List(sold))
      settle(entity) shouldBe Right(Done)
      state(entity) shouldBe a[Results.Counted]
    }

    "suppress the count with a by-hand marker and answer an accepted repeat afterwards" in {
      val store = Store()
      val entity = spawn(Outcomes(Some(List(sold))), forecastsOf(person(1) -> forecast), store, fresh())
      manual(entity) shouldBe Done
      state(entity) shouldBe Results.ByHand
      settle(entity) shouldBe Right(Done)
      state(entity) shouldBe Results.ByHand
      store.rows shouldBe empty
      manual(entity) shouldBe Done
      state(entity) shouldBe Results.ByHand
    }

    "answer a second settle that arrived while the first count was in flight" in {
      val store = Store()
      val entity = spawn(Outcomes(Some(List(sold))), forecastsOf(person(1) -> forecast), store, fresh())
      val probe = kit.createTestProbe[Either[SettleRefused, Done]]()
      entity ! ResultsEntity.Settle(probe.ref)
      entity ! ResultsEntity.Settle(probe.ref)
      probe.receiveMessages(2) shouldBe List(Right(Done), Right(Done))
      store.recorded shouldBe 1
    }

    "clear the rows and the state on a discard, so a reborn auction starts from a clean sheet" in {
      val store = Store()
      val id = fresh()
      val entity = spawn(Outcomes(Some(List(sold))), forecastsOf(person(1) -> forecast), store, id)
      settle(entity) shouldBe Right(Done)
      discard(entity) shouldBe Done
      store.discarded shouldBe 1
      store.rows shouldBe empty
      state(entity) shouldBe Results.Unsettled
    }
  }
}
