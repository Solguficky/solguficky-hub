import type { AuctionPort, LotView, Viewer } from "../../ports.js";
import {
  FEED_PAGE_SIZE,
  loadFeed,
  orderForFeed,
  readFinalLineup,
} from "./open-feed.js";

// Соседи лота в ленте для «‹ пред / след ›» карточки (PER-644). Порядок — тот
// же, что у ленты: соседей считает её же сортировка, поэтому листание карточки
// и строки ленты не расходятся по устройству. У соседа своя страница ленты:
// после листания «‹ Лоты» открывает ту, где он стоит.
export type LotNeighbor = { lotId: string; page: number };

export type LotNeighbors = { prev?: LotNeighbor; next?: LotNeighbor };

// На краях соседа нет, по кругу листание не идёт (решение владельца по
// прогону 14 октября 2026 года). Лота нет в ленте — соседей тоже.
export function neighborsOf(
  sorted: readonly LotView[],
  lotId: string,
): LotNeighbors {
  const index = sorted.findIndex((lot) => lot.lotId === lotId);
  if (index < 0) return {};
  const at = (position: number): LotNeighbor | undefined => {
    const lot = sorted[position];
    return lot === undefined
      ? undefined
      : { lotId: lot.lotId, page: Math.floor(position / FEED_PAGE_SIZE) };
  };
  const prev = at(index - 1);
  const next = at(index + 1);
  return {
    ...(prev === undefined ? {} : { prev }),
    ...(next === undefined ? {} : { next }),
  };
}

// Отказ чтения ленты карточку не роняет: цена и ставка важнее листания, и
// карточка остаётся без ряда соседей — как без кнопки избранного, когда
// Notifications не ответил.
export async function readNeighbors(input: {
  auction: AuctionPort;
  viewer: Viewer;
  lot: LotView;
}): Promise<LotNeighbors> {
  try {
    const feed = {
      auction: input.auction,
      viewer: input.viewer,
      auctionId: input.lot.auctionId,
    };
    const [lineup, lots] = await Promise.all([
      readFinalLineup(feed),
      loadFeed(feed),
    ]);
    return neighborsOf(orderForFeed(lots, lineup), input.lot.lotId);
  } catch {
    return {};
  }
}
