package auction.boundary

import org.apache.pekko.http.scaladsl.model.ContentTypes
import org.apache.pekko.http.scaladsl.model.HttpEntity
import org.apache.pekko.http.scaladsl.server.Directives.*
import org.apache.pekko.http.scaladsl.server.Route

/**
 * Health-эндпоинт сервиса.
 *
 * Отвечает только за живость процесса и HTTP-границы. Готовность зависимостей он не проверяет: у сервиса их пока нет, а
 * признак, который всегда возвращает «да», неотличим от неработающей проверки.
 */
object HealthRoutes {

  private val okBody = """{"status":"ok"}"""

  val route: Route =
    path("health") {
      get {
        complete(HttpEntity(ContentTypes.`application/json`, okBody))
      }
    }
}
