import { z } from "zod";
import type {
  LotCardView,
  LotImage,
  LotImagePort,
  Viewer,
} from "../../auction-ui/index.js";

// Фото карточки лота у обоих ботов (PER-721; ADR-057, дополнение 2026-10-24):
// какие фото показать, как их загрузить из Auction, как разметить в
// rich-сообщении и где взять `file_id` из ответа Telegram. Кэш `file_id` у
// каждого бота свой: `file_id` действует только у бота-получателя.

/**
 * Одно фото карточки. Кэш бота держит `file_id` по паре «лот и версия»: та же
 * версия — те же байты. `photoId` нет — фото читается обложкой через
 * `GetLotImage`: так показывает карточку Auction до списка фото.
 */
export type LotPhotoKey = { lotId: string; version: string; photoId?: string };

/**
 * Больше фото у лота не бывает (Auction держит тот же предел), и карусель
 * Telegram длиннее альбома не листается.
 */
export const maxLotPhotos = 10;

/** Фото карточки в порядке показа: список фото, иначе одна обложка. */
export function lotPhotoKeys(
  lotId: string,
  card: LotCardView | undefined,
): LotPhotoKey[] {
  if (card === undefined) return [];
  if (card.photos !== undefined && card.photos.length > 0) {
    return card.photos.slice(0, maxLotPhotos).map((photo) => ({
      lotId,
      version: photo.version,
      photoId: photo.photoId,
    }));
  }
  return card.image === undefined
    ? []
    : [{ lotId, version: card.image.version }];
}

/** Байты одного фото: по идентификатору либо обложкой. */
export function loadLotPhoto(
  port: LotImagePort,
  viewer: Viewer,
  key: LotPhotoKey,
): Promise<LotImage> {
  return key.photoId === undefined
    ? port.getLotImage({ viewer, lotId: key.lotId })
    : port.getLotPhoto({ viewer, lotId: key.lotId, photoId: key.photoId });
}

/**
 * Идентификатор фото внутри rich-сообщения: на него ссылается `<img>`. У
 * первого он прежний — `lot`, — и карточка с одним фото не меняется.
 */
export function richPhotoId(index: number): string {
  return index === 0 ? "lot" : `lot${index + 1}`;
}

/**
 * Блок фото над заголовком карточки: одно фото — фотографией, несколько —
 * каруселью, как постеры карточки сходки (дизайн-код, «Показ фото лота»).
 */
export function richPhotoBlock(ids: readonly string[]): string {
  const images = ids.map((id) => `<img src="tg://photo?id=${id}"/>`);
  if (images.length <= 1) return images[0] ?? "";
  return `<tg-slideshow>${images.join("")}</tg-slideshow>`;
}

// Ответ Telegram — внешние данные: блок фото разбирает схема, а не приведение.
const RichMessageSchema = z.object({ rich_message: z.unknown() });
const PhotoBlockSchema = z.object({
  type: z.literal("photo"),
  photo: z.array(z.object({ file_id: z.string().min(1) })).min(1),
});

/**
 * `file_id` наибольшего размера каждого фото из ответа rich-сообщения, в
 * порядке документа. Фото лежат в блоках `photo` его `rich_message` (зонд
 * PER-450), у карусели — вложенными, поэтому обход идёт по всему ответу.
 */
export function richPhotoFileIds(message: unknown): string[] {
  const parsed = RichMessageSchema.safeParse(message);
  const found: string[] = [];
  if (parsed.success) collect(parsed.data.rich_message, found);
  return found;
}

function collect(node: unknown, found: string[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collect(item, found);
    return;
  }
  if (typeof node !== "object" || node === null) return;
  const block = PhotoBlockSchema.safeParse(node);
  if (block.success) {
    const largest = block.data.photo.at(-1);
    if (largest !== undefined) found.push(largest.file_id);
    return;
  }
  for (const value of Object.values(node)) collect(value, found);
}
