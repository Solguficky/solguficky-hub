package auction.testkit

import auction.persistence.DatabaseSettings
import com.dimafeng.testcontainers.PostgreSQLContainer
import com.typesafe.config.Config
import com.typesafe.config.ConfigFactory
import org.scalatest.BeforeAndAfterAll
import org.scalatest.Suite
import org.testcontainers.utility.DockerImageName

import java.sql.Connection
import java.sql.DriverManager
import java.util.UUID
import scala.util.Using

/**
 * Настоящий PostgreSQL для L1-сьюта: один контейнер на сьют и отдельная база на тест.
 *
 * Контейнер стартует при первом обращении, а не при создании сьюта: L1 отбирается по имени сьюта в `build.sbt`, но
 * лишний старт Docker ради сьюта, который ничего не спросил, всё равно стоил бы полминуты.
 */
trait PostgresFixture extends BeforeAndAfterAll { self: Suite =>

  private var container: Option[PostgreSQLContainer] = None

  private def postgres: PostgreSQLContainer =
    container.getOrElse {
      val started = PostgreSQLContainer(dockerImageNameOverride = DockerImageName.parse("postgres:16-alpine"))
      started.start()
      container = Some(started)
      started
    }

  /** Пустая база под один тест: тесты не видят схему и строки журнала друг друга. */
  protected def freshDatabase(): DatabaseSettings = {
    val name = s"auction_${UUID.randomUUID().toString.replace("-", "")}"
    Using.resource(DriverManager.getConnection(postgres.jdbcUrl, postgres.username, postgres.password)) {
      _.createStatement().execute(s"CREATE DATABASE $name")
    }
    DatabaseSettings(
      s"jdbc:postgresql://${postgres.host}:${postgres.mappedPort(5432)}/$name",
      postgres.username,
      postgres.password
    )
  }

  /** Останавливает сервер целиком — так тест видит базу, которая пропала под живым узлом. */
  protected def stopPostgres(): Unit = {
    container.foreach(_.stop())
    // Следующий freshDatabase в том же сьюте поднимает новый контейнер, а не
    // идёт в остановленный.
    container = None
  }

  protected def withConnection[A](database: DatabaseSettings)(use: Connection => A): A =
    Using.resource(DriverManager.getConnection(database.url, database.user, database.password))(use)

  /**
   * Конфигурация узла поверх `application.conf` сервиса, а не отдельная тестовая: тест проверяет ту конфигурацию
   * кластера и журнала, с которой стартует сервис, меняя только адрес базы.
   */
  protected def nodeConfig(database: DatabaseSettings): Config =
    ConfigFactory.load(
      ConfigFactory
        .parseString(
          s"""
          |auction.database {
          |  url = "${database.url}"
          |  user = "${database.user}"
          |  password = "${database.password}"
          |}
          |# Несколько ActorSystem с кластером в одной JVM регистрируют свои MBean.
          |pekko.cluster.jmx.multi-mbeans-in-same-jvm = on
          |# Тест часто гасит узел через миллисекунды после старта, когда экземпляры
          |# проекции ещё ждут координатора шардинга. Регион тогда ждёт их весь
          |# таймаут фазы — 10 секунд, ровно предел shutdownTestKit, — и остановка
          |# падает. Сервис так рано не останавливают, поэтому сокращение только здесь.
          |pekko.coordinated-shutdown.phases.cluster-sharding-shutdown-region.timeout = 2s
          |""".stripMargin
        )
        .withFallback(ConfigFactory.parseResourcesAnySyntax("application"))
    )

  override protected def afterAll(): Unit =
    try super.afterAll()
    finally stopPostgres()
}
