package auction.prediction

import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import scala.jdk.CollectionConverters.*
import scala.util.Using

/**
 * Граница ADR-067, п. 1 кодом: код прогнозов не читает журнал лота и не знает торгов — ни лота, ни ставки, ни аукциона,
 * ни read model. Проверяется исходник пакета `prediction`: любое упоминание `auction.<…>` вне белого списка —
 * нарушение. Белый список — значения-идентификаторы и общие типы журнала; лот раунда пакет знает только
 * идентификатором.
 */
final class PredictionBoundarySpec extends AnyWordSpec with Matchers {

  private val allowed = Set(
    "auction.prediction",
    "auction.lot.OpId",
    "auction.lot.ParticipantId",
    "auction.lot.AuctionId",
    "auction.catalog.LotId",
    "auction.entity.JournalSerializable",
    "auction.entity.JournalCorrupted"
  )

  private val root: Path = Paths.get("src", "main", "scala", "auction")

  private val sources: Path = root.resolve("prediction")

  /** Пакеты сервиса — каталоги под `auction/`, как в `RaffleBoundarySpec`. */
  private val Reference = {
    val packages =
      Using.resource(Files.list(root))(_.iterator.asScala.filter(Files.isDirectory(_)).toList).map(_.getFileName)
    ("""\bauction\.(?:""" + packages.mkString("|") + """)\b[A-Za-z0-9_.]*""").r
  }

  private def files: List[Path] =
    Using.resource(Files.list(sources))(_.iterator.asScala.filter(_.toString.endsWith(".scala")).toList)

  "the prediction package" should {

    "exists where the check looks for it" in {
      files.map(_.getFileName.toString) should contain allOf ("Predictions.scala", "PredictionEntity.scala")
    }

    "refers to nothing of the service beyond the identifiers and the journal base types" in {
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
