import type { Viewer } from "../../auction-ui/index.js";
import { MAX_LIST_PAGE } from "./faq.js";

// Списки аукционов — оболочка бота аукциона (PER-453): бот хаба их не
// получает, у него вход в аукцион из карточки сходки, поэтому в общий пакет
// они не входят. Переход из строки списка — кнопка ленты пакета.

// Выборка `ListAuctions`: активные — от `scheduled` до `in_final`, прошедшие —
// `finished`. Черновик не входит ни в одну (ADR-047).
export type AuctionListing = "active" | "finished";

export type AuctionStage =
  | "scheduled"
  | "prebidding"
  | "settling"
  | "on-break"
  | "lineup-frozen"
  | "in-final"
  | "finished";

// Строка списка. Имени у аукциона в контракте нет, а сходку список не
// называет намеренно: путь «аукцион → сходка» закрыт (ADR-047, «Видимость
// сходки»). Поэтому строку различают дата онлайн-фазы, этап и число лотов.
export type AuctionSummary = {
  auctionId: string;
  stage: AuctionStage;
  // Начало онлайн-фазы, RFC 3339. Нет — формат без онлайн-фазы.
  opensAt?: string;
  lotCount: number;
};

export type AuctionCatalogPort = {
  listAuctions(request: {
    viewer: Viewer;
    listing: AuctionListing;
    pageToken: string;
  }): Promise<{ auctions: AuctionSummary[]; nextPageToken: string }>;
};

export const LIST_PAGE_SIZE = 8;

// Предохранители обхода, как у ленты пакета: повтор токена или перечисление
// длиннее, чем помещается в страницы списка, — дефект соседа, а не повод
// крутиться.
const MAX_SERVER_PAGES = 200;
const MAX_AUCTIONS = (MAX_LIST_PAGE + 1) * LIST_PAGE_SIZE;

// Весь список целиком: сервер листает в порядке идентификаторов, а человеку
// нужен порядок дат, поэтому страницы режет край, а не сервер.
export async function readAuctions(input: {
  catalog: AuctionCatalogPort;
  viewer: Viewer;
  listing: AuctionListing;
}): Promise<AuctionSummary[]> {
  const auctions: AuctionSummary[] = [];
  const seen = new Set<string>();
  let pageToken = "";
  for (let pages = 0; pages < MAX_SERVER_PAGES; pages += 1) {
    const page = await input.catalog.listAuctions({
      viewer: input.viewer,
      listing: input.listing,
      pageToken,
    });
    auctions.push(...page.auctions);
    if (auctions.length > MAX_AUCTIONS) {
      throw new Error(`auction list exceeds ${MAX_AUCTIONS} items`);
    }
    if (page.nextPageToken === "") return sortAuctions(input.listing, auctions);
    if (seen.has(page.nextPageToken)) {
      throw new Error("auction list repeated a page token");
    }
    seen.add(page.nextPageToken);
    pageToken = page.nextPageToken;
  }
  throw new Error(`auction list exceeds ${MAX_SERVER_PAGES} server pages`);
}

// Активные — от ближайшего начала, прошедшие — от свежего. Аукцион без
// онлайн-фазы даты не имеет и стоит последним; равные — по идентификатору,
// чтобы порядок не прыгал между нажатиями.
export function sortAuctions(
  listing: AuctionListing,
  auctions: readonly AuctionSummary[],
): AuctionSummary[] {
  const direction = listing === "active" ? 1 : -1;
  return [...auctions].sort((left, right) => {
    const a = left.opensAt === undefined ? undefined : Date.parse(left.opensAt);
    const b =
      right.opensAt === undefined ? undefined : Date.parse(right.opensAt);
    if (a !== b) {
      if (a === undefined) return 1;
      if (b === undefined) return -1;
      return (a - b) * direction;
    }
    return left.auctionId < right.auctionId ? -1 : 1;
  });
}

export type AuctionListPage = {
  // Нумерация с нуля; пустой список — одна страница без строк.
  page: number;
  pageCount: number;
  auctions: readonly AuctionSummary[];
};

// Страница за концом — список сократился, пока экран висел: человек видит
// последнюю страницу, а не пустую.
export function listPage(
  auctions: readonly AuctionSummary[],
  page: number,
): AuctionListPage {
  const pageCount = Math.max(1, Math.ceil(auctions.length / LIST_PAGE_SIZE));
  const shown = Math.min(page, pageCount - 1);
  return {
    page: shown,
    pageCount,
    auctions: auctions.slice(
      shown * LIST_PAGE_SIZE,
      (shown + 1) * LIST_PAGE_SIZE,
    ),
  };
}
