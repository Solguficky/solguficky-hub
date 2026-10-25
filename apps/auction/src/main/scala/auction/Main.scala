package auction

import auction.beacon.BeaconSettings
import auction.beacon.DrandBeacon
import auction.boundary.BoundaryLogging
import auction.boundary.HealthRoutes
import auction.entity.AuctionRaffle
import auction.entity.UuidV7
import auction.grpc.CallerTable
import auction.grpc.MethodAccess
import auction.identity.GrpcIdentityAccess
import auction.identity.IdentitySettings
import auction.lot.AuctionId
import auction.lot.ParticipantId
import auction.meetup.GrpcMeetupAuthority
import auction.meetup.GrpcMeetupStandings
import auction.meetup.MeetupFactsSettings
import auction.meetup.MeetupsSettings
import auction.persistence.DatabaseSettings
import auction.persistence.JournalSchema
import auction.persistence.SlickDisplayNameStore
import auction.persistence.SlickPredictionStore
import auction.persistence.SlickRaffleTickets
import auction.persistence.SlickResultsOutcomes
import auction.persistence.SlickSetOutcomes
import auction.persistence.SlickResultsStore
import auction.naming.DisplayNameCommands
import auction.raffle.RaffleSettings
import auction.publication.PublicationSettings
import auction.results.ResultNames
import auction.results.ResultsForecasts
import auction.telemetry.DeadlineMetrics
import auction.telemetry.MeetupFactsMetrics
import auction.telemetry.ProjectionMetrics
import auction.telemetry.PublicationMetrics
import auction.telemetry.Telemetry
import com.typesafe.config.ConfigFactory
import net.logstash.logback.argument.StructuredArguments
import org.apache.pekko.Done
import org.apache.pekko.actor.CoordinatedShutdown
import org.apache.pekko.actor.typed.ActorSystem
import org.apache.pekko.actor.typed.scaladsl.Behaviors
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.server.Directives.concat
import org.slf4j.LoggerFactory

import java.time.Clock
import scala.concurrent.Future
import scala.concurrent.duration.FiniteDuration
import scala.jdk.DurationConverters.*
import scala.util.Failure
import scala.util.Success
import scala.util.Try
import scala.util.control.NonFatal

/**
 * Точка входа Auction Service.
 *
 * Доменной логики торгов здесь нет и не будет: composition root собирает конфигурацию, схему журнала, actor system с
 * кластером, entity лота и аукциона в шардинге, проекции лота и аукциона в read model с метриками, публикацию фактов
 * лота в шину, HTTP-границу с health и gRPC-границу с клиентом права у Meetups.
 */
object Main {

  private val logger = LoggerFactory.getLogger(getClass)

  def main(args: Array[String]): Unit = {
    val config = ConfigFactory.load()
    val httpConfig = AuctionConfig.fromConfig(config)
    val grpcConfig = AuctionConfig.grpcFromConfig(config)
    val readinessTimeout: FiniteDuration = config.getDuration("auction.readiness-timeout").toScala
    val askTimeout: FiniteDuration = config.getDuration("auction.grpc.ask-timeout").toScala
    val backlogTimeout: FiniteDuration = config.getDuration("auction.projection.backlog-timeout").toScala
    val overdueGrace = config.getDuration("auction.deadlines.overdue-grace")
    val publication = PublicationSettings.fromConfig(config)
    val meetupFacts = MeetupFactsSettings.fromConfig(config)
    val slot = SlotSettings.fromConfig(config, askTimeout) match {
      case Right(settings) => settings
      case Left(reason) => fail(reason, None)
    }

    val database = DatabaseSettings.fromConfig(config) match {
      case Right(settings) => settings
      case Left(reason) => fail(reason, None)
    }

    // Таблица вызывающих — до ActorSystem, как база: неполная таблица — дефект
    // развёртывания, и он виден отказом старта, а не зелёным health при закрытых
    // методах (ADR-056).
    val callers = CallerTable.fromConfig(config, MethodAccess.declared) match {
      case Right(table) => table
      case Left(reason) => fail(reason, None)
    }

    // Адрес и собственный токен для Meetups — тоже до ActorSystem: адрес без
    // токена или токен вызывающего вместо своего — дефект развёртывания.
    val meetups = MeetupsSettings.fromConfig(config, callers.recognizes) match {
      case Right(settings) => settings
      case Left(reason) => fail(reason, None)
    }

    // Розыгрыш (ADR-066): Identity для проверки права при закрытии, зеркала
    // маяка и окна — тоже до ActorSystem, по той же причине, что Meetups.
    val identity = IdentitySettings.fromConfig(config) match {
      case Right(settings) => settings
      case Left(reason) => fail(reason, None)
    }
    val beacon = BeaconSettings.fromConfig(config) match {
      case Right(settings) => settings
      case Left(reason) => fail(reason, None)
    }
    val raffle = RaffleSettings.fromConfig(config) match {
      case Right(settings) => settings
      case Left(reason) => fail(reason, None)
    }
    // Режим итога розыгрыша (PER-727) виден в логе старта: на проде его включает values среды, и запись — способ
    // убедиться, что выкладка его донесла.
    logger.info(
      "auction raffle draw configured",
      StructuredArguments.keyValue("raffle_draw", if (raffle.byHand) "manual" else "automatic")
    )
    val erasureEvery: FiniteDuration = config.getDuration("auction.raffle.erasure-every").toScala

    // Схема применяется до ActorSystem: журнал, поднятый на базе без таблиц,
    // отказал бы только на первой записи агрегата, а не на старте.
    val migrations =
      try JournalSchema.migrate(database)
      catch { case NonFatal(cause) => fail("auction journal schema migration failed", Some(cause)) }
    logger.info(
      "auction journal schema migrated",
      StructuredArguments.keyValue("migrations_executed", migrations)
    )

    val telemetry = Telemetry.fromEnvironment()

    given system: ActorSystem[Nothing] = ActorSystem(Behaviors.empty, "auction", config)
    import system.executionContext

    // Последний экспорт метрик — при штатной остановке, после остановки проекции.
    CoordinatedShutdown(system).addTask(CoordinatedShutdown.PhaseBeforeActorSystemTerminate, "auction-telemetry") {
      () => Future { telemetry.close(); Done }
    }

    // Узел, который стартует сервис, и узел L1-тестов собираются одинаково.
    val clock = Clock.systemUTC()
    val sharding = AuctionNode.join(system)
    AuctionNode.registerLots(sharding, clock, UuidV7.generator(clock))
    // Один клиент Identity на все вопросы о `place_bids`: кандидаты розыгрыша, человек ставки зала и список имён
    // аукциона для помощника ведущего.
    val placeBidsAccess = GrpcIdentityAccess(identity)
    val displayNames = DisplayNameCommands(SlickDisplayNameStore(system))
    val raffleTickets = SlickRaffleTickets(system, displayNames)
    val resultNames: ResultNames = new ResultNames {
      def names(auction: AuctionId, participants: Set[ParticipantId]): Future[Map[ParticipantId, String]] =
        displayNames.names(auction, participants).map(_.map((participant, name) => participant -> name.text))
    }
    AuctionNode.registerRaffles(
      system,
      sharding,
      clock,
      UuidV7.generator(clock),
      placeBidsAccess,
      DrandBeacon(beacon),
      raffleTickets,
      raffle
    )
    val predictionStore = SlickPredictionStore(system)
    val predictions = AuctionNode.registerPredictions(
      sharding,
      clock,
      UuidV7.generator(clock),
      predictionStore,
      askTimeout
    )
    val results = AuctionNode.registerResults(
      sharding,
      clock,
      UuidV7.generator(clock),
      SlickResultsOutcomes(system),
      ResultsForecasts.of(predictionStore),
      resultNames,
      SlickResultsStore(system),
      askTimeout
    )
    AuctionNode.registerAuctions(
      system,
      sharding,
      clock,
      UuidV7.generator(clock),
      askTimeout,
      AuctionRaffle.sharded(sharding, askTimeout),
      AuctionNode.registerSlot(sharding, clock, UuidV7.generator(clock), slot),
      predictions,
      results,
      SlickSetOutcomes(system)
    )
    val invoices = AuctionNode.registerInvoices(sharding, clock, UuidV7.generator(clock), askTimeout)
    AuctionNode.eraseRaffleNames(system, raffleTickets, clock, erasureEvery)
    if (identity.url.isEmpty)
      logger.warn(
        "auction place_bids check is off: AUCTION_IDENTITY_GRPC_URL is not set, raffle pools are fixed without exclusions, floor bids and auction names are not screened"
      )
    if (meetups.url.isEmpty)
      logger.warn(
        "auction meetup authority is off: AUCTION_MEETUPS_GRPC_URL is not set, admin commands are unavailable"
      )
    val projectionMetrics = ProjectionMetrics(telemetry.getMeter("auction"), clock)
    AuctionNode.startProjection(system, projectionMetrics, backlogTimeout)
    AuctionNode.startInvoicing(system, sharding, invoices, projectionMetrics, askTimeout, backlogTimeout)
    AuctionNode.watchDeadlines(
      system,
      DeadlineMetrics(telemetry.getMeter("auction")),
      clock,
      overdueGrace,
      backlogTimeout
    )
    AuctionNode.startPublication(
      system,
      projectionMetrics,
      PublicationMetrics(telemetry.getMeter("auction")),
      publication,
      backlogTimeout
    )
    // Durable не объявлен — дефект развёртывания: процесс падает с ненулевым кодом, а не работает без наследования
    // отмен сходок, как при отказе привязки границы. Выход — не на потоке потребителя: остановка узла ждёт его.
    AuctionNode.startMeetupFacts(
      system,
      sharding,
      meetupFacts,
      MeetupFactsMetrics(telemetry.getMeter("auction")),
      reason =>
        Future {
          logger.error(s"auction meetup facts consumer failed: $reason")
          system.terminate()
          System.exit(1)
        }
    )
    val readiness = AuctionNode.readiness(system, readinessTimeout)
    // Один источник изменений на gRPC-поток ботов и поток экрана зала: слушатель базы и его соединение одни.
    val changes = AuctionNode.listenChanges(system)

    Http()
      .newServerAt(httpConfig.host, httpConfig.port)
      .bind(
        BoundaryLogging.boundary(
          concat(HealthRoutes.route(readiness), AuctionNode.screen(system, changes, GrpcMeetupStandings(meetups)))
        )
      )
      .onComplete(bound("http", system))

    Http()
      .newServerAt(grpcConfig.host, grpcConfig.port)
      .withSettings(AuctionNode.grpcServerSettings(system))
      .bind(
        AuctionNode.grpc(
          system,
          sharding,
          callers,
          askTimeout,
          GrpcMeetupAuthority(meetups),
          placeBidsAccess.holdsRight,
          changes,
          clock,
          overdueGrace,
          invoices,
          raffle.byHand
        )
      )
      .onComplete(bound("grpc", system))
  }

  /**
   * Итог привязки одной из границ. Запись о жизненном цикле процесса операцией не является: длительности и результата у
   * неё нет, поэтому каркас к ней не применяется.
   *
   * Отказ привязки любой из границ роняет процесс: health на HTTP остался бы зелёным у сервиса, который не слушает
   * gRPC. Завершение обязано быть ненулевым: `system.terminate()` сам по себе отдаёт код 0, и оркестратор видит штатную
   * остановку вместо отказа, то есть рестарт-политика не срабатывает, а `just auction-run` печатает success на сервисе,
   * который никого не слушает.
   */
  private def bound(boundary: String, system: ActorSystem[?]): Try[Http.ServerBinding] => Unit = {
    case Success(binding) =>
      val address = binding.localAddress
      logger.info(
        s"auction $boundary bound",
        StructuredArguments.keyValue("bound_address", s"${address.getHostString}:${address.getPort}")
      )
    case Failure(cause) =>
      logger.error(s"auction $boundary bind failed", cause)
      system.terminate()
      System.exit(1)
  }

  // Отказ до ActorSystem: завершать нечего, кроме самого процесса, и код
  // ненулевой по той же причине, что при отказе привязки HTTP.
  private def fail(message: String, cause: Option[Throwable]): Nothing = {
    cause.fold(logger.error(message))(logger.error(message, _))
    sys.exit(1)
  }
}
