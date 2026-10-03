import { describe, expect, it } from "vitest";
import { encodeAuctionCallback } from "../../callback-data.js";
import type { AuctionPort, LotPage, LotView } from "../../ports.js";
import { FEED_PAGE_SIZE, openFeed, sortForFeed } from "./open-feed.js";

const AUCTION_ID = "01929b7e-5c1d-7a3f-8e4b-0000000000a1";
const VIEWER = {
  identityId: "01929b7e-5c1d-7a3f-8e4b-000000000001",
  globalRoles: ["public"] as const,
};

function lot(n: number, rubles?: number): LotView {
  const lotId = `01929b7e-5c1d-7a3f-8e4b-${n.toString(16).padStart(12, "0")}`;
  return {
    lotId,
    auctionId: AUCTION_ID,
    version: 1,
    status:
      rubles === undefined
        ? { kind: "unsold" }
        : {
            kind: "trading",
            currentPrice: { minorUnits: rubles * 100, currency: "RUB" },
          },
  };
}

function auctionOf(pages: Record<string, LotPage>): AuctionPort {
  return {
    getLot: async () => {
      throw new Error("not used");
    },
    getDisplayNames: async () => {
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
