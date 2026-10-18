import { describe, expect, it } from "vitest";
import type { LotView } from "../../ports.js";
import { neighborsOf } from "./neighbors.js";
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
