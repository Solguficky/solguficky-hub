import { describe, expect, it } from "vitest";
import { encodeAuctionCallback } from "../../callback-data.js";
import type {
  AuctionPort,
  LotLayoutView,
  LotPage,
  LotView,
} from "../../ports.js";
import { arrangeFeed, FEED_PAGE_SIZE, openFeed } from "./open-feed.js";

const AUCTION_ID = "01929b7e-5c1d-7a3f-8e4b-0000000000a1";
const VIEWER = {
  identityId: "01929b7e-5c1d-7a3f-8e4b-000000000001",
  rights: ["place-bids"] as const,
};

function lot(n: number, rubles?: number): LotView {
  const lotId = `01929b7e-5c1d-7a3f-8e4b-${n.toString(16).padStart(12, "0")}`;
  return {
    lotId,
    auctionId: AUCTION_ID,
    version: 1,
    proxyEnabled: false,
    status:
      rubles === undefined
        ? { kind: "unsold" }
        : {
            kind: "trading",
            currentPrice: { minorUnits: rubles * 100, currency: "RUB" },
            phase: "online",
          },
  };
}

function auctionOf(pages: Record<string, LotPage>): AuctionPort {
  return {
    findLot: async () => undefined,
    getLot: async () => {
      throw new Error("not used");
    },
    getOwnDisplayName: async () => ({ text: "@fake", frozen: false }),
    getDisplayNames: async () => {
      throw new Error("not used");
    },
    listLotHistory: async () => {
      throw new Error("not used");
    },
    placeBid: async () => {
      throw new Error("not used");
    },
    setProxyLimit: async () => {
      throw new Error("not used");
    },
    chooseDisplayName: async () => {
      throw new Error("not used");
    },
    getAuction: async () => undefined,
    getRaffle: async () => undefined,
    listMyInvoices: async () => ({ invoices: [] }),
    chooseFulfillment: async () => {
      throw new Error("not used");
    },
    getMyPredictions: async () => [],
    getPredictionResults: async () => {
      throw new Error("not used");
    },
    getDayChronicle: async () => {
      throw new Error("not used");
    },
    submitPrediction: async () => {
      throw new Error("not used");
    },
    registerForRaffle: async () => {
      throw new Error("not used");
    },
    cancelRaffleRegistration: async () => {
      throw new Error("not used");
    },
    async listAuctionLots({ pageToken }) {
      const page = pages[pageToken];
      if (page === undefined) throw new Error(`no page ${pageToken}`);
      return page;
    },
  };
}

const oneServerPage = (lots: LotView[]) =>
  auctionOf({ "": { lots, nextPageToken: "" } });

const feedButton = (page: number) =>
  encodeAuctionCallback({ kind: "feed", auctionId: AUCTION_ID, page });

describe("feed", () => {
  // 20 лотов дают три страницы по восемь: на средней обе кнопки листания.
  const twenty = Array.from({ length: 20 }, (_, i) => lot(i + 1, 100 + i));

  it("pages the feed in the order of creation and offers both directions in the middle", async () => {
    const body = await openFeed({
      auction: oneServerPage([...twenty].reverse()),
      viewer: VIEWER,
      auctionId: AUCTION_ID,
      page: 1,
    });
    const [block] = body.blocks;
    if (block?.kind !== "feed") throw new Error("feed block expected");
    expect(block.pageCount).toBe(3);
    expect(block.lots.map((item) => item.lotId)).toEqual(
      twenty.slice(FEED_PAGE_SIZE, 2 * FEED_PAGE_SIZE).map((l) => l.lotId),
    );
    // Листание — над возвратом в корень аукциона (PER-644).
    expect(body.keyboard.at(-2)).toEqual([
      { action: "feed.prev", callbackData: feedButton(0) },
      { action: "feed.next", callbackData: feedButton(2) },
    ]);
    expect(body.keyboard.at(-1)).toEqual([
      {
        action: "feed.back",
        callbackData: encodeAuctionCallback({
          kind: "root",
          auctionId: AUCTION_ID,
        }),
      },
    ]);
  });

  it("offers no previous page on the first and no next on the last", async () => {
    const first = await openFeed({
      auction: oneServerPage(twenty),
      viewer: VIEWER,
      auctionId: AUCTION_ID,
      page: 0,
    });
    const last = await openFeed({
      auction: oneServerPage(twenty),
      viewer: VIEWER,
      auctionId: AUCTION_ID,
      page: 2,
    });
    expect(first.keyboard.at(-2)).toEqual([
      { action: "feed.next", callbackData: feedButton(1) },
    ]);
    expect(last.keyboard.at(-2)).toEqual([
      { action: "feed.prev", callbackData: feedButton(1) },
    ]);
    expect(last.keyboard).toHaveLength(20 - 2 * FEED_PAGE_SIZE + 2);
  });

  it("shows the last page for a page that no longer exists", async () => {
    const body = await openFeed({
      auction: oneServerPage(twenty),
      viewer: VIEWER,
      auctionId: AUCTION_ID,
      page: 999,
    });
    expect(body.blocks[0]).toMatchObject({ kind: "feed", page: 2 });
  });

  it("refuses a server that repeats its page token", async () => {
    const looping = auctionOf({
      "": { lots: [lot(1, 1)], nextPageToken: "a" },
      a: { lots: [lot(2, 2)], nextPageToken: "a" },
    });
    await expect(
      openFeed({
        auction: looping,
        viewer: VIEWER,
        auctionId: AUCTION_ID,
        page: 0,
      }),
    ).rejects.toThrow("repeated a page token");
  });

  it("refuses a server that never ends the enumeration", async () => {
    let n = 0;
    const endless: AuctionPort = {
      ...oneServerPage([]),
      async listAuctionLots() {
        n += 1;
        return { lots: [], nextPageToken: `t${n}` };
      },
    };
    await expect(
      openFeed({
        auction: endless,
        viewer: VIEWER,
        auctionId: AUCTION_ID,
        page: 0,
      }),
    ).rejects.toThrow("server pages");
  });

  // Без раскладки администратора — порядок создания (PER-719): цена лот
  // больше не двигает.
  it("orders the feed by creation, not by price", () => {
    const { sections, rest } = arrangeFeed(
      [lot(5), lot(4, 10), lot(3), lot(2, 10), lot(1, 5)],
      undefined,
    );
    expect(sections).toEqual([]);
    expect(rest.map((l) => l.lotId.slice(-1))).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
    ]);
  });
});

// Торги не начались (PER-618): ни один лот всей ленты не торговался —
// запланированные, черновики и снятые. Один лот в торгах на любой странице
// снимает признак.
describe("feed before trading", () => {
  const scheduled = (n: number, rubles: number): LotView => ({
    ...lot(n),
    status: {
      kind: "scheduled",
      startingPrice: { minorUnits: rubles * 100, currency: "RUB" },
    },
  });
  const withdrawn: LotView = { ...lot(90), status: { kind: "withdrawn" } };
  const draft: LotView = { ...lot(91), status: { kind: "draft" } };

  const blockOf = async (lots: LotView[]) => {
    const body = await openFeed({
      auction: oneServerPage(lots),
      viewer: VIEWER,
      auctionId: AUCTION_ID,
      page: 0,
    });
    const [block] = body.blocks;
    if (block?.kind !== "feed") throw new Error("feed block expected");
    return block;
  };

  it("marks the feed whose lots have not traded yet", async () => {
    const block = await blockOf([scheduled(1, 500), withdrawn, draft]);
    expect(block.beforeTrading).toBe(true);
  });

  it("drops the mark once any lot of the whole feed has traded", async () => {
    const early = Array.from({ length: FEED_PAGE_SIZE }, (_, i) =>
      scheduled(i + 1, 100 + i),
    );
    const block = await blockOf([...early, lot(50, 9000)]);
    expect(block.lots.every((item) => item.status.kind === "scheduled")).toBe(
      true,
    );
    expect(block.beforeTrading).toBeUndefined();
  });

  it("drops the mark once the auction has a closed lot", async () => {
    expect((await blockOf([scheduled(1, 500), lot(2)])).beforeTrading).toBe(
      undefined,
    );
  });

  // Отмена идущего аукциона снимает и лоты в торгах: лента из одних снятых
  // лотов о начале торгов ничего не знает.
  it("leaves a feed of withdrawn lots only without the mark", async () => {
    expect((await blockOf([withdrawn])).beforeTrading).toBeUndefined();
  });

  it("leaves an empty feed without the mark", async () => {
    expect((await blockOf([])).beforeTrading).toBeUndefined();
  });
});

// Лента в живом финале (PER-639): стадия из `getAuction` даёт состав и лот,
// который торгует ведущий. Кнопки — в порядке зала: активный лот, лоты
// состава, которые ждут очереди, по порядку выхода, затем остальные в порядке
// администратора.
describe("feed in the live final", () => {
  const money = (rubles: number) => ({
    minorUnits: rubles * 100,
    currency: "RUB",
  });
  const held = (n: number, rubles: number): LotView => ({
    ...lot(n),
    status: { kind: "held", currentPrice: money(rubles) },
  });
  const live = (n: number, rubles: number): LotView => ({
    ...lot(n),
    status: {
      kind: "trading",
      currentPrice: money(rubles),
      phase: "live",
      ask: money(rubles + 300),
    },
  });
  const sold = (n: number, rubles: number): LotView => ({
    ...lot(n),
    status: { kind: "sold", winnerId: "w", price: money(rubles) },
  });

  const shirt = live(1, 1200);
  const vase = held(2, 400);
  const lamp = held(3, 2000);
  const mug = sold(4, 900);
  const lots = [mug, lamp, vase, shirt];

  const blockOf = async (
    getAuction: AuctionPort["getAuction"],
    feed: LotView[] = lots,
  ) => {
    const body = await openFeed({
      auction: { ...oneServerPage(feed), getAuction },
      viewer: VIEWER,
      auctionId: AUCTION_ID,
      page: 0,
    });
    const [block] = body.blocks;
    if (block?.kind !== "feed") throw new Error("feed block expected");
    return block;
  };

  const inFinal =
    (activeLotId?: string): AuctionPort["getAuction"] =>
    async () => ({
      auctionId: AUCTION_ID,
      stage: "in-final",
      final: true,
      lineup: {
        // Порядок выхода не совпадает с ценой: лампа раньше вазы.
        order: [mug.lotId, shirt.lotId, lamp.lotId, vase.lotId],
        ...(activeLotId === undefined ? {} : { activeLotId }),
      },
    });

  it("puts the active lot first, the waiting lineup next and the rest after", async () => {
    const block = await blockOf(inFinal(shirt.lotId));
    expect(block.lots.map((item) => item.lotId)).toEqual([
      shirt.lotId,
      lamp.lotId,
      vase.lotId,
      mug.lotId,
    ]);
    expect(block.final?.active?.lotId).toBe(shirt.lotId);
  });

  it("marks the final without an active lot between lots", async () => {
    const block = await blockOf(inFinal(), [mug, lamp, vase, sold(1, 1500)]);
    expect(block.final).toEqual({});
    expect(block.lots.map((item) => item.lotId)).toEqual([
      lamp.lotId,
      vase.lotId,
      lot(1).lotId,
      mug.lotId,
    ]);
  });

  // Вне финала и при отказе чтения стадии лента прежняя — в порядке
  // создания и без пометки.
  it("keeps the feed as before outside the final", async () => {
    const block = await blockOf(async () => ({
      auctionId: AUCTION_ID,
      stage: "lineup-frozen",
      final: true,
      lineup: { order: [shirt.lotId, lamp.lotId, vase.lotId] },
    }));
    expect(block.final).toBeUndefined();
    expect(block.lots.map((item) => item.lotId)).toEqual([
      shirt.lotId,
      vase.lotId,
      lamp.lotId,
      mug.lotId,
    ]);
  });

  it("keeps the feed as before when the stage is unavailable", async () => {
    const block = await blockOf(async () => {
      throw new Error("auction unavailable");
    });
    expect(block.final).toBeUndefined();
    expect(block.lots.map((item) => item.lotId)).toEqual([
      shirt.lotId,
      vase.lotId,
      lamp.lotId,
      mug.lotId,
    ]);
  });
});

// Порядок и разделы администратора (PER-719): разделы — кнопками над лотами,
// под ними общий список; лоты, которых он не упорядочил, — в конце в порядке
// создания.
describe("feed in the order of the administrator", () => {
  const lots = Array.from({ length: 6 }, (_, i) => lot(i + 1, 100));
  const id = (n: number) => lot(n).lotId;
  const withLayout = (layout: LotLayoutView, feed: LotView[] = lots) => ({
    ...oneServerPage(feed),
    getAuction: async () => ({
      auctionId: AUCTION_ID,
      stage: "prebidding" as const,
      final: false,
      layout,
    }),
  });
  const open = async (
    layout: LotLayoutView,
    extra: { sectionId?: number; feed?: LotView[] } = {},
  ) =>
    openFeed({
      auction: withLayout(layout, extra.feed),
      viewer: VIEWER,
      auctionId: AUCTION_ID,
      page: 0,
      ...(extra.sectionId === undefined ? {} : { sectionId: extra.sectionId }),
    });
  const blockOf = (body: Awaited<ReturnType<typeof openFeed>>) => {
    const [block] = body.blocks;
    if (block?.kind !== "feed") throw new Error("feed block expected");
    return block;
  };
  const sectionButton = (sectionId: number, page = 0) =>
    encodeAuctionCallback({
      kind: "section",
      auctionId: AUCTION_ID,
      sectionId,
      page,
    });

  it("shows a flat feed in the order of the administrator and the unordered lots last by creation", async () => {
    const body = await open({ lotIds: [id(5), id(2)], sections: [] });
    const block = blockOf(body);
    expect(block.sections).toBeUndefined();
    expect(block.lots.map((item) => item.lotId)).toEqual([
      id(5),
      id(2),
      id(1),
      id(3),
      id(4),
      id(6),
    ]);
  });

  it("starts the feed with the sections and lists the lots outside them after", async () => {
    const body = await open({
      lotIds: [id(6)],
      sections: [
        { sectionId: 3, name: "Книги", lotIds: [id(4), id(1)] },
        // Раздел без лотов ленты участнику не виден.
        { sectionId: 1, name: "Пустой", lotIds: [] },
        { sectionId: 2, name: "Посуда", lotIds: [id(2)] },
      ],
    });
    const block = blockOf(body);
    expect(block.sections).toEqual([
      { sectionId: 3, name: "Книги", lotCount: 2 },
      { sectionId: 2, name: "Посуда", lotCount: 1 },
    ]);
    expect(block.lots.map((item) => item.lotId)).toEqual([id(6), id(3), id(5)]);
    expect(body.keyboard.slice(0, 2)).toEqual([
      [
        {
          action: "feed.open-section",
          sectionId: 3,
          callbackData: sectionButton(3),
        },
      ],
      [
        {
          action: "feed.open-section",
          sectionId: 2,
          callbackData: sectionButton(2),
        },
      ],
    ]);
  });

  it("opens a section with its lots in the order of the administrator and leads back to the feed", async () => {
    const layout = {
      lotIds: [],
      sections: [{ sectionId: 3, name: "Книги", lotIds: [id(4), id(1)] }],
    };
    const body = await open(layout, { sectionId: 3 });
    const block = blockOf(body);
    expect(block.section).toEqual({ sectionId: 3, name: "Книги" });
    expect(block.sections).toBeUndefined();
    expect(block.lots.map((item) => item.lotId)).toEqual([id(4), id(1)]);
    expect(body.keyboard.at(-1)).toEqual([
      {
        action: "feed.back",
        callbackData: encodeAuctionCallback({
          kind: "feed",
          auctionId: AUCTION_ID,
          page: 0,
        }),
      },
    ]);
  });

  it("pages a long section with buttons of the same section", async () => {
    const many = Array.from({ length: FEED_PAGE_SIZE + 2 }, (_, i) =>
      lot(i + 1, 100),
    );
    const body = await open(
      {
        lotIds: [],
        sections: [
          { sectionId: 7, name: "Всё", lotIds: many.map((l) => l.lotId) },
        ],
      },
      { sectionId: 7, feed: many },
    );
    expect(body.keyboard.at(-2)).toEqual([
      { action: "feed.next", callbackData: sectionButton(7, 1) },
    ]);
  });

  // Кнопка устаревшего экрана: раздел удалили, пока сообщение висело.
  it("opens the feed for a section that no longer exists", async () => {
    const body = await open(
      {
        lotIds: [],
        sections: [{ sectionId: 3, name: "Книги", lotIds: [id(4)] }],
      },
      { sectionId: 9 },
    );
    const block = blockOf(body);
    expect(block.section).toBeUndefined();
    expect(block.sections).toEqual([
      { sectionId: 3, name: "Книги", lotCount: 1 },
    ]);
  });

  it("drops a lot the layout names but the feed does not have", () => {
    const { sections, rest } = arrangeFeed([lot(1), lot(2)], {
      lotIds: [id(9), id(2)],
      sections: [{ sectionId: 1, name: "Книги", lotIds: [id(8)] }],
    });
    expect(sections).toEqual([]);
    expect(rest.map((l) => l.lotId)).toEqual([id(2), id(1)]);
  });
});
