package auction

import auction.boundary.BoundaryLogging
import auction.boundary.HealthRoutes
import com.typesafe.config.ConfigFactory
import net.logstash.logback.argument.StructuredArguments
import org.apache.pekko.actor.typed.ActorSystem
import org.apache.pekko.actor.typed.scaladsl.Behaviors
import org.apache.pekko.http.scaladsl.Http
import org.slf4j.LoggerFactory

import scala.util.Failure
import scala.util.Success

/**
 * Точка входа Auction Service.
 *
 * Доменной логики торгов здесь нет и не будет: composition root собирает конфигурацию, actor system и HTTP-границу, а
 * всё остальное появляется отдельными срезами после доменного дизайна.
 */
object Main {

  private val logger = LoggerFactory.getLogger(getClass)

  def main(args: Array[String]): Unit = {
    val config = ConfigFactory.load()
    val httpConfig = AuctionConfig.fromConfig(config)

    given system: ActorSystem[Nothing] = ActorSystem(Behaviors.empty, "auction", config)
    import system.executionContext

    Http()
      .newServerAt(httpConfig.host, httpConfig.port)
      .bind(BoundaryLogging.boundary(HealthRoutes.route))
      .onComplete {
        // Запись о жизненном цикле процесса операцией не является: длительности
        // и результата у неё нет, поэтому каркас к ней не применяется.
        case Success(binding) =>
          val address = binding.localAddress
          logger.info(
            "auction http bound",
            StructuredArguments.keyValue("bound_address", s"${address.getHostString}:${address.getPort}")
          )
        // Завершение обязано быть ненулевым: `system.terminate()` сам по себе
        // отдаёт код 0, и оркестратор видит штатную остановку вместо отказа,
        // то есть рестарт-политика не срабатывает, а `just auction-run`
        // печатает success на сервисе, который никого не слушает.
        case Failure(cause) =>
          logger.error("auction http bind failed", cause)
          system.terminate()
          System.exit(1)
      }
  }
}
