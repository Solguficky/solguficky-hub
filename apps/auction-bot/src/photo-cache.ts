// `file_id` изображений лотов, которые этот бот уже загрузил в Telegram
// (ADR-057, дополнение). Это кэш, а не хранилище: рестарт его теряет, и
// следующий показ грузит файл из Auction заново, поэтому ADR-030 он не
// нарушает. В авторизации он не участвует: доступ к лоту решает чтение
// Auction, а не наличие записи здесь.

// Изображение лота в одной версии. Правка изображения меняет версию, и старое
// фото по новому ключу не находится.
export type ImageKey = { lotId: string; version: string };

export type PhotoCache = {
  get(key: ImageKey): string | undefined;
  set(key: ImageKey, fileId: string): void;
  delete(key: ImageKey): void;
};

// Лотов у сходки десятки; предел держит память процесса ограниченной, даже
// если версии меняются часто.
export const PHOTO_CACHE_LIMIT = 200;

export function createPhotoCache(limit = PHOTO_CACHE_LIMIT): PhotoCache {
  const entries = new Map<string, string>();
  const keyOf = (key: ImageKey) => `${key.lotId}:${key.version}`;
  return {
    get(key) {
      const k = keyOf(key);
      const fileId = entries.get(k);
      if (fileId !== undefined) {
        // Map хранит порядок вставки: перевставка делает запись свежей.
        entries.delete(k);
        entries.set(k, fileId);
      }
      return fileId;
    },
    set(key, fileId) {
      const k = keyOf(key);
      entries.delete(k);
      entries.set(k, fileId);
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
