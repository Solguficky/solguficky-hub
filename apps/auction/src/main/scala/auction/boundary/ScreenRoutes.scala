package auction.boundary

import auction.screen.Admission
import auction.screen.ScreenFeed
import auction.screen.ScreenViews
import org.apache.pekko.http.scaladsl.model.ContentType
import org.apache.pekko.http.scaladsl.model.ContentTypes
import org.apache.pekko.http.scaladsl.model.HttpEntity
import org.apache.pekko.http.scaladsl.model.HttpResponse
import org.apache.pekko.http.scaladsl.model.MediaType
import org.apache.pekko.http.scaladsl.model.MediaTypes
import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.model.headers.CacheDirectives
import org.apache.pekko.http.scaladsl.model.headers.RawHeader
import org.apache.pekko.http.scaladsl.model.headers.`Cache-Control`
import org.apache.pekko.http.scaladsl.server.Directives.*
import org.apache.pekko.http.scaladsl.server.Route
import org.apache.pekko.util.ByteString

import java.nio.charset.StandardCharsets
import java.util.UUID
import scala.concurrent.ExecutionContext
import scala.concurrent.Future
import scala.concurrent.duration.FiniteDuration

/**
 * Маршруты экрана зала (ADR-040, дополнение 2026-10-19) — единственная поверхность Auction без токена вызывающего:
 * браузер не вызывающий в смысле ADR-056. Адрес несёт идентификатор аукциона, и пропуском он не служит. Страница
 * `/screen/{auction_id}` (PER-485) читает поток того же адреса; её файлы — под `/screen/assets/`, внутри префикса,
 * который пропускает публичный вход (ADR-071).
 *
 * Поток — SSE с одним событием `state`, в `data` — JSON целого состояния. `id` нет: после переподключения приходит
 * свежий снимок, хвост не переигрывается. Heartbeat — комментарий SSE: по нему страница отличает тишину торгов от
 * обрыва.
 */
object ScreenRoutes {

  private val EventStream = ContentType(MediaTypes.`text/event-stream`)

  /** Год — «без срока» для кэша: адрес меняется вместе с версией изображения. */
  private val Immutable = RawHeader("Cache-Control", "public, max-age=31536000, immutable")

  /**
   * Страница и её файлы лежат ресурсами сервиса: сборки JS нет, в образ они едут runtime classpath. Отдаются только
   * названные файлы, а не каталог: путь из запроса до загрузчика ресурсов не доходит.
   */
  private val Assets: Set[String] = Set("screen.js", "connection.js", "screen.css")

  /**
   * Страница берёт ресурсы только у себя; данные из потока — ввод людей, и политика закрывает чужие скрипты, даже если
   * отрисовка однажды пропустит разметку.
   */
  private val Policy = RawHeader(
    "Content-Security-Policy",
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; " +
      "base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
  )

  /** Страница и её файлы меняются с выкладкой и адреса с версией не несут, поэтому кэш их перепроверяет. */
  private val pageHeaders = respondWithHeaders(`Cache-Control`(CacheDirectives.`no-cache`), Policy)

  def route(feed: ScreenFeed, views: ScreenViews, heartbeat: FiniteDuration): Route = {
    val html = page(heartbeat)
    pathPrefix("screen") {
      get {
        concat(
          path("assets" / Segment) { name =>
            if (Assets.contains(name))
              pageHeaders(getFromResource(s"screen/$name"))
            else complete(StatusCodes.NotFound)
          },
          pathPrefix(JavaUUID) { auctionId =>
            concat(
              // Страница одна на все аукционы и о сходке не спрашивает: «не найдено» скажет поток, а одинаковый
              // ответ на любой идентификатор ничего не выдаёт.
              pathEndOrSingleSlash {
                pageHeaders(complete(HttpEntity(ContentTypes.`text/html(UTF-8)`, html)))
              },
              path("events")(events(feed, auctionId, heartbeat)),
              path("lots" / JavaUUID / "images" / Segment) { (lotId, version) =>
                image(feed, views, auctionId, lotId, version)
              }
            )
          }
        )
      }
    }
  }

  /**
   * Период heartbeat страница получает из разметки: предел тишины — три периода (`connection.js`), и сервис с другим
   * периодом не оставляет страницу с чужим порогом.
   */
  private[boundary] def page(heartbeat: FiniteDuration): String = {
    val source = Option(getClass.getClassLoader.getResourceAsStream("screen/index.html"))
      .getOrElse(throw IllegalStateException("screen/index.html is not on the classpath"))
    try String(source.readAllBytes(), StandardCharsets.UTF_8).replace("{{heartbeat-ms}}", heartbeat.toMillis.toString)
    finally source.close()
  }

  /**
   * Место занимается до Meetups: отказанное подключение не порождает вызова, а подключения, ждущие ответа Meetups,
   * считаются в пределе. Отказ — `503`, и страница повторяет попытку с растущей паузой и случайной добавкой.
   */
  private def events(feed: ScreenFeed, auctionId: UUID, heartbeat: FiniteDuration): Route =
    if (!feed.limit.reserve()) complete(StatusCodes.ServiceUnavailable)
    else
      admitted(feed.admit(auctionId).andThen(_ => feed.limit.release())(using ExecutionContext.parasitic)) {
        // Прокси не должен копить поток: заголовок снимает буферизацию у nginx-подобных, Cache-Control — у остальных.
        respondWithHeaders(`Cache-Control`(CacheDirectives.`no-cache`), RawHeader("X-Accel-Buffering", "no")) {
          complete(
            HttpResponse(entity =
              HttpEntity.Chunked.fromData(
                EventStream,
                feed
                  .states(auctionId)
                  .map(json => ScreenRoutes.state(json))
                  .keepAlive(heartbeat, () => ScreenRoutes.Heartbeat)
              )
            )
          )
        }
      }

  private def image(feed: ScreenFeed, views: ScreenViews, auctionId: UUID, lotId: UUID, version: String): Route =
    admitted(feed.admit(auctionId)) {
      onSuccess(views.image(auctionId, lotId, version)) {
        case None => complete(StatusCodes.NotFound)
        case Some(found) =>
          MediaType.parse(found.mediaType) match {
            case Right(binary: MediaType.Binary) =>
              respondWithHeader(Immutable) {
                complete(HttpEntity(ContentType(binary), IArray.genericWrapArray(found.content).toArray))
              }
            case _ => throw IllegalStateException(s"lot_catalog of lot $lotId holds media type ${found.mediaType}")
          }
      }
    }

  /** «Не найдено» одинаково для скрытой, отменённой до торгов и отсутствующей сходки и для удалённого аукциона. */
  private def admitted(admission: Future[Admission])(inner: Route): Route =
    onSuccess(admission) {
      case Admission.Open => inner
      case Admission.NotFound => complete(StatusCodes.NotFound)
      case Admission.Unavailable => complete(StatusCodes.ServiceUnavailable)
    }

  /** JSON экрана — одна строка (Jackson без отступов), поэтому одного поля `data` хватает. */
  private[boundary] def state(json: String): ByteString = ByteString(s"event: state\ndata: $json\n\n")

  private[boundary] val Heartbeat: ByteString = ByteString(": heartbeat\n\n")
}
