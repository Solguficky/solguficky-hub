package auction.catalog

import java.security.MessageDigest
import java.util.HexFormat
import java.util.UUID

/** Идентификатор лота. Каталог и журнал лота делят его: строка каталога создаётся с тем же `lot_id`, что и лот. */
final case class LotId(value: UUID)

/** Название лота: не пустое и не из одних пробелов. Текст хранится как ввёл администратор, без обрезки. */
final case class LotTitle private (value: String)

object LotTitle {

  def apply(raw: String): Either[CatalogRefusal, LotTitle] =
    if (raw.forall(blank)) Left(CatalogRefusal.EmptyTitle) else Right(new LotTitle(raw))

  // `isBlank` неразрывные пробелы (U+00A0, U+2007, U+202F) пробелом не считает, а на экране они пусты так же.
  private def blank(c: Char): Boolean = Character.isWhitespace(c) || Character.isSpaceChar(c)
}

/**
 * Версия изображения — SHA-256 его байтов в hex. Те же байты дают ту же версию: повтор команды с тем же файлом карточку
 * не меняет, а кэш `file_id` у бота остаётся тёплым.
 */
final case class ImageVersion(value: String)

/** Тип изображения, которое хранит каталог. Его выводит сервис из байтов, а не берёт у вызывающего. */
enum ImageMediaType(val value: String) {
  case Jpeg extends ImageMediaType("image/jpeg")
  case Png extends ImageMediaType("image/png")
  case Webp extends ImageMediaType("image/webp")
}

object ImageMediaType {

  private val JpegMagic = IArray[Byte](0xff.toByte, 0xd8.toByte, 0xff.toByte)
  private val PngMagic = IArray[Byte](0x89.toByte, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)

  /** Тип по сигнатуре файла; `None` — байты не начинаются ни с одной из известных сигнатур. */
  def detect(bytes: IArray[Byte]): Option[ImageMediaType] =
    if (startsWith(bytes, 0, JpegMagic)) Some(Jpeg)
    else if (startsWith(bytes, 0, PngMagic)) Some(Png)
    // RIFF-контейнер: четыре байта длины между «RIFF» и «WEBP».
    else if (startsWith(bytes, 0, ascii("RIFF")) && startsWith(bytes, 8, ascii("WEBP"))) Some(Webp)
    else None

  private def ascii(text: String): IArray[Byte] = IArray.from(text.getBytes(java.nio.charset.StandardCharsets.US_ASCII))

  private def startsWith(bytes: IArray[Byte], offset: Int, magic: IArray[Byte]): Boolean =
    bytes.length >= offset + magic.length && magic.indices.forall(i => bytes(offset + i) == magic(i))
}

/**
 * Изображение лота, прошедшее проверку: размер в пределе, тип распознан по сигнатуре. Другого способа получить значение
 * нет, поэтому в хранилище не доходит ни слишком большой, ни нераспознанный файл.
 */
final class LotImage private (val content: IArray[Byte], val mediaType: ImageMediaType, val version: ImageVersion)

object LotImage {

  /**
   * Предел размера файла (ADR-057, дополнение 2026-09-30: значение выбирает реализация). Сжатое Telegram фото весит
   * сотни килобайт; потолок задаёт grpc-js ботов, который по умолчанию не принимает сообщение больше 4 MiB, и ответ
   * `GetLotImage` с файлом у этого потолка бот бы не прочитал.
   */
  val MaxBytes: Int = 2 * 1024 * 1024

  def apply(bytes: IArray[Byte]): Either[CatalogRefusal, LotImage] =
    if (bytes.length > MaxBytes) Left(CatalogRefusal.ImageTooLarge(MaxBytes))
    else
      ImageMediaType
        .detect(bytes)
        .toRight(CatalogRefusal.UnsupportedImage)
        .map(mediaType => new LotImage(bytes, mediaType, versionOf(bytes)))

  private def versionOf(bytes: IArray[Byte]): ImageVersion =
    ImageVersion(
      HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(IArray.genericWrapArray(bytes).toArray))
    )
}

/** Что правка карточки делает с изображением. Без поля в запросе изображение остаётся как есть. */
enum ImageChange[+A] {
  case Keep
  case Replace(image: A)
  case Remove
}

/**
 * Каталожная карточка лота — название, описание и версия изображения.
 *
 * Карточка не входит в домен торгов (ADR-047): её правка разрешена в любом состоянии лота, а условия торгов после
 * `LotOpened` заморожены и живут только в журнале лота. Описание может быть пустым. Байтов изображения в карточке нет:
 * их читают отдельно, а карточка несёт только версию, и сравнение карточек — сравнение версий.
 */
final case class LotCard(lotId: LotId, title: LotTitle, description: String, image: Option[ImageVersion])

/** Новая карточка вместе с проверенным изображением, которое запишется в ту же строку. */
final case class NewCard(lotId: LotId, title: LotTitle, description: String, image: Option[LotImage]) {
  def card: LotCard = LotCard(lotId, title, description, image.map(_.version))
}

/** Правка карточки: текст заменяется целиком, изображение — по `image`. */
final case class CardEdit(lotId: LotId, title: LotTitle, description: String, image: ImageChange[LotImage])

/** Ожидаемые отказы команд каталога. Транспортного кода они не несут: отображение — работа границы. */
enum CatalogRefusal {

  /** Смотрящий не администратор сходки. */
  case NotAdmin

  /** Название пустое или состоит из одних пробелов. */
  case EmptyTitle

  /** Правится карточка, которой нет. */
  case CardNotFound

  /**
   * Карточка с этим `lot_id` уже есть и с другими полями. Повтор с теми же полями — успех: это повтор той же команды.
   * Молча вернуть прежнюю карточку на повтор с другими полями нельзя — вызывающий решил бы, что записал новое.
   */
  case CardConflict

  /** Файл изображения больше предела; предел — в байтах, чтобы форма назвала его человеку. */
  case ImageTooLarge(maxBytes: Int)

  /** Байты не распознаны как изображение типа, который хранит каталог. */
  case UnsupportedImage
}
