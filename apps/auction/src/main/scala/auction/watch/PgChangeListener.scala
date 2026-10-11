package auction.watch

import auction.persistence.DatabaseSettings
import net.logstash.logback.argument.StructuredArguments
import org.postgresql.PGConnection
import org.postgresql.PGNotification
import org.slf4j.LoggerFactory

import java.sql.Connection
import java.sql.DriverManager
import java.util.UUID
import scala.concurrent.duration.FiniteDuration
import scala.jdk.CollectionConverters.*
import scala.util.Try
import scala.util.Using
import scala.util.control.NonFatal

/**
 * Слушатель канала [[AuctionChanges.Channel]]: своё соединение вне пула журнала и свой поток. Соединение `LISTEN`
 * держится всё время работы, а пул общий с журналом и проекциями; занятое навсегда соединение пула ушло бы у них.
 *
 * Пока соединения нет, сигналы теряются: PostgreSQL копит их только для слушающих сессий. Поэтому после каждого
 * подключения слушатель зовёт [[ChangeRegistry.everything]] — каждый подписчик перечитывает read model и видит всё, что
 * закоммитили без него.
 *
 * @param wait
 *   сколько ждать сигнала за одно обращение к драйверу; столько же длится остановка в худшем случае
 * @param retry
 *   пауза перед повторным подключением после отказа
 */
final class PgChangeListener(
    database: DatabaseSettings,
    registry: ChangeRegistry,
    wait: FiniteDuration,
    retry: FiniteDuration
) extends AutoCloseable {

  @volatile private var running = true

  private val thread = Thread
    .ofPlatform()
    .daemon(true)
    .name("auction-change-listener")
    .unstarted(() => loop())

  def start(): PgChangeListener = {
    thread.start()
    this
  }

  override def close(): Unit = {
    running = false
    thread.interrupt()
    thread.join(wait.toMillis + retry.toMillis)
  }

  private def loop(): Unit =
    while (running)
      try Using.resource(connect())(listen)
      catch {
        // Текст отказа драйвера может нести адрес базы, поэтому в запись уходит только класс исключения.
        case NonFatal(cause) if running =>
          PgChangeListener.logger.warn(
            "auction change listener disconnected",
            StructuredArguments.entries(
              Map[String, Any](
                "operation" -> PgChangeListener.Operation,
                "result" -> "error",
                "error_category" -> "dependency_unavailable",
                "error" -> cause.getClass.getName
              ).asJava
            )
          )
          Try(Thread.sleep(retry.toMillis))
        case NonFatal(_) => ()
        case _: InterruptedException => ()
      }

  private def connect(): Connection = {
    val connection = DriverManager.getConnection(database.url, database.user, database.password)
    try {
      Using.resource(connection.createStatement())(_.execute(s"LISTEN ${AuctionChanges.Channel}"))
      connection
    } catch {
      case NonFatal(cause) =>
        connection.close()
        throw cause
    }
  }

  private def listen(connection: Connection): Unit = {
    val pg = connection.unwrap(classOf[PGConnection])
    registry.everything()
    while (running) {
      // Драйвер отвечает `null`, когда за время ожидания сигналов не было.
      val notifications: Array[PGNotification] = pg.getNotifications(wait.toMillis.toInt)
      Option(notifications).toList.flatten.foreach { notification =>
        Try(UUID.fromString(notification.getParameter)).toOption match {
          case Some(auctionId) => registry.changed(auctionId)
          case None => registry.everything()
        }
      }
    }
  }
}

object PgChangeListener {
  val Operation = "auction.change_listener"

  private val logger = LoggerFactory.getLogger(classOf[PgChangeListener])
}
