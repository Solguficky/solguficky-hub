package auction.persistence

import auction.testkit.PostgresFixture
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

import scala.collection.mutable.ListBuffer
import scala.concurrent.Await
import scala.concurrent.ExecutionContext.Implicits.global
import scala.concurrent.Future
import scala.concurrent.duration.*
import scala.util.Using

final class JournalSchemaIntegrationSpec extends AnyWordSpec with Matchers with PostgresFixture {

  private def tables(database: DatabaseSettings): Set[String] =
    withConnection(database) { connection =>
      Using.resource(
        connection
          .createStatement()
          .executeQuery("SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()")
      ) { rows =>
        val names = ListBuffer.empty[String]
        while (rows.next()) names += rows.getString(1)
        names.toSet
      }
    }

  private def appliedVersions(database: DatabaseSettings): List[String] =
    withConnection(database) { connection =>
      Using.resource(
        connection
          .createStatement()
          .executeQuery(s"SELECT version FROM ${JournalSchema.HistoryTable} WHERE success ORDER BY installed_rank")
      ) { rows =>
        val versions = ListBuffer.empty[String]
        while (rows.next()) versions += rows.getString(1)
        versions.toList
      }
    }

  "journal schema" should {

    "create the journal, tag, snapshot and lot catalog tables on an empty database" in {
      val database = freshDatabase()

      JournalSchema.migrate(database) shouldBe 2

      tables(database) should contain allOf (
        "event_journal",
        "event_tag",
        "snapshot",
        "lot_catalog",
        JournalSchema.HistoryTable
      )
    }

    "apply nothing and keep one record per version on a database that already carries the schema" in {
      val database = freshDatabase()
      JournalSchema.migrate(database)

      JournalSchema.migrate(database) shouldBe 0

      appliedVersions(database) shouldBe List("1", "2")
    }

    "let two processes migrating the same empty database at once apply the schema exactly once" in {
      val database = freshDatabase()

      val executed = Await.result(
        Future.sequence(List.fill(2)(Future(JournalSchema.migrate(database)))),
        60.seconds
      )

      executed.sum shouldBe 2
      appliedVersions(database) shouldBe List("1", "2")
    }
  }
}
