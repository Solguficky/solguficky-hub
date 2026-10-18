package auction

import org.apache.pekko.actor.testkit.typed.scaladsl.ActorTestKit
import org.apache.pekko.actor.typed.ActorSystem
import org.scalatest.BeforeAndAfterAll
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

import scala.concurrent.Await
import scala.concurrent.ExecutionContext
import scala.concurrent.Future
import scala.concurrent.Promise
import scala.concurrent.duration.*

final class NodeReadinessSpec extends AnyWordSpec with Matchers with BeforeAndAfterAll {

  // Тесткит нужен ради планировщика предела, а не ради акторов: кластера и
  // журнала здесь нет, их заменяют функции.
  private val kit = ActorTestKit()
  private given ActorSystem[?] = kit.system
  private given ExecutionContext = kit.system.executionContext

  private val timeout = 200.millis

  override protected def afterAll(): Unit = kit.shutdownTestKit()

  private def check(clusterUp: Boolean, pingJournal: () => Future[Boolean]): Readiness =
    Await.result(NodeReadiness.check(() => clusterUp, pingJournal, timeout), 5.seconds)

  private val untouched: () => Future[Boolean] = () => fail("journal must not be pinged while the cluster is down")

  "node readiness" should {

    "report the cluster without touching the journal while the node is not up" in {
      check(clusterUp = false, untouched) shouldBe Readiness.ClusterNotUp
    }

    "report ready when the node is up and the journal connection is valid" in {
      check(clusterUp = true, () => Future.successful(true)) shouldBe Readiness.Ready
    }

    "report the journal when its connection is not valid" in {
      check(clusterUp = true, () => Future.successful(false)) shouldBe Readiness.JournalUnavailable
    }

    "report the journal when the ping fails" in {
      check(
        clusterUp = true,
        () => Future.failed(new java.sql.SQLTransientConnectionException("pool timeout"))
      ) shouldBe
        Readiness.JournalUnavailable
    }

    "report the journal when the ping throws before returning a future" in {
      check(clusterUp = true, () => throw new IllegalStateException("pool closed")) shouldBe
        Readiness.JournalUnavailable
    }

    "report the journal once the timeout passes without an answer" in {
      check(clusterUp = true, () => Promise[Boolean]().future) shouldBe Readiness.JournalUnavailable
    }
  }
}
