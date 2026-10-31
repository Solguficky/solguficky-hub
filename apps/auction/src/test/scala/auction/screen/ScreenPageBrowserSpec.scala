package auction.screen

import auction.lot.LotFixtures.participant
import auction.lot.Money
import auction.persistence.JournalSchema
import auction.testkit.PostgresFixture
import auction.testkit.StallingProxy
import com.microsoft.playwright.Browser
import com.microsoft.playwright.Page
import com.microsoft.playwright.Playwright
import com.microsoft.playwright.assertions.LocatorAssertions
import com.microsoft.playwright.assertions.PlaywrightAssertions.assertThat
import com.typesafe.config.ConfigFactory
import org.scalatest.concurrent.Eventually
import org.scalatest.concurrent.ScalaFutures
import org.scalatest.matchers.should.Matchers
import org.scalatest.time.Millis
import org.scalatest.time.Seconds
import org.scalatest.time.Span
import org.scalatest.wordspec.AnyWordSpec

import java.time.Instant
import java.util.UUID
import scala.concurrent.ExecutionContext
import scala.concurrent.Future
import scala.concurrent.Promise
import scala.concurrent.duration.*
import scala.jdk.CollectionConverters.*

/**
 * Страница экрана зала (PER-485) в настоящем Chromium против настоящего узла: первое открытие, обрыв и восстановление,
 * и подпись времени финала (PER-701). Между браузером и узлом — `StallingProxy`: обрыв зала — замолкшая сеть, а не
 * закрытое соединение, и замечает его только сторож тишины страницы.
 *
 * Сьют называется `*BrowserSpec` и идёт только под `AUCTION_BROWSER_TESTS=1`: ему нужны Docker и скачанный Chromium той
 * версии, что у Playwright в `build.sbt`.
 */
final class ScreenPageBrowserSpec
    extends AnyWordSpec
    with Matchers
    with PostgresFixture
    with ScalaFutures
    with Eventually
    with ScreenNodes {

  implicit override val patienceConfig: PatienceConfig =
    PatienceConfig(timeout = Span(60, Seconds), interval = Span(100, Millis))

  private val heartbeat = 1.second

  /** Предел тишины страницы — три периода heartbeat (`silenceLimit` в `connection.js`). */
  private val silence = heartbeat * 3

  private var playwright: Option[Playwright] = None

  private def browser(): Browser = {
    val started = playwright.getOrElse(Playwright.create())
    playwright = Some(started)
    started.chromium().launch()
  }

  override protected def afterAll(): Unit =
    try playwright.foreach(_.close())
    finally super.afterAll()

  /** Meetups, который молчит, пока сьют его не отпустит: так страница видна до первого снимка. */
  private final class HeldStandings extends MeetupStandings {
    private val gate = Promise[Unit]()
    def release(): Unit = gate.trySuccess(()): Unit
    def standing(meetup: UUID): Future[StandingAnswer] =
      gate.future.flatMap(_ => Visible.standing(meetup))(using ExecutionContext.parasitic)
  }

  "the screen page" should {

    "show connecting before the first snapshot, warn within the silence limit and lift the warning only with a snapshot" in {
      val database = freshDatabase()
      JournalSchema.migrate(database)
      val standings = HeldStandings()
      val overrides = ConfigFactory.parseString(s"auction.screen.heartbeat = ${heartbeat.toMillis}ms")
      withNode(database, overrides, standings) { node =>
        val (auction, lot) = liveFinal(node)
        val proxy = StallingProxy(node.port)(using node.system)
        val chromium = browser()
        try {
          val page = chromium.newPage()
          page.addInitScript(StatusRecorder)
          page.navigate(s"http://127.0.0.1:${proxy.port}/screen/${auction.value}")

          // Первое открытие: Meetups ещё не ответил, снимка нет — цена и лидер не выдумываются.
          awaitStatus(page, "connecting")
          assertThat(page.locator("#screen")).hasText("Подключение…")
          assertThat(page.locator(".price")).hasCount(0)
          standings.release()
          awaitStatus(page, "live")
          assertThat(page.locator("#banner")).isHidden()
          // История пишется: без неё проверка окна ниже прошла бы на пустом списке.
          history(page) should contain("live")

          // Обрыв: сеть замолкла, соединение не закрыто. Предупреждение — не позже предела тишины.
          proxy.silence()
          val cut = System.nanoTime()
          awaitStatus(page, "stale", within = silence + 2.seconds)
          (System.nanoTime() - cut).nanos should be <= silence + 1.second
          assertThat(page.locator("#banner")).isVisible()
          val stale = digits(page)

          // Пока сеть лежит, торги идут.
          val next = node.nextPrice(lot)
          node.bid(lot, next, participant(2))

          // Соединение открылось, а снимок не пришёл: предупреждение остаётся, цена — прежняя. Сторож страницы
          // всё равно вернул бы «stale» через предел тишины, поэтому проверяется вся история за весь предел, а
          // не итог.
          val mark = history(page).size
          proxy.headersOnly()
          eventually(proxy.headersOnlyResponses should be > 0)
          Thread.sleep(silence.toMillis)
          history(page).drop(mark) should not contain "live"
          awaitStatus(page, "stale")
          digits(page) shouldBe stale

          // Сеть вернулась: предупреждение снимает только новый снимок, и он несёт ставку из обрыва.
          proxy.restore()
          awaitStatus(page, "live", within = 60.seconds)
          assertThat(page.locator("#banner")).isHidden()
          digits(page) shouldBe expected(next)

          // Вне активного лота: ведущий закрыл последний лот состава, и экран показывает итог сбора. Снимок итога
          // идёт через проекции лота и аукциона, а сторож тишины страницы ждёт три периода heartbeat: на загруженной
          // машине снимок приходит позже, и молчание до него — не повод считать проверку проваленной.
          node.close(auction, lot)
          val settled = 30.seconds.toMillis.toDouble
          assertThat(page.locator(".title"))
            .hasText("Аукцион завершён", LocatorAssertions.HasTextOptions().setTimeout(settled))
          assertThat(page.locator(".totals"))
            .containsText("1 лот", LocatorAssertions.ContainsTextOptions().setTimeout(settled))
          awaitStatus(page, "live")
        } finally {
          chromium.close()
          proxy.close()
        }
      }
    }

    "write the final time in the community zone and follow its change and removal without a reload" in {
      val database = freshDatabase()
      JournalSchema.migrate(database)
      withNode(database) { node =>
        val auction = drafted(node)
        val chromium = browser()
        try {
          val page = chromium.newPage()
          // Часы страницы стоят: подпись «в тот же день» зависит от сегодняшней даты в поясе сообщества.
          page.clock().setFixedTime(Instant.parse("2026-10-23T12:00:00Z").toEpochMilli)
          page.navigate(s"http://127.0.0.1:${node.port}/screen/${auction.value}")
          val finale = page.locator(".finale")

          awaitStatus(page, "live")
          assertThat(finale).hasText("Финал скоро")

          node.finalTime(auction, Some(Instant.parse("2026-10-23T16:00:00Z")))
          assertThat(finale).hasText("Финал в 19:00")

          // Смена на другой день — тот же экран, без перезагрузки: подпись берёт дату.
          node.finalTime(auction, Some(Instant.parse("2026-10-24T19:30:00Z")))
          assertThat(finale).hasText("Финал 24 октября в 22:30")

          node.finalTime(auction, None)
          assertThat(finale).hasText("Финал скоро")
        } finally chromium.close()
      }
    }
  }

  /**
   * Каждая запись `data-status` страницы с самого открытия, в порядке записи: итог в момент проверки не видит
   * состояния, которое страница успела показать и сменить. Скрипт идёт до разбора разметки, когда корневого элемента
   * ещё может не быть, поэтому наблюдается сам документ.
   */
  private val StatusRecorder =
    """window.statusHistory = [];
      |new MutationObserver((records) => {
      |  for (const record of records) window.statusHistory.push(record.target.dataset.status);
      |}).observe(document, { subtree: true, attributes: true, attributeFilter: ["data-status"] });
      |""".stripMargin

  private def history(page: Page): List[String] =
    page.evaluate("() => window.statusHistory").asInstanceOf[java.util.List[?]].asScala.map(_.toString).toList

  private def awaitStatus(page: Page, value: String, within: FiniteDuration = 10.seconds): Unit =
    assertThat(page.locator("body"))
      .hasAttribute("data-status", value, LocatorAssertions.HasAttributeOptions().setTimeout(within.toMillis.toDouble))

  /**
   * Цифры текущей ставки на экране: разделители разрядов и знак валюты зависят от локали, сумма — нет. С PER-839
   * главная цифра `.price` — снова текущая ставка, и она же несёт `.current-price`.
   */
  private def digits(page: Page): String = page.locator(".current-price").textContent().replaceAll("\\D", "")

  /** Копейки экран показывает, только когда они есть (`money` в `screen.js`). */
  private def expected(price: Money): String =
    if (price.minorUnits % 100 == 0) (price.minorUnits / 100).toString else price.minorUnits.toString
}
