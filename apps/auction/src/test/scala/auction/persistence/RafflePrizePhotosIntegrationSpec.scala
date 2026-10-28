package auction.persistence

import auction.lot.AuctionId
import auction.raffle.PrizePhotoBytes
import auction.testkit.PostgresFixture
import org.apache.pekko.actor.testkit.typed.scaladsl.ActorTestKit
import org.scalatest.concurrent.ScalaFutures
import org.scalatest.matchers.should.Matchers
import org.scalatest.time.Seconds
import org.scalatest.time.Span
import org.scalatest.wordspec.AnyWordSpec

import java.util.UUID

/**
 * Байты фото приза розыгрыша (PER-772) на настоящей базе: строка под id фото не перезаписывается, другие байты под тем
 * же id — конфликт, а удаление снимает только названную строку своего аукциона.
 */
final class RafflePrizePhotosIntegrationSpec extends AnyWordSpec with Matchers with ScalaFutures with PostgresFixture {

  implicit override val patienceConfig: PatienceConfig = PatienceConfig(timeout = Span(20, Seconds))

  private def withPhotos[A](use: SlickRafflePrizePhotos => A): A = {
    val database = freshDatabase()
    JournalSchema.migrate(database)
    val kit = ActorTestKit(s"auction-${UUID.randomUUID()}", nodeConfig(database))
    try use(SlickRafflePrizePhotos(kit.system))
    finally kit.shutdownTestKit()
  }

  private def photo(bytes: Byte*) =
    PrizePhotoBytes(
      IArray.from(Array[Byte](0xff.toByte, 0xd8.toByte, 0xff.toByte) ++ bytes),
      "image/jpeg",
      s"v${bytes.mkString}"
    )

  "raffle prize photos" should {

    "keeps the first bytes under a photo id, accepts the same bytes again and refuses other bytes" in {
      withPhotos { photos =>
        val auction = AuctionId(UUID.randomUUID())
        val id = UUID.randomUUID()
        photos.store(auction, id, photo(1)).futureValue shouldBe true
        photos.store(auction, id, photo(1)).futureValue shouldBe true
        photos.store(auction, id, photo(2)).futureValue shouldBe false

        val read = photos.read(auction, id).futureValue.getOrElse(fail("the photo was not stored"))
        IArray.genericWrapArray(read.content).toSeq shouldBe IArray.genericWrapArray(photo(1).content).toSeq
        (read.mediaType, read.version) shouldBe ("image/jpeg", "v1")
        photos.read(AuctionId(UUID.randomUUID()), id).futureValue shouldBe None
      }
    }

    "deletes only the named photo of its auction" in {
      withPhotos { photos =>
        val auction = AuctionId(UUID.randomUUID())
        val other = AuctionId(UUID.randomUUID())
        val (gone, kept) = (UUID.randomUUID(), UUID.randomUUID())
        photos.store(auction, gone, photo(1)).futureValue shouldBe true
        photos.store(auction, kept, photo(2)).futureValue shouldBe true
        photos.store(other, gone, photo(3)).futureValue shouldBe true

        photos.delete(auction, gone).futureValue
        photos.read(auction, gone).futureValue shouldBe None
        photos.read(auction, kept).futureValue.map(_.version) shouldBe Some("v2")
        photos.read(other, gone).futureValue.map(_.version) shouldBe Some("v3")
        photos.delete(auction, gone).futureValue
      }
    }
  }
}
