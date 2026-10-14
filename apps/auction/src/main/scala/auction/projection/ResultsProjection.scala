package auction.projection

import auction.results.ResultsTags
import auction.results.StoredResultsEvent
import auction.telemetry.ProjectionBacklog
import auction.telemetry.ProjectionMetrics
import org.apache.pekko.actor.typed.ActorSystem
import org.apache.pekko.cluster.sharding.typed.ShardedDaemonProcessSettings
import org.apache.pekko.cluster.sharding.typed.scaladsl.ShardedDaemonProcess
import org.apache.pekko.persistence.jdbc.db.SlickExtension
import org.apache.pekko.persistence.jdbc.query.scaladsl.JdbcReadJournal
import org.apache.pekko.persistence.query.Offset
import org.apache.pekko.projection.ProjectionBehavior
import org.apache.pekko.projection.ProjectionId
import org.apache.pekko.projection.eventsourced.EventEnvelope
import org.apache.pekko.projection.eventsourced.scaladsl.EventSourcedProvider
import org.apache.pekko.projection.jdbc.JdbcSession
import org.apache.pekko.projection.jdbc.scaladsl.JdbcHandler
import org.apache.pekko.projection.jdbc.scaladsl.JdbcProjection
import org.apache.pekko.projection.scaladsl.ExactlyOnceProjection
import slick.jdbc.JdbcBackend.Database
import slick.jdbc.PostgresProfile.api.*

import scala.concurrent.Await
import scala.concurrent.duration.FiniteDuration

/**
 * Проекция журнала итогов — та же форма, что [[RaffleProjection]]: экземпляр на тег [[ResultsTags]] под
 * `ShardedDaemonProcess`, offset и запись обработчика одной транзакцией `JdbcProjection.exactlyOnce`. Она одна —
 * публикация итогов `results-publication` (PER-490): read model итогам не нужна, их читают из entity.
 */
object ResultsProjection {

  val PublicationName: String = "results-publication"

  type Envelope = EventEnvelope[StoredResultsEvent]

  def init(
      system: ActorSystem[?],
      name: String,
      metrics: ProjectionMetrics,
      handler: () => JdbcHandler[Envelope, JdbcSession]
  ): Unit =
    ShardedDaemonProcess(system).init[ProjectionBehavior.Command](
      name,
      ResultsTags.Count,
      index => ProjectionBehavior(projection(system, name, ResultsTags.all(index), metrics, handler)),
      ShardedDaemonProcessSettings(system),
      Some(ProjectionBehavior.Stop)
    )

  def projection(
      system: ActorSystem[?],
      name: String,
      tag: String,
      metrics: ProjectionMetrics,
      handler: () => JdbcHandler[Envelope, JdbcSession]
  ): ExactlyOnceProjection[Offset, Envelope] = {
    val source = journal(system)
    JdbcProjection
      .exactlyOnce(
        ProjectionId(name, tag),
        EventSourcedProvider.eventsByTag[StoredResultsEvent](system, JdbcReadJournal.Identifier, tag),
        () => new PooledJdbcSession(source.source),
        handler
      )(using system)
      .withStatusObserver(metrics.observer[Envelope](_.timestamp))
  }

  /** Отставание каждого тега для `events_behind` — тот же запрос, что у [[RaffleProjection.backlog]]. */
  def backlog(system: ActorSystem[?], name: String, timeout: FiniteDuration): () => Map[String, Long] = {
    val database = journal(system)
    val tags = ResultsTags.all
    () => {
      val behind =
        sql"""SELECT t.tag, COUNT(*) FROM event_tag t
              LEFT JOIN pekko_projection_offset_store o ON o.projection_name = $name AND o.projection_key = t.tag
              WHERE t.tag = ANY(${tags.mkString("{", ",", "}")}::varchar[])
                AND t.event_id > COALESCE(o.current_offset::bigint, 0)
              GROUP BY t.tag""".as[(String, Long)]
      ProjectionBacklog.behind(tags, Await.result(database.run(behind), timeout).toMap)
    }
  }

  private def journal(system: ActorSystem[?]): Database =
    SlickExtension(system).database(system.settings.config.getConfig("jdbc-journal")).database
}
