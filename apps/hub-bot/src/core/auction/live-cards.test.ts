import { describe, expect, it } from "vitest";
import type {
  AuctionBlock,
  AuctionScreenBody,
  LotView,
  Viewer,
} from "../../auction-ui/index.js";
import type { EditLimiter } from "../bot/edit-limiter.js";
import {
  createLiveCards,
  type LiveCardEntry,
  type LiveEditOutcome,
  liveCardOf,
} from "./live-cards.js";
import type { AuctionWatches, AuctionWatchState } from "./watch.js";

const AUCTION_ID = "01929b7e-5c1d-7a3f-8e4b-0000000000a1";
const LOT_A = "01929b7e-5c1d-7a3f-8e4b-00000000000a";
const LOT_B = "01929b7e-5c1d-7a3f-8e4b-00000000000b";
const VIEWER: Viewer = { identityId: "viewer", rights: ["place-bids"] };
const rub = (rubles: number) => ({ minorUnits: rubles * 100, currency: "RUB" });

const live = (
  lotId: string,
  version: number,
  price: number,
  leaderId = "leader",
): LotView => ({
  lotId,
  auctionId: AUCTION_ID,
  version,
  nextPrice: rub(price + 100),
  proxyEnabled: true,
  status: {
    kind: "trading",
    currentPrice: rub(price),
    leaderId,
    phase: "live",
  },
});

const sold = (lotId: string, version: number): LotView => ({
  lotId,
  auctionId: AUCTION_ID,
  version,
  proxyEnabled: true,
  status: { kind: "sold", winnerId: "leader", price: rub(3000) },
});

// Поток, который ведёт тест: состояние приходит вызовом `emit`.
function manualWatches() {
  const listeners = new Map<number, (state: AuctionWatchState) => void>();
  const viewers: Viewer[] = [];
  let id = 0;
  const watches: AuctionWatches = {
    subscribe(_auctionId, viewer, listener) {
      const own = id++;
      viewers.push(viewer);
      listeners.set(own, listener);
      return () => listeners.delete(own);
    },
    open: () => (listeners.size > 0 ? 1 : 0),
    close: () => listeners.clear(),
  };
  return {
    watches,
    viewers,
    subscribers: () => listeners.size,
    emit(activeLot: LotView | undefined, lineup: readonly LotView[] = []) {
      for (const listener of [...listeners.values()]) {
        listener({
          auctionId: AUCTION_ID,
          finished: false,
          ...(activeLot === undefined ? {} : { activeLot }),
          lineup,
        });
      }
    },
  };
}

// Лимитер без темпа: правка уходит сразу, темп проверяет свой тест.
const immediate: EditLimiter = {
  submit: (_chat, _key, task) => {
    void task();
  },
  drop: () => {},
  waiting: () => 0,
  close: () => {},
};

const flush = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

function setup(outcome: LiveEditOutcome = { kind: "done" }) {
  const stream = manualWatches();
  const edits: { card: LiveCardEntry; body: AuctionScreenBody }[] = [];
  const nameCalls: string[][] = [];
  const cards = createLiveCards({
    watches: stream.watches,
    limiter: immediate,
    names: {
      async getDisplayNames(request) {
        nameCalls.push([...request.participantIds]);
        return Object.fromEntries(
          request.participantIds.map((id) => [id, `@${id}`]),
        );
      },
    },
    edit: async (card, body) => {
      edits.push({ card, body });
      return outcome;
    },
  });
  const lotOf = (body: AuctionScreenBody) =>
    body.blocks.find(
      (block): block is Extract<AuctionBlock, { kind: "lot" }> =>
        block.kind === "lot",
    );
  return { stream, edits, nameCalls, cards, lotOf };
}

const opened = {
  auctionId: AUCTION_ID,
  lotId: LOT_A,
  version: 1,
  viewer: VIEWER,
  page: 2,
};

describe("live cards", () => {
  it("edits an open card on a new price and skips a state it already shows", async () => {
    const { stream, edits, cards, lotOf } = setup();
    cards.shown(7, 70, opened);
    expect(stream.viewers).toEqual([VIEWER]);
    stream.emit(live(LOT_A, 1, 1200));
    await flush();
    expect(edits).toHaveLength(0);
    stream.emit(live(LOT_A, 2, 1300));
    await flush();
    expect(edits).toHaveLength(1);
    const block = lotOf(edits[0]?.body ?? { blocks: [], keyboard: [] });
    expect(block?.status).toMatchObject({ currentPrice: rub(1300) });
    expect(block?.participantName).toBe("@leader");
    expect(edits[0]?.body.keyboard[0]?.[0]).toMatchObject({
      action: "lot.bid-final",
      amount: rub(1400),
    });
  });

  it("follows the active lot of the final", async () => {
    const { stream, edits, cards, lotOf } = setup();
    cards.shown(7, 70, opened);
    stream.emit(live(LOT_B, 1, 500), [sold(LOT_A, 3), live(LOT_B, 1, 500)]);
    await flush();
    expect(lotOf(edits[0]?.body ?? { blocks: [], keyboard: [] })?.lotId).toBe(
      LOT_B,
    );
  });

  it("shows the outcome of its lot between lots", async () => {
    const { stream, edits, cards, lotOf } = setup();
    cards.shown(7, 70, opened);
    stream.emit(undefined, [sold(LOT_A, 3), live(LOT_B, 0, 500)]);
    await flush();
    const block = lotOf(edits[0]?.body ?? { blocks: [], keyboard: [] });
    expect(block?.status.kind).toBe("sold");
    expect(edits[0]?.body.keyboard.flat().map((b) => b.action)).not.toContain(
      "lot.bid-final",
    );
  });

  it("forgets the card when another screen takes its message", async () => {
    const { stream, edits, cards } = setup();
    cards.shown(7, 70, opened);
    cards.shown(7, 70, undefined);
    expect(stream.subscribers()).toBe(0);
    stream.emit(live(LOT_A, 2, 1300));
    await flush();
    expect(edits).toHaveLength(0);
  });

  it("keeps the card when another message of the chat changes", () => {
    const { stream, cards } = setup();
    cards.shown(7, 70, opened);
    cards.shown(7, 71, undefined);
    expect(cards.size()).toBe(1);
    expect(stream.subscribers()).toBe(1);
  });

  it("keeps one card per chat", () => {
    const { stream, cards } = setup();
    cards.shown(7, 70, opened);
    cards.shown(7, 71, opened);
    expect(cards.size()).toBe(1);
    expect(stream.subscribers()).toBe(1);
  });

  it("forgets a card whose message is gone", async () => {
    const { stream, cards } = setup({ kind: "gone" });
    cards.shown(7, 70, opened);
    stream.emit(live(LOT_A, 2, 1300));
    await flush();
    expect(cards.size()).toBe(0);
    expect(stream.subscribers()).toBe(0);
  });

  it("asks the name of a leader once", async () => {
    const { stream, cards, nameCalls } = setup();
    cards.shown(7, 70, opened);
    cards.shown(8, 80, opened);
    stream.emit(live(LOT_A, 2, 1300));
    await flush();
    stream.emit(live(LOT_A, 3, 1400));
    await flush();
    expect(nameCalls).toEqual([["leader"]]);
  });

  it("keeps the own proxy limit on the lot it was opened on", async () => {
    const { stream, edits, cards, lotOf } = setup();
    cards.shown(7, 70, {
      ...opened,
      proxyLimit: { lotId: LOT_A, amount: rub(2000) },
    });
    stream.emit(live(LOT_A, 2, 1300));
    await flush();
    stream.emit(live(LOT_B, 1, 500));
    await flush();
    expect(
      lotOf(edits[0]?.body ?? { blocks: [], keyboard: [] })?.viewerProxyLimit,
    ).toEqual(rub(2000));
    expect(
      lotOf(edits[1]?.body ?? { blocks: [], keyboard: [] })?.viewerProxyLimit,
    ).toBeUndefined();
  });

  it("evicts the oldest card over the limit", () => {
    const stream = manualWatches();
    const cards = createLiveCards({
      watches: stream.watches,
      limiter: immediate,
      names: { getDisplayNames: async () => ({}) },
      edit: async () => ({ kind: "done" }),
      limit: 2,
    });
    cards.shown(1, 10, opened);
    cards.shown(2, 20, opened);
    cards.shown(3, 30, opened);
    expect(cards.size()).toBe(2);
    expect(stream.subscribers()).toBe(2);
  });
});

describe("live card of a body", () => {
  it("reads a lot of the live final and nothing else", () => {
    const block: Extract<AuctionBlock, { kind: "lot" }> = {
      kind: "lot",
      lotId: LOT_A,
      auctionId: AUCTION_ID,
      version: 4,
      status: live(LOT_A, 4, 1200).status,
      following: true,
      viewerProxyLimit: rub(2000),
      live: { page: 3 },
    };
    expect(liveCardOf({ blocks: [block], keyboard: [] }, VIEWER)).toEqual({
      auctionId: AUCTION_ID,
      lotId: LOT_A,
      version: 4,
      viewer: VIEWER,
      page: 3,
      following: true,
      proxyLimit: { lotId: LOT_A, amount: rub(2000) },
    });
    const { live: _live, ...online } = block;
    expect(liveCardOf({ blocks: [online], keyboard: [] }, VIEWER)).toBe(
      undefined,
    );
    expect(liveCardOf({ blocks: [block], keyboard: [] }, undefined)).toBe(
      undefined,
    );
  });
});
