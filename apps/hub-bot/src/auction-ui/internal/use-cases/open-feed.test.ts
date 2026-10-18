import { describe, expect, it } from "vitest";
import { encodeAuctionCallback } from "../../callback-data.js";
import type { AuctionPort, LotPage, LotView } from "../../ports.js";
import { FEED_PAGE_SIZE, openFeed, sortForFeed } from "./open-feed.js";

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
    getMyPredictions: async () => [],
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

  it("pages the sorted feed and offers both directions in the middle", async () => {
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

  it("puts lots without a price last and breaks ties by lot id", () => {
    const sorted = sortForFeed([
      lot(5),
      lot(4, 10),
      lot(3),
      lot(2, 10),
      lot(1, 5),
    ]);
    expect(sorted.map((l) => l.lotId.slice(-1))).toEqual([
      "1",
      "2",
      "4",
      "3",
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
// состава, которые ждут очереди, по порядку выхода, затем остальные по цене.
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
      mug.lotId,
      lot(1).lotId,
    ]);
  });

  // Вне финала и при отказе чтения стадии лента прежняя — по цене и без
  // пометки.
  it("keeps the feed as before outside the final", async () => {
    const block = await blockOf(async () => ({
      auctionId: AUCTION_ID,
      stage: "lineup-frozen",
      final: true,
      lineup: { order: [shirt.lotId, lamp.lotId, vase.lotId] },
    }));
    expect(block.final).toBeUndefined();
    expect(block.lots.map((item) => item.lotId)).toEqual(
      sortForFeed(lots).map((each) => each.lotId),
    );
  });

  it("keeps the feed as before when the stage is unavailable", async () => {
    const block = await blockOf(async () => {
      throw new Error("auction unavailable");
    });
    expect(block.final).toBeUndefined();
    expect(block.lots.map((item) => item.lotId)).toEqual(
      sortForFeed(lots).map((each) => each.lotId),
    );
  });
});
