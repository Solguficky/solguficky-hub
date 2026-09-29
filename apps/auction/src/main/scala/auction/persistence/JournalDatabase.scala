package auction.persistence

import org.apache.pekko.actor.typed.ActorSystem
import org.apache.pekko.persistence.jdbc.db.SlickExtension
import slick.jdbc.SimpleJdbcAction

import scala.concurrent.Future
import scala.concurrent.duration.FiniteDuration

/**
 * Проверка базы журнала через тот же пул, которым пишет плагин.
 *
 * Отдельное подключение ответило бы на вопрос «жив ли сервер», а готовность спрашивает, может ли журнал записать
 * событие: исчерпанный или сломанный пул плагина она обязана видеть.
 */
object JournalDatabase {

  def ping(system: ActorSystem[?], timeout: FiniteDuration): () => Future[Boolean] = {
    val database = SlickExtension(system).database(system.settings.config.getConfig("jdbc-journal")).database
    // isValid принимает целые секунды, и ноль у него означает «без предела».
    val seconds = math.max(1, timeout.toSeconds.toInt)
    () => database.run(SimpleJdbcAction(_.connection.isValid(seconds)))
  }
}
