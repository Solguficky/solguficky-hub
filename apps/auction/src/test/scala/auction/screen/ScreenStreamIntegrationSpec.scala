package auction.screen

import auction.lot.AuctionId
import auction.lot.LotFixtures.participant
import auction.lot.LotState
import auction.naming.ChosenName
import auction.naming.TelegramUsername
import auction.persistence.JournalSchema
import auction.persistence.SlickDisplayNameStore
import auction.persistence.SlickLotViews
import auction.testkit.PostgresFixture
import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.typesafe.config.ConfigFactory
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model.HttpRequest
import org.apache.pekko.http.scaladsl.model.HttpResponse
import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.stream.Materializer
import org.apache.pekko.stream.scaladsl.Sink
import org.apache.pekko.stream.scaladsl.SinkQueueWithCancel
import org.apache.pekko.util.ByteString
import org.scalatest.concurrent.Eventually
import org.scalatest.concurrent.ScalaFutures
import org.scalatest.matchers.should.Matchers
import org.scalatest.time.Millis
import org.scalatest.time.Seconds
import org.scalatest.time.Span
import org.scalatest.wordspec.AnyWordSpec

import scala.concurrent.Future
import scala.concurrent.duration.*

/**
 * Поток экрана зала (PER-484) на узле, собранном так же, как в `Main` (`ScreenNodes`). Meetups подменён ответом «сходка
 * видна»: провод к нему держат L0 адаптера и контур.
 */
final class ScreenStreamIntegrationSpec
    extends AnyWordSpec
    with Matchers
    with PostgresFixture
    with ScalaFutures
    with Eventually
    with ScreenNodes {

  implicit override val patienceConfig: PatienceConfig =
    PatienceConfig(timeout = Span(30, Seconds), interval = Span(100, Millis))

  private val json = ObjectMapper()

  "the screen stream" should {

    "show a bid within a second while a hung reader holds its stream and does not delay the bid" in {
      val database = freshDatabase()
      JournalSchema.migrate(database)
      withNode(database) { node =>
        val (auction, lot) = liveFinal(node)
        val active = node.screen(auction)
        active.state(_.at("/phase").asText == "lot")
        // Подвешенный читатель: подключён и ничего не читает. Ни ставка, ни второй поток его не ждут.
        val hung = node.open(auction)
        hung.status shouldBe StatusCodes.OK

        val next = node.nextPrice(lot)
        val startedAt = System.nanoTime()
        node.bid(lot, next, participant(2))
        (System.nanoTime() - startedAt).nanos should be <= 1.second
        val raised = active.state(_.at("/lot/price/amount").asLong == next.minorUnits, within = 1.second)

        raised.at("/lot/bids/0/channel").asText shouldBe "online"
        active.cancel()
        node.discard(hung)
      }
    }

    "give a reader who reconnects after the node restarts the snapshot of the read model" in {
      val database = freshDatabase()
      JournalSchema.migrate(database)
      val (auction, lot, price) = withNode(database) { node =>
        val (auction, lot) = liveFinal(node)
        val next = node.nextPrice(lot)
        node.bid(lot, next, participant(3))
        val stream = node.screen(auction)
        stream.state(_.at("/lot/price/amount").asLong == next.minorUnits)
        stream.cancel()
        (auction, lot, next)
      }

      withNode(database) { node =>
        val again = node.screen(auction)
        val snapshot = again.state(_.at("/phase").asText == "lot")
        again.cancel()
        val stored = SlickLotViews(node.system).find(lot.value).futureValue.getOrElse(fail("lot is not in read model"))
        val trading = stored.lot.state match {
          case LotState.Trading(state) => state
          case other => fail(s"lot is not trading: $other")
        }
        snapshot.at("/lot/id").asText shouldBe lot.value.toString
        snapshot.at("/lot/price/amount").asLong shouldBe trading.currentPrice.minorUnits
        trading.currentPrice shouldBe price
      }
    }

    "refuse a stream over the limit and keep taking bids" in {
      val database = freshDatabase()
      JournalSchema.migrate(database)
      withNode(database, ConfigFactory.parseString("auction.screen.max-streams = 1")) { node =>
        val (auction, lot) = liveFinal(node)
        val held = node.screen(auction)
        held.state(_.at("/phase").asText == "lot")

        val refused = node.open(auction)
        refused.status shouldBe StatusCodes.ServiceUnavailable
        node.discard(refused)

        val startedAt = System.nanoTime()
        node.bid(lot, node.nextPrice(lot), participant(2))
        (System.nanoTime() - startedAt).nanos should be <= 1.second
        held.cancel()
      }
    }

    "show a chosen display name without a projection event" in {
      val database = freshDatabase()
      JournalSchema.migrate(database)
      withNode(database) { node =>
        val (auction, lot) = liveFinal(node)
        val bidder = participant(4)
        node.bid(lot, node.nextPrice(lot), bidder)
        val stream = node.screen(auction)
        stream.state(_.at("/lot/leader").asText.startsWith("Участник"))

        val name = TelegramUsername.from("solegoof").getOrElse(fail("username refused"))
        SlickDisplayNameStore(node.system).choose(auction, bidder, ChosenName.Telegram(name)).futureValue
        stream.state(_.at("/lot/leader").asText == "@solegoof")
        stream.cancel()
      }
    }
  }

  /** Поток экрана, разобранный на события: heartbeat пропускается, `state` читается JSON. */
  private final class ScreenReader(queue: SinkQueueWithCancel[ByteString]) {
    private var buffer = ""
    private var waiting: Option[Future[Option[ByteString]]] = None

    /** Следующее состояние, удовлетворяющее `matches`, не позже `within`; промежуточные пропускаются. */
    def state(matches: JsonNode => Boolean, within: FiniteDuration = 20.seconds): JsonNode = {
      val deadline = within.fromNow
      var found: Option[JsonNode] = None
      while (found.isEmpty) {
        if (deadline.isOverdue()) fail(s"no matching screen state within $within")
        nextEvent(deadline).foreach(event => if (matches(event)) found = Some(event))
      }
      found.get
    }

    private def nextEvent(deadline: Deadline): Option[JsonNode] = {
      val end = buffer.indexOf("\n\n")
      if (end >= 0) {
        val frame = buffer.substring(0, end)
        buffer = buffer.substring(end + 2)
        frame.linesIterator.find(_.startsWith("data: ")).map(line => json.readTree(line.stripPrefix("data: ")))
      } else {
        val pull = waiting.getOrElse(queue.pull())
        try {
          val chunk = pull.futureValue(timeout(Span(deadline.timeLeft.max(1.milli).toMillis, Millis)))
          waiting = None
          buffer += chunk.getOrElse(fail("the screen stream ended")).utf8String
        } catch {
          case _: org.scalatest.exceptions.TestFailedException if !pull.isCompleted => waiting = Some(pull)
        }
        None
      }
    }

    def cancel(): Unit = queue.cancel()
  }

  extension (node: Node) {
    private def open(auction: AuctionId): HttpResponse =
      Http()(using node.system)
        .singleRequest(HttpRequest(uri = s"http://127.0.0.1:${node.port}/screen/${auction.value}/events"))
        .futureValue

    private def discard(response: HttpResponse): Unit =
      response.discardEntityBytes()(using Materializer(node.system)): Unit

    private def screen(auction: AuctionId): ScreenReader = {
      val response = node.open(auction)
      response.status shouldBe StatusCodes.OK
      ScreenReader(response.entity.dataBytes.runWith(Sink.queue[ByteString]())(using Materializer(node.system)))
    }
  }
}
