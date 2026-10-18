package auction

import auction.persistence.JournalSchema
import auction.testkit.PostgresFixture
import org.apache.pekko.actor.testkit.typed.scaladsl.ActorTestKit
import org.scalatest.concurrent.Eventually
import org.scalatest.matchers.should.Matchers
import org.scalatest.time.Seconds
import org.scalatest.time.Span
import org.scalatest.wordspec.AnyWordSpec

import java.util.UUID
import scala.concurrent.Await
import scala.concurrent.duration.*

final class NodeReadinessIntegrationSpec extends AnyWordSpec with Matchers with Eventually with PostgresFixture {

  private val timeout = 2.seconds

  override implicit val patienceConfig: PatienceConfig = PatienceConfig(timeout = Span(20, Seconds))

  "node readiness" should {

    "report the cluster until the node joins, then ready, then the journal once its database is gone" in {
      val database = freshDatabase()
      JournalSchema.migrate(database)
      val kit = ActorTestKit(s"auction-${UUID.randomUUID()}", nodeConfig(database))
      try {
        val readiness = AuctionNode.readiness(kit.system, timeout)
        def current(): Readiness = Await.result(readiness(), timeout * 2)

        current() shouldBe Readiness.ClusterNotUp

        AuctionNode.join(kit.system)
        eventually(current() shouldBe Readiness.Ready)

        stopPostgres()
        val started = System.nanoTime()
        current() shouldBe Readiness.JournalUnavailable
        (System.nanoTime() - started).nanos should be <= (timeout + 1.second)
      } finally kit.shutdownTestKit()
    }
  }
}
