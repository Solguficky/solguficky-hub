// `file_id` изображений лотов, которые бот хаба уже загрузил в Telegram
// (ADR-057, дополнение; дизайн-код, «Показ фото лота»). Это кэш, а не
// хранилище: рестарт его теряет, и следующий показ грузит файл из Auction
// заново, поэтому ADR-030 он не нарушает. В авторизации он не участвует: доступ
// к лоту решает чтение Auction, а не наличие записи здесь. Тот же кэш держит
// бот аукциона в своём процессе: `file_id` у каждого бота свой.

// Изображение лота в одной версии. Правка изображения меняет версию, и старое
// фото по новому ключу не находится.
export type ImageKey = { lotId: string; version: string };

// `rejected` — Telegram не принял эту версию изображения: до рестарта она
// больше не загружается, карточка идёт без фото. Новая версия — новый ключ.
export type CachedPhoto =
  | { kind: "file"; fileId: string }
  | { kind: "rejected" };

export type LotPhotos = {
  get(key: ImageKey): CachedPhoto | undefined;
  set(key: ImageKey, photo: CachedPhoto): void;
  delete(key: ImageKey): void;
};

// Лотов у аукциона десятки; предел держит память процесса ограниченной, даже
// если версии меняются часто.
export const LOT_PHOTOS_LIMIT = 200;

export function createLotPhotos(limit = LOT_PHOTOS_LIMIT): LotPhotos {
  const entries = new Map<string, CachedPhoto>();
  const keyOf = (key: ImageKey) => `${key.lotId}:${key.version}`;
  return {
    get(key) {
      const k = keyOf(key);
      const photo = entries.get(k);
      if (photo !== undefined) {
        // Map хранит порядок вставки: перевставка делает запись свежей.
        entries.delete(k);
        entries.set(k, photo);
      }
      return photo;
    },
    set(key, photo) {
      const k = keyOf(key);
      entries.delete(k);
      entries.set(k, photo);
      while (entries.size > limit) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },
    delete(key) {
      entries.delete(keyOf(key));
    },
  };
}
