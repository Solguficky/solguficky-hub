package auction.testkit

import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import java.time.Duration
import java.util.concurrent.TimeUnit
import scala.io.Source
import scala.jdk.CollectionConverters.*
import scala.util.Using

/**
 * Auction отдельным процессом: та же голая JVM `java auction.Main`, которой его запускает узел Aspire, по runtime
 * classpath из ресурса `auction-runtime-classpath` (его пишет `build.sbt`). В отличие от узла в JVM теста, процесс
 * можно убить без штатной остановки: `kill` — это `destroyForcibly`, SIGKILL на Linux и TerminateProcess на Windows, и
 * ни CoordinatedShutdown, ни дописанная запись журнала после него не случаются.
 *
 * Окружение процесса — только то, что назвал тест: унаследованные `AUCTION_*` и `OTEL_*` машины теста вычищаются, иначе
 * чужая база или экспортёр метрик доехали бы до сервиса молча. Вывод процесса пишется в файл, а не в консоль сьюта.
 */
final class ServiceProcess private (process: Process, val grpcPort: Int, val httpPort: Int, val log: Path) {

  /**
   * Ждёт `200` от `/health` — узел `Up` в кластере и журнал отвечает — и открытый gRPC-порт. Умерший процесс — провал с
   * хвостом его лога.
   */
  def awaitReady(timeout: Duration): Unit = {
    val client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(1)).build()
    val request =
      HttpRequest.newBuilder(URI.create(s"http://127.0.0.1:$httpPort/health")).timeout(Duration.ofSeconds(2)).build()
    val until = System.nanoTime() + timeout.toNanos
    // Health и gRPC привязываются независимо: health может ответить раньше, чем gRPC-порт начнёт принимать.
    def listening: Boolean =
      try { Using.resource(new Socket())(_.connect(new InetSocketAddress("127.0.0.1", grpcPort), 1000)); true }
      catch { case _: java.io.IOException => false }
    def ready: Boolean =
      try client.send(request, HttpResponse.BodyHandlers.discarding()).statusCode() == 200 && listening
      catch { case _: java.io.IOException => false }
    while (!ready) {
      if (!process.isAlive) throw new IllegalStateException(s"auction exited with ${process.exitValue()}:\n$tail")
      if (System.nanoTime() > until) throw new IllegalStateException(s"auction is not ready after $timeout:\n$tail")
      Thread.sleep(200)
    }
  }

  /** Убийство без штатной остановки: процесс не успевает ни ответить, ни дописать журнал. */
  def kill(): Unit = {
    process.destroyForcibly()
    if (!process.waitFor(30, TimeUnit.SECONDS)) throw new IllegalStateException("auction survived destroyForcibly")
  }

  /** Остановка в конце теста. Штатная она или нет, проверке всё равно: проверка закончилась раньше. */
  def stop(): Unit = if (process.isAlive) kill()

  /** Последние строки лога процесса: их несёт провал, чтобы причина была видна без поиска файла. */
  def tail: String =
    if (!Files.exists(log)) ""
    else Files.readAllLines(log, StandardCharsets.UTF_8).asScala.takeRight(40).mkString("\n")
}

object ServiceProcess {

  /** Стартует сервис на свободных портах. Готовность — отдельным `awaitReady`. */
  def start(environment: Map[String, String], log: Path): ServiceProcess = {
    val grpcPort = freePort()
    val httpPort = Iterator.continually(freePort()).dropWhile(_ == grpcPort).next()
    val java = Paths.get(sys.props("java.home"), "bin", "java").toString
    val builder = new ProcessBuilder(java, "-cp", classpath, "auction.Main")
    val env = builder.environment()
    env.keySet.removeIf(key => key.startsWith("AUCTION_") || key.startsWith("OTEL_"))
    (environment ++ Map(
      "AUCTION_HTTP_PORT" -> httpPort.toString,
      "AUCTION_GRPC_PORT" -> grpcPort.toString
    )).foreach((key, value) => env.put(key, value))
    Files.createDirectories(log.getParent)
    builder.redirectErrorStream(true).redirectOutput(ProcessBuilder.Redirect.appendTo(log.toFile))
    new ServiceProcess(builder.start(), grpcPort, httpPort, log)
  }

  private lazy val classpath: String = {
    val resource = Option(getClass.getClassLoader.getResource("auction-runtime-classpath"))
      .getOrElse(
        throw new IllegalStateException("auction-runtime-classpath is not on the test classpath: see build.sbt")
      )
    Using.resource(Source.fromURL(resource, "UTF-8"))(_.mkString.trim).ensuring(_.nonEmpty)
  }

  /** Порт, который ОС только что отдала: между закрытием сокета и стартом процесса его может занять другой. */
  private def freePort(): Int = Using.resource(new ServerSocket(0))(_.getLocalPort)

  /** Каталог логов процессов под `target`, чтобы его чистил `sbt clean`. */
  def logOf(name: String): Path = Paths.get("target", "service-process", s"$name.log").toAbsolutePath
}
