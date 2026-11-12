package auction.screen.load

import auction.testkit.MeetupsStub
import auction.testkit.ServiceProcess
import auction.volley.Volley
import com.dimafeng.testcontainers.PostgreSQLContainer
import org.apache.pekko.actor.typed.ActorSystem
import org.testcontainers.utility.DockerImageName

import java.time.Duration
import java.util.UUID
import scala.util.Random
import scala.util.control.NonFatal

/**
 * Стенд прогона на машине агента: PostgreSQL в контейнере, Meetups-заглушка и Auction отдельным процессом `java
 * auction.Main` — так же, как его запускает узел Aspire и L1 рестарта под залпом. Рестарт — убийство процесса без
 * штатной остановки и подъём нового на тех же портах и той же базе: экран и gRPC отвечают по прежним адресам.
 *
 * Числа этого стенда — предварительные: генератор, зрители и сервис делят одну машину, а маршрута через туннель нет.
 * Ответ по ADR-040 даёт прогон на stage.
 */
final class LocalStand private (
    postgres: PostgreSQLContainer,
    meetups: MeetupsStub,
    environment: Map[String, String],
    first: ServiceProcess
) {

  @volatile private var process = first

  def grpcPort: Int = process.grpcPort
  def httpPort: Int = process.httpPort

  /** Убивает процесс и поднимает новый на тех же портах; возвращает моменты убийства и готовности нового. */
  def restart(): (Long, Long) = {
    val ports = (process.grpcPort, process.httpPort)
    process.kill()
    val killedAt = System.currentTimeMillis()
    process = LocalStand.launch(environment, Some(ports))
    (killedAt, System.currentTimeMillis())
  }

  def close(): Unit =
    try process.stop()
    finally
      try meetups.stop()
      finally postgres.stop()
}

object LocalStand {

  val HubToken = "screen-load-hub"

  /** Администратор аукциона стенда: заглушка Meetups подтверждает только его. */
  val Administrator: String = newId().toString

  /** Идентификаторы людей и `op_id` граница принимает только в форме UUIDv7. */
  def newId(): UUID = Volley.uuidV7(Random(), System.currentTimeMillis())

  def start(maxStreams: Int)(using system: ActorSystem[?]): LocalStand = {
    val postgres = PostgreSQLContainer(dockerImageNameOverride = DockerImageName.parse("postgres:16-alpine"))
    postgres.start()
    // Отказ на любом шаге подъёма гасит то, что уже поднято: иначе контейнер и заглушка пережили бы упавший прогон.
    val meetups =
      try MeetupsStub.start(Administrator)
      catch { case NonFatal(e) => postgres.stop(); throw e }
    val environment = Map(
      "AUCTION_DATABASE_JDBC_URL" -> postgres.jdbcUrl,
      "AUCTION_DATABASE_USER" -> postgres.username,
      "AUCTION_DATABASE_PASSWORD" -> postgres.password,
      "AUCTION_CALLER_TOKEN_HUB_BOT" -> HubToken,
      "AUCTION_CALLER_TOKEN_AUCTION_BOT" -> "screen-load-auction",
      "AUCTION_CALLER_TOKEN_NOTIFICATIONS" -> "screen-load-notifications",
      "AUCTION_MEETUPS_GRPC_URL" -> meetups.url,
      "AUCTION_SERVICE_TOKEN" -> "screen-load-own",
      "AUCTION_SCREEN_MAX_STREAMS" -> maxStreams.toString
    )
    try LocalStand(postgres, meetups, environment, launch(environment, None))
    catch {
      case NonFatal(e) =>
        try meetups.stop()
        finally postgres.stop()
        throw e
    }
  }

  private def launch(environment: Map[String, String], ports: Option[(Int, Int)]): ServiceProcess = {
    val process = ServiceProcess.start(environment, ServiceProcess.logOf(s"screen-load-${UUID.randomUUID()}"), ports)
    // Неготовый процесс держал бы порты и базу и пережил бы JVM прогона.
    try process.awaitReady(Duration.ofMinutes(2))
    catch { case NonFatal(e) => process.stop(); throw e }
    process
  }
}
