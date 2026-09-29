package auction

import org.apache.pekko.actor.ClassicActorSystemProvider
import org.apache.pekko.pattern.after

import scala.concurrent.ExecutionContext
import scala.concurrent.Future
import scala.concurrent.duration.FiniteDuration
import scala.util.control.NonFatal

/** Может ли узел принять команду агрегата. Причина неготовности называется, чтобы оператор не гадал, что лежит. */
enum Readiness {
  case Ready
  case ClusterNotUp
  case JournalUnavailable
}

/**
 * Готовность узла: кластер поднят и журнал отвечает.
 *
 * Вычисляется на каждый запрос, а не фоновым циклом, с пределом на ответ базы — та же модель, что у gRPC-сервисов в
 * ADR-054: статус не отстаёт от базы на период опроса. Кластер проверяется первым: пока узел не `Up`, шардинг entity не
 * поднимет, и ходить в базу незачем.
 */
object NodeReadiness {

  def check(clusterUp: () => Boolean, pingJournal: () => Future[Boolean], timeout: FiniteDuration)(using
      system: ClassicActorSystemProvider,
      ec: ExecutionContext
  ): Future[Readiness] =
    if (!clusterUp()) Future.successful(Readiness.ClusterNotUp)
    else {
      val probe = Future
        .delegate(pingJournal())
        .map(valid => if (valid) Readiness.Ready else Readiness.JournalUnavailable)
        // Отказ пробы и есть ответ «журнал недоступен»: причина видна в записи
        // журнала плагина, а граница получает значение, а не исключение.
        .recover { case NonFatal(_) => Readiness.JournalUnavailable }
      val deadline = after(timeout)(Future.successful(Readiness.JournalUnavailable))
      Future.firstCompletedOf(List(probe, deadline))
    }
}
