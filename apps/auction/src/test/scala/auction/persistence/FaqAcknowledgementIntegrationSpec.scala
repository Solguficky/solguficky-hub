package auction.persistence

import auction.lot.ParticipantId
import auction.onboarding.FaqAcknowledgements
import auction.testkit.PostgresFixture
import org.apache.pekko.actor.testkit.typed.scaladsl.ActorTestKit
import org.scalatest.concurrent.ScalaFutures
import org.scalatest.matchers.should.Matchers
import org.scalatest.time.Seconds
import org.scalatest.time.Span
import org.scalatest.wordspec.AnyWordSpec

import java.util.UUID
import scala.concurrent.ExecutionContext
import scala.concurrent.Future
import scala.util.Using

final class FaqAcknowledgementIntegrationSpec extends AnyWordSpec with Matchers with ScalaFutures with PostgresFixture {
  implicit override val patienceConfig: PatienceConfig = PatienceConfig(timeout = Span(20, Seconds))
  private given ExecutionContext = ExecutionContext.global

  private def withNode[A](database: DatabaseSettings)(use: FaqAcknowledgements => A): A = {
    JournalSchema.migrate(database)
    val kit = ActorTestKit(s"auction-${UUID.randomUUID()}", nodeConfig(database))
    try use(SlickFaqAcknowledgements(kit.system))
    finally kit.shutdownTestKit()
  }

  "FAQ acknowledgement" should {
    "survives a node restart without an auction or chosen display name" in {
      val database = freshDatabase()
      val person = ParticipantId(UUID.randomUUID())
      withNode(database) { faq =>
        faq.acknowledged(person).futureValue shouldBe false
        faq.acknowledge(person).futureValue
      }
      withNode(database) { faq =>
        faq.acknowledged(person).futureValue shouldBe true
        faq.acknowledged(ParticipantId(UUID.randomUUID())).futureValue shouldBe false
      }
    }

    "keeps one row after concurrent and repeated completion" in {
      val database = freshDatabase()
      val person = ParticipantId(UUID.randomUUID())
      withNode(database) { faq =>
        Future.sequence(List.fill(8)(faq.acknowledge(person))).futureValue
        faq.acknowledge(person).futureValue
        faq.acknowledged(person).futureValue shouldBe true
      }
      val count = withConnection(database) { connection =>
        Using.resource(connection.createStatement()) { statement =>
          Using.resource(statement.executeQuery("SELECT count(*) FROM auction_faq_acknowledgement")) { result =>
            result.next()
            result.getLong(1)
          }
        }
      }
      count shouldBe 1L
    }
  }
}
