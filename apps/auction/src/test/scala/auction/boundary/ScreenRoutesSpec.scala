package auction.boundary

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
import auction.screen.MeetupStandings
import auction.screen.ScreenFeed
import auction.screen.ScreenImage
import auction.screen.ScreenReading
import auction.screen.ScreenViews
import auction.screen.StandingAnswer
import auction.screen.StreamLimit
import auction.watch.ChangeRegistry
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model.HttpRequest
import org.apache.pekko.http.scaladsl.model.HttpResponse
import org.apache.pekko.http.scaladsl.model.MediaTypes
import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.server.Route
import org.apache.pekko.http.scaladsl.testkit.RouteTestTimeout
import org.apache.pekko.http.scaladsl.testkit.ScalatestRouteTest
import org.apache.pekko.stream.scaladsl.Sink
import org.apache.pekko.util.ByteString
import org.scalatest.concurrent.Eventually
import org.scalatest.concurrent.ScalaFutures
import org.scalatest.matchers.should.Matchers
import org.scalatest.time.Seconds
import org.scalatest.time.Span
import org.scalatest.wordspec.AnyWordSpec

import java.util.UUID
import java.util.concurrent.atomic.AtomicInteger
import scala.concurrent.Future
import scala.concurrent.Promise
import scala.concurrent.duration.*

final class ScreenRoutesSpec
    extends AnyWordSpec
    with Matchers
    with ScalatestRouteTest
    with ScalaFutures
    with Eventually {

  override implicit val patienceConfig: PatienceConfig = PatienceConfig(Span(5, Seconds))
  private given RouteTestTimeout = RouteTestTimeout(5.seconds)

  private val auctionId = UUID.fromString("01890a5d-ac97-7c2b-9f3a-0d1b2c3d4eaa")
  private val meetupId = UUID.fromString("01890a5d-ac97-7c2b-9f3a-0d1b2c3d4ebb")
  private val lotId = UUID.fromString("01890a5d-ac97-7c2b-9f3a-0d1b2c3d4e01")

  private def readingIn(state: AuctionState): ScreenReading =
    ScreenReading(auctionId, meetupId, Auction(state, Some(MeetupId(meetupId)), Set.empty, Map.empty), Nil, Nil, Nil)

  private final class Views(@volatile var current: Option[ScreenReading]) extends ScreenViews {
    def read(id: UUID): Future[Option[ScreenReading]] = Future.successful(current.filter(_ => id == auctionId))
    def image(auction: UUID, lot: UUID, version: String): Future[Option[ScreenImage]] =
      Future.successful(
        Option.when(auction == auctionId && lot == lotId && version == "v2")(
          ScreenImage(IArray[Byte](1, 2, 3), "image/png")
        )
      )
  }

  private object NoNames extends DisplayNameStore {
    def choose(auction: AuctionId, participant: ParticipantId, name: ChosenName): Future[ChooseResult] = ???
    def freeze(auction: AuctionId, participant: ParticipantId): Future[Boolean] = ???
    def find(auction: AuctionId, participants: Set[ParticipantId]): Future[Map[ParticipantId, StoredName]] =
      Future.successful(Map.empty)
  }

  /** Meetups, который считает вопросы: отказ по пределу обязан наступать до него. */
  private final class Standings(answer: StandingAnswer) extends MeetupStandings {
    val asked = AtomicInteger(0)
    def standing(meetup: UUID): Future[StandingAnswer] = {
      asked.incrementAndGet()
      Future.successful(answer)
    }
  }

  private val visible = StandingAnswer.Found(MeetupStanding(MeetupLifecycle.Planned, MeetupVisibility.Visible))

  private def routeOf(
      views: Views = Views(Some(readingIn(AuctionState.Draft))),
      standings: MeetupStandings = Standings(visible),
      changes: ChangeRegistry = ChangeRegistry(),
      limit: StreamLimit = StreamLimit(10),
      heartbeat: FiniteDuration = 1.minute
  ): Route = {
    val feed = ScreenFeed(views, NoNames, standings, changes, limit)
    BoundaryLogging.boundary(ScreenRoutes.route(feed, views, heartbeat))
  }

  private def events = s"/screen/$auctionId/events"

  /**
   * Поток бесконечен, а route-testkit ждёт тело ответа целиком, поэтому поток читается с настоящего сервера на
   * свободном порту: заголовки — из ответа, кадры — по одному, следующий тест тянет сам.
   */
  private def connecting[A](route: Route)(use: (() => Future[HttpResponse]) => A): A = {
    val binding = Http().newServerAt("127.0.0.1", 0).bind(route).futureValue
    try use(() => Http().singleRequest(HttpRequest(uri = s"http://127.0.0.1:${binding.localAddress.getPort}$events")))
    finally binding.unbind().futureValue
  }

  private def streaming[A](route: Route)(use: (() => HttpResponse) => A): A =
    connecting(route)(request => use(() => request().futureValue))

  private def frames(response: HttpResponse) = response.entity.dataBytes.runWith(Sink.queue[ByteString]())

  "the screen stream" should {

    "send the whole state as one state event at subscription" in streaming(routeOf()) { open =>
      val response = open()
      response.status shouldBe StatusCodes.OK
      response.entity.contentType.mediaType shouldBe MediaTypes.`text/event-stream`
      response.headers.find(_.is("x-accel-buffering")).map(_.value) shouldBe Some("no")
      val stream = frames(response)
      stream.pull().futureValue.map(_.utf8String) shouldBe
        Some("event: state\ndata: {\"schema\":1,\"phase\":\"upcoming\",\"final\":true,\"final_at\":null}\n\n")
      stream.cancel()
    }

    "send a fresh state after a change and a heartbeat comment in silence" in {
      val views = Views(Some(readingIn(AuctionState.Draft)))
      val registry = ChangeRegistry()
      streaming(routeOf(views = views, changes = registry, heartbeat = 200.millis)) { open =>
        val stream = frames(open())
        stream.pull().futureValue.map(_.utf8String).get should include("upcoming")
        stream.pull().futureValue shouldBe Some(ScreenRoutes.Heartbeat)

        views.current = Some(readingIn(AuctionState.Finished(AuctionFixtures.config(), LotFixtures.op(9))))
        registry.changed(auctionId)
        Iterator
          .continually(stream.pull().futureValue)
          .dropWhile(_.contains(ScreenRoutes.Heartbeat))
          .next()
          .map(_.utf8String)
          .get should include("\"phase\":\"finished\"")
        stream.cancel()
      }
    }

    "refuse a stream over the limit before asking Meetups and free the place when a stream ends" in {
      val limit = StreamLimit(1)
      val standings = Standings(visible)
      streaming(routeOf(standings = standings, limit = limit)) { open =>
        val stream = frames(open())
        stream.pull().futureValue should not be empty
        limit.current shouldBe 1

        val refused = open()
        refused.status shouldBe StatusCodes.ServiceUnavailable
        refused.discardEntityBytes()
        standings.asked.get() shouldBe 1

        stream.cancel()
        eventually(limit.current shouldBe 0)
      }
    }

    "count a connection waiting for Meetups against the limit" in {
      val limit = StreamLimit(1)
      val answer = Promise[StandingAnswer]()
      val waiting = new MeetupStandings {
        def standing(meetup: UUID): Future[StandingAnswer] = answer.future
      }
      connecting(routeOf(standings = waiting, limit = limit)) { request =>
        val first = request()
        eventually(limit.current shouldBe 1)

        val refused = request().futureValue
        refused.status shouldBe StatusCodes.ServiceUnavailable
        refused.discardEntityBytes()

        answer.success(visible)
        val stream = frames(first.futureValue)
        stream.pull().futureValue should not be empty
        limit.current shouldBe 1
        stream.cancel()
        eventually(limit.current shouldBe 0)
      }
    }

    "answer not found alike for a hidden meetup, a missing meetup and an unknown auction" in {
      val hidden = StandingAnswer.Found(MeetupStanding(MeetupLifecycle.Planned, MeetupVisibility.Hidden))
      Get(events) ~> routeOf(standings = Standings(hidden)) ~> check(status shouldBe StatusCodes.NotFound)
      Get(events) ~> routeOf(standings = Standings(StandingAnswer.Missing)) ~> check(
        status shouldBe StatusCodes.NotFound
      )
      Get(events) ~> routeOf(views = Views(None)) ~> check(status shouldBe StatusCodes.NotFound)
    }

    "answer 503 while the meetup state cannot be confirmed" in {
      Get(events) ~> routeOf(standings = Standings(StandingAnswer.Unavailable)) ~> check(
        status shouldBe StatusCodes.ServiceUnavailable
      )
    }

  }

  "the lot image" should {

    "serve the current version with an unlimited cache lifetime" in {
      Get(s"/screen/$auctionId/lots/$lotId/images/v2") ~> routeOf() ~> check {
        status shouldBe StatusCodes.OK
        mediaType shouldBe MediaTypes.`image/png`
        header("Cache-Control").map(_.value) shouldBe Some("public, max-age=31536000, immutable")
        responseAs[Array[Byte]] shouldBe Array[Byte](1, 2, 3)
      }
    }

    "answer not found for a previous version rather than the current bytes" in {
      Get(s"/screen/$auctionId/lots/$lotId/images/v1") ~> routeOf() ~> check(status shouldBe StatusCodes.NotFound)
    }

    "answer not found for the image of a hidden meetup's auction" in {
      val hidden = StandingAnswer.Found(MeetupStanding(MeetupLifecycle.Planned, MeetupVisibility.Hidden))
      Get(s"/screen/$auctionId/lots/$lotId/images/v2") ~> routeOf(standings = Standings(hidden)) ~> check(
        status shouldBe StatusCodes.NotFound
      )
    }
  }
}
