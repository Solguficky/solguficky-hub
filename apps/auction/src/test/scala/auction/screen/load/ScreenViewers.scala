package auction.screen.load

import com.fasterxml.jackson.databind.ObjectMapper
import com.google.gson.JsonObject
import com.microsoft.playwright.Browser
import com.microsoft.playwright.CDPSession
import com.microsoft.playwright.Page
import com.microsoft.playwright.Playwright
import org.apache.pekko.actor.typed.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model.HttpRequest
import org.apache.pekko.http.scaladsl.model.HttpResponse
import org.apache.pekko.http.scaladsl.model.MediaTypes
import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.model.Uri
import org.apache.pekko.http.scaladsl.model.headers.Accept
import org.apache.pekko.stream.KillSwitches
import org.apache.pekko.stream.UniqueKillSwitch
import org.apache.pekko.stream.scaladsl.Flow
import org.apache.pekko.stream.scaladsl.Framing
import org.apache.pekko.stream.scaladsl.Keep
import org.apache.pekko.stream.scaladsl.Sink
import org.apache.pekko.stream.scaladsl.Source
import org.apache.pekko.util.ByteString

import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicBoolean
import scala.concurrent.ExecutionContext
import scala.concurrent.Future
import scala.concurrent.duration.*
import scala.jdk.CollectionConverters.*
import scala.util.Random
import scala.util.control.NonFatal

/** Ответ на подключение к потоку: момент и код; `0` — соединение не состоялось. */
final case class Answer(at: Long, status: Int)

/**
 * Адрес экрана: `http://127.0.0.1:8080` локального стенда или публичный вход stage. Страница и поток строятся от одной
 * строки, поэтому префикс пути и завершающий `/` адреса у них одинаковы.
 */
final case class ScreenTarget(base: Uri) {
  def page(auction: String): String = s"${base.toString.stripSuffix("/")}/screen/$auction"
  def events(auction: String): Uri = Uri(s"${page(auction)}/events")
}

/**
 * Лёгкий зритель экрана — поток `/screen/{auction_id}/events` без браузера, каждый на своём соединении, как отдельная
 * вкладка. После конца потока или отказа он повторяет подключение тем же правилом паузы, что страница, поэтому рестарт
 * и занятый предел нагружают сервис так же. Медленный зритель (`slow`) читает поток по строке в 30 секунд: сервер
 * упирается в его окно TCP, а торги ждать его не должны (ADR-040, «Состояние и восстановление»).
 */
final class StreamViewer(target: ScreenTarget, auction: String, slow: Boolean)(using system: ActorSystem[?]) {

  private given ExecutionContext = system.executionContext

  private val running = AtomicBoolean(false)
  @volatile private var stream: Option[UniqueKillSwitch] = None

  val seen = ConcurrentLinkedQueue[Seen]()
  val answers = ConcurrentLinkedQueue[Answer]()

  /** Цена последнего события `state` — по ней прогон сверяет актуальность в конце. */
  @volatile var lastPrice: Option[Long] = None
  @volatile var states: Int = 0

  def start(): Unit = if (running.compareAndSet(false, true)) loop(0)

  def stop(): Unit = {
    running.set(false)
    stream.foreach(_.shutdown())
  }

  /** Тот же счёт попыток, что в `run` страницы: паузу сбрасывает только соединение со снимком дольше самой длинной. */
  private def loop(attempt: Int): Unit =
    if (running.get) {
      val started = System.currentTimeMillis()
      connect().foreach { delivered =>
        val current = if (delivered && System.currentTimeMillis() - started >= ScreenLatency.MaxRetryMs) 0 else attempt
        val pause = ScreenLatency.retryDelay(current, Random.nextDouble())
        if (running.get) system.scheduler.scheduleOnce(pause.millis, () => loop(current + 1)): Unit
      }
    }

  private def connection: Flow[HttpRequest, HttpResponse, ?] = {
    val authority = target.base.authority
    if (target.base.scheme == "https") Http().outgoingConnectionHttps(authority.host.address, authority.port max 443)
    else Http().outgoingConnection(authority.host.address, authority.port max 80)
  }

  /** Одно подключение до конца потока: `true`, если оно успело дать событие `state`. */
  private def connect(): Future[Boolean] = {
    val request =
      HttpRequest(uri = target.events(auction).toRelative).withHeaders(Accept(MediaTypes.`text/event-stream`))
    Source
      .single(request)
      .via(connection)
      .runWith(Sink.head)
      .flatMap { response =>
        answers.add(Answer(System.currentTimeMillis(), response.status.intValue))
        // Остановленный во время подключения зритель поток не читает: иначе он держал бы место в пределе после ухода.
        if (response.status != StatusCodes.OK || !running.get) response.discardEntityBytes().future.map(_ => false)
        else read(response)
      }
      .recover { case NonFatal(_) =>
        answers.add(Answer(System.currentTimeMillis(), 0))
        false
      }
  }

  private def read(response: HttpResponse): Future[Boolean] = {
    val delivered = AtomicBoolean(false)
    var event = ""
    val pace = if (slow) Flow[String].throttle(1, 30.seconds) else Flow[String]
    // Сторож тишины, как у страницы: без него тихо оборванный поток (туннель без FIN) выглядел бы живым. Медленному
    // зрителю сторож не ставится — его тишина намеренная.
    val watchdog =
      if (slow) Flow[ByteString] else Flow[ByteString].idleTimeout(StreamViewer.Silence)
    val (kill, done) = response.entity.dataBytes
      .via(watchdog)
      .via(Framing.delimiter(ByteString("\n"), maximumFrameLength = 1 << 20, allowTruncation = true))
      .map(_.utf8String)
      .viaMat(KillSwitches.single)(Keep.right)
      .via(pace)
      .toMat(Sink.foreach { line =>
        if (line.startsWith("event:")) event = line.drop(6).trim
        else if (line.startsWith("data:") && event == "state") {
          state(line.drop(5).trim)
          delivered.set(true)
        } else if (line.isEmpty) event = ""
      })(Keep.both)
      .run()
    stream = Some(kill)
    if (!running.get) kill.shutdown()
    done.map(_ => delivered.get).recover { case NonFatal(_) => delivered.get }
  }

  private def state(json: String): Unit = {
    states += 1
    ScreenViewers.price(json).foreach { price =>
      seen.add(Seen(System.currentTimeMillis(), price))
      lastPrice = Some(price)
    }
  }
}

object StreamViewer {

  /**
   * Три периода heartbeat по умолчанию (`auction.screen.heartbeat` = 5 с) — тот же предел, что `silenceLimit` страницы.
   */
  val Silence: FiniteDuration = 15.seconds
}

/**
 * Настоящие страницы экрана в Chromium. Каждая — в своём контексте браузера: у контекста свой пул соединений, а в общем
 * пуле шестой поток HTTP/1.1 к одному адресу ждал бы, пока закроется один из пяти. Страница пишет в `window.screenLoad`
 * моменты применения цены, смены статуса и ответы на свои подключения; прогон забирает их в конце.
 *
 * Playwright не потокобезопасен: все вызовы — из одного потока, того, что ведёт прогон.
 */
final class PageViewers(urls: Seq[String]) {

  // Без страниц браузер не запускается: базовая линия снимается без Chromium на машине прогона.
  private val playwright = Option.when(urls.nonEmpty)(Playwright.create())
  private val browser: Option[Browser] = playwright.map(_.chromium().launch())
  private var sessions = Map.empty[Int, CDPSession]

  val pages: Vector[Page] = urls.toVector.map { url =>
    val page = browser.get.newContext().newPage()
    page.addInitScript(ScreenViewers.Recorder)
    page.navigate(url)
    page
  }

  /**
   * Фоновая вкладка: Chromium замораживает страницу — таймеры и задачи стоят, поток копится в сети. Это заморозка
   * браузера на этой машине, а не вкладка телефона в фоне: ту проверяет владелец руками.
   */
  def freeze(index: Int): Unit = lifecycle(index, "frozen")

  def thaw(index: Int): Unit = lifecycle(index, "active")

  private def lifecycle(index: Int, state: String): Unit = {
    val session = sessions.getOrElse(index, pages(index).context().newCDPSession(pages(index)))
    sessions += index -> session
    val args = JsonObject()
    args.addProperty("state", state)
    session.send("Page.setWebLifecycleState", args): Unit
  }

  /** Цены, которые страница применила в статусе `live`, по возрастанию момента. */
  def seen(index: Int): Vector[Seen] =
    records(index, "seen").flatMap(r => ScreenLatency.pagePrice(r("price").toString).map(Seen(long(r("at")), _)))

  def answers(index: Int): Vector[Answer] =
    records(index, "fetches").map(r => Answer(long(r("at")), long(r("status")).toInt))

  def statuses(index: Int): Vector[(Long, String)] =
    records(index, "statuses").map(r => long(r("at")) -> String.valueOf(r("status")))

  def lastPrice(index: Int): Option[Long] = seen(index).lastOption.map(_.price)

  def close(): Unit = playwright.foreach(_.close())

  private def records(index: Int, key: String): Vector[Map[String, Any]] =
    pages(index)
      .evaluate(s"() => window.screenLoad.$key")
      .asInstanceOf[java.util.List[?]]
      .asScala
      .toVector
      .map(_.asInstanceOf[java.util.Map[String, Any]].asScala.toMap)

  private def long(value: Any): Long = value match {
    case number: java.lang.Number => number.longValue
    case other => other.toString.toLong
  }
}

object ScreenViewers {

  private val json = ObjectMapper()

  /** Цена активного лота из события `state`; вне фазы `lot` её нет. */
  def price(data: String): Option[Long] = {
    val root = json.readTree(data)
    if (root.path("phase").asText() != "lot") None
    else Option(root.path("lot").path("price").get("amount")).filter(_.canConvertToLong).map(_.asLong())
  }

  /**
   * Скрипт страницы до её кода. Обёртка `fetch` записывает каждое подключение к потоку и код ответа (сбой сети — `0`),
   * наблюдатель — момент, когда отрисовка сменила цену или статус. Наблюдатель срабатывает в той же задаче, что
   * `render`, поэтому момент — применение состояния, а не появление пикселей. Цена пишется только в статусе `live`:
   * устаревшая цена зачёркнута и применённой не считается.
   */
  val Recorder: String =
    """window.screenLoad = { seen: [], fetches: [], statuses: [] };
      |const originalFetch = window.fetch.bind(window);
      |window.fetch = (...args) => {
      |  const record = { at: Date.now(), status: 0 };
      |  window.screenLoad.fetches.push(record);
      |  return originalFetch(...args).then((response) => {
      |    record.status = response.status;
      |    return response;
      |  });
      |};
      |let lastPrice = null;
      |let lastStatus = null;
      |new MutationObserver(() => {
      |  const at = Date.now();
      |  const status = document.body ? document.body.dataset.status ?? null : null;
      |  if (status !== lastStatus) {
      |    lastStatus = status;
      |    window.screenLoad.statuses.push({ at, status });
      |  }
      |  const node = document.querySelector(".price");
      |  const price = node === null ? null : node.textContent;
      |  if (status === "live" && price !== null && price !== lastPrice) {
      |    lastPrice = price;
      |    window.screenLoad.seen.push({ at, price });
      |  }
      |}).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
      |""".stripMargin
}
