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
  type WatchStore,
  type WatchTarget,
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
  const endings = new Map<number, () => void>();
  const viewers: Viewer[] = [];
  let id = 0;
  const watches: AuctionWatches = {
    subscribe(_auctionId, viewer, listener, ended) {
      const own = id++;
      viewers.push(viewer);
      listeners.set(own, listener);
      if (ended !== undefined) endings.set(own, ended);
      return () => {
        listeners.delete(own);
        endings.delete(own);
      };
    },
    open: () => (listeners.size > 0 ? 1 : 0),
    close: () => listeners.clear(),
  };
  return {
    watches,
    viewers,
    subscribers: () => listeners.size,
    end() {
      for (const ended of [...endings.values()]) ended();
    },
    emit(
      activeLot: LotView | undefined,
      lineup: readonly LotView[] = [],
      finished = false,
    ) {
      for (const listener of [...listeners.values()]) {
        listener({
          auctionId: AUCTION_ID,
          finished,
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

function setup(
  outcome: LiveEditOutcome = { kind: "done" },
  store?: WatchStore,
) {
  const stream = manualWatches();
  const edits: { card: LiveCardEntry; body: AuctionScreenBody }[] = [];
  const nameCalls: string[][] = [];
  const cards = createLiveCards({
    watches: stream.watches,
    limiter: immediate,
    ...(store === undefined ? {} : { store }),
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
  live: true,
  page: 2,
};

describe("live cards", () => {
  it("edits an open card only on a state it does not show yet", async () => {
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

  // Последнее сообщение потока завершённого аукциона несёт состав с
  // исходами (PER-712): карточка последнего лота показывает продажу без
  // нажатия.
  it("shows the sale of the last lot of the final when the auction finishes", async () => {
    const { stream, edits, cards, lotOf } = setup();
    cards.shown(7, 70, opened);
    stream.emit(undefined, [sold(LOT_A, 3)], true);
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

  // PER-835: проигравший гонку на одну цену видел ответ «цена ушла» лишь до
  // следующей правки по потоку, и она его стирала.
  it("keeps the price-moved reply while the stream edits the card", async () => {
    const { stream, edits, cards, lotOf } = setup();
    const moved = { kind: "price-changed" as const, next: rub(1400) };
    cards.shown(7, 70, { ...opened, priceMoved: moved });
    stream.emit(live(LOT_A, 2, 1300));
    await flush();
    expect(
      lotOf(edits[0]?.body ?? { blocks: [], keyboard: [] })?.finalBid,
    ).toEqual(moved);
    // Новый показ карточки без ответа его снимает.
    cards.shown(7, 70, { ...opened, version: 2 });
    stream.emit(live(LOT_A, 3, 1400));
    await flush();
    expect(
      lotOf(edits[1]?.body ?? { blocks: [], keyboard: [] })?.finalBid,
    ).toBeUndefined();
  });

  it("drops the price-moved reply when the card moves to another lot", async () => {
    const { stream, edits, cards, lotOf } = setup();
    const moved = { kind: "price-changed" as const, next: rub(1400) };
    cards.shown(7, 70, { ...opened, priceMoved: moved });
    stream.emit(live(LOT_B, 1, 500));
    await flush();
    stream.emit(live(LOT_A, 5, 1500));
    await flush();
    expect(
      lotOf(edits[0]?.body ?? { blocks: [], keyboard: [] })?.finalBid,
    ).toBeUndefined();
    expect(
      lotOf(edits[1]?.body ?? { blocks: [], keyboard: [] })?.finalBid,
    ).toBeUndefined();
  });

  it("takes the price-moved reply of the card body", () => {
    const body: AuctionScreenBody = {
      blocks: [
        {
          kind: "lot",
          auctionId: AUCTION_ID,
          lotId: LOT_A,
          version: 2,
          live: { page: 1 },
          finalBid: {
            kind: "refused",
            refusal: { kind: "bid-not-at-next-price", expected: rub(1400) },
          },
        } as unknown as AuctionBlock,
      ],
      keyboard: [],
    };
    expect(liveCardOf(body, VIEWER)?.priceMoved).toMatchObject({
      kind: "refused",
    });
  });

  it("keeps the own proxy limit on the lot it was opened on", async () => {
    const { stream, edits, cards, lotOf } = setup();
    cards.shown(7, 70, { ...opened, proxyLimit: rub(2000) });
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

  // Между лотами человек жмёт «Обновить» или «В избранное» на проданном
  // лоте: тело без пометки `live`, но финал идёт, и карточка остаётся живой.
  it("keeps the card when the same message shows a settled lot of its auction", async () => {
    const { stream, edits, cards, lotOf } = setup();
    cards.shown(7, 70, opened);
    const { page: _page, ...settled } = opened;
    expect(cards.shown(7, 70, { ...settled, live: false, version: 3 })).toBe(
      true,
    );
    expect(stream.subscribers()).toBe(1);
    stream.emit(live(LOT_B, 1, 500));
    await flush();
    expect(lotOf(edits[0]?.body ?? { blocks: [], keyboard: [] })?.lotId).toBe(
      LOT_B,
    );
  });

  it("does not keep a settled lot in a message that was not live", () => {
    const { stream, cards } = setup();
    expect(cards.shown(7, 70, { ...opened, live: false })).toBe(false);
    expect(stream.subscribers()).toBe(0);
  });

  it("carries the favorite mark only on the lot it was read for", async () => {
    const { stream, edits, cards, lotOf } = setup();
    cards.shown(7, 70, { ...opened, following: true });
    stream.emit(live(LOT_A, 2, 1300));
    await flush();
    stream.emit(live(LOT_B, 1, 500));
    await flush();
    expect(
      lotOf(edits[0]?.body ?? { blocks: [], keyboard: [] })?.following,
    ).toBe(true);
    expect(
      lotOf(edits[1]?.body ?? { blocks: [], keyboard: [] })?.following,
    ).toBeUndefined();
  });

  // Поток отстал от чтения по нажатию: карточка назад не откатывается.
  it("does not roll the card back to an older version", async () => {
    const { stream, edits, cards } = setup();
    cards.shown(7, 70, { ...opened, version: 5 });
    stream.emit(live(LOT_A, 4, 1300));
    await flush();
    expect(edits).toHaveLength(0);
  });

  // Нажатие показало карточку новее, пока правка ждала имени: устаревшая
  // правка её не затирает.
  it("drops an edit that a newer card overtook while it waited", async () => {
    const stream = manualWatches();
    const edits: AuctionScreenBody[] = [];
    let release: () => void = () => {};
    const cards = createLiveCards({
      watches: stream.watches,
      limiter: immediate,
      names: {
        getDisplayNames: () =>
          new Promise((resolve) => {
            release = () => resolve({ leader: "@leader" });
          }),
      },
      edit: async (_card, body) => {
        edits.push(body);
        return { kind: "done" };
      },
    });
    cards.shown(7, 70, opened);
    stream.emit(live(LOT_A, 2, 1300));
    await flush();
    cards.shown(7, 70, { ...opened, version: 3 });
    release();
    await flush();
    expect(edits).toHaveLength(0);
  });

  // Ответ на нажатие прочитал лот раньше, чем поток ушёл дальше, а
  // отрисовался после правки потока: карточка снова получает последнее.
  it("reapplies the latest stream state after a stale press render", async () => {
    const { stream, edits, cards, lotOf } = setup();
    cards.shown(7, 70, opened);
    stream.emit(live(LOT_A, 6, 1400));
    await flush();
    cards.shown(7, 70, { ...opened, version: 5 });
    await flush();
    expect(edits).toHaveLength(2);
    expect(lotOf(edits[1]?.body ?? { blocks: [], keyboard: [] })?.version).toBe(
      6,
    );
  });

  it("edits the same state again after an edit that failed", async () => {
    const stream = manualWatches();
    const outcomes: LiveEditOutcome[] = [{ kind: "failed" }, { kind: "done" }];
    let calls = 0;
    const cards = createLiveCards({
      watches: stream.watches,
      limiter: immediate,
      names: { getDisplayNames: async () => ({}) },
      edit: async () => {
        calls += 1;
        return outcomes.shift() ?? { kind: "done" };
      },
    });
    cards.shown(7, 70, opened);
    stream.emit(live(LOT_A, 2, 1300));
    await flush();
    stream.emit(live(LOT_A, 2, 1300));
    await flush();
    expect(calls).toBe(2);
  });

  it("forgets the cards of a stream that ended", () => {
    const stream = manualWatches();
    const cards = createLiveCards({
      watches: stream.watches,
      limiter: immediate,
      names: { getDisplayNames: async () => ({}) },
      edit: async () => ({ kind: "done" }),
    });
    cards.shown(7, 70, opened);
    stream.end();
    expect(cards.size()).toBe(0);
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
      live: true,
      page: 3,
      following: true,
      proxyLimit: rub(2000),
    });
    const { live: _live, ...online } = block;
    expect(
      liveCardOf({ blocks: [online], keyboard: [] }, VIEWER),
    ).toMatchObject({ live: false });
    expect(liveCardOf({ blocks: [], keyboard: [] }, VIEWER)).toBeUndefined();
    expect(liveCardOf({ blocks: [block], keyboard: [] }, undefined)).toBe(
      undefined,
    );
  });
});

// Карточка в слежении (PER-837): та же карточка, запись о которой переживает
// рестарт, а в конце финала она пишет «Аукцион завершён».
describe("cards in the follow", () => {
  function memoryStore(initial: WatchTarget[] = []) {
    const records = new Map(initial.map((each) => [each.chatId, each]));
    const store: WatchStore = {
      async save(target) {
        records.set(target.chatId, target);
      },
      async remove(chatId) {
        records.delete(chatId);
      },
      async list() {
        return [...records.values()];
      },
    };
    return { records, store };
  }
  const start = { ...opened, watch: "start" as const, watching: true };

  it("saves the card on the watch button and draws the unfollow button", async () => {
    const { records, store } = memoryStore();
    const { stream, edits, cards, lotOf } = setup({ kind: "done" }, store);
    cards.shown(7, 70, start);
    await flush();
    expect(records.get(7)).toMatchObject({
      messageId: 70,
      auctionId: AUCTION_ID,
      lotId: LOT_A,
      page: 2,
    });
    stream.emit(live(LOT_A, 2, 1300));
    await flush();
    const body = edits[0]?.body ?? { blocks: [], keyboard: [] };
    expect(lotOf(body)?.watching).toBe(true);
    expect(body.keyboard.flat().map((b) => b.action)).toContain("lot.unwatch");
  });

  it("follows the next lot and keeps the record under it", async () => {
    const { records, store } = memoryStore();
    const { stream, cards } = setup({ kind: "done" }, store);
    cards.shown(7, 70, start);
    stream.emit(live(LOT_B, 1, 500), [sold(LOT_A, 3), live(LOT_B, 1, 500)]);
    await flush();
    expect(records.get(7)?.lotId).toBe(LOT_B);
  });

  it("stops editing and drops the record on the unfollow button", async () => {
    const { records, store } = memoryStore();
    const { stream, edits, cards } = setup({ kind: "done" }, store);
    cards.shown(7, 70, start);
    await flush();
    expect(cards.shown(7, 70, { ...opened, watch: "stop" })).toBe(false);
    await flush();
    expect(records.size).toBe(0);
    expect(stream.subscribers()).toBe(0);
    stream.emit(live(LOT_A, 2, 1300));
    await flush();
    expect(edits).toHaveLength(0);
  });

  it("drops the record when another screen takes the message", async () => {
    const { records, store } = memoryStore();
    const { cards } = setup({ kind: "done" }, store);
    cards.shown(7, 70, start);
    await flush();
    cards.shown(7, 70, undefined);
    await flush();
    expect(records.size).toBe(0);
  });

  it("restores the card after a restart and edits the same message", async () => {
    const { records, store } = memoryStore([
      {
        chatId: 7,
        messageId: 70,
        auctionId: AUCTION_ID,
        lotId: LOT_A,
        page: 2,
        viewer: VIEWER,
      },
    ]);
    const { stream, edits, cards, lotOf } = setup({ kind: "done" }, store);
    await expect(cards.restore()).resolves.toBe(1);
    expect(stream.viewers).toEqual([VIEWER]);
    // Версия карточки неизвестна: первое состояние потока перерисует её.
    stream.emit(live(LOT_A, 1, 1200));
    await flush();
    expect(edits).toHaveLength(1);
    expect(edits[0]?.card).toMatchObject({ chatId: 7, messageId: 70 });
    expect(
      lotOf(edits[0]?.body ?? { blocks: [], keyboard: [] })?.watching,
    ).toBe(true);
    expect(records.has(7)).toBe(true);
  });

  it("does not revive a follow that was switched off before the restore read it", async () => {
    const stale: WatchTarget = {
      chatId: 7,
      messageId: 70,
      auctionId: AUCTION_ID,
      lotId: LOT_A,
      page: 2,
      viewer: VIEWER,
    };
    const { store } = memoryStore();
    const { stream, cards } = setup(
      { kind: "done" },
      { ...store, list: async () => [stale] },
    );
    cards.shown(7, 70, start);
    cards.shown(7, 70, { ...opened, watch: "stop" });
    await cards.restore();
    expect(stream.subscribers()).toBe(0);
  });

  it("writes that the auction is over on the last edit and lets the card go", async () => {
    const { records, store } = memoryStore();
    const { stream, edits, cards, lotOf } = setup({ kind: "done" }, store);
    cards.shown(7, 70, start);
    stream.emit(undefined, [sold(LOT_A, 5)], true);
    // Поток закрывается сразу за последним состоянием: правку это не отменяет.
    stream.end();
    await flush();
    expect(edits).toHaveLength(1);
    expect(lotOf(edits[0]?.body ?? { blocks: [], keyboard: [] })?.ended).toBe(
      true,
    );
    expect(records.size).toBe(0);
    expect(cards.size()).toBe(0);
  });

  it("carries the follow flags from the shown card", () => {
    const block: Extract<AuctionBlock, { kind: "lot" }> = {
      kind: "lot",
      lotId: LOT_A,
      auctionId: AUCTION_ID,
      version: 4,
      status: live(LOT_A, 4, 1200).status,
      live: { page: 3 },
      watch: true,
      watching: true,
    };
    expect(liveCardOf({ blocks: [block], keyboard: [] }, VIEWER)).toMatchObject(
      { watch: "start", watching: true },
    );
    const { watch: _watch, watching: _watching, ...plain } = block;
    expect(
      liveCardOf(
        { blocks: [{ ...plain, unwatch: true }], keyboard: [] },
        VIEWER,
      ),
    ).toMatchObject({ watch: "stop" });
  });
});
