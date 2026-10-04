package auction.catalog

import org.scalacheck.Gen
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec
import org.scalatestplus.scalacheck.ScalaCheckDrivenPropertyChecks

final class LotImageSpec extends AnyWordSpec with Matchers with ScalaCheckDrivenPropertyChecks {

  private def accepted(bytes: IArray[Byte]): LotImage =
    LotImage(bytes).getOrElse(fail("the image was refused"))

  "lot image" should {

    "recognise JPEG, PNG and WebP by their signature" in {
      accepted(TestImages.jpeg()).mediaType shouldBe ImageMediaType.Jpeg
      accepted(TestImages.png()).mediaType shouldBe ImageMediaType.Png
      accepted(TestImages.webp()).mediaType shouldBe ImageMediaType.Webp
    }

    "refuse bytes that start with no known signature" in {
      val unknown = Gen.listOf(Gen.choose(Byte.MinValue, Byte.MaxValue)).suchThat { bytes =>
        ImageMediaType.detect(IArray.from(bytes)).isEmpty
      }
      forAll(unknown) { bytes =>
        LotImage(IArray.from(bytes)).left.toOption shouldBe Some(CatalogRefusal.UnsupportedImage)
      }
    }

    "refuse an empty file and a signature cut short" in {
      LotImage(IArray.empty[Byte]).left.toOption shouldBe Some(CatalogRefusal.UnsupportedImage)
      LotImage(TestImages.jpeg().take(2)).left.toOption shouldBe Some(CatalogRefusal.UnsupportedImage)
      LotImage(TestImages.png().take(7)).left.toOption shouldBe Some(CatalogRefusal.UnsupportedImage)
      // «RIFF» без «WEBP» на восьмом байте — другой RIFF-контейнер, например WAV.
      LotImage(TestImages.webp().take(11)).left.toOption shouldBe Some(CatalogRefusal.UnsupportedImage)
    }

    "accept a file exactly at the limit and refuse one byte more with the limit named" in {
      accepted(TestImages.jpeg(LotImage.MaxBytes)).content.length shouldBe LotImage.MaxBytes
      LotImage(TestImages.jpeg(LotImage.MaxBytes + 1)).left.toOption shouldBe
        Some(CatalogRefusal.ImageTooLarge(LotImage.MaxBytes))
    }

    "refuse an oversized file by its size even when it is not an image" in {
      LotImage(IArray.from(Array.fill[Byte](LotImage.MaxBytes + 1)(0))).left.toOption shouldBe
        Some(CatalogRefusal.ImageTooLarge(LotImage.MaxBytes))
    }

    "give the same bytes the same version and other bytes another" in {
      accepted(TestImages.jpeg(fill = 1)).version shouldBe accepted(TestImages.jpeg(fill = 1)).version
      accepted(TestImages.jpeg(fill = 1)).version should not be accepted(TestImages.jpeg(fill = 2)).version
    }

    "take the SHA-256 of the bytes in hex as the version" in {
      // SHA-256 от трёх байтов FF D8 FF, посчитанный независимо: `printf '\xff\xd8\xff' | sha256sum`.
      accepted(TestImages.jpeg(size = 3)).version shouldBe
        ImageVersion("6e568e1f67fba258184c78181539e5e8fdee447e49bb706fc0ea34fbf12336a5")
    }
  }
}
