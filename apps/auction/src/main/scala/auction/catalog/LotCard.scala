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
   * Предел размера файла — 1 МБ, решение владельца от 2026-10-04 в дизайн-коде бота (`docs/design/bot/design-code.md`,
   * «Показ фото лота» → «Размер изображения — 1 МБ»); ADR-057 (дополнение 2026-09-30) оставляет значение реализации.
   * Основание — замер: загрузка фото в несколько мегабайт в Telegram держит очередь апдейтов бота десятки секунд, а
   * сжатое Telegram фото весит сотни килобайт. Вторая граница — grpc-js ботов, который по умолчанию не принимает
   * сообщение больше 4 MiB: ответ `GetLotImage` с файлом у этого потолка бот бы не прочитал.
   */
  val MaxBytes: Int = 1 * 1024 * 1024

  /**
   * Предел числа фото лота — 10: столько принимает альбом Telegram, и столько кадров держит карусель rich-карточки;
   * решение владельца по PER-711 от 2026-10-24 (ADR-057, дополнение 2026-10-24), реализация — PER-721.
   */
  val MaxPhotos: Int = 10

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

/**
 * Идентификатор фото лота. Фото, добавленное `AddLotPhoto`, несёт id вызывающего — он же ключ повтора; фото, пришедшее
 * с карточкой или правкой изображения, и перенесённое миграцией получает id от сервиса.
 */
final case class PhotoId(value: UUID)

/** Фото лота без байтов: id и версия, как изображение карточки. */
final case class LotPhotoRef(photoId: PhotoId, version: ImageVersion)

/**
 * Что правка карточки делает с изображением. Без поля в запросе изображение остаётся как есть. Изображение карточки —
 * обложка, первое фото лота: замена меняет байты первого фото, а у лота без фото добавляет его; снятие убирает первое
 * фото, и обложкой становится следующее (ADR-057, дополнение 2026-10-24).
 */
enum ImageChange[+A] {
  case Keep
  case Replace(image: A)
  case Remove
}

/**
 * Каталожная карточка лота — название, описание и версия изображения.
 *
 * Карточка не входит в домен торгов (ADR-047): правка названия, описания и изображения закрыта у проданного лота и у
 * лота, закрытого без продажи, а в остальных состояниях остаётся (ADR-057, дополнение 2026-10-20). Условия торгов после
 * `LotOpened` заморожены и живут только в журнале лота. Описание может быть пустым. Байтов изображения в карточке нет:
 * их читают отдельно, а карточка несёт только версию, и сравнение карточек — сравнение версий.
 */
final case class LotCard(
    lotId: LotId,
    title: LotTitle,
    description: String,
    image: Option[ImageVersion],
    photos: Vector[LotPhotoRef] = Vector.empty
) {

  /**
   * Та же ли это карточка по содержанию: текст и обложка. Id фото сюда не входят — их у созданной карточки даёт сервис,
   * и повтор создания с тем же файлом получил бы другой.
   */
  def sameContent(other: LotCard): Boolean =
    lotId == other.lotId && title == other.title && description == other.description && image == other.image
}

/**
 * Новая карточка вместе с проверенным изображением, которое запишется в ту же строку и первым фото лота под `photoId`.
 */
final case class NewCard(
    lotId: LotId,
    title: LotTitle,
    description: String,
    image: Option[LotImage],
    photoId: PhotoId
) {
  def card: LotCard =
    LotCard(lotId, title, description, image.map(_.version), image.map(i => LotPhotoRef(photoId, i.version)).toVector)
}

/**
 * Правка карточки: текст заменяется целиком, изображение — по `image`. `photoId` нужен только замене у лота без фото:
 * под ним ложится первое фото.
 */
final case class CardEdit(
    lotId: LotId,
    title: LotTitle,
    description: String,
    image: ImageChange[LotImage],
    photoId: PhotoId
)

/** Фото в конец списка фото лота под id вызывающего. */
final case class PhotoAddition(lotId: LotId, photoId: PhotoId, image: LotImage)

/** Снятие одного фото лота. */
final case class PhotoRemoval(lotId: LotId, photoId: PhotoId)

/** Исход вставки карточки: вставлена или уже была — и какая. */
enum CardInsertion {
  case Inserted(card: LotCard)
  case Existing(card: LotCard)
}

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

  /** Лот продан или закрыт без продажи: название, описание и изображение больше не меняются. */
  case CardClosed

  /** У лота уже столько фото, сколько каталог принимает; предел — чтобы форма назвала его человеку. */
  case PhotoLimitReached(maxPhotos: Int)

  /** Фото с этим id у лота уже есть и с другими байтами. Повтор с теми же байтами — успех. */
  case PhotoConflict
}

/** Можно ли записать правку карточки. Состояние лота сюда сводит граница: каталог журнал не читает. */
enum CardStanding {
  case Open
  case Closed
}
