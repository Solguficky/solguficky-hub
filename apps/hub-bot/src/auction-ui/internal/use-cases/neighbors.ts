import type { AuctionPort, LotView, Viewer } from "../../ports.js";
import {
  arrangeFeed,
  feedPages,
  loadFeed,
  orderForFeed,
  readFeedShape,
} from "./open-feed.js";

// Соседи лота в ленте для ◀️ и ▶️ карточки (PER-644, PER-669). Порядок — тот
// же, что у ленты: соседей считает её же раскладка (PER-719), поэтому
// листание карточки и строки ленты не расходятся по устройству. У соседа своя страница ленты:
// после листания «‹ Лоты» открывает ту, где он стоит.
export type LotNeighbor = { lotId: string; page: number };

// `sectionId` — раздел ленты, в котором стоит лот (PER-719): соседи берутся
// из его списка, а «‹ Лоты» карточки ведёт в раздел. Нет — лот в общем
// списке или идёт финал.
export type LotNeighbors = {
  prev?: LotNeighbor;
  next?: LotNeighbor;
  sectionId?: number;
};

// На краях соседа нет, по кругу листание не идёт (решение владельца по
// прогону 14 октября 2026 года). Лота нет в ленте — соседей тоже.
// `lead` — ряды кнопок разделов на первой странице общего списка (PER-719):
// они сдвигают страницы его лотов.
export function neighborsOf(
  sorted: readonly LotView[],
  lotId: string,
  lead = 0,
): LotNeighbors {
  const pages = feedPages(sorted.length, lead);
  const index = sorted.findIndex((lot) => lot.lotId === lotId);
  if (index < 0) return {};
  const at = (position: number): LotNeighbor | undefined => {
    const lot = sorted[position];
    return lot === undefined
      ? undefined
      : { lotId: lot.lotId, page: pages.pageOf(position) };
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
    const [{ lineup, layout }, lots] = await Promise.all([
      readFeedShape(feed),
      loadFeed(feed),
    ]);
    if (lineup !== undefined) {
      return neighborsOf(orderForFeed(lots, lineup), input.lot.lotId);
    }
    // Вне финала соседи — в списке лота: в его разделе или в общем списке,
    // как их показывает лента.
    const { sections, rest } = arrangeFeed(lots, layout);
    const section = sections.find((each) =>
      each.lots.some((lot) => lot.lotId === input.lot.lotId),
    );
    return section === undefined
      ? neighborsOf(rest, input.lot.lotId, sections.length)
      : {
          ...neighborsOf(section.lots, input.lot.lotId),
          sectionId: section.sectionId,
        };
  } catch {
    return {};
  }
}
