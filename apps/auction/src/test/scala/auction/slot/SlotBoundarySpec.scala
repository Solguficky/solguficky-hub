package auction.slot

import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import scala.jdk.CollectionConverters.*
import scala.util.Using

/**
 * Слот торгов сообщества не знает торгов (ADR-047, дополнение 2026-10-12): идут ли они у держателя, он узнаёт только
 * ответом порта `SlotHolders`. Проверяется исходник пакета `slot`: любое упоминание `auction.<…>` вне белого списка —
 * нарушение, будь то импорт или полное имя в коде. Белый список — идентификатор аукциона и общие типы журнала.
 */
final class SlotBoundarySpec extends AnyWordSpec with Matchers {

  private val allowed = Set(
    "auction.slot",
    "auction.lot.AuctionId",
    "auction.entity.JournalSerializable",
    "auction.entity.JournalCorrupted"
  )

  private val root: Path = Paths.get("src", "main", "scala", "auction")

  private val sources: Path = root.resolve("slot")

  /**
   * Пакеты сервиса — каталоги под `auction/`: ссылка — это `auction.<пакет>…`, а не любое `auction.<имя>`, иначе
   * переменная `auction` с её полями читалась бы как путь пакета.
   */
  private val Reference = {
    val packages =
      Using.resource(Files.list(root))(_.iterator.asScala.filter(Files.isDirectory(_)).toList).map(_.getFileName)
    ("""\bauction\.(?:""" + packages.mkString("|") + """)\b[A-Za-z0-9_.]*""").r
  }

  private def files: List[Path] =
    Using.resource(Files.list(sources))(_.iterator.asScala.filter(_.toString.endsWith(".scala")).toList)

  "the slot package" should {

    "exists where the check looks for it" in {
      files.map(_.getFileName.toString) should contain allOf ("TradingSlot.scala", "TradingSlotEntity.scala")
    }

    "refers to nothing of the service beyond the auction identifier and the journal base types" in {
      val violations = for {
        file <- files
        text = new String(Files.readAllBytes(file), StandardCharsets.UTF_8)
        reference <- Reference.findAllIn(text).toList
        if !allowed.exists(prefix => reference == prefix || reference.startsWith(prefix + "."))
      } yield s"${file.getFileName}: $reference"
      violations shouldBe empty
    }
  }
}
