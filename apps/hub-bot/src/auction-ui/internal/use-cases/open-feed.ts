import { encodeAuctionCallback, MAX_FEED_PAGE } from "../../callback-data.js";
import type {
  AuctionPort,
  FinalLineupView,
  LotLayoutView,
  LotStatusView,
  LotView,
  Money,
  Viewer,
} from "../../ports.js";
import type { AuctionButton, AuctionScreenBody } from "../../screen.js";
import { collectPages } from "./collect-pages.js";
import { feedItemOf, mineOf, withMine } from "./standing.js";

// Лотов на странице ленты. Восемь — как у списка материалов в хабе: кнопки
// лотов и строка листания помещаются в один экран телефона.
export const FEED_PAGE_SIZE = 8;

const MAX_FEED_LOTS = FEED_PAGE_SIZE * (MAX_FEED_PAGE + 1);

// Сырой юзкейс: доступ он не проверяет и поэтому из пакета не экспортируется.
//
// Страница за пределом ленты — кнопка устаревшего экрана: лоты сняли, пока
// сообщение висело. Она показывает последнюю страницу, а не ошибку.
//
// Без `sectionId` — лента: разделы администратора кнопками (PER-719), под
// ними лоты вне разделов. С ним — экран раздела: его лоты в порядке
// администратора. Раздела, которого больше нет, кнопка устаревшего экрана
// не находит, и открывается лента.
export async function openFeed(input: {
  auction: AuctionPort;
  viewer: Viewer;
  auctionId: string;
  page: number;
  sectionId?: number;
}): Promise<AuctionScreenBody> {
  // Стадия и раскладка читаются параллельно страницам и стартуют первыми,
  // как розыгрыш у корня: порядок вызовов один при любом числе страниц.
  const [shape, loaded] = await Promise.all([
    readFeedShape(input),
    loadFeed(input),
  ]);
  const { lineup } = shape;
  const arranged = arrangeFeed(loaded, shape.layout);
  const ordered = orderForFeed(loaded, lineup, shape.layout);
  // В живом финале разделов нет: лента идёт порядком зала (PER-639).
  const section =
    lineup === undefined && input.sectionId !== undefined
      ? arranged.sections.find((each) => each.sectionId === input.sectionId)
      : undefined;
  const sections = lineup === undefined ? arranged.sections : [];
  const lots =
    section !== undefined
      ? section.lots
      : lineup !== undefined
        ? ordered
        : arranged.rest;
  const active =
    lineup?.activeLotId === undefined
      ? undefined
      : lots.find((lot) => lot.lotId === lineup.activeLotId);
  // Кнопки разделов стоят на первой странице ленты вместо части лотов: экран
  // не выходит за потолок рядов (PER-719).
  const pages = feedPages(
    lots.length,
    section === undefined ? sections.length : 0,
  );
  const page = Math.min(input.page, pages.count - 1);
  const pageCount = pages.count;
  const shown = lots.slice(...pages.range(page));
  const feedButton = (target: number) =>
    section === undefined
      ? encodeAuctionCallback({
          kind: "feed",
          auctionId: input.auctionId,
          page: target,
        })
      : encodeAuctionCallback({
          kind: "section",
          auctionId: input.auctionId,
          sectionId: section.sectionId,
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
  // Разделы — оглавление над лотами первой страницы: листание идёт по лотам
  // вне разделов.
  const shownSections = section === undefined && page === 0 ? sections : [];
  const sectionRows: AuctionButton[][] =
    shownSections.length > 0
      ? shownSections.map((each) => [
          {
            action: "feed.open-section" as const,
            sectionId: each.sectionId,
            callbackData: encodeAuctionCallback({
              kind: "section",
              auctionId: input.auctionId,
              sectionId: each.sectionId,
              page: 0,
            }),
          },
        ])
      : [];
  return {
    blocks: [
      {
        kind: "feed",
        auctionId: input.auctionId,
        page,
        pageCount,
        lots: shown.map((lot) => feedItemOf(lot, input.viewer)),
        ...withMine(mineOf(ordered, input.viewer)),
        ...(beforeTrading(loaded) ? { beforeTrading: true as const } : {}),
        ...(shownSections.length > 0
          ? {
              sections: shownSections.map((each) => ({
                sectionId: each.sectionId,
                name: each.name,
                lotCount: each.lots.length,
              })),
            }
          : {}),
        ...(section === undefined
          ? {}
          : { section: { sectionId: section.sectionId, name: section.name } }),
        ...(lineup === undefined
          ? {}
          : {
              final:
                active === undefined
                  ? {}
                  : { active: feedItemOf(active, input.viewer) },
            }),
      },
    ],
    // Лента — просто список лотов (PER-644): розыгрыш и избранное стоят в
    // корне аукциона у обоих ботов, и возврат ведёт туда же. С раздела
    // возврат ведёт в ленту — к списку разделов.
    keyboard: [
      ...sectionRows,
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
      [
        {
          action: "feed.back" as const,
          callbackData: encodeAuctionCallback(
            section === undefined
              ? { kind: "root", auctionId: input.auctionId }
              : { kind: "feed", auctionId: input.auctionId, page: 0 },
          ),
        },
      ],
    ],
  };
}

// Кнопка «Розыгрыш» стоит, только пока розыгрыш есть: Auction отдаёт его с
// открытия онлайн-торгов (ADR-066). Отказ чтения убирает кнопку, а не роняет
// ленту — как отказ имён на карточке.
export async function hasRaffle(input: {
  auction: AuctionPort;
  viewer: Viewer;
  auctionId: string;
}): Promise<boolean> {
  try {
    return (
      (await input.auction.getRaffle({
        viewer: input.viewer,
        auctionId: input.auctionId,
      })) !== undefined
    );
  } catch {
    return false;
  }
}

// Торги аукциона ещё не открыты: ни один лот не торговался и хотя бы один
// ещё ждёт торгов (PER-618). Снятый лот торгов не доказывает в обе стороны —
// его снимают и из черновика, и при отмене идущего аукциона, — поэтому лента
// из одних снятых лотов ничего не обещает, а пустая своё говорит сама.
function beforeTrading(lots: readonly LotView[]): boolean {
  return (
    lots.some((lot) => awaitsTrading(lot.status)) &&
    lots.every((lot) => !hasOpened(lot.status))
  );
}

function awaitsTrading(status: LotStatusView): boolean {
  return status.kind === "draft" || status.kind === "scheduled";
}

function hasOpened(status: LotStatusView): boolean {
  switch (status.kind) {
    case "trading":
    case "held":
    case "sold":
    case "unsold":
      return true;
    case "draft":
    case "scheduled":
    case "withdrawn":
      return false;
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

export function loadFeed(input: {
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

// Страницы списка ленты: `lead` рядов первой страницы заняты кнопками
// разделов (PER-719), и лотов на ней столько меньше; дальше — по
// `FEED_PAGE_SIZE`. Ту же раскладку страниц берут соседи карточки.
export function feedPages(
  count: number,
  lead: number,
): {
  count: number;
  range: (page: number) => [number, number];
  pageOf: (index: number) => number;
} {
  const first = Math.max(0, FEED_PAGE_SIZE - lead);
  const rest = Math.max(0, count - first);
  return {
    count: count === 0 ? 1 : 1 + Math.ceil(rest / FEED_PAGE_SIZE),
    range: (page) =>
      page === 0
        ? [0, first]
        : [first + (page - 1) * FEED_PAGE_SIZE, first + page * FEED_PAGE_SIZE],
    pageOf: (index) =>
      index < first ? 0 : 1 + Math.floor((index - first) / FEED_PAGE_SIZE),
  };
}

// Стадия и раскладка ленты из одного `getAuction`: состав идущего финала
// (PER-639) и порядок и разделы администратора (PER-719). Отказ чтения ленту
// не роняет — она идёт в порядке создания, как без кнопки «Розыгрыш» у корня.
export type FeedShape = { lineup?: FinalLineupView; layout?: LotLayoutView };

export async function readFeedShape(input: {
  auction: AuctionPort;
  viewer: Viewer;
  auctionId: string;
}): Promise<FeedShape> {
  try {
    const summary = await input.auction.getAuction({
      viewer: input.viewer,
      auctionId: input.auctionId,
    });
    return {
      ...(summary?.stage === "in-final" && summary.lineup !== undefined
        ? { lineup: summary.lineup }
        : {}),
      ...(summary?.layout === undefined ? {} : { layout: summary.layout }),
    };
  } catch {
    return {};
  }
}

// Раздел ленты с его лотами в порядке администратора.
export type FeedSection = {
  sectionId: number;
  name: string;
  lots: readonly LotView[];
};

// Лента по раскладке администратора (PER-719): разделы в его порядке, каждый
// со своими лотами, и общий список — лоты вне разделов в его порядке, а за
// ними лоты, которых он не упорядочил, в порядке создания. Раздел без лотов
// ленты участнику не виден. Лот, которого раскладка называет, а лента не
// отдала, выпадает. Без раскладки — один общий список в порядке создания.
export function arrangeFeed(
  lots: readonly LotView[],
  layout: LotLayoutView | undefined,
): { sections: FeedSection[]; rest: LotView[] } {
  const byId = new Map(lots.map((lot) => [lot.lotId, lot]));
  const placed = new Set<string>();
  const take = (ids: readonly string[]): LotView[] =>
    ids.flatMap((id) => {
      const lot = byId.get(id);
      if (lot === undefined || placed.has(id)) return [];
      placed.add(id);
      return [lot];
    });
  const sections = (layout?.sections ?? [])
    .map((section) => ({
      sectionId: section.sectionId,
      name: section.name,
      lots: take(section.lotIds),
    }))
    .filter((section) => section.lots.length > 0);
  const ordered = take(layout?.lotIds ?? []);
  const unordered = byCreation(lots.filter((lot) => !placed.has(lot.lotId)));
  return { sections, rest: [...ordered, ...unordered] };
}

// Лента одним списком: разделы по порядку, затем общий список. Его берут
// финал для лотов вне состава и соседи карточки.
export function flatFeed(
  lots: readonly LotView[],
  layout: LotLayoutView | undefined,
): LotView[] {
  const { sections, rest } = arrangeFeed(lots, layout);
  return [...sections.flatMap((section) => section.lots), ...rest];
}

// Порядок ленты: вне финала — порядок администратора (PER-719), в финале —
// порядок зала (PER-639), и раскладку финал не читает. Активный лот первым,
// за ним лоты состава, которые ещё ждут своей очереди, в порядке выхода,
// затем проданные и прочие по цене. Соседи карточки берут ту же функцию,
// поэтому листание и лента не расходятся.
export function orderForFeed(
  lots: readonly LotView[],
  lineup: FinalLineupView | undefined,
  layout?: LotLayoutView,
): LotView[] {
  if (lineup === undefined) return flatFeed(lots, layout);
  const byId = new Map(lots.map((lot) => [lot.lotId, lot]));
  const ahead = [
    ...(lineup.activeLotId === undefined ? [] : [lineup.activeLotId]),
    ...lineup.order.filter((lotId) => lotId !== lineup.activeLotId),
  ]
    .map((lotId) => byId.get(lotId))
    .filter(
      (lot): lot is LotView =>
        lot !== undefined &&
        (lot.status.kind === "held" || lot.status.kind === "trading"),
    );
  const placed = new Set(ahead.map((lot) => lot.lotId));
  return [
    ...ahead,
    ...sortForFeed(lots.filter((lot) => !placed.has(lot.lotId))),
  ];
}

// Финал (PER-639): по возрастанию цены; при равной цене — по `lotId`, чтобы
// номер страницы держал один и тот же набор лотов между нажатиями. Валюта у
// платформы одна, поэтому сравниваются минимальные единицы.
function sortForFeed(lots: readonly LotView[]): LotView[] {
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

// Цена, по которой лот стоит в ленте финала: текущая в торгах, стартовая до
// них, цена продажи у проданного. У черновика, снятого и непроданного лота
// цены нет — они идут в конец.
function feedPriceOf(status: LotStatusView): Money | undefined {
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

// Порядок создания — порядок `lotId`: идентификатор лота — UUIDv7, и его
// начало — момент рождения. Сравнение строк, а не `localeCompare`: номер
// страницы держит один и тот же набор лотов между нажатиями.
function byCreation(lots: readonly LotView[]): LotView[] {
  return [...lots].sort((a, b) =>
    a.lotId < b.lotId ? -1 : a.lotId > b.lotId ? 1 : 0,
  );
}
