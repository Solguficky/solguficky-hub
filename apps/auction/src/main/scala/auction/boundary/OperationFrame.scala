package auction.boundary

import io.grpc.Status
import org.apache.pekko.http.scaladsl.model.StatusCode

/**
 * Каркас записи об операции из [[docs/standards/observability/logging.md]].
 *
 * Здесь только чистое отображение «что вернула граница» в поля записи: сам вывод делает [[BoundaryLogging]]. Поле
 * `service` заполняет logback как константу сборки, а `use_case` у операции без сценария отсутствует — health-проверку
 * не начинал человек.
 */
object OperationFrame {

  def of(
      operation: String,
      status: StatusCode,
      durationUs: Long,
      requestId: Option[String],
      failure: Option[Throwable] = None
  ): Map[String, String] = {
    val failed = status.intValue >= 400

    val base = Map(
      "operation" -> operation,
      "result" -> (if (failed) "error" else "ok"),
      "duration_us" -> durationUs.toString
    )

    // Поле, которое нечем заполнить, опускается, а не пишется пустым: пустое
    // значение неотличимо от заполненного при запросе на существование поля.
    // Свой request_id сервис не рождает — его рождает край цепочки.
    val withRequestId =
      requestId.filter(_.nonEmpty).fold(base)(id => base + ("request_id" -> id))

    if (!failed) withRequestId
    else {
      val classified = withRequestId ++ Map(
        "error_category" -> errorCategory(status),
        "error" -> errorText(status, failure)
      )
      // stack обязателен только при неожиданном отказе, а не при любом:
      // у отклонённого входа стека нет и придумывать его нечем.
      failure.fold(classified)(cause => classified + ("stack" -> framesOf(cause)))
    }
  }

  /**
   * Запись gRPC-операции. Код транспорта пишется своим полем `grpc_code`, а не в `result` (стандарт, «Поля»).
   *
   * Текст отказа санитизирован по построению: у статуса это код и описание, которое сервис написал сам и которое
   * называет поле или правило, но не значение из запроса; у неожиданного отказа — только класс исключения. Сообщение
   * исключения сюда не попадает: например, PostgreSQL кладёт в текст нарушения ограничения значения строки, то есть
   * ввод администратора.
   *
   * @param useCase
   *   значение заголовка `x-use-case`: сценарий рождается на краю, сервис его только переносит
   */
  def grpc(
      operation: String,
      code: Status.Code,
      description: Option[String],
      durationUs: Long,
      requestId: Option[String],
      useCase: Option[String],
      failure: Option[Throwable] = None
  ): Map[String, String] = {
    val failed = code != Status.Code.OK

    val base = Map(
      "operation" -> operation,
      "result" -> (if (failed) "error" else "ok"),
      "duration_us" -> durationUs.toString,
      "grpc_code" -> code.name
    ) ++ requestId.filter(_.nonEmpty).map("request_id" -> _) ++ useCase.filter(_.nonEmpty).map("use_case" -> _)

    if (!failed) base
    else {
      val text = failure.fold(description.fold(code.name)(text => s"${code.name}: $text"))(_.getClass.getName)
      val classified = base ++ Map("error_category" -> errorCategory(code), "error" -> text)
      failure.fold(classified)(cause => classified + ("stack" -> framesOf(cause)))
    }
  }

  /**
   * Стек без сообщений: класс и кадры каждого исключения цепочки причин. `printStackTrace` начинает каждое звено с
   * сообщения, и запрет на ввод в `error` обходился бы через `stack`.
   */
  private def framesOf(cause: Throwable): String = {
    val buffer = new StringBuilder
    @scala.annotation.tailrec
    def chain(current: Throwable, prefix: String, seen: Set[Throwable]): Unit =
      if (current != null && !seen.contains(current)) {
        buffer.append(prefix).append(current.getClass.getName).append('\n')
        current.getStackTrace.foreach(frame => buffer.append("\tat ").append(frame).append('\n'))
        chain(current.getCause, "Caused by: ", seen + current)
      }
    chain(cause, "", Set.empty)
    buffer.toString
  }

  /**
   * Отображение gRPC-кода в тот же словарь. `UNAUTHENTICATED` — отказ процессу-вызывающему (ADR-056), и он тоже
   * `authorization`: причина — дефект развёртывания или чужой процесс — лежит рядом полем `caller_refusal`, а не в
   * отдельной категории словаря.
   */
  private def errorCategory(code: Status.Code): String =
    code match {
      case Status.Code.UNAUTHENTICATED | Status.Code.PERMISSION_DENIED => "authorization"
      case Status.Code.DEADLINE_EXCEEDED => "timeout"
      case Status.Code.UNAVAILABLE => "dependency_unavailable"
      case Status.Code.INVALID_ARGUMENT | Status.Code.NOT_FOUND | Status.Code.FAILED_PRECONDITION |
          Status.Code.ALREADY_EXISTS | Status.Code.UNIMPLEMENTED =>
        "invariant"
      case _ => "unexpected"
    }

  /**
   * Отображение HTTP-статуса в общий для всех сервисов словарь категорий.
   *
   * `visibility` транспорт сам не выставляет: стандарт описывает его как отказ, который домен намеренно маскирует под
   * «не найдено», поэтому категорию выбирает доменный обработчик, а не код статуса. Обычный 404 на неизвестном пути —
   * это нарушенное правило входа, то есть `invariant`.
   */
  private def errorCategory(status: StatusCode): String =
    status.intValue match {
      case 401 | 403 => "authorization"
      case 408 | 504 => "timeout"
      case 503 => "dependency_unavailable"
      case code if code >= 500 => "unexpected"
      case _ => "invariant"
    }

  /**
   * Текст отказа.
   *
   * У неожиданного отказа это только класс исключения, у отклонённого входа — причина статуса. Второй случай не
   * заглушка: отклонение рождается в самом транспорте, и другого текста у него нет.
   *
   * Сообщение исключения сюда не попадает, как и в [[grpc]]: в сервис приходит пользовательский текст — карточка
   * администратора и псевдоним участника, — а PostgreSQL кладёт значения строки в текст нарушения ограничения. Правило
   * держится одинаково на обеих границах, а не только там, где ввод приходит сегодня.
   */
  private def errorText(status: StatusCode, failure: Option[Throwable]): String =
    failure.fold(status.reason)(_.getClass.getName)
}
