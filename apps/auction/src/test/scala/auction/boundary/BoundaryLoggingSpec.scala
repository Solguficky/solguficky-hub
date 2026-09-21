package auction.boundary

import ch.qos.logback.classic.spi.ILoggingEvent
import ch.qos.logback.classic.Logger as LogbackLogger
import ch.qos.logback.core.read.ListAppender
import org.apache.pekko.http.scaladsl.model.HttpHeader
import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.server.Directives.*
import org.apache.pekko.http.scaladsl.server.Route
import org.apache.pekko.http.scaladsl.testkit.ScalatestRouteTest
import org.scalatest.BeforeAndAfterEach
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec
import org.slf4j.LoggerFactory

import scala.annotation.tailrec
import scala.jdk.CollectionConverters.*

final class BoundaryLoggingSpec extends AnyWordSpec with Matchers with ScalatestRouteTest with BeforeAndAfterEach {

  // Перехват настоящего вывода логгера: без него негативный путь проверялся бы
  // только по статусу, а сама запись — то единственное, ради чего граница и
  // существует — оставалась бы непокрытой.
  private val appender = new ListAppender[ILoggingEvent]()

  // Имя берётся у самого объекта, а не собирается строкой: производственный код
  // зовёт LoggerFactory.getLogger(getClass) изнутри object, и это имя с хвостовым
  // `$`. Любая ручная нормализация даёт соседний логгер, до которого записи не
  // доходят.
  //
  // Ожидание здесь не перестраховка: пока один поток инициализирует backend,
  // SLF4J 2 отдаёт остальным SubstituteLogger, и приведение к logback падает.
  // Инициализацию начинает поток ActorSystem, который ScalatestRouteTest
  // поднимает в конструкторе сьюта, поэтому налетит на неё тот сьют, которому
  // не повезло с порядком запуска: отдельный прогон этого файла был зелёным,
  // а полный `just verify` — красным на том же коде.
  private lazy val boundaryLogger: LogbackLogger = {
    @tailrec
    def resolve(attemptsLeft: Int): LogbackLogger =
      LoggerFactory.getLogger(BoundaryLogging.getClass.getName) match {
        case logback: LogbackLogger => logback
        case _ if attemptsLeft > 0 =>
          Thread.sleep(50)
          resolve(attemptsLeft - 1)
        case other =>
          fail(s"slf4j did not settle on logback: ${other.getClass.getName}")
      }

    resolve(attemptsLeft = 40)
  }

  override def beforeEach(): Unit = {
    appender.list.clear()
    appender.start()
    boundaryLogger.addAppender(appender)
  }

  override def afterEach(): Unit = {
    boundaryLogger.detachAppender(appender)
    appender.stop()
  }

  private def recordedFrame: String = {
    val events = appender.list.asScala.toList
    events should have size 1
    events.head.getArgumentArray.head.toString
  }

  "boundary" should {

    "answer a served request through the wrapped route" in {
      Get("/health") ~> BoundaryLogging.boundary(HealthRoutes.route) ~> check {
        status shouldBe StatusCodes.OK
      }
    }

    // Незапечатанный маршрут отклонил бы запрос, 404 появился бы выше границы,
    // и запись об обслуженном запросе не попала бы в журнал вовсе.
    "answer an unserved path itself instead of letting the rejection escape" in {
      Get("/lots") ~> BoundaryLogging.boundary(HealthRoutes.route) ~> check {
        handled shouldBe true
        status shouldBe StatusCodes.NotFound
      }
    }

    "answer an unsupported method itself" in {
      Post("/health") ~> BoundaryLogging.boundary(HealthRoutes.route) ~> check {
        handled shouldBe true
        status shouldBe StatusCodes.MethodNotAllowed
      }
    }

    // Штатный обработчик Route.seal ответил бы тем же 500, но проглотил бы
    // причину до записи, и обязательные при неожиданном отказе поля `error`
    // и `stack` заполнить было бы нечем.
    "turn a thrown failure into an empty 500 without leaking its cause" in {
      val throwing: Route = get {
        throw new IllegalStateException("lot registry is not wired yet")
      }

      Get("/lots") ~> BoundaryLogging.boundary(throwing) ~> check {
        handled shouldBe true
        status shouldBe StatusCodes.InternalServerError
        responseAs[String] should not include "lot registry"
        responseAs[String] should not include "IllegalStateException"
      }
    }
  }

  "boundary record" should {

    "carry the frame of a served request and no scenario" in {
      Get("/health") ~> BoundaryLogging.boundary(HealthRoutes.route) ~> check {
        status shouldBe StatusCodes.OK
      }

      val frame = recordedFrame
      frame should include("operation=GET /health")
      frame should include("result=ok")
      frame should include("duration_us=")
      frame should not include "use_case"
      frame should not include "request_id"
    }

    "carry the request_id the caller sent" in {
      val header = HttpHeader.parse("x-request-id", "local-probe") match {
        case HttpHeader.ParsingResult.Ok(parsed, _) => parsed
        case other => fail(s"unexpected header parsing result: $other")
      }

      Get("/health").withHeaders(header) ~> BoundaryLogging.boundary(HealthRoutes.route) ~> check {
        status shouldBe StatusCodes.OK
      }

      recordedFrame should include("request_id=local-probe")
    }

    // Иначе перебор адресов неаутентифицированным клиентом пишет в журнал
    // столько разных operation, сколько строк он сумел прислать.
    "keep an unserved path out of the record" in {
      Get("/lots/../../etc/passwd") ~> BoundaryLogging.boundary(HealthRoutes.route) ~> check {
        status shouldBe StatusCodes.NotFound
      }

      val frame = recordedFrame
      frame should include("operation=GET <unmatched>")
      frame should not include "passwd"
      frame should include("error_category=invariant")
      frame should include("error=")
    }

    "carry the cause and its stack when something was thrown" in {
      val throwing: Route = get {
        throw new IllegalStateException("lot registry is not wired yet")
      }

      Get("/lots") ~> BoundaryLogging.boundary(throwing) ~> check {
        status shouldBe StatusCodes.InternalServerError
      }

      val frame = recordedFrame
      frame should include("result=error")
      frame should include("error_category=unexpected")
      frame should include("IllegalStateException")
      frame should include("stack=")
    }
  }
}
