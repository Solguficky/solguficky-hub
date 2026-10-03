package auction.testkit

import com.dimafeng.testcontainers.GenericContainer
import io.nats.client.Connection
import io.nats.client.JetStreamManagement
import io.nats.client.Nats
import io.nats.client.api.MessageInfo
import io.nats.client.api.StorageType
import io.nats.client.api.StreamConfiguration
import org.scalatest.BeforeAndAfterAll
import org.scalatest.Suite
import org.testcontainers.DockerClientFactory
import org.testcontainers.containers.wait.strategy.Wait

import java.time.Duration
import scala.util.Using

/**
 * Настоящий NATS с JetStream для L1-сьюта: один контейнер на сьют, стартует при первом обращении.
 *
 * Стрим сервис не заводит — его объявляет топология AppHost (ADR-050), — поэтому сьют объявляет его сам теми же
 * настройками, что `JetStreamTopology`: subjects домена и окно дедупликации в две минуты.
 */
trait NatsFixture extends BeforeAndAfterAll { self: Suite =>

  private var container: Option[GenericContainer] = None

  private def nats: GenericContainer =
    container.getOrElse {
      val started = GenericContainer(
        dockerImage = "nats:2.10-alpine",
        exposedPorts = Seq(4222),
        command = Seq("-js"),
        waitStrategy = Wait.forLogMessage(".*Server is ready.*", 1)
      )
      started.start()
      container = Some(started)
      started
    }

  protected def natsUrl: String = s"nats://${nats.host}:${nats.mappedPort(4222)}"

  /** Пустой стрим `AUCTION_EVENTS`: прежний удаляется, и тест не видит сообщений соседа. */
  protected def freshStream(): Unit =
    withJetStream { management =>
      if (management.getStreamNames.contains("AUCTION_EVENTS")) management.deleteStream("AUCTION_EVENTS")
      management.addStream(
        StreamConfiguration
          .builder()
          .name("AUCTION_EVENTS")
          .subjects("events.auction.>")
          .storageType(StorageType.Memory)
          .duplicateWindow(Duration.ofMinutes(2))
          .build()
      )
    }

  /** Все сообщения стрима по порядку: subject, заголовки и тело, как их сохранил сервер. */
  protected def streamMessages(): List[MessageInfo] =
    withJetStream { management =>
      val last = management.getStreamInfo("AUCTION_EVENTS").getStreamState.getLastSequence
      (1L to last).map(management.getMessage("AUCTION_EVENTS", _)).toList
    }

  /**
   * Замораживает сервер: соединение живо по TCP, но ни один запрос не получает ответа — так выглядит недоступная шина.
   */
  protected def pauseNats(): Unit =
    DockerClientFactory.instance().client().pauseContainerCmd(nats.containerId).exec()

  protected def resumeNats(): Unit =
    DockerClientFactory.instance().client().unpauseContainerCmd(nats.containerId).exec()

  private def withJetStream[A](use: JetStreamManagement => A): A =
    Using.resource(Nats.connect(natsUrl): Connection)(connection => use(connection.jetStreamManagement()))

  override protected def afterAll(): Unit =
    try super.afterAll()
    finally {
      container.foreach(_.stop())
      container = None
    }
}
