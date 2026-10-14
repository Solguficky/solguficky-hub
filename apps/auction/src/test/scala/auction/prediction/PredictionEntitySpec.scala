package auction.prediction

import auction.catalog.LotId
import auction.entity.JournalFixtures.*
import auction.lot.AuctionId
import auction.lot.OpId
import auction.lot.ParticipantId
import org.apache.pekko.Done
import org.apache.pekko.actor.testkit.typed.scaladsl.ActorTestKit
import org.apache.pekko.actor.typed.ActorRef
import org.apache.pekko.persistence.testkit.scaladsl.EventSourcedBehaviorTestKit
import org.scalatest.BeforeAndAfterAll
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

import java.util.UUID
import scala.concurrent.Future
import scala.concurrent.Promise
import scala.concurrent.duration.*

/**
 * Entity прогнозов на журнале в памяти, хранилище — подмена порта с той же семантикой, что у строк. Запись хранилища
 * тест может задержать: так видно, что закрытие раунда ждёт принятую запись, а не обгоняет её.
 */
final class PredictionEntitySpec extends AnyWordSpec with Matchers with BeforeAndAfterAll {

  private val kit = ActorTestKit("prediction-entity", EventSourcedBehaviorTestKit.config.withFallback(localConfig))

  override protected def afterAll(): Unit = kit.shutdownTestKit()

  /** Строки в памяти. `held` задерживает следующую запись до своего обещания; `down` отвечает отказом. */
  private final class Store extends PredictionStore {
    private var rows = Map.empty[(AuctionId, PredictionRound, ParticipantId), Forecast]
    private var ops = Map.empty[(AuctionId, OpId), (ParticipantId, Forecast)]
    @volatile var held: Option[Promise[Unit]] = None
    @volatile var down = false
    @volatile var discards = 0

    /** Своему повтору — то, что отправил этот `op_id`; другому участнику или раунду — отказ. */
    private def repeated(
        participant: ParticipantId,
        round: PredictionRound,
        sent: (ParticipantId, Forecast)
    ): Either[SubmitRejected.OpIdTaken.type, Forecast] =
      if (sent._1 == participant && sent._2.round == round) Right(sent._2) else Left(SubmitRejected.OpIdTaken)

    def submit(auction: AuctionId, command: SubmitForecast): Future[Either[SubmitRejected.OpIdTaken.type, Forecast]] = {
      val gate = held.fold(Future.unit)(_.future)
      held = None
      if (down) Future.failed(new RuntimeException("the store did not answer"))
      else
        gate.map { _ =>
          synchronized[Either[SubmitRejected.OpIdTaken.type, Forecast]] {
            ops.get(auction -> command.opId) match {
              case Some(sent) => repeated(command.participant, command.round, sent)
              case None =>
                ops = ops.updated(auction -> command.opId, command.participant -> command.forecast)
                rows = rows.updated((auction, command.round, command.participant), command.forecast)
                Right(command.forecast)
            }
          }
        }(using scala.concurrent.ExecutionContext.parasitic)
    }

    def recall(
        auction: AuctionId,
        participant: ParticipantId,
        round: PredictionRound,
        opId: OpId
    ): Future[Option[Either[SubmitRejected.OpIdTaken.type, Forecast]]] =
      Future.successful(synchronized(ops.get(auction -> opId).map(repeated(participant, round, _))))

    def mine(auction: AuctionId, participant: ParticipantId): Future[Map[PredictionRound, Forecast]] =
      Future.successful(synchronized(rows.collect { case ((`auction`, round, `participant`), forecast) =>
        round -> forecast
      }))

    def all(auction: AuctionId): Future[Map[PredictionRound, Map[ParticipantId, Forecast]]] =
      Future.successful(synchronized {
        rows
          .collect { case ((`auction`, round, participant), forecast) => (round, participant, forecast) }
          .groupBy(_._1)
          .map((round, ofRound) => round -> ofRound.map((_, participant, forecast) => participant -> forecast).toMap)
      })

    def discard(auction: AuctionId): Future[Unit] = synchronized {
      discards += 1
      rows = rows.filterNot(_._1._1 == auction)
      ops = ops.filterNot(_._1._1 == auction)
      Future.unit
    }

    def erase(participant: ParticipantId): Future[Unit] = Future.unit
  }

  private val auctionId = "83a6d0b2-84ed-5444-a77b-dd0338dc84a4"
  private def person(n: Int) = ParticipantId(uuid(100 + n))
  private val lot = LotId(uuid(11))

  private val forecast =
    Forecast.parse(PredictionRound.Catalog, List(Nomination.MostExpensiveLot -> Answer.Lot(lot))).toOption.get

  private def spawn(store: Store, id: String = auctionId): ActorRef[PredictionEntity.Command] =
    kit.spawn(PredictionEntity(id, clock, sequentialIds(), store))

  private def ask(entity: ActorRef[PredictionEntity.Command])(
      command: ActorRef[Done] => PredictionEntity.Command
  ): Unit = {
    val probe = kit.createTestProbe[Done]()
    entity ! command(probe.ref)
    probe.expectMessage(Done)
  }

  private def submit(entity: ActorRef[PredictionEntity.Command], who: Int, opN: Int, value: Forecast = forecast) = {
    val probe = kit.createTestProbe[Either[SubmitRejected, Forecast]]()
    entity ! PredictionEntity.Submit(SubmitForecast(person(who), value, OpId(uuid(opN))), probe.ref)
    probe
  }

  private def game(entity: ActorRef[PredictionEntity.Command]): Predictions = {
    val probe = kit.createTestProbe[Predictions]()
    entity ! PredictionEntity.Get(probe.ref)
    probe.receiveMessage()
  }

  private var ids = 0

  /** Свой аукцион на тест: журнал в памяти общий у всей системы. */
  private def fresh(): String = {
    ids += 1
    new UUID(0x83a6d0b284ed5444L, 0xa77bdd0338dc0000L | ids.toLong).toString
  }

  "prediction entity" should {

    "refuses a prediction before its round opens and accepts it while the round is open" in {
      val store = Store()
      val entity = spawn(store, fresh())
      submit(entity, who = 1, opN = 1).expectMessage(Left(SubmitRejected.RoundNotOpen))
      ask(entity)(PredictionEntity.Open(PredictionRound.Catalog, _))
      submit(entity, who = 1, opN = 2).expectMessage(Right(forecast))
    }

    "waits with the closing until the write in flight is done, then refuses a late prediction" in {
      val store = Store()
      val entity = spawn(store)
      ask(entity)(PredictionEntity.Open(PredictionRound.Catalog, _))
      val gate = Promise[Unit]()
      store.held = Some(gate)
      val accepted = submit(entity, who = 1, opN = 1)
      val closing = kit.createTestProbe[Done]()
      entity ! PredictionEntity.Close(PredictionRound.Catalog, closing.ref)
      closing.expectNoMessage(200.millis)
      gate.success(())
      accepted.expectMessage(Right(forecast))
      closing.expectMessage(Done)
      submit(entity, who = 2, opN = 2).expectMessage(Left(SubmitRejected.RoundClosed))
    }

    "answers a repeat of an accepted op_id with the prediction after the round is closed, and refuses another's" in {
      val store = Store()
      val entity = spawn(store, fresh())
      ask(entity)(PredictionEntity.Open(PredictionRound.Catalog, _))
      submit(entity, who = 1, opN = 1).expectMessage(Right(forecast))
      ask(entity)(PredictionEntity.Close(PredictionRound.Catalog, _))
      submit(entity, who = 1, opN = 1).expectMessage(Right(forecast))
      submit(entity, who = 2, opN = 1).expectMessage(Left(SubmitRejected.OpIdTaken))
    }

    "keeps the rounds through a restart: a closed round stays closed" in {
      val store = Store()
      val id = fresh()
      val first = spawn(store, id)
      ask(first)(PredictionEntity.Open(PredictionRound.Catalog, _))
      ask(first)(PredictionEntity.Close(PredictionRound.Catalog, _))
      kit.stop(first)
      val second = spawn(store, id)
      game(second).catalog shouldBe RoundStatus.Closed
      submit(second, who = 1, opN = 1).expectMessage(Left(SubmitRejected.RoundClosed))
    }

    "deletes the rows before the discard and starts from a clean sheet" in {
      val store = Store()
      val id = fresh()
      val entity = spawn(store, id)
      ask(entity)(PredictionEntity.Open(PredictionRound.Catalog, _))
      submit(entity, who = 1, opN = 1).expectMessage(Right(forecast))
      ask(entity)(PredictionEntity.Discard(_))
      store.discards shouldBe 1
      game(entity) shouldBe Predictions.initial
      ask(entity)(PredictionEntity.Open(PredictionRound.Catalog, _))
      submit(entity, who = 1, opN = 1).expectMessage(Right(forecast))
    }

    "gives no answer when the store does not answer and goes on with the next command" in {
      val store = Store()
      val entity = spawn(store, fresh())
      ask(entity)(PredictionEntity.Open(PredictionRound.Catalog, _))
      store.down = true
      submit(entity, who = 1, opN = 1).expectNoMessage(200.millis)
      store.down = false
      ask(entity)(PredictionEntity.Close(PredictionRound.Catalog, _))
      game(entity).catalog shouldBe RoundStatus.Closed
    }
  }
}
