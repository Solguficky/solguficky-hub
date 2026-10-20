package auction.boundary

import auction.screen.Admission
import auction.screen.ScreenFeed
import auction.screen.ScreenViews
import org.apache.pekko.http.scaladsl.model.ContentType
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

import java.util.UUID
import scala.concurrent.duration.FiniteDuration

/**
 * Маршруты экрана зала (ADR-040, дополнение 2026-10-19) — единственная поверхность Auction без токена вызывающего:
 * браузер не вызывающий в смысле ADR-056. Адрес несёт идентификатор аукциона, и пропуском он не служит.
 *
 * Поток — SSE с одним событием `state`, в `data` — JSON целого состояния. `id` нет: после переподключения приходит
 * свежий снимок, хвост не переигрывается. Heartbeat — комментарий SSE: по нему страница отличает тишину торгов от
 * обрыва.
 */
object ScreenRoutes {

  private val EventStream = ContentType(MediaTypes.`text/event-stream`)

  /** Год — «без срока» для кэша: адрес меняется вместе с версией изображения. */
  private val Immutable = RawHeader("Cache-Control", "public, max-age=31536000, immutable")

  def route(feed: ScreenFeed, views: ScreenViews, heartbeat: FiniteDuration): Route =
    pathPrefix("screen" / JavaUUID) { auctionId =>
      get {
        concat(
          path("events")(events(feed, auctionId, heartbeat)),
          path("lots" / JavaUUID / "images" / Segment) { (lotId, version) =>
            image(feed, views, auctionId, lotId, version)
          }
        )
      }
    }

  /**
   * Предел проверяется до Meetups: отказанное подключение не порождает вызова. Отказ — `503`, и страница повторяет
   * попытку с растущей паузой и случайной добавкой.
   */
  private def events(feed: ScreenFeed, auctionId: UUID, heartbeat: FiniteDuration): Route =
    if (feed.limit.full) complete(StatusCodes.ServiceUnavailable)
    else
      admitted(feed, auctionId) {
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
    admitted(feed, auctionId) {
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
  private def admitted(feed: ScreenFeed, auctionId: UUID)(inner: Route): Route =
    onSuccess(feed.admit(auctionId)) {
      case Admission.Open => inner
      case Admission.NotFound => complete(StatusCodes.NotFound)
      case Admission.Unavailable => complete(StatusCodes.ServiceUnavailable)
    }

  /** JSON экрана — одна строка (Jackson без отступов), поэтому одного поля `data` хватает. */
  private[boundary] def state(json: String): ByteString = ByteString(s"event: state\ndata: $json\n\n")

  private[boundary] val Heartbeat: ByteString = ByteString(": heartbeat\n\n")
}
