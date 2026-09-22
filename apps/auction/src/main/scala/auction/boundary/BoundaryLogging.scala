package auction.boundary

import net.logstash.logback.argument.StructuredArguments
import org.apache.pekko.http.scaladsl.model.StatusCode
import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.server.Directives.*
import org.apache.pekko.http.scaladsl.server.ExceptionHandler
import org.apache.pekko.http.scaladsl.server.Route
import org.slf4j.LoggerFactory

import java.util.concurrent.atomic.AtomicReference
import scala.jdk.CollectionConverters.*

/**
 * Заполнение каркаса лога на HTTP-границе.
 *
 * Границей стандарт называет место, где сервис принимает вызов и отвечает на него. Заполнение каркаса — работа границы,
 * а не вызываемого кода, поэтому маршруты о логе ничего не знают и логировать не обязаны.
 */
object BoundaryLogging {

  private val logger = LoggerFactory.getLogger(getClass)

  private val RequestIdHeader = "x-request-id"

  /**
   * Готовая к привязке граница: запечатывает маршрут, перехватывает неожиданный отказ и пишет ровно одну запись.
   *
   * Порядок здесь не косметика, и оба вложения решают одну и ту же задачу — не дать ответу появиться снаружи записи.
   *
   * Незапечатанный маршрут на неизвестном пути не отвечает, а отклоняется, и отклонение превращается в 404 выше по
   * стеку, то есть снаружи директивы. `mapResponse` такого ответа не видит, и запрос, на который сервис ответил, не
   * попадает в журнал вообще.
   *
   * Брошенное исключение `Route.seal` превращает в 500 своим штатным обработчиком, и до записи долетает только статус:
   * обязательные при неожиданном отказе поля `error` и `stack` заполнить нечем. Поэтому свой обработчик стоит внутри
   * `seal` — он перехватывает причину первым, кладёт её рядом с запросом и отвечает пустым 500, не вынося причину
   * наружу.
   */
  def boundary(route: Route): Route =
    extractRequestContext { ctx =>
      val startedAtNanos = System.nanoTime()
      // Держатель живёт ровно один запрос: тело extractRequestContext
      // вычисляется на каждый вызов заново.
      val failure = new AtomicReference[Option[Throwable]](None)

      mapResponse { response =>
        val frame = OperationFrame.of(
          operation = operationOf(ctx.request.method.value, ctx.request.uri.path.toString, response.status),
          status = response.status,
          durationUs = (System.nanoTime() - startedAtNanos) / 1000,
          requestId = ctx.request.headers.find(_.lowercaseName() == RequestIdHeader).map(_.value()),
          failure = failure.get()
        )

        logger.info("request handled", StructuredArguments.entries(frame.asJava))
        response
      } {
        Route.seal(handleExceptions(capturing(failure))(route))
      }
    }

  /**
   * Транспортное имя операции.
   *
   * Путь пишется дословно только у запроса, который маршрут обслужил. Ни один маршрут не совпал — значит путь придумал
   * клиент, и он ничем не ограничен: перебор адресов дал бы в журнале столько разных значений `operation`, сколько
   * строк клиент сумел прислать.
   */
  private[boundary] def operationOf(method: String, path: String, status: StatusCode): String = {
    val named = if (status == StatusCodes.NotFound) "<unmatched>" else path
    s"$method $named"
  }

  /**
   * Перехватывает неожиданный отказ, чтобы граница могла его записать.
   *
   * Сам он не логирует: у записи об отказе ровно один автор, и это запись операции выше. Наружу уходит пустой 500 —
   * причина остаётся оператору.
   */
  private def capturing(failure: AtomicReference[Option[Throwable]]): ExceptionHandler =
    ExceptionHandler { case cause =>
      failure.set(Some(cause))
      complete(StatusCodes.InternalServerError)
    }
}
