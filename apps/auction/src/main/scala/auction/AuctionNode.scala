package auction

import auction.aggregate.AuctionCommands
import auction.aggregate.MeetupAuthority
import auction.boundary.ScreenRoutes
import auction.catalog.LotCatalogCommands
import auction.entity.AuctionEntity
import auction.entity.AuctionGateway
import auction.entity.AuctionLots
import auction.entity.AuctionPredictions
import auction.entity.AuctionRaffle
import auction.entity.AuctionResults
import auction.entity.AuctionSlot
import auction.entity.LotCardGate
import auction.entity.LotEntity
import auction.entity.LotGateway
import auction.grpc.AuctionGrpcService
import auction.grpc.CallerTable
import auction.grpc.GrpcBoundary
import auction.meetup.MeetupCancellationConsumer
import auction.meetup.MeetupFactsSettings
import auction.lot.AuctionId
import auction.lot.ParticipantId
import auction.naming.DisplayNameCommands
import auction.persistence.DatabaseSettings
import auction.persistence.JournalDatabase
import auction.persistence.SlickAuctionViews
import auction.persistence.SlickAuctionWatchViews
import auction.persistence.SlickFinalBids
import auction.persistence.SlickLotViews
import auction.persistence.SlickScreenViews
import auction.projection.AuctionProjection
import auction.projection.AuctionViewHandler
import auction.projection.LotProjection
import auction.projection.LotViewHandler
import auction.projection.RaffleProjection
import auction.projection.ResultsProjection
import auction.publication.AuctionPublicationHandler
import auction.publication.JetStreamPublisher
import auction.publication.LotOutbox
import auction.publication.LotPublicationHandler
import auction.publication.OutboxRelay
import auction.publication.PublicationSettings
import auction.publication.RafflePublicationHandler
import auction.publication.ResultsPublicationHandler
import auction.telemetry.DeadlineMetrics
import auction.telemetry.MeetupFactsMetrics
import auction.telemetry.ProjectionMetrics
import auction.telemetry.PublicationMetrics
import auction.persistence.SlickDisplayNameStore
import auction.persistence.SlickLotCatalogStore
import auction.persistence.SlickFaqAcknowledgements
import auction.persistence.SlickPredictionStore
import auction.persistence.SlickRaffleTickets
import auction.persistence.SlickResultsStore
import auction.prediction.PredictionEntity
import auction.prediction.PredictionGateway
import auction.prediction.PredictionStore
import auction.raffle.Beacon
import auction.raffle.RaffleAccess
import auction.raffle.RaffleEntity
import auction.raffle.RaffleGateway
import auction.raffle.RaffleTickets
import auction.raffle.Seed
import auction.results.ResultNames
import auction.results.ResultsEntity
import auction.results.ResultsForecasts
import auction.results.ResultsGateway
import auction.results.ResultsOutcomes
import auction.results.ResultsStore
import auction.screen.MeetupStandings
import auction.screen.ScreenFeed
import auction.screen.StreamLimit
import auction.slot.SlotHolders
import auction.slot.TradingSlotEntity
import auction.watch.AuctionChanges
import auction.watch.ChangeRegistry
import auction.watch.PgChangeListener
import net.logstash.logback.argument.StructuredArguments
import org.apache.pekko.Done
import org.apache.pekko.actor.CoordinatedShutdown
import org.apache.pekko.http.scaladsl.model.HttpRequest
import org.apache.pekko.http.scaladsl.model.HttpResponse
import org.apache.pekko.http.scaladsl.server.Route
import org.apache.pekko.http.scaladsl.settings.ServerSettings
import org.apache.pekko.actor.typed.ActorRef
import org.apache.pekko.actor.typed.ActorSystem
import org.apache.pekko.cluster.MemberStatus
import org.apache.pekko.cluster.sharding.typed.ClusterShardingSettings
import org.apache.pekko.cluster.sharding.typed.ShardingEnvelope
import org.apache.pekko.cluster.sharding.typed.scaladsl.ClusterSharding
import org.apache.pekko.cluster.sharding.typed.scaladsl.Entity
import org.apache.pekko.cluster.typed.Cluster
import org.apache.pekko.cluster.typed.Join
import org.apache.pekko.persistence.jdbc.db.SlickExtension
import org.apache.pekko.util.Timeout
import org.slf4j.LoggerFactory

import java.security.SecureRandom
import java.time.Clock
import java.util.UUID
import scala.concurrent.Future
import scala.concurrent.duration.FiniteDuration
import scala.jdk.DurationConverters.*
import scala.util.Failure
import scala.util.Success

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

  /**
   * Регистрирует entity аукциона; идентификатор entity — идентификатор аукциона (ADR-047, дополнение 2026-10-03). К
   * лотам аукцион ходит через тот же шардинг, поэтому entity лота регистрируются раньше; `askTimeout` — срок ответа
   * лота на вопрос о состоянии, `OpenLot` и `CloseLot`.
   *
   * Аукцион шардинг помнит (ADR-045, дополнение 2026-10-05): таймеры закрытия живут в entity, а помнящаяся entity
   * поднимается сама после рестарта процесса и по простою не усыпляется. Хранилище запоминания — журнал
   * (`eventsourced`): хранилище по умолчанию `ddata` пишет в LMDB-каталог с портом remoting в имени, а порт узла — `0`,
   * и после рестарта процесса прошлое не читается.
   */
  def registerAuctions(
      system: ActorSystem[?],
      sharding: ClusterSharding,
      clock: Clock,
      newId: () => UUID,
      askTimeout: FiniteDuration,
      raffle: AuctionRaffle = AuctionRaffle.none,
      slot: AuctionSlot = AuctionSlot.none,
      predictions: AuctionPredictions = AuctionPredictions.none,
      results: AuctionResults = AuctionResults.none
  ): ActorRef[ShardingEnvelope[AuctionEntity.Command]] = {
    val lots = AuctionLots.sharded(sharding, askTimeout)
    sharding.init(
      Entity(AuctionEntity.TypeKey) { context =>
        AuctionEntity(
          context.entityId,
          clock,
          newId,
          lots,
          shard = Some(context.shard),
          raffle = raffle,
          slot = slot,
          predictions = predictions,
          results = results
        )
      }
        .withSettings(remembered(system))
    )
  }

  /**
   * Регистрирует слот торгов сообщества (ADR-047, дополнение 2026-10-12) и отдаёт порт к нему для аукционов. Держателя
   * слот спрашивает у entity аукциона через тот же шардинг; ссылка на неё берётся в момент вопроса, поэтому слот
   * регистрируется раньше аукциона. `holderTimeout` — срок ответа держателя, `askTimeout` — срок ответа слота аукциону:
   * первый короче второго, второй — короче срока команды открытия у шлюза ([[SlotSettings]]).
   */
  def registerSlot(
      sharding: ClusterSharding,
      clock: Clock,
      newId: () => UUID,
      settings: SlotSettings
  ): AuctionSlot = {
    val holders: SlotHolders = new SlotHolders {
      private given Timeout = Timeout(settings.holderTimeout)
      def busy(auction: AuctionId): Future[Boolean] =
        sharding.entityRefFor(AuctionEntity.TypeKey, auction.value.toString).ask[Boolean](AuctionEntity.Trading(_))
    }
    sharding.init(Entity(TradingSlotEntity.TypeKey)(_ => TradingSlotEntity(clock, newId, holders)))
    AuctionSlot.sharded(sharding, settings.askTimeout)
  }

  /**
   * Регистрирует entity прогнозов (ADR-067); идентификатор entity — идентификатор аукциона. Регистрируется раньше
   * аукциона: раунды ведёт аукцион. Таймеров у неё нет, поэтому шардинг её не помнит, и простаивающая entity засыпает.
   */
  def registerPredictions(
      sharding: ClusterSharding,
      clock: Clock,
      newId: () => UUID,
      store: PredictionStore,
      askTimeout: FiniteDuration
  ): AuctionPredictions = {
    sharding.init(Entity(PredictionEntity.TypeKey)(context => PredictionEntity(context.entityId, clock, newId, store)))
    AuctionPredictions.sharded(sharding, askTimeout)
  }

  /**
   * Регистрирует entity итогов прогнозов (ADR-067, п. 8); идентификатор entity — идентификатор аукциона. Регистрируется
   * раньше аукциона: подсчёт ведёт аукцион. Таймеров у неё нет, поэтому шардинг её не помнит. Снимок исходов лотов
   * приносит порт [[ResultsOutcomes]] — торгов entity не знает.
   */
  def registerResults(
      sharding: ClusterSharding,
      clock: Clock,
      newId: () => UUID,
      outcomes: ResultsOutcomes,
      forecasts: ResultsForecasts,
      names: ResultNames,
      store: ResultsStore,
      askTimeout: FiniteDuration
  ): AuctionResults = {
    sharding.init(
      Entity(ResultsEntity.TypeKey)(context =>
        ResultsEntity(context.entityId, clock, newId, outcomes, forecasts, names, store)
      )
    )
    AuctionResults.sharded(sharding, askTimeout)
  }

  /** Запоминание entity в журнале — у аукциона и у розыгрыша: их таймеры обязаны пережить рестарт процесса. */
  private def remembered(system: ActorSystem[?]): ClusterShardingSettings =
    ClusterShardingSettings(system)
      .withRememberEntities(true)
      .withRememberEntitiesStoreMode(ClusterShardingSettings.RememberEntitiesStoreModeEventSourced)

  /**
   * Регистрирует entity розыгрыша (ADR-066); идентификатор entity — идентификатор аукциона. Регистрируется раньше
   * аукциона: открывает её аукцион после старта торгов. Розыгрыш шардинг помнит по той же причине, что аукцион: таймеры
   * закрытия регистрации и опроса маяка живут в entity. Seed — 32 байта `SecureRandom` (п. 6).
   */
  def registerRaffles(
      system: ActorSystem[?],
      sharding: ClusterSharding,
      clock: Clock,
      newId: () => UUID,
      access: RaffleAccess,
      beacon: Beacon,
      tickets: RaffleTickets,
      settings: RaffleEntity.Settings
  ): ActorRef[ShardingEnvelope[RaffleEntity.Command]] = {
    val generator = new SecureRandom()
    sharding.init(
      Entity(RaffleEntity.TypeKey) { context =>
        RaffleEntity(
          context.entityId,
          clock,
          newId,
          () => Seed.random(generator),
          access,
          beacon,
          tickets,
          settings,
          shard = Some(context.shard)
        )
      }
        .withSettings(remembered(system))
    )
  }

  /**
   * Стирание имён списка билетов с истёкшим сроком хранения (ADR-066, п. 12) таймером узла. Номера, N и итог остаются в
   * журнале розыгрыша; стирается только строка имени.
   */
  def eraseRaffleNames(
      system: ActorSystem[?],
      tickets: SlickRaffleTickets,
      clock: Clock,
      every: FiniteDuration
  ): Unit = {
    import system.executionContext
    system.scheduler.scheduleWithFixedDelay(every, every) { () =>
      tickets.eraseExpired(clock.instant()).onComplete {
        case Success(erased) if erased > 0 =>
          logger.info("raffle ticket names erased after retention", StructuredArguments.keyValue("erased", erased))
        case Success(_) => ()
        // Ожидаемый отказ зависимости: база недоступна. Следующий тик повторит стирание.
        case Failure(cause) =>
          logger.warn(
            "raffle ticket name erasure failed",
            StructuredArguments.keyValue("error_category", "dependency_unavailable"),
            StructuredArguments.keyValue("error", cause.getClass.getName)
          )
      }
    }
    ()
  }

  /**
   * Проекции журналов лотов и аукционов в read model (ADR-045). Метрики отставания регистрируются вместе с ними;
   * `backlogTimeout` ограничивает запрос к базе на сборе метрики.
   */
  def startProjection(system: ActorSystem[?], metrics: ProjectionMetrics, backlogTimeout: FiniteDuration): Unit = {
    LotProjection.init(system, LotProjection.Name, metrics, () => LotViewHandler(system))
    metrics.watchBacklog(LotProjection.Name, LotProjection.backlog(system, LotProjection.Name, backlogTimeout))
    AuctionProjection.init(system, AuctionProjection.Name, metrics, () => AuctionViewHandler(system))
    metrics.watchBacklog(
      AuctionProjection.Name,
      AuctionProjection.backlog(system, AuctionProjection.Name, backlogTimeout)
    )
  }

  /**
   * Просроченные незакрытые лоты в метрике `auction.lots.overdue` (PER-292). Считается по read model лотов, поэтому
   * видна, даже когда планировщик аукциона молчит; `timeout` ограничивает запрос к базе на сборе.
   */
  def watchDeadlines(
      system: ActorSystem[?],
      metrics: DeadlineMetrics,
      clock: Clock,
      grace: java.time.Duration,
      timeout: FiniteDuration
  ): AutoCloseable =
    metrics.watchOverdue(LotProjection.overdue(system, clock, grace, timeout))

  /**
   * Публикация фактов лота, аукциона и итога розыгрыша в шину (integration.md, «Auction NATS»): по своей проекции
   * журнала лотов, аукционов и розыгрышей, каждая со своим offset, пишут общий outbox, а релей выносит его в JetStream.
   * Проекция работает и без адреса шины — факты ждут в outbox; релей стартует, только когда адрес задан. Отставание
   * видно дважды: `events_behind` проекции и очередь outbox.
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
    AuctionProjection.init(system, AuctionProjection.PublicationName, metrics, () => AuctionPublicationHandler(system))
    metrics.watchBacklog(
      AuctionProjection.PublicationName,
      AuctionProjection.backlog(system, AuctionProjection.PublicationName, backlogTimeout)
    )
    RaffleProjection.init(system, RaffleProjection.PublicationName, metrics, () => RafflePublicationHandler(system))
    metrics.watchBacklog(
      RaffleProjection.PublicationName,
      RaffleProjection.backlog(system, RaffleProjection.PublicationName, backlogTimeout)
    )
    ResultsProjection.init(system, ResultsProjection.PublicationName, metrics, () => ResultsPublicationHandler(system))
    metrics.watchBacklog(
      ResultsProjection.PublicationName,
      ResultsProjection.backlog(system, ResultsProjection.PublicationName, backlogTimeout)
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
   * Наследование отмены сходки (ADR-047, дополнение 2026-10-12): durable-потребитель `events.meetups.meetup_cancelled`
   * отдаёт аукциону сходки `ApplyMeetupCancelled` через шардинг, а отставание durable видно метриками. Без адреса шины
   * потребитель не стартует, как релей фактов: профиль без NATS живёт, но отмены сходок в нём не наследуются, и запись
   * об этом одна. Durable не объявлен — `missing`: узел обязан остановиться, а не работать без наследования молча.
   *
   * @return
   *   потребитель, если он стартовал; останавливает его `CoordinatedShutdown`
   */
  def startMeetupFacts(
      system: ActorSystem[?],
      sharding: ClusterSharding,
      settings: MeetupFactsSettings,
      metrics: MeetupFactsMetrics,
      missing: String => Unit
  ): Option[MeetupCancellationConsumer] =
    settings.natsUrl match {
      case None =>
        logger.warn("auction meetup facts consumer is off: AUCTION_NATS_URL is not set, meetup cancellations wait")
        None
      case Some(url) =>
        given Timeout = Timeout(settings.answerTimeout)
        val consumer = MeetupCancellationConsumer(
          url,
          settings,
          inheritance =>
            sharding
              .entityRefFor(AuctionEntity.TypeKey, inheritance.auctionId.value.toString)
              .ask(AuctionEntity.InheritCancellation(inheritance.command, _)),
          missing
        )
        val watching = metrics.watchPending(MeetupCancellationConsumer.Durable, () => consumer.backlog())
        // Остановка регистрируется до старта: отказ привязки приходит сразу и может сам начать остановку узла.
        CoordinatedShutdown(system).addTask(CoordinatedShutdown.PhaseServiceStop, "auction-meetup-facts") { () =>
          watching.close()
          consumer.close()
          Future.successful(Done)
        }
        Some(consumer.start())
    }

  /**
   * Предел тела запроса gRPC-границы. Умолчание pekko-http — 8 MiB, и файл крупнее до домена не дошёл бы: вместо
   * именованного `ImageTooLarge` бот получил бы сбой транспорта. Предел покрывает всё, что бот вообще может скачать
   * через `getFile` (до 20 MB), поэтому предел изображения решает домен, а не транспорт.
   */
  val GrpcMaxRequestBytes: Long = 24L * 1024 * 1024

  /** Настройки сервера gRPC-границы; ими привязывают границу и сервис, и L1. */
  def grpcServerSettings(system: ActorSystem[?]): ServerSettings = {
    val defaults = ServerSettings(system)
    defaults.withParserSettings(defaults.parserSettings.withMaxContentLength(GrpcMaxRequestBytes))
  }

  /**
   * Источник изменений для потока `WatchAuction` (PER-335): слушатель канала, в который пишут проекции read model,
   * своим соединением к базе из `auction.database`. Останавливается вместе с узлом, до остановки проекций, и завершает
   * открытые потоки.
   */
  def listenChanges(system: ActorSystem[?]): AuctionChanges = {
    val config = system.settings.config
    val database = DatabaseSettings
      .fromConfig(config)
      .fold(reason => throw new IllegalStateException(reason), settings => settings)
    val registry = ChangeRegistry()
    val listener = PgChangeListener(
      database,
      registry,
      config.getDuration("auction.watch.listener-wait").toScala,
      config.getDuration("auction.watch.reconnect-after").toScala
    ).start()
    CoordinatedShutdown(system).addTask(CoordinatedShutdown.PhaseServiceStop, "auction-change-listener") { () =>
      Future {
        listener.close()
        registry.close()
        Done
      }(using system.executionContext)
    }
    registry
  }

  /**
   * gRPC-граница узла: сервис поверх шардинга лотов и аукционов, каталога, имён участников, read model, права у Meetups
   * и права `place_bids` человека зала у Identity, обёрнутый проверкой вызывающего и записью операции. Entity лота и
   * аукциона к этому моменту уже зарегистрированы в `sharding`.
   */
  def grpc(
      system: ActorSystem[?],
      sharding: ClusterSharding,
      callers: CallerTable,
      askTimeout: FiniteDuration,
      authority: MeetupAuthority,
      placeBidsRight: ParticipantId => Future[Boolean],
      changes: AuctionChanges,
      clock: Clock = Clock.systemUTC(),
      overdueGrace: java.time.Duration = AuctionGrpcService.DefaultOverdueGrace
  ): HttpRequest => Future[HttpResponse] = {
    given ActorSystem[?] = system
    import system.executionContext
    val lots = LotGateway.sharded(sharding, askTimeout)
    val names = DisplayNameCommands(SlickDisplayNameStore(system))
    val raffleTickets = SlickRaffleTickets(system, names)
    val service = AuctionGrpcService(
      lots,
      LotCatalogCommands(
        SlickLotCatalogStore(system),
        id => lots.stateOf(id.value).map(LotCardGate.standing)
      ),
      SlickFaqAcknowledgements(system),
      SlickLotViews(system),
      AuctionCommands(AuctionGateway.sharded(sharding, askTimeout), lots, authority),
      SlickAuctionViews(system),
      names,
      clock = clock,
      overdueGrace = overdueGrace,
      raffles = RaffleGateway.sharded(sharding, askTimeout),
      raffleNames = raffleTickets.names,
      predictions = PredictionGateway.sharded(sharding, SlickPredictionStore(system), askTimeout),
      results = ResultsGateway.sharded(sharding, SlickResultsStore(system), askTimeout),
      watchViews = SlickAuctionWatchViews(system),
      changes = changes,
      placeBidsRight = placeBidsRight,
      finalBids = SlickFinalBids(system)
    )
    GrpcBoundary(callers, (caller, correlation, notes) => service.within(correlation, Some(caller), notes))
  }

  /**
   * Маршруты экрана зала (ADR-040, дополнение 2026-10-19): поток на тех же поводах, что `WatchAuction`, — `changes`
   * общий с gRPC-границей, — и ворота по состоянию сходки у Meetups. Предел потоков и период heartbeat — из
   * `auction.screen`.
   */
  def screen(system: ActorSystem[?], changes: AuctionChanges, standings: MeetupStandings): Route = {
    val config = system.settings.config
    import system.executionContext
    val views = SlickScreenViews(system)
    val feed = ScreenFeed(
      views,
      SlickDisplayNameStore(system),
      standings,
      changes,
      StreamLimit(config.getInt("auction.screen.max-streams"))
    )
    ScreenRoutes.route(feed, views, config.getDuration("auction.screen.heartbeat").toScala)
  }

  def readiness(system: ActorSystem[?], timeout: FiniteDuration): () => Future[Readiness] = {
    val cluster = Cluster(system)
    val pingJournal = JournalDatabase.ping(system, timeout)
    given ActorSystem[?] = system
    import system.executionContext
    () => NodeReadiness.check(() => cluster.selfMember.status == MemberStatus.Up, pingJournal, timeout)
  }
}
