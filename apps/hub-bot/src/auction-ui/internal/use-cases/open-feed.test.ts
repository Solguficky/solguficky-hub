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
    expect(body.keyboard.at(-1)).toEqual([
      { action: "feed.prev", callbackData: feedButton(0) },
      { action: "feed.next", callbackData: feedButton(2) },
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
    expect(first.keyboard.at(-1)).toEqual([
      { action: "feed.next", callbackData: feedButton(1) },
    ]);
    expect(last.keyboard.at(-1)).toEqual([
      { action: "feed.prev", callbackData: feedButton(1) },
    ]);
    expect(last.keyboard).toHaveLength(20 - 2 * FEED_PAGE_SIZE + 1);
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

  it("leaves an empty feed without the mark", async () => {
    expect((await blockOf([])).beforeTrading).toBeUndefined();
  });
});
