package auction.catalog

import auction.access.AccessRight
import auction.access.Viewer
import java.util.concurrent.TimeoutException
import org.scalacheck.Gen
import org.scalatest.concurrent.ScalaFutures
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec
import org.scalatestplus.scalacheck.ScalaCheckDrivenPropertyChecks

import java.util.UUID
import scala.collection.concurrent.TrieMap
import scala.concurrent.ExecutionContext
import scala.concurrent.Future

final class LotCatalogCommandsSpec
    extends AnyWordSpec
    with Matchers
    with ScalaFutures
    with ScalaCheckDrivenPropertyChecks {

  private given ExecutionContext = ExecutionContext.parasitic

  private val admin = Viewer(AccessRight.values.toSet)

  // Все, у кого нет права вести аукцион, в том числе держатель права вести сходки и остальных служебных прав:
  // каталог открывает только оно (ADR-070, п. 1).
  private val notAdmins = Gen.oneOf(
    Viewer(Set.empty),
    Viewer(Set(AccessRight.PlaceBids)),
    Viewer(Set(AccessRight.AccessHub, AccessRight.PlaceBids)),
    Viewer(Set(AccessRight.ManageMeetups)),
    Viewer(AccessRight.values.toSet - AccessRight.RunAuctions)
  )

  private val blankTitles = Gen.listOf(Gen.oneOf(' ', '\t', '\n', '\r', '\u00A0', '\u2007', '\u202F')).map(_.mkString)

  private val oversized = TestImages.jpeg(LotImage.MaxBytes + 1)

  private def lotId() = LotId(UUID.randomUUID())

  private def catalog(
      store: LotCatalogStore,
      standing: LotId => Future[CardStanding] = _ => Future.successful(CardStanding.Open)
  ) =
    LotCatalogCommands(store, standing)

  private def versionOf(bytes: IArray[Byte]): ImageVersion = LotImage(bytes).map(_.version).getOrElse(fail("refused"))

  /** Хранилище, которое нельзя трогать: любой вызов роняет тест. */
  private object Untouchable extends LotCatalogStore {
    private def touched = fail("the store was touched")
    def insertIfAbsent(card: NewCard): Future[CardInsertion] = touched
    def update(edit: CardEdit): Future[Option[LotCard]] = touched
    def addPhoto(addition: PhotoAddition, maxPhotos: Int): Future[Either[CatalogRefusal, LotCard]] = touched
    def removePhoto(removal: PhotoRemoval): Future[Either[CatalogRefusal, LotCard]] = touched
    def find(lotId: LotId): Future[Option[LotCard]] = touched
  }

  /**
   * Строка в памяти: изображение — только версия, как его видит карточка, и всегда равно первому фото. Правила записи в
   * базу держит L1 `LotCatalogIntegrationSpec`; здесь — то, что команды решают до хранилища.
   */
  private final class InMemory extends LotCatalogStore {
    val rows = TrieMap.empty[LotId, LotCard]
    private def withPhotos(card: LotCard, photos: Vector[LotPhotoRef]) =
      card.copy(image = photos.headOption.map(_.version), photos = photos)
    def insertIfAbsent(created: NewCard): Future[CardInsertion] =
      Future.successful(
        rows.putIfAbsent(created.lotId, created.card) match {
          case None => CardInsertion.Inserted(created.card)
          case Some(existing) => CardInsertion.Existing(existing)
        }
      )
    def update(edit: CardEdit): Future[Option[LotCard]] =
      Future.successful(rows.get(edit.lotId).map { stored =>
        val photos = edit.image match {
          case ImageChange.Keep => stored.photos
          case ImageChange.Replace(replacement) =>
            stored.photos.headOption match {
              case Some(cover) => cover.copy(version = replacement.version) +: stored.photos.tail
              case None => Vector(LotPhotoRef(edit.photoId, replacement.version))
            }
          case ImageChange.Remove => stored.photos.drop(1)
        }
        val card = withPhotos(stored.copy(title = edit.title, description = edit.description), photos)
        rows.update(edit.lotId, card)
        card
      })
    def addPhoto(addition: PhotoAddition, maxPhotos: Int): Future[Either[CatalogRefusal, LotCard]] =
      Future.successful(
        rows
          .get(addition.lotId)
          .toRight(CatalogRefusal.CardNotFound)
          .flatMap { stored =>
            stored.photos.find(_.photoId == addition.photoId) match {
              case Some(photo) if photo.version == addition.image.version => Right(stored)
              case Some(_) => Left(CatalogRefusal.PhotoConflict)
              case None if stored.photos.size >= maxPhotos => Left(CatalogRefusal.PhotoLimitReached(maxPhotos))
              case None =>
                val card = withPhotos(stored, stored.photos :+ LotPhotoRef(addition.photoId, addition.image.version))
                rows.update(addition.lotId, card)
                Right(card)
            }
          }
      )
    def removePhoto(removal: PhotoRemoval): Future[Either[CatalogRefusal, LotCard]] =
      Future.successful(rows.get(removal.lotId).toRight(CatalogRefusal.CardNotFound).map { stored =>
        val card = withPhotos(stored, stored.photos.filterNot(_.photoId == removal.photoId))
        rows.update(removal.lotId, card)
        card
      })
    def find(lotId: LotId): Future[Option[LotCard]] = Future.successful(rows.get(lotId))
  }

  private def photoId() = PhotoId(UUID.randomUUID())

  "lot catalog commands" should {

    "refuses a viewer who is not a meetup administrator before touching the store" in {
      val commands = catalog(Untouchable)
      forAll(notAdmins) { viewer =>
        commands.create(viewer, lotId(), "Лот", "", None).futureValue shouldBe Left(CatalogRefusal.NotAdmin)
        commands.edit(viewer, lotId(), "Лот", "", ImageChange.Keep).futureValue shouldBe Left(CatalogRefusal.NotAdmin)
      }
    }

    "refuses a non-administrator who sends or removes an image before touching the store" in {
      val commands = catalog(Untouchable)
      forAll(notAdmins) { viewer =>
        commands.create(viewer, lotId(), "Лот", "", Some(TestImages.jpeg())).futureValue shouldBe
          Left(CatalogRefusal.NotAdmin)
        commands.edit(viewer, lotId(), "Лот", "", ImageChange.Replace(TestImages.jpeg())).futureValue shouldBe
          Left(CatalogRefusal.NotAdmin)
        commands.edit(viewer, lotId(), "Лот", "", ImageChange.Remove).futureValue shouldBe
          Left(CatalogRefusal.NotAdmin)
      }
    }

    "refuses a blank title before touching the store" in {
      val commands = catalog(Untouchable)
      forAll(blankTitles) { title =>
        commands.create(admin, lotId(), title, "описание", None).futureValue shouldBe Left(CatalogRefusal.EmptyTitle)
        commands.edit(admin, lotId(), title, "описание", ImageChange.Keep).futureValue shouldBe
          Left(CatalogRefusal.EmptyTitle)
      }
    }

    "answers a non-administrator with a blank title and an oversized image by the missing right" in {
      forAll(notAdmins, blankTitles) { (viewer, title) =>
        catalog(Untouchable).create(viewer, lotId(), title, "", Some(oversized)).futureValue shouldBe
          Left(CatalogRefusal.NotAdmin)
      }
    }

    "refuses an oversized image before touching the store with the limit named" in {
      val commands = catalog(Untouchable)
      val refusal = Left(CatalogRefusal.ImageTooLarge(LotImage.MaxBytes))

      commands.create(admin, lotId(), "Кружка", "", Some(oversized)).futureValue shouldBe refusal
      commands.edit(admin, lotId(), "Кружка", "", ImageChange.Replace(oversized)).futureValue shouldBe refusal
    }

    "refuses bytes that are not an image before touching the store" in {
      val commands = catalog(Untouchable)
      val text = IArray.from("не картинка".getBytes(java.nio.charset.StandardCharsets.UTF_8))

      commands.create(admin, lotId(), "Кружка", "", Some(text)).futureValue shouldBe
        Left(CatalogRefusal.UnsupportedImage)
      commands.edit(admin, lotId(), "Кружка", "", ImageChange.Replace(text)).futureValue shouldBe
        Left(CatalogRefusal.UnsupportedImage)
    }

    "answers a blank title with an oversized image by the title" in {
      catalog(Untouchable).create(admin, lotId(), " ", "", Some(oversized)).futureValue shouldBe
        Left(CatalogRefusal.EmptyTitle)
    }

    "keeps the title as the administrator typed it" in {
      val store = InMemory()
      val id = lotId()

      val created = catalog(store).create(admin, id, "  Кружка с гербом ", "", None).futureValue

      created.map(_.title.value) shouldBe Right("  Кружка с гербом ")
      store.rows(id).title.value shouldBe "  Кружка с гербом "
    }

    "creates a card with the version of its image and one without" in {
      val store = InMemory()
      val commands = catalog(store)
      val pictured = lotId()
      val bare = lotId()

      commands.create(admin, pictured, "Кружка", "", Some(TestImages.png())).futureValue.map(_.image) shouldBe
        Right(Some(versionOf(TestImages.png())))
      commands.create(admin, bare, "Кружка", "", None).futureValue.map(_.image) shouldBe Right(None)
    }

    "accepts a repeated creation with the same fields and keeps one card" in {
      val store = InMemory()
      val commands = catalog(store)
      val id = lotId()
      val first = commands.create(admin, id, "Кружка", "с гербом", Some(TestImages.jpeg())).futureValue

      commands.create(admin, id, "Кружка", "с гербом", Some(TestImages.jpeg())).futureValue shouldBe first
      store.rows.size shouldBe 1
    }

    "refuses a repeated creation with other fields and leaves the card as it was" in {
      val store = InMemory()
      val commands = catalog(store)
      val id = lotId()
      val first = commands.create(admin, id, "Кружка", "с гербом", Some(TestImages.jpeg(fill = 1))).futureValue

      commands.create(admin, id, "Кружка", "без герба", Some(TestImages.jpeg(fill = 1))).futureValue shouldBe
        Left(CatalogRefusal.CardConflict)
      commands.create(admin, id, "Кружка", "с гербом", Some(TestImages.jpeg(fill = 2))).futureValue shouldBe
        Left(CatalogRefusal.CardConflict)
      commands.create(admin, id, "Кружка", "с гербом", None).futureValue shouldBe Left(CatalogRefusal.CardConflict)
      Right(store.rows(id)) shouldBe first
    }

    "replaces the text of an existing card and keeps its image when the edit names none" in {
      val store = InMemory()
      val commands = catalog(store)
      val id = lotId()
      commands.create(admin, id, "Кружка", "с гербом", Some(TestImages.jpeg())).futureValue

      val edited = commands.edit(admin, id, "Кружка большая", "", ImageChange.Keep).futureValue

      edited.map(card => (card.title.value, card.description, card.image)) shouldBe
        Right(("Кружка большая", "", Some(versionOf(TestImages.jpeg()))))
      Right(store.rows(id)) shouldBe edited
    }

    "changes the version together with the image and drops it with a removed image" in {
      val store = InMemory()
      val commands = catalog(store)
      val id = lotId()
      commands.create(admin, id, "Кружка", "", Some(TestImages.jpeg(fill = 1))).futureValue

      val replaced = commands.edit(admin, id, "Кружка", "", ImageChange.Replace(TestImages.jpeg(fill = 2))).futureValue
      val removed = commands.edit(admin, id, "Кружка", "", ImageChange.Remove).futureValue

      replaced.map(_.image) shouldBe Right(Some(versionOf(TestImages.jpeg(fill = 2))))
      replaced.map(_.image) should not be Right(Some(versionOf(TestImages.jpeg(fill = 1))))
      removed.map(_.image) shouldBe Right(None)
      store.rows(id).image shouldBe None
    }

    "refuses to edit a card that does not exist" in {
      val store = InMemory()

      catalog(store).edit(admin, lotId(), "Кружка", "", ImageChange.Keep).futureValue shouldBe
        Left(CatalogRefusal.CardNotFound)
      store.rows shouldBe empty
    }

    "refuses to change the title, description or image of a closed card and does not touch the store" in {
      val closed = catalog(Untouchable, _ => Future.successful(CardStanding.Closed))
      val image = ImageChange.Replace(TestImages.jpeg())

      closed.edit(admin, lotId(), "Новое", "текст", image).futureValue shouldBe Left(CatalogRefusal.CardClosed)
      closed.edit(admin, lotId(), "Новое", "", ImageChange.Keep).futureValue shouldBe Left(CatalogRefusal.CardClosed)
    }

    "does not ask the lot when the title is blank" in {
      catalog(Untouchable, _ => fail("the lot was asked"))
        .edit(admin, lotId(), " ", "", ImageChange.Keep)
        .futureValue shouldBe Left(CatalogRefusal.EmptyTitle)
    }

    "refuses photo commands of a viewer who is not a meetup administrator before asking the lot or the store" in {
      val commands = catalog(Untouchable, _ => fail("the lot was asked"))
      forAll(notAdmins) { viewer =>
        commands.addPhoto(viewer, lotId(), photoId(), TestImages.jpeg()).futureValue shouldBe
          Left(CatalogRefusal.NotAdmin)
        commands.removePhoto(viewer, lotId(), photoId()).futureValue shouldBe Left(CatalogRefusal.NotAdmin)
      }
    }

    "refuses an oversized photo and bytes that are not an image before asking the lot or the store" in {
      val commands = catalog(Untouchable, _ => fail("the lot was asked"))
      val text = IArray.from("не картинка".getBytes(java.nio.charset.StandardCharsets.UTF_8))

      commands.addPhoto(admin, lotId(), photoId(), oversized).futureValue shouldBe
        Left(CatalogRefusal.ImageTooLarge(LotImage.MaxBytes))
      commands.addPhoto(admin, lotId(), photoId(), text).futureValue shouldBe Left(CatalogRefusal.UnsupportedImage)
    }

    "refuses to add or remove a photo of a closed card and does not touch the store" in {
      val closed = catalog(Untouchable, _ => Future.successful(CardStanding.Closed))

      closed.addPhoto(admin, lotId(), photoId(), TestImages.jpeg()).futureValue shouldBe
        Left(CatalogRefusal.CardClosed)
      closed.removePhoto(admin, lotId(), photoId()).futureValue shouldBe Left(CatalogRefusal.CardClosed)
    }

    "keeps the image of the card equal to the first photo as photos come and go" in {
      val store = InMemory()
      val commands = catalog(store)
      val id = lotId()
      val (first, second) = (photoId(), photoId())
      commands.create(admin, id, "Кружка", "", None).futureValue

      commands.addPhoto(admin, id, first, TestImages.jpeg(fill = 1)).futureValue
      val added = commands.addPhoto(admin, id, second, TestImages.jpeg(fill = 2)).futureValue
      val removed = commands.removePhoto(admin, id, first).futureValue

      added.map(_.image) shouldBe Right(Some(versionOf(TestImages.jpeg(fill = 1))))
      added.map(_.photos.map(_.photoId)) shouldBe Right(Vector(first, second))
      removed.map(_.image) shouldBe Right(Some(versionOf(TestImages.jpeg(fill = 2))))
    }

    "passes the photo limit to the store" in {
      val store = InMemory()
      val commands = catalog(store)
      val id = lotId()
      commands.create(admin, id, "Кружка", "", None).futureValue
      (1 to LotImage.MaxPhotos).foreach(fill =>
        commands.addPhoto(admin, id, photoId(), TestImages.jpeg(fill = fill.toByte)).futureValue.isRight shouldBe true
      )

      commands.addPhoto(admin, id, photoId(), TestImages.jpeg(fill = 99)).futureValue shouldBe
        Left(CatalogRefusal.PhotoLimitReached(LotImage.MaxPhotos))
    }

    "does not write the card when the lot does not answer" in {
      catalog(Untouchable, _ => Future.failed(new TimeoutException("ask")))
        .edit(admin, lotId(), "Новое", "", ImageChange.Keep)
        .failed
        .futureValue shouldBe a[TimeoutException]
    }
  }
}
