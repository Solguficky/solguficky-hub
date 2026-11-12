package auction.persistence

import auction.access.AccessRight
import auction.access.Viewer
import auction.catalog.CardStanding
import auction.catalog.CatalogRefusal
import auction.catalog.ImageChange
import auction.catalog.LotCatalogCommands
import auction.catalog.LotId
import auction.catalog.LotImage
import auction.catalog.PhotoId
import auction.catalog.TestImages
import auction.testkit.PostgresFixture
import org.apache.pekko.actor.testkit.typed.scaladsl.ActorTestKit
import org.flywaydb.core.Flyway
import org.postgresql.util.PSQLException
import org.scalatest.concurrent.ScalaFutures
import org.scalatest.matchers.should.Matchers
import org.scalatest.time.Seconds
import org.scalatest.time.Span
import org.scalatest.wordspec.AnyWordSpec

import java.util.UUID
import scala.collection.mutable.ListBuffer
import scala.concurrent.Future
import scala.util.Using

final class LotCatalogIntegrationSpec extends AnyWordSpec with Matchers with ScalaFutures with PostgresFixture {

  implicit override val patienceConfig: PatienceConfig = PatienceConfig(timeout = Span(20, Seconds))

  private val admin = Viewer(AccessRight.values.toSet)
  private val participant = Viewer(Set(AccessRight.PlaceBids))

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

  /** Фото лота в порядке показа мимо сервиса: позиция и изображение. */
  private def photos(database: DatabaseSettings, lotId: LotId): List[(Int, StoredImage)] =
    withConnection(database) { connection =>
      Using.resource(
        connection.prepareStatement(
          "SELECT position, content, media_type, version FROM lot_photo WHERE lot_id = ?::uuid ORDER BY position"
        )
      ) { statement =>
        statement.setString(1, lotId.value.toString)
        Using.resource(statement.executeQuery()) { found =>
          val all = ListBuffer.empty[(Int, StoredImage)]
          while (found.next())
            all += found.getInt(1) -> StoredImage(found.getBytes(2).toSeq, found.getString(3), found.getString(4))
          all.toList
        }
      }
    }

  /** Строка каталога с изображением мимо сервиса — так её пишет образ Auction без `lot_photo`. */
  private def writePast(database: DatabaseSettings, lotId: LotId, bytes: IArray[Byte]): Unit =
    withConnection(database) { connection =>
      Using.resource(
        connection.prepareStatement(
          "INSERT INTO lot_catalog (lot_id, title, description, image, image_media_type, image_version) " +
            "VALUES (?::uuid, 'Кружка', '', ?, 'image/jpeg', ?)"
        )
      ) { statement =>
        statement.setString(1, lotId.value.toString)
        statement.setBytes(2, IArray.genericWrapArray(bytes).toArray)
        statement.setString(3, stored(bytes, "image/jpeg").version)
        statement.executeUpdate()
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
      use(
        store,
        LotCatalogCommands(store, _ => Future.successful(CardStanding.Open))(using
          kit.system.executionContext
        )
      )
    } finally kit.shutdownTestKit()
  }

  private def lotId() = LotId(UUID.randomUUID())

  private def photoId() = PhotoId(UUID.randomUUID())

  private def jpeg(fill: Int) = TestImages.jpeg(fill = fill.toByte)

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

    "moves an image stored before the photo list into the first photo with the same bytes and version" in {
      val database = freshDatabase()
      val id = lotId()
      val bare = lotId()
      Flyway
        .configure()
        .dataSource(database.url, database.user, database.password)
        .locations("classpath:db/migration")
        .table(JournalSchema.HistoryTable)
        .target("18")
        .load()
        .migrate()
      writePast(database, id, jpeg(1))
      withConnection(database)(
        _.createStatement().executeUpdate(
          s"INSERT INTO lot_catalog (lot_id, title, description) VALUES ('${bare.value}', 'Без фото', '')"
        )
      )

      JournalSchema.migrate(database) should be >= 1

      photos(database, id) shouldBe List(1 -> stored(jpeg(1), "image/jpeg"))
      image(database, id) shouldBe Some(stored(jpeg(1), "image/jpeg"))
      photos(database, bare) shouldBe empty
      val card = withNode(database)((store, _) => store.find(id).futureValue).getOrElse(fail("no card"))
      card.photos.map(_.version) shouldBe Vector(card.image.getOrElse(fail("no cover")))
    }

    "adds photos to the end, keeps the image equal to the cover and refuses the eleventh with the limit" in {
      val database = freshDatabase()
      val id = lotId()
      val ids = Vector.fill(LotImage.MaxPhotos)(photoId())
      withNode(database) { (_, commands) =>
        commands.create(admin, id, "Кружка", "", None).futureValue
        ids.zipWithIndex.foreach((photo, index) =>
          commands.addPhoto(admin, id, photo, jpeg(index + 1)).futureValue.isRight shouldBe true
        )

        val card = commands.addPhoto(admin, id, ids.last, jpeg(LotImage.MaxPhotos)).futureValue
        card.map(_.photos.map(_.photoId)) shouldBe Right(ids)
        card.map(_.image) shouldBe Right(card.toOption.flatMap(_.photos.headOption.map(_.version)))
        commands.addPhoto(admin, id, photoId(), jpeg(99)).futureValue shouldBe
          Left(CatalogRefusal.PhotoLimitReached(LotImage.MaxPhotos))
      }

      photos(database, id).map(_._2) shouldBe (1 to LotImage.MaxPhotos).map(fill => stored(jpeg(fill), "image/jpeg"))
      image(database, id) shouldBe Some(stored(jpeg(1), "image/jpeg"))
    }

    "accepts a repeated addition once and refuses the same photo id with other bytes" in {
      val database = freshDatabase()
      val id = lotId()
      val photo = photoId()
      withNode(database) { (_, commands) =>
        commands.create(admin, id, "Кружка", "", None).futureValue
        val first = commands.addPhoto(admin, id, photo, jpeg(1)).futureValue

        commands.addPhoto(admin, id, photo, jpeg(1)).futureValue shouldBe first
        commands.addPhoto(admin, id, photo, jpeg(2)).futureValue shouldBe Left(CatalogRefusal.PhotoConflict)
      }

      photos(database, id) shouldBe List(1 -> stored(jpeg(1), "image/jpeg"))
    }

    "removes any photo, makes the next one the cover and clears the image with the last" in {
      val database = freshDatabase()
      val id = lotId()
      val (first, second, third) = (photoId(), photoId(), photoId())
      withNode(database) { (_, commands) =>
        commands.create(admin, id, "Кружка", "", None).futureValue
        commands.addPhoto(admin, id, first, jpeg(1)).futureValue
        commands.addPhoto(admin, id, second, jpeg(2)).futureValue
        commands.addPhoto(admin, id, third, jpeg(3)).futureValue

        commands.removePhoto(admin, id, first).futureValue.map(_.photos.map(_.photoId)) shouldBe
          Right(Vector(second, third))
        image(database, id) shouldBe Some(stored(jpeg(2), "image/jpeg"))

        commands.removePhoto(admin, id, third).futureValue.map(_.photos.map(_.photoId)) shouldBe Right(Vector(second))
        image(database, id) shouldBe Some(stored(jpeg(2), "image/jpeg"))

        commands.removePhoto(admin, id, second).futureValue.map(_.image) shouldBe Right(None)
        commands.removePhoto(admin, id, second).futureValue.map(_.photos) shouldBe Right(Vector.empty)
      }

      photos(database, id) shouldBe empty
      image(database, id) shouldBe None
    }

    "replaces and removes the cover through a card edit and keeps the other photos" in {
      val database = freshDatabase()
      val id = lotId()
      val later = photoId()
      withNode(database) { (_, commands) =>
        val created = commands.create(admin, id, "Кружка", "", Some(jpeg(1))).futureValue
        val cover = created.toOption.flatMap(_.photos.headOption).getOrElse(fail("no first photo")).photoId
        commands.addPhoto(admin, id, later, jpeg(2)).futureValue

        val replaced = commands.edit(admin, id, "Кружка", "", ImageChange.Replace(jpeg(3))).futureValue
        replaced.map(_.photos.map(_.photoId)) shouldBe Right(Vector(cover, later))
        image(database, id) shouldBe Some(stored(jpeg(3), "image/jpeg"))

        val removed = commands.edit(admin, id, "Кружка", "", ImageChange.Remove).futureValue
        removed.map(_.photos.map(_.photoId)) shouldBe Right(Vector(later))
      }

      photos(database, id).map(_._2) shouldBe List(stored(jpeg(2), "image/jpeg"))
      image(database, id) shouldBe Some(stored(jpeg(2), "image/jpeg"))
    }

    "adopts an image written past the photo list as the first photo before a photo command" in {
      val database = freshDatabase()
      val id = lotId()
      val added = photoId()
      JournalSchema.migrate(database)
      writePast(database, id, jpeg(1))

      withNode(database) { (_, commands) =>
        val card = commands.addPhoto(admin, id, added, jpeg(2)).futureValue
        card.map(_.photos.map(_.version.value)) shouldBe
          Right(Vector(stored(jpeg(1), "image/jpeg").version, stored(jpeg(2), "image/jpeg").version))
      }

      image(database, id) shouldBe Some(stored(jpeg(1), "image/jpeg"))
    }

    "refuses photo commands of a card that does not exist" in {
      val database = freshDatabase()
      val missing = lotId()
      withNode(database) { (_, commands) =>
        commands.addPhoto(admin, missing, photoId(), jpeg(1)).futureValue shouldBe Left(CatalogRefusal.CardNotFound)
        commands.removePhoto(admin, missing, photoId()).futureValue shouldBe Left(CatalogRefusal.CardNotFound)
      }

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
