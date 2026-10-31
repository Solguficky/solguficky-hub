package auction.screen

import auction.aggregate.Auction
import auction.aggregate.AuctionFixtures
import auction.aggregate.AuctionState
import auction.aggregate.MeetupId
import auction.aggregate.MeetupLifecycle
import auction.aggregate.MeetupStanding
import auction.aggregate.MeetupVisibility
import auction.lot.AuctionId
import auction.lot.LotFixtures
import auction.lot.ParticipantId
import auction.naming.ChooseResult
import auction.naming.ChosenName
import auction.naming.DisplayNameStore
import auction.naming.StoredName
import auction.prediction.Nomination
import auction.results.NominationValue
import auction.watch.ChangeRegistry
import ch.qos.logback.classic.Logger as LogbackLogger
import ch.qos.logback.classic.spi.ILoggingEvent
import ch.qos.logback.core.read.ListAppender
import org.apache.pekko.actor.testkit.typed.scaladsl.ActorTestKit
import org.apache.pekko.actor.typed.ActorSystem
import org.apache.pekko.stream.Materializer
import org.apache.pekko.stream.SystemMaterializer
import org.apache.pekko.stream.scaladsl.Sink
import org.apache.pekko.stream.scaladsl.SinkQueueWithCancel
import org.scalatest.BeforeAndAfterAll
import org.scalatest.concurrent.Eventually
import org.scalatest.concurrent.ScalaFutures
import org.scalatest.matchers.should.Matchers
import org.scalatest.time.Millis
import org.scalatest.time.Seconds
import org.scalatest.time.Span
import org.scalatest.wordspec.AnyWordSpec
import org.slf4j.LoggerFactory

import java.util.UUID
import java.util.concurrent.atomic.AtomicInteger
import scala.concurrent.ExecutionContext
import scala.concurrent.Future
import scala.jdk.CollectionConverters.*

/**
 * Снимок экрана зала читается один раз на повод и аукцион (PER-695): число чтений не зависит от числа потоков, а
 * поведение потока остаётся прежним — подписка до первого чтения, склейка поводов и конец потока на пропавшем аукционе.
 */
final class ScreenFeedSpec extends AnyWordSpec with Matchers with ScalaFutures with Eventually with BeforeAndAfterAll {

  private val kit = ActorTestKit("auction-screen-feed")
  private given ActorSystem[?] = kit.system
  private given Materializer = SystemMaterializer(kit.system).materializer
  private given ExecutionContext = kit.system.executionContext

  override implicit val patienceConfig: PatienceConfig =
    PatienceConfig(timeout = Span(10, Seconds), interval = Span(50, Millis))

  override def afterAll(): Unit = kit.shutdownTestKit()

  private val auctionId = UUID.fromString("01890a5d-ac97-7c2b-9f3a-0d1b2c3d4faa")
  private val meetupId = UUID.fromString("01890a5d-ac97-7c2b-9f3a-0d1b2c3d4fbb")

  private def readingIn(state: AuctionState): ScreenReading =
    ScreenReading(auctionId, meetupId, Auction(state, Some(MeetupId(meetupId)), Set.empty, Map.empty), Nil, Nil, Nil)

  /** Read model, который считает чтения снимка: их число и есть предмет теста. */
  private final class Views(@volatile var current: Option[ScreenReading]) extends ScreenViews {
    val reads = AtomicInteger(0)

    def read(id: UUID): Future[Option[ScreenReading]] = {
      reads.incrementAndGet()
      Future.successful(current.filter(_ => id == auctionId))
    }

    def image(auction: UUID, lot: UUID, version: String): Future[Option[ScreenImage]] = Future.successful(None)
  }

  private object NoNames extends DisplayNameStore {
    def choose(auction: AuctionId, participant: ParticipantId, name: ChosenName): Future[ChooseResult] = ???
    def freeze(auction: AuctionId, participant: ParticipantId): Future[Boolean] = ???
    def find(auction: AuctionId, participants: Set[ParticipantId]): Future[Map[ParticipantId, StoredName]] =
      Future.successful(Map.empty)
    def all(auction: AuctionId): Future[Map[ParticipantId, StoredName]] = Future.successful(Map.empty)
  }

  private object Visible extends MeetupStandings {
    def standing(meetup: UUID): Future[StandingAnswer] =
      Future.successful(StandingAnswer.Found(MeetupStanding(MeetupLifecycle.Planned, MeetupVisibility.Visible)))
  }

  private def feedOf(views: Views, changes: ChangeRegistry): ScreenFeed =
    ScreenFeed(views, NoNames, Visible, changes, StreamLimit(100))

  private def streamOf(feed: ScreenFeed): SinkQueueWithCancel[String] =
    feed.states(auctionId).runWith(Sink.queue[String]())

  "the shared screen snapshot" should {

    "read the read model once per change for every stream of the auction" in {
      val views = Views(Some(readingIn(AuctionState.Draft)))
      val changes = ChangeRegistry()
      val feed = feedOf(views, changes)

      val first = streamOf(feed)
      first.pull().futureValue shouldBe defined
      val readForTheFirst = views.reads.get()
      readForTheFirst shouldBe 1

      // Потоки, пришедшие следом, берут уже прочитанное состояние: поводов с прошлого чтения не было.
      val rest = Vector.fill(4)(streamOf(feed))
      rest.foreach(_.pull().futureValue shouldBe defined)
      views.reads.get() shouldBe readForTheFirst

      views.current = Some(readingIn(AuctionState.Finished(AuctionFixtures.config(), LotFixtures.op(9))))
      changes.changed(auctionId)
      val changed = (first +: rest).map(_.pull().futureValue.getOrElse(fail("the stream ended before the change")))
      changed.foreach(_ should include("\"phase\":\"finished\""))
      views.reads.get() shouldBe readForTheFirst + 1

      (first +: rest).foreach(_.cancel())
    }

    "read once for the first stream without waiting for a subscriber to ask" in {
      val views = Views(Some(readingIn(AuctionState.Draft)))
      val feed = feedOf(views, ChangeRegistry())

      val stream = streamOf(feed)
      eventually(views.reads.get() shouldBe 1)
      stream.pull().futureValue.getOrElse(fail("no state")) should include("\"phase\":\"upcoming\"")
      stream.cancel()
    }

    "end every stream of the auction when the auction disappears from the read model" in {
      val views = Views(Some(readingIn(AuctionState.Draft)))
      val changes = ChangeRegistry()
      val feed = feedOf(views, changes)

      val streams = Vector.fill(3)(streamOf(feed))
      streams.foreach(_.pull().futureValue shouldBe defined)

      views.current = None
      changes.changed(auctionId)
      streams.foreach(_.pull().futureValue shouldBe empty)

      // Поток, пришедший после конца, снова читает снимок сам и заканчивается на пропавшем аукционе.
      streamOf(feed).pull().futureValue shouldBe empty
      streams.foreach(_.cancel())
    }

    "leave the changes of the auction when its last stream ends" in {
      val views = Views(Some(readingIn(AuctionState.Draft)))
      val changes = ChangeRegistry()
      val feed = feedOf(views, changes)

      val streams = Vector.fill(3)(streamOf(feed))
      streams.foreach(_.pull().futureValue shouldBe defined)
      changes.subscriptions(auctionId) shouldBe 1

      streams.foreach(_.cancel())
      eventually(changes.subscriptions(auctionId) shouldBe 0)
    }

    "retry finished prediction results on reconnect after a failed read without another auction change" in {
      val views = Views(Some(readingIn(AuctionState.Draft)))
      val changes = ChangeRegistry()
      val reads = AtomicInteger(0)
      val predictions = new ScreenPredictions {
        def read(id: UUID): Future[List[ScreenNomination]] =
          if (reads.incrementAndGet() == 1) Future.failed(IllegalStateException("private failure detail"))
          else Future.successful(List(ScreenNomination(Nomination.TotalSales, NominationValue.Number(10000), 0, Nil)))
      }
      val feed = ScreenFeed(views, NoNames, Visible, changes, StreamLimit(100), predictions)
      val logger = eventually {
        LoggerFactory.getLogger(classOf[ScreenFeed]) match {
          case found: LogbackLogger => found
          case _ => fail("slf4j has not settled on logback")
        }
      }
      val appender = new ListAppender[ILoggingEvent]()
      appender.start()
      logger.addAppender(appender)
      try {
        val streams = Vector.fill(2)(streamOf(feed))
        streams.foreach(_.pull().futureValue shouldBe defined)

        views.current = Some(readingIn(AuctionState.Finished(AuctionFixtures.config(), LotFixtures.op(9))))
        changes.changed(auctionId)
        streams.foreach(_.pull().futureValue shouldBe empty)

        // Потерянный итог не кешируется: новое подключение само перечитывает его без changes.changed.
        val reconnected = streamOf(feed)
        try {
          reconnected.pull().futureValue.getOrElse(fail("no recovered result")) should include(
            "\"nomination\":\"catalog-total-sales\""
          )
          reads.get() shouldBe 2
          val recorded = appender.list.asScala.toList
          recorded should have size 1
          val frame = recorded.head.getArgumentArray.head.toString
          frame should include("operation=auction.screen.snapshot")
          frame should include("error=java.lang.IllegalStateException")
          frame should include("stack=")
          frame should not include "private failure detail"
        } finally reconnected.cancel()
      } finally {
        logger.detachAppender(appender)
        appender.stop()
      }
    }
  }
}
