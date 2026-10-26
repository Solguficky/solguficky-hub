import { describe, expect, it } from "vitest";
import type { AuctionPort, LotView } from "../../ports.js";
import { neighborsOf, readNeighbors } from "./neighbors.js";
import { FEED_PAGE_SIZE } from "./open-feed.js";

const lot = (n: number): LotView => ({
  lotId: `lot-${n}`,
  auctionId: "auction",
  version: 1,
  proxyEnabled: false,
  status: { kind: "unsold" },
});

const feed = Array.from({ length: FEED_PAGE_SIZE + 2 }, (_, n) => lot(n));

// Соседи считаются по уже отсортированной ленте (PER-644): тот же порядок,
// что у её строк, и у каждого — его страница.
describe("lot neighbors", () => {
  it("has no previous on the first lot and no next on the last", () => {
    expect(neighborsOf(feed, "lot-0")).toEqual({
      next: { lotId: "lot-1", page: 0 },
    });
    expect(neighborsOf(feed, `lot-${FEED_PAGE_SIZE + 1}`)).toEqual({
      prev: { lotId: `lot-${FEED_PAGE_SIZE}`, page: 1 },
    });
  });

  it("gives the neighbor across a page boundary its own page", () => {
    expect(neighborsOf(feed, `lot-${FEED_PAGE_SIZE - 1}`)).toEqual({
      prev: { lotId: `lot-${FEED_PAGE_SIZE - 2}`, page: 0 },
      next: { lotId: `lot-${FEED_PAGE_SIZE}`, page: 1 },
    });
  });

  it("has no neighbors for a lot outside the feed or alone in it", () => {
    expect(neighborsOf(feed, "lot-missing")).toEqual({});
    expect(neighborsOf([lot(0)], "lot-0")).toEqual({});
  });
});

// Лот раздела (PER-719): соседи — из его раздела, и карточка знает раздел для
// «‹ Лоты».
describe("lot neighbors in a section", () => {
  const lots = [lot(1), lot(2), lot(3), lot(4)];
  const auction = {
    listAuctionLots: async () => ({ lots, nextPageToken: "" }),
    getAuction: async () => ({
      auctionId: "auction",
      stage: "prebidding" as const,
      final: false,
      layout: {
        lotIds: [],
        sections: [{ sectionId: 2, name: "Книги", lotIds: ["lot-3", "lot-1"] }],
      },
    }),
  } as unknown as AuctionPort;
  const viewer = { identityId: "viewer", rights: ["place-bids" as const] };

  it("takes the neighbors from the section of the lot and names the section", async () => {
    expect(await readNeighbors({ auction, viewer, lot: lot(1) })).toEqual({
      prev: { lotId: "lot-3", page: 0 },
      sectionId: 2,
    });
  });

  it("takes the neighbors of a lot outside the sections from the general list", async () => {
    expect(await readNeighbors({ auction, viewer, lot: lot(2) })).toEqual({
      next: { lotId: "lot-4", page: 0 },
    });
  });
});
