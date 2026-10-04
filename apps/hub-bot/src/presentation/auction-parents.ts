// Сходка аукциона: родитель ленты лотов в оболочке хаба (ADR-030, дополнение
// 2026-10-04; PER-307). Кнопки домена `auc` сходки не несут — их пишет общий
// пакет, одинаковыми в обоих ботах (ADR-044), — а Auction по аукциону сходку не
// отдаёт намеренно. Поэтому оболочка запоминает пару, которую уже видела:
// карточку сходки с её аукционом или ответ на включение.
//
// Это память процесса, а не хранилище: пара неизменна — аукцион рождён у
// сходки, и его идентификатор выведен из неё, — так что запись не устаревает,
// её может только не оказаться. После рестарта лента до следующего открытия
// карточки возвращает в «Ближайшие». В авторизации запись не участвует: экран
// сходки, куда ведёт возврат, читает Meetups от имени смотрящего.

export type AuctionParents = {
  remember(auctionId: string, meetupId: string): void;
  meetupOf(auctionId: string): string | undefined;
};

// Аукцион один на сходку, а сходок в сообществе — сотни. Предел держит память
// процесса ограниченной, вытесняется самая давняя запись.
export const AUCTION_PARENTS_LIMIT = 1_000;

export function createAuctionParents(
  limit = AUCTION_PARENTS_LIMIT,
): AuctionParents {
  const entries = new Map<string, string>();
  return {
    remember(auctionId, meetupId) {
      // Map хранит порядок вставки: перевставка делает запись свежей.
      entries.delete(auctionId);
      entries.set(auctionId, meetupId);
      while (entries.size > limit) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },
    meetupOf(auctionId) {
      return entries.get(auctionId);
    },
  };
}
