// `file_id` изображений лотов, которые этот бот уже загрузил в Telegram
// (ADR-057, дополнение). Это кэш, а не хранилище: рестарт его теряет, и
// следующий показ грузит файл из Auction заново, поэтому ADR-030 он не
// нарушает. В авторизации он не участвует: доступ к лоту решает чтение
// Auction, а не наличие записи здесь.
//
// Ключ — лот и версия изображения: правка изображения меняет версию, и старое
// фото по новому ключу не находится.
export type PhotoCache = {
  get(lotId: string, version: string): string | undefined;
  set(lotId: string, version: string, fileId: string): void;
  delete(lotId: string, version: string): void;
};

// Лотов у сходки десятки; предел держит память процесса ограниченной, даже
// если версии меняются часто.
export const PHOTO_CACHE_LIMIT = 200;

export function createPhotoCache(limit = PHOTO_CACHE_LIMIT): PhotoCache {
  const entries = new Map<string, string>();
  const key = (lotId: string, version: string) => `${lotId}:${version}`;
  return {
    get(lotId, version) {
      const k = key(lotId, version);
      const fileId = entries.get(k);
      if (fileId !== undefined) {
        // Map хранит порядок вставки: перевставка делает запись свежей.
        entries.delete(k);
        entries.set(k, fileId);
      }
      return fileId;
    },
    set(lotId, version, fileId) {
      const k = key(lotId, version);
      entries.delete(k);
      entries.set(k, fileId);
      while (entries.size > limit) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },
    delete(lotId, version) {
      entries.delete(key(lotId, version));
    },
  };
}
