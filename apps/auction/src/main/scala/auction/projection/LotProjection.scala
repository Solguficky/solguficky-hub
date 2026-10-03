package auction.projection

import auction.entity.StoredLotEvent
import auction.telemetry.ProjectionBacklog
import auction.telemetry.ProjectionMetrics
import org.apache.pekko.actor.typed.ActorSystem
import org.apache.pekko.cluster.sharding.typed.ShardedDaemonProcessSettings
import org.apache.pekko.cluster.sharding.typed.scaladsl.ShardedDaemonProcess
import org.apache.pekko.persistence.jdbc.db.SlickExtension
import org.apache.pekko.persistence.jdbc.query.scaladsl.JdbcReadJournal
import org.apache.pekko.projection.ProjectionBehavior
import org.apache.pekko.projection.ProjectionId
import org.apache.pekko.projection.eventsourced.EventEnvelope
import org.apache.pekko.projection.eventsourced.scaladsl.EventSourcedProvider
import org.apache.pekko.projection.jdbc.JdbcSession
import org.apache.pekko.projection.jdbc.scaladsl.JdbcHandler
import org.apache.pekko.projection.jdbc.scaladsl.JdbcProjection
import org.apache.pekko.projection.scaladsl.ExactlyOnceProjection
import org.apache.pekko.persistence.query.Offset
import slick.jdbc.JdbcBackend.Database
import slick.jdbc.PostgresProfile.api.*

import scala.concurrent.Await
import scala.concurrent.duration.FiniteDuration

/**
 * Проекция журнала лотов в read model (ADR-045): по экземпляру на тег [[LotTags]] под `ShardedDaemonProcess`, offset и
 * read model одной транзакцией `JdbcProjection.exactlyOnce`. После рестарта экземпляр читает сохранённый offset своего
 * тега и продолжает со следующего события, а не переигрывает журнал.
 */
object LotProjection {

  val Name: String = "lot-view"

  type Envelope = EventEnvelope[StoredLotEvent]

  /**
   * Запускает экземпляры проекции на узле.
   *
   * @param handler
   *   обработчик на каждый запуск экземпляра; рабочий — [[LotViewHandler]], тест подменяет его обёрткой
   */
  def init(
      system: ActorSystem[?],
      metrics: ProjectionMetrics,
      handler: () => JdbcHandler[Envelope, JdbcSession]
  ): Unit =
    ShardedDaemonProcess(system).init[ProjectionBehavior.Command](
      Name,
      LotTags.Count,
      index => ProjectionBehavior(projection(system, LotTags.all(index), metrics, handler)),
      ShardedDaemonProcessSettings(system),
      Some(ProjectionBehavior.Stop)
    )

  def projection(
      system: ActorSystem[?],
      tag: String,
      metrics: ProjectionMetrics,
      handler: () => JdbcHandler[Envelope, JdbcSession]
  ): ExactlyOnceProjection[Offset, Envelope] = {
    val source = journal(system)
    JdbcProjection
      .exactlyOnce(
        ProjectionId(Name, tag),
        EventSourcedProvider.eventsByTag[StoredLotEvent](system, JdbcReadJournal.Identifier, tag),
        () => new PooledJdbcSession(source.source),
        handler
      )(using system)
      .withStatusObserver(metrics.observer[Envelope](_.timestamp))
  }

  /**
   * Отставание каждого тега проекции для `events_behind`: голова тега в `event_tag` и offset в хранилище проекции.
   * Offset событий по тегу у Pekko Persistence JDBC — `ordering` строки журнала, и в хранилище он лежит его числом.
   */
  def backlog(system: ActorSystem[?], timeout: FiniteDuration): () => Map[String, Long] = {
    val database = journal(system)
    () => {
      val heads = sql"SELECT tag, MAX(event_id) FROM event_tag WHERE tag LIKE 'lot-%' GROUP BY tag".as[(String, Long)]
      val offsets =
        sql"SELECT projection_key, current_offset FROM pekko_projection_offset_store WHERE projection_name = $Name"
          .as[(String, String)]
      val read = database.run(heads.zip(offsets))
      val (head, offset) = Await.result(read, timeout)
      ProjectionBacklog.behind(LotTags.all, head.toMap, offset.map((tag, value) => tag -> value.toLong).toMap)
    }
  }

  private def journal(system: ActorSystem[?]): Database =
    SlickExtension(system).database(system.settings.config.getConfig("jdbc-journal")).database
}
