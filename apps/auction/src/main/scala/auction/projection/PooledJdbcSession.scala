package auction.projection

import org.apache.pekko.japi.function.Function as JFunction
import org.apache.pekko.projection.jdbc.JdbcSession
import slick.jdbc.JdbcDataSource

import java.sql.Connection

/**
 * Сессия проекции поверх пула плагина журнала: отдельного пула нет, как и у каталога. Соединение берётся при первом
 * обращении и держит одну транзакцию до `commit` или `rollback`; `close` возвращает его в пул.
 *
 * Пул общий с журналом, поэтому `pekko.projection.jdbc.blocking-jdbc-dispatcher` меньше пула: проекция не может занять
 * все соединения и оставить журнал без записи.
 */
final class PooledJdbcSession(source: JdbcDataSource) extends JdbcSession {

  private var opened: Option[Connection] = None

  private def connection: Connection =
    opened.getOrElse {
      val created = source.createConnection()
      created.setAutoCommit(false)
      opened = Some(created)
      created
    }

  override def withConnection[Result](func: JFunction[Connection, Result]): Result = func(connection)

  override def commit(): Unit = opened.foreach(_.commit())

  override def rollback(): Unit = opened.foreach(_.rollback())

  override def close(): Unit = {
    opened.foreach(_.close())
    opened = None
  }
}
