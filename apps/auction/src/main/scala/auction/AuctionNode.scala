package auction

import auction.aggregate.AuctionCommands
import auction.aggregate.MeetupAuthority
import auction.catalog.LotCatalogCommands
import auction.entity.AuctionEntity
import auction.entity.AuctionGateway
import auction.entity.LotEntity
import auction.entity.LotGateway
import auction.grpc.AuctionGrpcService
import auction.grpc.CallerTable
import auction.grpc.GrpcBoundary
import auction.persistence.JournalDatabase
import auction.persistence.SlickAuctionViews
import auction.persistence.SlickLotViews
import auction.projection.AuctionProjection
import auction.projection.AuctionViewHandler
import auction.projection.LotProjection
import auction.projection.LotViewHandler
import auction.publication.JetStreamPublisher
import auction.publication.LotOutbox
import auction.publication.LotPublicationHandler
import auction.publication.OutboxRelay
import auction.publication.PublicationSettings
import auction.telemetry.ProjectionMetrics
import auction.telemetry.PublicationMetrics
import auction.persistence.SlickLotCatalogStore
import auction.persistence.SlickFaqAcknowledgements
import org.apache.pekko.Done
import org.apache.pekko.actor.CoordinatedShutdown
import org.apache.pekko.http.scaladsl.model.HttpRequest
import org.apache.pekko.http.scaladsl.model.HttpResponse
import org.apache.pekko.actor.typed.ActorRef
import org.apache.pekko.actor.typed.ActorSystem
import org.apache.pekko.cluster.MemberStatus
import org.apache.pekko.cluster.sharding.typed.ShardingEnvelope
import org.apache.pekko.cluster.sharding.typed.scaladsl.ClusterSharding
import org.apache.pekko.cluster.sharding.typed.scaladsl.Entity
import org.apache.pekko.cluster.typed.Cluster
import org.apache.pekko.cluster.typed.Join
import org.apache.pekko.persistence.jdbc.db.SlickExtension
import org.slf4j.LoggerFactory

import java.time.Clock
import java.util.UUID
import scala.concurrent.Future
import scala.concurrent.duration.FiniteDuration

/**
 * Узел Auction в одноузловом кластере (ADR-045).
 *
 * Шардинг здесь нужен ради адресации entity и её жизненного цикла, а не ради распределения: узел присоединяется сам к
 * себе, и все shard'ы живут на нём. Второй узел потребует решения о хостинге и seed-адресов вместо self-join.
 */
object AuctionNode {

  private val logger = LoggerFactory.getLogger(getClass)

  /**
   * Присоединяет узел к самому себе и отдаёт шардинг, в котором агрегаты регистрируют свои entity.
   *
   * Join асинхронный: узел становится `Up` позже, и до этого [[readiness]] отвечает «кластер не поднят».
   */
  def join(system: ActorSystem[?]): ClusterSharding = {
    val cluster = Cluster(system)
    cluster.manager ! Join(cluster.selfMember.address)
    ClusterSharding(system)
  }

  /** Регистрирует entity лота; идентификатор entity — идентификатор лота. */
  def registerLots(
      sharding: ClusterSharding,
      clock: Clock,
      newId: () => UUID
  ): ActorRef[ShardingEnvelope[LotEntity.Command]] =
    sharding.init(Entity(LotEntity.TypeKey)(context => LotEntity(context.entityId, clock, newId)))

  /** Регистрирует entity аукциона; идентификатор entity — идентификатор аукциона (ADR-047, дополнение 2026-10-03). */
  def registerAuctions(
      sharding: ClusterSharding,
      clock: Clock,
      newId: () => UUID
  ): ActorRef[ShardingEnvelope[AuctionEntity.Command]] =
    sharding.init(Entity(AuctionEntity.TypeKey)(context => AuctionEntity(context.entityId, clock, newId)))

  /**
   * Проекции журналов лотов и аукционов в read model (ADR-045). Метрики отставания регистрируются вместе с ними;
   * `backlogTimeout` ограничивает запрос к базе на сборе метрики.
   */
  def startProjection(system: ActorSystem[?], metrics: ProjectionMetrics, backlogTimeout: FiniteDuration): Unit = {
    LotProjection.init(system, LotProjection.Name, metrics, () => LotViewHandler(system))
    metrics.watchBacklog(LotProjection.Name, LotProjection.backlog(system, LotProjection.Name, backlogTimeout))
    AuctionProjection.init(system, metrics, () => AuctionViewHandler(system))
    metrics.watchBacklog(AuctionProjection.Name, AuctionProjection.backlog(system, backlogTimeout))
  }

  /**
   * Публикация фактов лота в шину (integration.md, «Auction NATS»): своя проекция журнала со своим offset пишет outbox,
   * а релей выносит его в JetStream. Проекция работает и без адреса шины — факты ждут в outbox; релей стартует, только
   * когда адрес задан. Отставание видно дважды: `events_behind` проекции и очередь outbox.
   */
  def startPublication(
      system: ActorSystem[?],
      metrics: ProjectionMetrics,
      publicationMetrics: PublicationMetrics,
      settings: PublicationSettings,
      backlogTimeout: FiniteDuration
  ): Unit = {
    LotProjection.init(system, LotProjection.PublicationName, metrics, () => LotPublicationHandler(system))
    metrics.watchBacklog(
      LotProjection.PublicationName,
      LotProjection.backlog(system, LotProjection.PublicationName, backlogTimeout)
    )
    val pool = SlickExtension(system).database(system.settings.config.getConfig("jdbc-journal")).database.source
    val outbox = LotOutbox(() => pool.createConnection())
    publicationMetrics.watchOutbox(() => outbox.backlog())
    settings.natsUrl match {
      case None =>
        logger.warn("auction fact relay is off: AUCTION_NATS_URL is not set, facts wait in the outbox")
      case Some(url) =>
        val publisher = JetStreamPublisher(url, settings.ackTimeout)
        val ticks = OutboxRelay.start(system, OutboxRelay(outbox, publisher, settings.batch), settings.interval)
        CoordinatedShutdown(system).addTask(CoordinatedShutdown.PhaseServiceStop, "auction-fact-relay") { () =>
          ticks.cancel()
          publisher.close()
          Future.successful(Done)
        }
    }
  }

  /**
   * gRPC-граница узла: сервис поверх шардинга лотов и аукционов, каталога, read model и права у Meetups, обёрнутый
   * проверкой вызывающего и записью операции. Entity лота и аукциона к этому моменту уже зарегистрированы в `sharding`.
   */
  def grpc(
      system: ActorSystem[?],
      sharding: ClusterSharding,
      callers: CallerTable,
      askTimeout: FiniteDuration,
      authority: MeetupAuthority
  ): HttpRequest => Future[HttpResponse] = {
    given ActorSystem[?] = system
    import system.executionContext
    val lots = LotGateway.sharded(sharding, askTimeout)
    val service = AuctionGrpcService(
      lots,
      LotCatalogCommands(SlickLotCatalogStore(system)),
      SlickFaqAcknowledgements(system),
      SlickLotViews(system),
      AuctionCommands(AuctionGateway.sharded(sharding, askTimeout), lots, authority),
      SlickAuctionViews(system)
    )
    GrpcBoundary(callers, service)
  }

  def readiness(system: ActorSystem[?], timeout: FiniteDuration): () => Future[Readiness] = {
    val cluster = Cluster(system)
    val pingJournal = JournalDatabase.ping(system, timeout)
    given ActorSystem[?] = system
    import system.executionContext
    () => NodeReadiness.check(() => cluster.selfMember.status == MemberStatus.Up, pingJournal, timeout)
  }
}
