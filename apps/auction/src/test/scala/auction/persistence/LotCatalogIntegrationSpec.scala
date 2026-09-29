package auction.persistence

import auction.access.GlobalRole
import auction.access.Viewer
import auction.catalog.CatalogRefusal
import auction.catalog.LotCatalogCommands
import auction.catalog.LotId
import auction.testkit.PostgresFixture
import org.apache.pekko.actor.testkit.typed.scaladsl.ActorTestKit
import org.postgresql.util.PSQLException
import org.scalatest.concurrent.ScalaFutures
import org.scalatest.matchers.should.Matchers
import org.scalatest.time.Seconds
import org.scalatest.time.Span
import org.scalatest.wordspec.AnyWordSpec

import java.util.UUID
import scala.collection.mutable.ListBuffer
import scala.util.Using

final class LotCatalogIntegrationSpec extends AnyWordSpec with Matchers with ScalaFutures with PostgresFixture {

  implicit override val patienceConfig: PatienceConfig = PatienceConfig(timeout = Span(20, Seconds))

  private val admin = Viewer(Set(GlobalRole.Admin, GlobalRole.Member, GlobalRole.Public))
  private val participant = Viewer(Set(GlobalRole.Public))

  /** Строки каталога одного лота как их видит база, мимо сервиса. */
  private def rows(database: DatabaseSettings, lotId: LotId): List[(String, String)] =
    withConnection(database) { connection =>
      Using.resource(
        connection.prepareStatement("SELECT title, description FROM lot_catalog WHERE lot_id = ?::uuid")
      ) { statement =>
        statement.setString(1, lotId.value.toString)
        Using.resource(statement.executeQuery()) { found =>
          val all = ListBuffer.empty[(String, String)]
          while (found.next()) all += found.getString(1) -> found.getString(2)
          all.toList
        }
      }
    }

  private def node(database: DatabaseSettings): ActorTestKit = {
    JournalSchema.migrate(database)
    ActorTestKit(s"auction-${UUID.randomUUID()}", nodeConfig(database))
  }

  /** Узел, его хранилище каталога и команды поверх него; узел останавливается после теста. */
  private def withNode[A](database: DatabaseSettings)(use: (SlickLotCatalogStore, LotCatalogCommands) => A): A = {
    val kit = node(database)
    try {
      val store = SlickLotCatalogStore(kit.system)
      use(store, LotCatalogCommands(store)(using kit.system.executionContext))
    } finally kit.shutdownTestKit()
  }

  private def lotId() = LotId(UUID.randomUUID())

  "lot catalog" should {

    "keep a card written before the node stopped for the next node on the same database" in {
      val database = freshDatabase()
      val id = lotId()
      val created = withNode(database)((_, commands) => commands.create(admin, id, "Кружка", "с гербом").futureValue)

      val restored = withNode(database)((store, _) => store.find(id).futureValue)

      created.isRight shouldBe true
      restored shouldBe created.toOption
    }

    "keep one row when the same creation repeats and refuse a repetition with other fields" in {
      val database = freshDatabase()
      val id = lotId()
      withNode(database) { (_, commands) =>
        val first = commands.create(admin, id, "Кружка", "с гербом").futureValue

        commands.create(admin, id, "Кружка", "с гербом").futureValue shouldBe first
        commands.create(admin, id, "Кружка", "без герба").futureValue shouldBe Left(CatalogRefusal.CardConflict)
      }

      rows(database, id) shouldBe List("Кружка" -> "с гербом")
    }

    "leave the row as it was when a participant tries to edit it" in {
      val database = freshDatabase()
      val id = lotId()
      withNode(database) { (_, commands) =>
        commands.create(admin, id, "Кружка", "с гербом").futureValue

        commands.edit(participant, id, "Чужое", "").futureValue shouldBe Left(CatalogRefusal.NotAdmin)
        commands.create(participant, lotId(), "Чужое", "").futureValue shouldBe Left(CatalogRefusal.NotAdmin)
      }

      rows(database, id) shouldBe List("Кружка" -> "с гербом")
    }

    "replace the text of an existing card and refuse a card that does not exist" in {
      val database = freshDatabase()
      val id = lotId()
      val missing = lotId()
      withNode(database) { (_, commands) =>
        commands.create(admin, id, "Кружка", "с гербом").futureValue
        commands.edit(admin, id, "Кружка с опечаткой исправленной", "").futureValue.isRight shouldBe true

        commands.edit(admin, missing, "Кружка", "").futureValue shouldBe Left(CatalogRefusal.CardNotFound)
      }

      rows(database, id) shouldBe List("Кружка с опечаткой исправленной" -> "")
      rows(database, missing) shouldBe empty
    }

    "reject a blank title written past the service" in {
      val database = freshDatabase()
      JournalSchema.migrate(database)

      val rejected = the[PSQLException] thrownBy withConnection(database) {
        _.createStatement().executeUpdate(
          s"INSERT INTO lot_catalog (lot_id, title, description) VALUES ('${UUID.randomUUID()}', '   ', '')"
        )
      }

      rejected.getSQLState shouldBe "23514"
    }
  }
}
