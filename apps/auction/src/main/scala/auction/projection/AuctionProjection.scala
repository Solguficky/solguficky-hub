package auction.projection

import auction.entity.AuctionTags
import auction.entity.StoredAuctionEvent
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
 * Проекция журнала аукционов в read model — та же форма, что [[LotProjection]]: экземпляр на тег [[AuctionTags]] под
 * `ShardedDaemonProcess`, offset и запись обработчика одной транзакцией `JdbcProjection.exactlyOnce`.
 */
object AuctionProjection {

  val Name: String = "auction-view"

  type Envelope = EventEnvelope[StoredAuctionEvent]

  def init(
      system: ActorSystem[?],
      metrics: ProjectionMetrics,
      handler: () => JdbcHandler[Envelope, JdbcSession]
  ): Unit =
    ShardedDaemonProcess(system).init[ProjectionBehavior.Command](
      Name,
      AuctionTags.Count,
      index => ProjectionBehavior(projection(system, AuctionTags.all(index), metrics, handler)),
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
        EventSourcedProvider.eventsByTag[StoredAuctionEvent](system, JdbcReadJournal.Identifier, tag),
        () => new PooledJdbcSession(source.source),
        handler
      )(using system)
      .withStatusObserver(metrics.observer[Envelope](_.timestamp))
  }

  /** Отставание каждого тега для `events_behind` — тот же запрос, что у [[LotProjection.backlog]]. */
  def backlog(system: ActorSystem[?], timeout: FiniteDuration): () => Map[String, Long] = {
    val database = journal(system)
    val tags = AuctionTags.all
    () => {
      val behind =
        sql"""SELECT t.tag, COUNT(*) FROM event_tag t
              LEFT JOIN pekko_projection_offset_store o ON o.projection_name = $Name AND o.projection_key = t.tag
              WHERE t.tag = ANY(${tags.mkString("{", ",", "}")}::varchar[])
                AND t.event_id > COALESCE(o.current_offset::bigint, 0)
              GROUP BY t.tag""".as[(String, Long)]
      ProjectionBacklog.behind(tags, Await.result(database.run(behind), timeout).toMap)
    }
  }

  private def journal(system: ActorSystem[?]): Database =
    SlickExtension(system).database(system.settings.config.getConfig("jdbc-journal")).database
}
