package auction.catalog

/**
 * Файлы изображений для тестов: верная сигнатура и заданный размер. Декодер каталогу не нужен — он смотрит только на
 * сигнатуру и размер, — поэтому за сигнатурой идут любые байты, а `fill` различает файлы одного размера.
 */
object TestImages {

  def jpeg(size: Int = 64, fill: Byte = 1): IArray[Byte] =
    file(IArray[Byte](0xff.toByte, 0xd8.toByte, 0xff.toByte), size, fill)

  def png(size: Int = 64, fill: Byte = 1): IArray[Byte] =
    file(IArray[Byte](0x89.toByte, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), size, fill)

  def webp(size: Int = 64, fill: Byte = 1): IArray[Byte] = {
    val riff = IArray[Byte](0x52, 0x49, 0x46, 0x46)
    val webp = IArray[Byte](0x57, 0x45, 0x42, 0x50)
    IArray.from(riff ++ Array.fill[Byte](4)(fill) ++ webp ++ Array.fill[Byte](size - 12)(fill))
  }

  private def file(magic: IArray[Byte], size: Int, fill: Byte): IArray[Byte] =
    IArray.from(magic ++ Array.fill[Byte](size - magic.length)(fill))
}
