package auction.catalog

import auction.access.GlobalRole
import auction.access.Viewer
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

  private val admin = Viewer(Set(GlobalRole.Admin, GlobalRole.Member, GlobalRole.Public))

  // Всё, что ниже администратора сходки: maintainer в круг admin не входит (ADR-043).
  private val notAdmins = Gen.oneOf(
    Viewer(Set.empty),
    Viewer(Set(GlobalRole.Public)),
    Viewer(Set(GlobalRole.Member, GlobalRole.Public)),
    Viewer(Set(GlobalRole.Maintainer, GlobalRole.Member, GlobalRole.Public))
  )

  private val blankTitles = Gen.listOf(Gen.oneOf(' ', '\t', '\n', '\r', '\u00A0', '\u2007', '\u202F')).map(_.mkString)

  private val oversized = TestImages.jpeg(LotImage.MaxBytes + 1)

  private def lotId() = LotId(UUID.randomUUID())

  private def versionOf(bytes: IArray[Byte]): ImageVersion = LotImage(bytes).map(_.version).getOrElse(fail("refused"))

  /** Хранилище, которое нельзя трогать: любой вызов роняет тест. */
  private object Untouchable extends LotCatalogStore {
    private def touched = fail("the store was touched")
    def insertIfAbsent(card: NewCard): Future[Option[LotCard]] = touched
    def update(edit: CardEdit): Future[Option[LotCard]] = touched
    def find(lotId: LotId): Future[Option[LotCard]] = touched
  }

  /** Строка в памяти: изображение — только версия, как его видит карточка. */
  private final class InMemory extends LotCatalogStore {
    val rows = TrieMap.empty[LotId, LotCard]
    def insertIfAbsent(created: NewCard): Future[Option[LotCard]] =
      Future.successful(rows.putIfAbsent(created.lotId, created.card))
    def update(edit: CardEdit): Future[Option[LotCard]] =
      Future.successful(rows.get(edit.lotId).map { stored =>
        val image = edit.image match {
          case ImageChange.Keep => stored.image
          case ImageChange.Replace(replacement) => Some(replacement.version)
          case ImageChange.Remove => None
        }
        val card = LotCard(edit.lotId, edit.title, edit.description, image)
        rows.update(edit.lotId, card)
        card
      })
    def find(lotId: LotId): Future[Option[LotCard]] = Future.successful(rows.get(lotId))
  }

  "lot catalog commands" should {

    "refuses a viewer who is not a meetup administrator before touching the store" in {
      val commands = LotCatalogCommands(Untouchable)
      forAll(notAdmins) { viewer =>
        commands.create(viewer, lotId(), "Лот", "", None).futureValue shouldBe Left(CatalogRefusal.NotAdmin)
        commands.edit(viewer, lotId(), "Лот", "", ImageChange.Keep).futureValue shouldBe Left(CatalogRefusal.NotAdmin)
      }
    }

    "refuses a non-administrator who sends or removes an image before touching the store" in {
      val commands = LotCatalogCommands(Untouchable)
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
      val commands = LotCatalogCommands(Untouchable)
      forAll(blankTitles) { title =>
        commands.create(admin, lotId(), title, "описание", None).futureValue shouldBe Left(CatalogRefusal.EmptyTitle)
        commands.edit(admin, lotId(), title, "описание", ImageChange.Keep).futureValue shouldBe
          Left(CatalogRefusal.EmptyTitle)
      }
    }

    "answers a non-administrator with a blank title and an oversized image by the missing right" in {
      forAll(notAdmins, blankTitles) { (viewer, title) =>
        LotCatalogCommands(Untouchable).create(viewer, lotId(), title, "", Some(oversized)).futureValue shouldBe
          Left(CatalogRefusal.NotAdmin)
      }
    }

    "refuses an oversized image before touching the store with the limit named" in {
      val commands = LotCatalogCommands(Untouchable)
      val refusal = Left(CatalogRefusal.ImageTooLarge(LotImage.MaxBytes))

      commands.create(admin, lotId(), "Кружка", "", Some(oversized)).futureValue shouldBe refusal
      commands.edit(admin, lotId(), "Кружка", "", ImageChange.Replace(oversized)).futureValue shouldBe refusal
    }

    "refuses bytes that are not an image before touching the store" in {
      val commands = LotCatalogCommands(Untouchable)
      val text = IArray.from("не картинка".getBytes(java.nio.charset.StandardCharsets.UTF_8))

      commands.create(admin, lotId(), "Кружка", "", Some(text)).futureValue shouldBe
        Left(CatalogRefusal.UnsupportedImage)
      commands.edit(admin, lotId(), "Кружка", "", ImageChange.Replace(text)).futureValue shouldBe
        Left(CatalogRefusal.UnsupportedImage)
    }

    "answers a blank title with an oversized image by the title" in {
      LotCatalogCommands(Untouchable).create(admin, lotId(), " ", "", Some(oversized)).futureValue shouldBe
        Left(CatalogRefusal.EmptyTitle)
    }

    "keeps the title as the administrator typed it" in {
      val store = InMemory()
      val id = lotId()

      val created = LotCatalogCommands(store).create(admin, id, "  Кружка с гербом ", "", None).futureValue

      created.map(_.title.value) shouldBe Right("  Кружка с гербом ")
      store.rows(id).title.value shouldBe "  Кружка с гербом "
    }

    "creates a card with the version of its image and one without" in {
      val store = InMemory()
      val commands = LotCatalogCommands(store)
      val pictured = lotId()
      val bare = lotId()

      commands.create(admin, pictured, "Кружка", "", Some(TestImages.png())).futureValue.map(_.image) shouldBe
        Right(Some(versionOf(TestImages.png())))
      commands.create(admin, bare, "Кружка", "", None).futureValue.map(_.image) shouldBe Right(None)
    }

    "accepts a repeated creation with the same fields and keeps one card" in {
      val store = InMemory()
      val commands = LotCatalogCommands(store)
      val id = lotId()
      val first = commands.create(admin, id, "Кружка", "с гербом", Some(TestImages.jpeg())).futureValue

      commands.create(admin, id, "Кружка", "с гербом", Some(TestImages.jpeg())).futureValue shouldBe first
      store.rows.size shouldBe 1
    }

    "refuses a repeated creation with other fields and leaves the card as it was" in {
      val store = InMemory()
      val commands = LotCatalogCommands(store)
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
      val commands = LotCatalogCommands(store)
      val id = lotId()
      commands.create(admin, id, "Кружка", "с гербом", Some(TestImages.jpeg())).futureValue

      val edited = commands.edit(admin, id, "Кружка большая", "", ImageChange.Keep).futureValue

      edited.map(card => (card.title.value, card.description, card.image)) shouldBe
        Right(("Кружка большая", "", Some(versionOf(TestImages.jpeg()))))
      Right(store.rows(id)) shouldBe edited
    }

    "changes the version together with the image and drops it with a removed image" in {
      val store = InMemory()
      val commands = LotCatalogCommands(store)
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

      LotCatalogCommands(store).edit(admin, lotId(), "Кружка", "", ImageChange.Keep).futureValue shouldBe
        Left(CatalogRefusal.CardNotFound)
      store.rows shouldBe empty
    }
  }
}
