package auction.persistence

import auction.access.GlobalRole
import auction.access.Viewer
import auction.catalog.CatalogRefusal
import auction.catalog.ImageChange
import auction.catalog.LotCatalogCommands
import auction.catalog.LotId
import auction.catalog.LotImage
import auction.catalog.TestImages
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

  /** Изображение строки как его видит база, мимо сервиса: байты, тип и версия. */
  private final case class StoredImage(content: Seq[Byte], mediaType: String, version: String)

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

  /** Изображение строки лота мимо сервиса; `None` — колонки пусты. */
  private def image(database: DatabaseSettings, lotId: LotId): Option[StoredImage] =
    withConnection(database) { connection =>
      Using.resource(
        connection.prepareStatement(
          "SELECT image, image_media_type, image_version FROM lot_catalog WHERE lot_id = ?::uuid"
        )
      ) { statement =>
        statement.setString(1, lotId.value.toString)
        Using.resource(statement.executeQuery()) { found =>
          if (!found.next()) fail(s"no lot_catalog row for lot ${lotId.value}")
          Option(found.getBytes(1)).map(bytes => StoredImage(bytes.toSeq, found.getString(2), found.getString(3)))
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

  private def stored(bytes: IArray[Byte], mediaType: String): StoredImage = {
    val accepted = LotImage(bytes).getOrElse(fail("the image was refused"))
    StoredImage(bytes.toSeq, mediaType, accepted.version.value)
  }

  "lot catalog" should {

    "keeps a card written before the node stopped for the next node on the same database" in {
      val database = freshDatabase()
      val id = lotId()
      val created =
        withNode(database)((_, commands) => commands.create(admin, id, "Кружка", "с гербом", None).futureValue)

      val restored = withNode(database)((store, _) => store.find(id).futureValue)

      created.isRight shouldBe true
      restored shouldBe created.toOption
    }

    "keeps an image written by a catalog command for the next node on the same database" in {
      val database = freshDatabase()
      val id = lotId()
      val created = withNode(database) { (_, commands) =>
        commands.create(admin, id, "Кружка", "с гербом", Some(TestImages.png(size = 4096))).futureValue
      }

      val restored = withNode(database)((store, _) => store.find(id).futureValue)

      restored shouldBe created.toOption
      restored.flatMap(_.image) shouldBe Some(
        LotImage(TestImages.png(size = 4096)).map(_.version).getOrElse(fail("the image was refused"))
      )
      image(database, id) shouldBe Some(stored(TestImages.png(size = 4096), "image/png"))
    }

    "keeps one row when the same creation repeats and refuses a repetition with other fields" in {
      val database = freshDatabase()
      val id = lotId()
      withNode(database) { (_, commands) =>
        val first = commands.create(admin, id, "Кружка", "с гербом", Some(TestImages.jpeg())).futureValue

        commands.create(admin, id, "Кружка", "с гербом", Some(TestImages.jpeg())).futureValue shouldBe first
        commands.create(admin, id, "Кружка", "без герба", Some(TestImages.jpeg())).futureValue shouldBe
          Left(CatalogRefusal.CardConflict)
        commands.create(admin, id, "Кружка", "с гербом", Some(TestImages.jpeg(fill = 2))).futureValue shouldBe
          Left(CatalogRefusal.CardConflict)
      }

      rows(database, id) shouldBe List("Кружка" -> "с гербом")
      image(database, id) shouldBe Some(stored(TestImages.jpeg(), "image/jpeg"))
    }

    "leaves the row as it was when a participant tries to edit it" in {
      val database = freshDatabase()
      val id = lotId()
      withNode(database) { (_, commands) =>
        commands.create(admin, id, "Кружка", "с гербом", Some(TestImages.jpeg())).futureValue

        commands.edit(participant, id, "Чужое", "", ImageChange.Replace(TestImages.webp())).futureValue shouldBe
          Left(CatalogRefusal.NotAdmin)
        commands.edit(participant, id, "Чужое", "", ImageChange.Remove).futureValue shouldBe
          Left(CatalogRefusal.NotAdmin)
        commands.create(participant, lotId(), "Чужое", "", None).futureValue shouldBe Left(CatalogRefusal.NotAdmin)
      }

      rows(database, id) shouldBe List("Кружка" -> "с гербом")
      image(database, id) shouldBe Some(stored(TestImages.jpeg(), "image/jpeg"))
    }

    "leaves the row as it was when the image is over the limit" in {
      val database = freshDatabase()
      val id = lotId()
      withNode(database) { (_, commands) =>
        commands.create(admin, id, "Кружка", "с гербом", Some(TestImages.jpeg())).futureValue

        commands
          .edit(admin, id, "Другое", "", ImageChange.Replace(TestImages.jpeg(LotImage.MaxBytes + 1)))
          .futureValue shouldBe Left(CatalogRefusal.ImageTooLarge(LotImage.MaxBytes))
      }

      rows(database, id) shouldBe List("Кружка" -> "с гербом")
      image(database, id) shouldBe Some(stored(TestImages.jpeg(), "image/jpeg"))
    }

    "stores an image exactly at the limit" in {
      val database = freshDatabase()
      val id = lotId()
      val atLimit = TestImages.jpeg(LotImage.MaxBytes)
      withNode(database)((_, commands) => commands.create(admin, id, "Кружка", "", Some(atLimit)).futureValue)

      image(database, id).map(_.content.length) shouldBe Some(LotImage.MaxBytes)
    }

    "keeps the image on a text edit, changes the version with the image and clears all of it on removal" in {
      val database = freshDatabase()
      val id = lotId()
      withNode(database) { (_, commands) =>
        commands.create(admin, id, "Кружка", "", Some(TestImages.jpeg(fill = 1))).futureValue

        val kept = commands.edit(admin, id, "Кружка большая", "", ImageChange.Keep).futureValue
        image(database, id) shouldBe Some(stored(TestImages.jpeg(fill = 1), "image/jpeg"))
        kept.map(_.image.map(_.value)) shouldBe Right(image(database, id).map(_.version))

        val replaced =
          commands.edit(admin, id, "Кружка большая", "", ImageChange.Replace(TestImages.webp())).futureValue
        image(database, id) shouldBe Some(stored(TestImages.webp(), "image/webp"))
        replaced.map(_.image) should not be kept.map(_.image)
        replaced.map(_.image.map(_.value)) shouldBe Right(image(database, id).map(_.version))

        commands.edit(admin, id, "Кружка большая", "", ImageChange.Remove).futureValue.map(_.image) shouldBe Right(None)
      }

      rows(database, id) shouldBe List("Кружка большая" -> "")
      image(database, id) shouldBe None
    }

    "replaces the text of an existing card and refuses a card that does not exist" in {
      val database = freshDatabase()
      val id = lotId()
      val missing = lotId()
      withNode(database) { (_, commands) =>
        commands.create(admin, id, "Кружка", "с гербом", None).futureValue
        commands.edit(admin, id, "Кружка с опечаткой исправленной", "", ImageChange.Keep).futureValue.isRight shouldBe
          true

        commands.edit(admin, missing, "Кружка", "", ImageChange.Replace(TestImages.jpeg())).futureValue shouldBe
          Left(CatalogRefusal.CardNotFound)
      }

      rows(database, id) shouldBe List("Кружка с опечаткой исправленной" -> "")
      rows(database, missing) shouldBe empty
    }

    "rejects a blank title written past the service" in {
      val database = freshDatabase()
      JournalSchema.migrate(database)

      val rejected = the[PSQLException] thrownBy withConnection(database) {
        _.createStatement().executeUpdate(
          s"INSERT INTO lot_catalog (lot_id, title, description) VALUES ('${UUID.randomUUID()}', '   ', '')"
        )
      }

      rejected.getSQLState shouldBe "23514"
    }

    "rejects an image without its type and version written past the service" in {
      val database = freshDatabase()
      JournalSchema.migrate(database)

      val rejected = the[PSQLException] thrownBy withConnection(database) {
        _.createStatement().executeUpdate(
          s"INSERT INTO lot_catalog (lot_id, title, description, image) VALUES ('${UUID.randomUUID()}', 'Кружка', '', '\\xffd8ff')"
        )
      }

      rejected.getSQLState shouldBe "23514"
    }
  }
}
