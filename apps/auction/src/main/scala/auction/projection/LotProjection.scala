package auction.projection

import auction.entity.LotTags
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

import java.time.Clock
import java.time.Duration
import scala.concurrent.Await
import scala.concurrent.duration.FiniteDuration

/**
 * Проекция журнала лотов (ADR-045): по экземпляру на тег [[LotTags]] под `ShardedDaemonProcess`, offset и запись
 * обработчика одной транзакцией `JdbcProjection.exactlyOnce`. После рестарта экземпляр читает сохранённый offset своего
 * тега и продолжает со следующего события, а не переигрывает журнал.
 *
 * Проекций журнала лотов две, и у каждой своё имя, а значит свой offset: read model [[Name]] и публикация фактов
 * [[PublicationName]]. Отказ одной не задерживает другую.
 */
object LotProjection {

  val Name: String = "lot-view"

  val PublicationName: String = "lot-publication"

  type Envelope = EventEnvelope[StoredLotEvent]

  /**
   * Запускает экземпляры проекции на узле.
   *
   * @param name
   *   имя проекции — [[Name]] или [[PublicationName]]: ключ её offset и имя процесса
   * @param handler
   *   обработчик на каждый запуск экземпляра; рабочий — [[LotViewHandler]] или `LotPublicationHandler`, тест подменяет
   *   его обёрткой
   */
  def init(
      system: ActorSystem[?],
      name: String,
      metrics: ProjectionMetrics,
      handler: () => JdbcHandler[Envelope, JdbcSession]
  ): Unit =
    ShardedDaemonProcess(system).init[ProjectionBehavior.Command](
      name,
      LotTags.Count,
      index => ProjectionBehavior(projection(system, name, LotTags.all(index), metrics, handler)),
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
        EventSourcedProvider.eventsByTag[StoredLotEvent](system, JdbcReadJournal.Identifier, tag),
        () => new PooledJdbcSession(source.source),
        handler
      )(using system)
      .withStatusObserver(metrics.observer[Envelope](_.timestamp))
  }

  /**
   * Отставание каждого тега проекции для `events_behind`: число строк `event_tag` этого тега после его offset. Offset
   * событий по тегу у Pekko Persistence JDBC — `ordering` строки журнала, общий для всех тегов, поэтому считается число
   * строк, а не разность номеров: она включала бы события чужих тегов.
   */
  def backlog(system: ActorSystem[?], name: String, timeout: FiniteDuration): () => Map[String, Long] = {
    val database = journal(system)
    val tags = LotTags.all
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

  /**
   * Лоты, просроченные, но не закрытые: в торгах по read model, с дедлайном раньше `now − grace`. Read model отстаёт от
   * entity, поэтому лот, закрытый вовремя, может мелькнуть здесь на время отставания; допуск покрывает его, а
   * застрявшую проекцию показывает её собственный `events_behind`.
   */
  def overdue(system: ActorSystem[?], clock: Clock, grace: Duration, timeout: FiniteDuration): () => Long = {
    val database = journal(system)
    () => {
      val cutoff = clock.instant().minus(grace).toString
      val count =
        sql"""SELECT COUNT(*) FROM lot_view
              WHERE state -> 'state' ->> 'kind' = 'Trading'
                AND (state -> 'state' -> 'trading' ->> 'deadline')::timestamptz < $cutoff::timestamptz""".as[Long].head
      Await.result(database.run(count), timeout)
    }
  }

  private def journal(system: ActorSystem[?]): Database =
    SlickExtension(system).database(system.settings.config.getConfig("jdbc-journal")).database
}
