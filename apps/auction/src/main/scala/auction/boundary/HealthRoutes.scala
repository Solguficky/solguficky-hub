package auction.boundary

import auction.Readiness
import org.apache.pekko.http.scaladsl.model.ContentTypes
import org.apache.pekko.http.scaladsl.model.HttpEntity
import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.server.Directives.*
import org.apache.pekko.http.scaladsl.server.Route

import scala.concurrent.Future

/**
 * Health-эндпоинт сервиса — проба готовности.
 *
 * `200` отвечает только узел, который может принять команду агрегата: кластер поднят и журнал отвечает. Иначе `503` с
 * причиной, и граница записывает его категорией `dependency_unavailable`. Отдельного liveness нет: его пока некому
 * читать, а проба AppHost спрашивает этот путь.
 */
object HealthRoutes {

  private val okBody = """{"status":"ok"}"""

  def route(readiness: () => Future[Readiness]): Route =
    path("health") {
      get {
        onSuccess(readiness()) {
          case Readiness.Ready => complete(HttpEntity(ContentTypes.`application/json`, okBody))
          case Readiness.ClusterNotUp => notReady("cluster")
          case Readiness.JournalUnavailable => notReady("journal")
        }
      }
    }

  private def notReady(reason: String): Route =
    complete(
      StatusCodes.ServiceUnavailable,
      HttpEntity(ContentTypes.`application/json`, s"""{"status":"not ready","reason":"$reason"}""")
    )
}
