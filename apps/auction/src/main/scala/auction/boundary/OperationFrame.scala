package auction.boundary

import org.apache.pekko.http.scaladsl.model.StatusCode

import java.io.PrintWriter
import java.io.StringWriter

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
      failure.fold(classified)(cause => classified + ("stack" -> stackOf(cause)))
    }
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
   * У неожиданного отказа это класс и сообщение исключения, у отклонённого входа — причина статуса. Второй случай не
   * заглушка: отклонение рождается в самом транспорте, и другого текста у него нет.
   *
   * Сообщение исключения подчиняется запретам стандарта наравне с остальными полями. Сейчас в сервис не приходит
   * пользовательский ввод, поэтому попасть в текст ему неоткуда; первый обработчик, который такой ввод примет, обязан
   * принести сюда санитизацию — об этом сказано в `AGENTS.md` компонента.
   */
  private def errorText(status: StatusCode, failure: Option[Throwable]): String =
    failure match {
      case Some(cause) =>
        Option(cause.getMessage).fold(cause.getClass.getName)(message => s"${cause.getClass.getName}: $message")
      case None => status.reason
    }

  private def stackOf(cause: Throwable): String = {
    val buffer = new StringWriter()
    cause.printStackTrace(new PrintWriter(buffer))
    buffer.toString
  }
}
