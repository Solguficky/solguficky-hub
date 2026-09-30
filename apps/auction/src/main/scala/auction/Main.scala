package auction

import auction.boundary.BoundaryLogging
import auction.boundary.HealthRoutes
import auction.entity.UuidV7
import auction.grpc.CallerTable
import auction.grpc.MethodAccess
import auction.persistence.DatabaseSettings
import auction.persistence.JournalSchema
import com.typesafe.config.ConfigFactory
import net.logstash.logback.argument.StructuredArguments
import org.apache.pekko.actor.typed.ActorSystem
import org.apache.pekko.actor.typed.scaladsl.Behaviors
import org.apache.pekko.http.scaladsl.Http
import org.slf4j.LoggerFactory

import java.time.Clock
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
 * кластером, entity лота в шардинге, HTTP-границу с health и gRPC-границу.
 */
object Main {

  private val logger = LoggerFactory.getLogger(getClass)

  def main(args: Array[String]): Unit = {
    val config = ConfigFactory.load()
    val httpConfig = AuctionConfig.fromConfig(config)
    val grpcConfig = AuctionConfig.grpcFromConfig(config)
    val readinessTimeout: FiniteDuration = config.getDuration("auction.readiness-timeout").toScala
    val askTimeout: FiniteDuration = config.getDuration("auction.grpc.ask-timeout").toScala

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

    // Схема применяется до ActorSystem: журнал, поднятый на базе без таблиц,
    // отказал бы только на первой записи агрегата, а не на старте.
    val migrations =
      try JournalSchema.migrate(database)
      catch { case NonFatal(cause) => fail("auction journal schema migration failed", Some(cause)) }
    logger.info(
      "auction journal schema migrated",
      StructuredArguments.keyValue("migrations_executed", migrations)
    )

    given system: ActorSystem[Nothing] = ActorSystem(Behaviors.empty, "auction", config)
    import system.executionContext

    // Узел, который стартует сервис, и узел L1-тестов собираются одинаково.
    val clock = Clock.systemUTC()
    val sharding = AuctionNode.join(system)
    AuctionNode.registerLots(sharding, clock, UuidV7.generator(clock))
    val readiness = AuctionNode.readiness(system, readinessTimeout)

    Http()
      .newServerAt(httpConfig.host, httpConfig.port)
      .bind(BoundaryLogging.boundary(HealthRoutes.route(readiness)))
      .onComplete(bound("http", system))

    Http()
      .newServerAt(grpcConfig.host, grpcConfig.port)
      .bind(AuctionNode.grpc(system, sharding, callers, askTimeout))
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
