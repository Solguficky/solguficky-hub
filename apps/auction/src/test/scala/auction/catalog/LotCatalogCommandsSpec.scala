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

  private val blankTitles = Gen.listOf(Gen.oneOf(' ', '\t', '\n', '\r')).map(_.mkString)

  private def lotId() = LotId(UUID.randomUUID())

  /** Хранилище, которое нельзя трогать: любой вызов роняет тест. */
  private object Untouchable extends LotCatalogStore {
    private def touched = fail("the store was touched")
    def insertIfAbsent(card: LotCard): Future[Option[LotCard]] = touched
    def update(card: LotCard): Future[Boolean] = touched
    def find(lotId: LotId): Future[Option[LotCard]] = touched
  }

  private final class InMemory extends LotCatalogStore {
    val rows = TrieMap.empty[LotId, LotCard]
    def insertIfAbsent(card: LotCard): Future[Option[LotCard]] = Future.successful(rows.putIfAbsent(card.lotId, card))
    def update(card: LotCard): Future[Boolean] =
      Future.successful(rows.replace(card.lotId, card).isDefined)
    def find(lotId: LotId): Future[Option[LotCard]] = Future.successful(rows.get(lotId))
  }

  "lot catalog commands" should {

    "refuse a viewer who is not a meetup administrator before touching the store" in {
      val commands = LotCatalogCommands(Untouchable)
      forAll(notAdmins) { viewer =>
        commands.create(viewer, lotId(), "Лот", "").futureValue shouldBe Left(CatalogRefusal.NotAdmin)
        commands.edit(viewer, lotId(), "Лот", "").futureValue shouldBe Left(CatalogRefusal.NotAdmin)
      }
    }

    "refuse a blank title before touching the store" in {
      val commands = LotCatalogCommands(Untouchable)
      forAll(blankTitles) { title =>
        commands.create(admin, lotId(), title, "описание").futureValue shouldBe Left(CatalogRefusal.EmptyTitle)
        commands.edit(admin, lotId(), title, "описание").futureValue shouldBe Left(CatalogRefusal.EmptyTitle)
      }
    }

    "answer a non-administrator with a blank title by the missing right" in {
      forAll(notAdmins, blankTitles) { (viewer, title) =>
        LotCatalogCommands(Untouchable).create(viewer, lotId(), title, "").futureValue shouldBe
          Left(CatalogRefusal.NotAdmin)
      }
    }

    "keep the title as the administrator typed it" in {
      val store = InMemory()
      val id = lotId()

      val created = LotCatalogCommands(store).create(admin, id, "  Кружка с гербом ", "").futureValue

      created.map(_.title.value) shouldBe Right("  Кружка с гербом ")
      store.rows(id).title.value shouldBe "  Кружка с гербом "
    }

    "accept a repeated creation with the same fields and keep one card" in {
      val store = InMemory()
      val commands = LotCatalogCommands(store)
      val id = lotId()
      val first = commands.create(admin, id, "Кружка", "с гербом").futureValue

      commands.create(admin, id, "Кружка", "с гербом").futureValue shouldBe first
      store.rows.size shouldBe 1
    }

    "refuse a repeated creation with other fields and leave the card as it was" in {
      val store = InMemory()
      val commands = LotCatalogCommands(store)
      val id = lotId()
      val first = commands.create(admin, id, "Кружка", "с гербом").futureValue

      commands.create(admin, id, "Кружка", "без герба").futureValue shouldBe Left(CatalogRefusal.CardConflict)
      Right(store.rows(id)) shouldBe first
    }

    "replace the title and the description of an existing card" in {
      val store = InMemory()
      val commands = LotCatalogCommands(store)
      val id = lotId()
      commands.create(admin, id, "Кружка", "с гербом").futureValue

      val edited = commands.edit(admin, id, "Кружка большая", "").futureValue

      edited.map(card => card.title.value -> card.description) shouldBe Right("Кружка большая" -> "")
      Right(store.rows(id)) shouldBe edited
    }

    "refuse to edit a card that does not exist" in {
      val store = InMemory()

      LotCatalogCommands(store).edit(admin, lotId(), "Кружка", "").futureValue shouldBe
        Left(CatalogRefusal.CardNotFound)
      store.rows shouldBe empty
    }
  }
}
