import { encodeAuctionCallback, MAX_FEED_PAGE } from "../../callback-data.js";
import type {
  AuctionPort,
  LotStatusView,
  LotView,
  Money,
  Viewer,
} from "../../ports.js";
import type { AuctionButton, AuctionScreenBody } from "../../screen.js";
import { collectPages } from "./collect-pages.js";

// Лотов на странице ленты. Восемь — как у списка материалов в хабе: кнопки
// лотов и строка листания помещаются в один экран телефона.
export const FEED_PAGE_SIZE = 8;

const MAX_FEED_LOTS = FEED_PAGE_SIZE * (MAX_FEED_PAGE + 1);

// Сырой юзкейс: доступ он не проверяет и поэтому из пакета не экспортируется.
//
// Страница за пределом ленты — кнопка устаревшего экрана: лоты сняли, пока
// сообщение висело. Она показывает последнюю страницу, а не ошибку.
export async function openFeed(input: {
  auction: AuctionPort;
  viewer: Viewer;
  auctionId: string;
  page: number;
}): Promise<AuctionScreenBody> {
  const lots = sortForFeed(await loadFeed(input));
  const pageCount = Math.max(1, Math.ceil(lots.length / FEED_PAGE_SIZE));
  const page = Math.min(input.page, pageCount - 1);
  const shown = lots.slice(page * FEED_PAGE_SIZE, (page + 1) * FEED_PAGE_SIZE);
  const feedButton = (target: number) =>
    encodeAuctionCallback({
      kind: "feed",
      auctionId: input.auctionId,
      page: target,
    });
  const paging: AuctionButton[] = [
    ...(page > 0
      ? [{ action: "feed.prev" as const, callbackData: feedButton(page - 1) }]
      : []),
    ...(page < pageCount - 1
      ? [{ action: "feed.next" as const, callbackData: feedButton(page + 1) }]
      : []),
  ];
  return {
    blocks: [
      {
        kind: "feed",
        auctionId: input.auctionId,
        page,
        pageCount,
        lots: shown.map((lot) => ({
          lotId: lot.lotId,
          ...(lot.card === undefined ? {} : { title: lot.card.title }),
          status: lot.status,
        })),
      },
    ],
    keyboard: [
      ...shown.map((lot) => [
        {
          action: "feed.open-lot" as const,
          lotId: lot.lotId,
          callbackData: encodeAuctionCallback({
            kind: "lot",
            lotId: lot.lotId,
            page,
          }),
        },
      ]),
      ...(paging.length > 0 ? [paging] : []),
    ],
  };
}

function loadFeed(input: {
  auction: AuctionPort;
  viewer: Viewer;
  auctionId: string;
}): Promise<LotView[]> {
  return collectPages({
    what: "auction feed",
    maxItems: MAX_FEED_LOTS,
    fetch: async (pageToken) => {
      const page = await input.auction.listAuctionLots({
        viewer: input.viewer,
        auctionId: input.auctionId,
        pageToken,
      });
      return { items: page.lots, nextPageToken: page.nextPageToken };
    },
  });
}

// Цена, по которой лот стоит в ленте: текущая в торгах, стартовая до них,
// цена продажи у проданного. У черновика, снятого и непроданного лота цены
// нет — они идут в конец ленты.
export function feedPriceOf(status: LotStatusView): Money | undefined {
  switch (status.kind) {
    case "trading":
    case "held":
      return status.currentPrice;
    case "scheduled":
      return status.startingPrice;
    case "sold":
      return status.price;
    case "draft":
    case "unsold":
    case "withdrawn":
      return undefined;
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

// По возрастанию цены; при равной цене — по `lotId`, чтобы номер страницы
// держал один и тот же набор лотов между нажатиями. Валюта у платформы одна,
// поэтому сравниваются минимальные единицы.
export function sortForFeed(lots: readonly LotView[]): LotView[] {
  return [...lots].sort((a, b) => {
    const priceA = feedPriceOf(a.status)?.minorUnits;
    const priceB = feedPriceOf(b.status)?.minorUnits;
    if (priceA !== priceB) {
      if (priceA === undefined) return 1;
      if (priceB === undefined) return -1;
      return priceA - priceB;
    }
    return a.lotId < b.lotId ? -1 : a.lotId > b.lotId ? 1 : 0;
  });
}
