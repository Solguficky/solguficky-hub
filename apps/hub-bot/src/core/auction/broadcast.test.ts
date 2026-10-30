import { describe, expect, it } from "vitest";
import type { LotView, Viewer } from "../../auction-ui/index.js";
import type { EditLimiter, EditTask } from "../bot/edit-limiter.js";
import {
  type BroadcastApi,
  type BroadcastStore,
  type BroadcastTarget,
  createLiveBroadcasts,
} from "./broadcast.js";
import type { LiveEditOutcome } from "./live-cards.js";
import type { AuctionWatches, AuctionWatchState } from "./watch.js";

const AUCTION = "0192f0aa-0000-7000-8000-000000000001";
const viewer: Viewer = { identityId: "id-me", rights: ["place-bids"] };
const rub = (rubles: number) => ({ minorUnits: rubles * 100, currency: "RUB" });

function lot(input: {
  version: number;
  price: number;
  next: number;
  leader?: string;
  step?: number;
}): LotView {
  return {
    lotId: "lot-1",
    auctionId: AUCTION,
    version: input.version,
    card: { title: "Гитара <б>", description: "" },
    nextPrice: rub(input.next),
    ...(input.step === undefined ? {} : { baseStep: rub(input.step) }),
    proxyEnabled: false,
    status: {
      kind: "trading",
      currentPrice: rub(input.price),
      ...(input.leader === undefined ? {} : { leaderId: input.leader }),
      phase: "live",
    },
  };
}

const stateOf = (active: LotView | undefined, finished = false) =>
  ({
    auctionId: AUCTION,
    finished,
    ...(active === undefined ? {} : { activeLot: active }),
    lineup: active === undefined ? [] : [active],
  }) satisfies AuctionWatchState;

// Поток под управлением теста: подписка запоминает слушателя.
function fakeWatches() {
  const listeners = new Map<
    number,
    { listener: (s: AuctionWatchState) => void; ended?: () => void }
  >();
  let next = 0;
  let subscriptions = 0;
  const watches: AuctionWatches = {
    subscribe(_auction, _viewer, listener, ended) {
      const id = next++;
      subscriptions += 1;
      listeners.set(id, {
        listener,
        ...(ended === undefined ? {} : { ended }),
      });
      return () => {
        listeners.delete(id);
      };
    },
    open: () => listeners.size,
    close: () => listeners.clear(),
  };
  return {
    watches,
    emit(state: AuctionWatchState) {
      for (const each of [...listeners.values()]) each.listener(state);
    },
    // Поток закрылся сам, как после последнего состояния финала.
    end() {
      for (const each of [...listeners.values()]) each.ended?.();
    },
    subscribers: () => listeners.size,
    subscriptions: () => subscriptions,
  };
}

// Лимитер, который выполняет правки сразу и помнит, какой полосой они пришли.
function immediateLimiter() {
  const lanes: (string | undefined)[] = [];
  const dropped: string[] = [];
  const pending: Promise<unknown>[] = [];
  const limiter: EditLimiter = {
    submit(_chat: number, _key: string, task: EditTask, lane) {
      lanes.push(lane);
      pending.push(task());
    },
    drop: (key) => {
      dropped.push(key);
    },
    waiting: () => 0,
    close: () => {},
  };
  return { limiter, lanes, dropped, settle: () => Promise.all(pending) };
}

function memoryStore() {
  const records = new Map<number, BroadcastTarget>();
  const store: BroadcastStore = {
    save: async (target) => {
      records.set(target.chatId, target);
    },
    remove: async (chatId) => {
      records.delete(chatId);
    },
    list: async () => [...records.values()],
  };
  return { store, records };
}

function fakeApi(outcome: () => LiveEditOutcome = () => ({ kind: "done" })) {
  const sent: { chatId: number; text: string }[] = [];
  const edits: {
    target: { chatId: number; messageId: number };
    text: string;
    final: boolean;
  }[] = [];
  let id = 500;
  const api: BroadcastApi = {
    send: async (input) => {
      sent.push({ ...input, text: plain(input.text) });
      id += 1;
      return id;
    },
    edit: async (target, input) => {
      edits.push({ target, ...input, text: plain(input.text) });
      return outcome();
    },
  };
  return { api, sent, edits };
}

// Intl пишет сумму с неразрывными пробелами; тексты теста — с обычными.
const plain = (text: string) => text.replaceAll(/[  ]/g, " ");

const flush = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

function setup(
  input: {
    outcome?: () => LiveEditOutcome;
    names?: Record<string, string>;
    seed?: BroadcastTarget;
  } = {},
) {
  const feed = fakeWatches();
  const limiter = immediateLimiter();
  const store = memoryStore();
  if (input.seed !== undefined)
    store.records.set(input.seed.chatId, input.seed);
  const telegram = fakeApi(input.outcome);
  const broadcasts = createLiveBroadcasts({
    watches: feed.watches,
    limiter: limiter.limiter,
    names: {
      getDisplayNames: async (request) =>
        Object.fromEntries(
          request.participantIds.flatMap((id) =>
            input.names?.[id] === undefined ? [] : [[id, input.names[id]]],
          ),
        ),
    },
    api: telegram.api,
    store: store.store,
    timeZone: "Europe/Moscow",
    now: () => new Date("2026-10-31T16:05:09Z"),
  });
  return { feed, limiter, store, telegram, broadcasts };
}

describe("live bid broadcast", () => {
  it("sends one message with the next price and edits it on every bid", async () => {
    const { feed, telegram, broadcasts, store, limiter } = setup({
      names: { "id-other": "Маша" },
    });
    await broadcasts.start({ chatId: 7, auctionId: AUCTION, viewer });
    feed.emit(stateOf(lot({ version: 1, price: 1500, next: 1750, step: 250 })));
    await flush();

    expect(telegram.sent).toHaveLength(1);
    const first = telegram.sent[0]?.text ?? "";
    expect(first).toContain("Следующая цена");
    expect(first).toContain("<b>1 750 ₽</b>");
    expect(first).toContain("Текущая ставка 1 500 ₽ · ставок пока нет");
    expect(first).toContain("Шаг: +250 ₽");
    expect(first).toContain("Обновлено в 19:05:09");
    // Название лота экранируется.
    expect(first).toContain("<b>Гитара &lt;б&gt;</b>");
    expect(store.records.get(7)?.messageId).toBe(501);

    feed.emit(
      stateOf(
        lot({
          version: 2,
          price: 1750,
          next: 2000,
          leader: "id-other",
          step: 250,
        }),
      ),
    );
    await flush();
    feed.emit(
      stateOf(
        lot({
          version: 3,
          price: 2000,
          next: 2250,
          leader: "id-me",
          step: 250,
        }),
      ),
    );
    await limiter.settle();
    await flush();

    // Новых сообщений нет, только правки того же.
    expect(telegram.sent).toHaveLength(1);
    expect(telegram.edits.map((e) => e.target.messageId)).toEqual([501, 501]);
    expect(telegram.edits[0]?.text).toContain("лидирует Маша");
    expect(telegram.edits[1]?.text).toContain("лидируешь ты");
    expect(telegram.edits.every((e) => !e.final)).toBe(true);
  });

  it("edits through the background lane so cards are not held up", async () => {
    const { feed, limiter, broadcasts } = setup();
    await broadcasts.start({ chatId: 7, auctionId: AUCTION, viewer });
    feed.emit(stateOf(lot({ version: 1, price: 1500, next: 1750 })));
    await flush();
    feed.emit(stateOf(lot({ version: 2, price: 1750, next: 2000 })));
    await flush();
    expect(limiter.lanes).toEqual(["background"]);
  });

  it("sends nothing to somebody who did not subscribe", async () => {
    const { feed, telegram } = setup();
    feed.emit(stateOf(lot({ version: 1, price: 1500, next: 1750 })));
    await flush();
    expect(telegram.sent).toHaveLength(0);
    expect(telegram.edits).toHaveLength(0);
  });

  it("does not send a second message when the same broadcast is requested again", async () => {
    const { feed, telegram, broadcasts } = setup();
    await broadcasts.start({ chatId: 7, auctionId: AUCTION, viewer });
    feed.emit(stateOf(lot({ version: 1, price: 1500, next: 1750 })));
    await flush();
    await broadcasts.start({ chatId: 7, auctionId: AUCTION, viewer });
    await flush();
    expect(telegram.sent).toHaveLength(1);
    expect(feed.subscribers()).toBe(1);
  });

  it("does not edit a message whose text did not change", async () => {
    const { feed, telegram, limiter, broadcasts } = setup();
    await broadcasts.start({ chatId: 7, auctionId: AUCTION, viewer });
    feed.emit(stateOf(lot({ version: 1, price: 1500, next: 1750 })));
    await flush();
    feed.emit(stateOf(lot({ version: 2, price: 1500, next: 1750 })));
    await limiter.settle();
    await flush();
    expect(telegram.edits).toHaveLength(0);
  });

  it("shows the sold lot and then the end of the auction, and lets the subscription go", async () => {
    const { feed, telegram, limiter, broadcasts, store } = setup({
      names: { "id-other": "Маша" },
    });
    await broadcasts.start({ chatId: 7, auctionId: AUCTION, viewer });
    const trading = lot({ version: 1, price: 1500, next: 1750 });
    feed.emit(stateOf(trading));
    await flush();
    const sold: LotView = {
      ...trading,
      version: 4,
      status: { kind: "sold", winnerId: "id-other", price: rub(2250) },
    };
    feed.emit({ auctionId: AUCTION, finished: false, lineup: [sold] });
    await limiter.settle();
    await flush();
    expect(telegram.edits[0]?.text).toContain("Продан за 2 250 ₽ · Маша");
    expect(telegram.edits[0]?.text).toContain("Ждём следующий лот");

    feed.emit({ auctionId: AUCTION, finished: true, lineup: [sold] });
    await limiter.settle();
    await flush();
    const last = telegram.edits.at(-1);
    expect(last?.text).toContain("Аукцион завершён");
    expect(last?.final).toBe(true);
    expect(feed.subscribers()).toBe(0);
    expect(store.records.size).toBe(0);
    expect(broadcasts.size()).toBe(0);
  });

  it("stops on request: last edit, no more edits, record removed", async () => {
    const { feed, telegram, limiter, broadcasts, store } = setup();
    await broadcasts.start({ chatId: 7, auctionId: AUCTION, viewer });
    feed.emit(stateOf(lot({ version: 1, price: 1500, next: 1750 })));
    await flush();
    await broadcasts.stop(7);
    expect(telegram.edits).toHaveLength(1);
    expect(telegram.edits[0]).toMatchObject({
      text: "Трансляция остановлена",
      final: true,
    });
    expect(store.records.size).toBe(0);
    feed.emit(stateOf(lot({ version: 2, price: 1750, next: 2000 })));
    await limiter.settle();
    await flush();
    expect(telegram.edits).toHaveLength(1);
    expect(feed.subscribers()).toBe(0);
  });

  it("forgets a message that is gone", async () => {
    let outcome: LiveEditOutcome = { kind: "gone" };
    const { feed, limiter, broadcasts, store } = setup({
      outcome: () => outcome,
    });
    await broadcasts.start({ chatId: 7, auctionId: AUCTION, viewer });
    feed.emit(stateOf(lot({ version: 1, price: 1500, next: 1750 })));
    await flush();
    feed.emit(stateOf(lot({ version: 2, price: 1750, next: 2000 })));
    await limiter.settle();
    await flush();
    outcome = { kind: "done" };
    expect(broadcasts.size()).toBe(0);
    expect(store.records.size).toBe(0);
    expect(feed.subscribers()).toBe(0);
  });

  it("continues with an edit of the same message after a restart", async () => {
    const seed: BroadcastTarget = {
      chatId: 7,
      messageId: 321,
      auctionId: AUCTION,
      viewer,
    };
    const { feed, telegram, limiter, broadcasts } = setup({ seed });
    expect(await broadcasts.restore()).toBe(1);
    feed.emit(stateOf(lot({ version: 9, price: 3000, next: 3250 })));
    await limiter.settle();
    await flush();
    // Нового сообщения нет: правится то, что было до рестарта.
    expect(telegram.sent).toHaveLength(0);
    expect(telegram.edits).toHaveLength(1);
    expect(telegram.edits[0]?.target.messageId).toBe(321);
    expect(telegram.edits[0]?.text).toContain("<b>3 250 ₽</b>");
  });

  it("does not let a restored record override a press of the new process", async () => {
    const seed: BroadcastTarget = {
      chatId: 7,
      messageId: 321,
      auctionId: AUCTION,
      viewer,
    };
    const { feed, telegram, broadcasts } = setup({ seed });
    await broadcasts.start({ chatId: 7, auctionId: AUCTION, viewer });
    await broadcasts.restore();
    feed.emit(stateOf(lot({ version: 1, price: 1500, next: 1750 })));
    await flush();
    expect(telegram.sent).toHaveLength(1);
    expect(feed.subscribers()).toBe(1);
  });

  it("forgets a person who blocked the bot at the first message", async () => {
    const feed = fakeWatches();
    const limiter = immediateLimiter();
    const broadcasts = createLiveBroadcasts({
      watches: feed.watches,
      limiter: limiter.limiter,
      names: { getDisplayNames: async () => ({}) },
      api: {
        send: async () => undefined,
        edit: async () => ({ kind: "done" }),
      },
      timeZone: "UTC",
    });
    await broadcasts.start({ chatId: 7, auctionId: AUCTION, viewer });
    feed.emit(stateOf(lot({ version: 1, price: 1500, next: 1750 })));
    await flush();
    expect(broadcasts.size()).toBe(0);
    expect(feed.subscribers()).toBe(0);
  });

  // Поток закрывается сразу после последнего состояния финала: правка с
  // концом финала не должна пропасть вместе с подпиской.
  it("still delivers the end of the auction when the stream closes right after it", async () => {
    const { feed, telegram, limiter, store, broadcasts } = setup();
    await broadcasts.start({ chatId: 7, auctionId: AUCTION, viewer });
    const trading = lot({ version: 1, price: 1500, next: 1750 });
    feed.emit(stateOf(trading));
    await flush();
    feed.emit(stateOf(trading, true));
    feed.end();
    await limiter.settle();
    await flush();
    expect(telegram.edits.at(-1)).toMatchObject({
      text: expect.stringContaining("Аукцион завершён"),
      final: true,
    });
    expect(store.records.size).toBe(0);
    expect(broadcasts.size()).toBe(0);
  });

  it("closes the message when the stream ends without the end of the final", async () => {
    const { feed, telegram, store, broadcasts } = setup();
    await broadcasts.start({ chatId: 7, auctionId: AUCTION, viewer });
    feed.emit(stateOf(lot({ version: 1, price: 1500, next: 1750 })));
    await flush();
    feed.end();
    await flush();
    expect(telegram.edits.at(-1)).toMatchObject({
      text: "Трансляция остановлена",
      final: true,
    });
    expect(store.records.size).toBe(0);
  });

  it("sends nothing when the final is over before the first message", async () => {
    const { feed, telegram, broadcasts } = setup();
    await broadcasts.start({ chatId: 7, auctionId: AUCTION, viewer });
    feed.emit(stateOf(undefined, true));
    await flush();
    expect(telegram.sent).toHaveLength(0);
    expect(broadcasts.size()).toBe(0);
  });

  it("opens one broadcast for two presses in a row", async () => {
    const { feed, telegram, broadcasts } = setup();
    await Promise.all([
      broadcasts.start({ chatId: 7, auctionId: AUCTION, viewer }),
      broadcasts.start({ chatId: 7, auctionId: AUCTION, viewer }),
    ]);
    feed.emit(stateOf(lot({ version: 1, price: 1500, next: 1750 })));
    await flush();
    expect(telegram.sent).toHaveLength(1);
    expect(feed.subscribers()).toBe(1);
  });

  it("closes a message that was still on its way when the broadcast was stopped", async () => {
    const feed = fakeWatches();
    const limiter = immediateLimiter();
    const edits: { messageId: number; text: string }[] = [];
    let release: (id: number) => void = () => {};
    const broadcasts = createLiveBroadcasts({
      watches: feed.watches,
      limiter: limiter.limiter,
      names: { getDisplayNames: async () => ({}) },
      api: {
        send: () => new Promise<number>((resolve) => (release = resolve)),
        edit: async (target, input) => {
          edits.push({ messageId: target.messageId, text: input.text });
          return { kind: "done" };
        },
      },
      timeZone: "UTC",
    });
    await broadcasts.start({ chatId: 7, auctionId: AUCTION, viewer });
    feed.emit(stateOf(lot({ version: 1, price: 1500, next: 1750 })));
    await flush();
    await broadcasts.stop(7);
    release(900);
    await flush();
    expect(edits).toEqual([{ messageId: 900, text: "Трансляция остановлена" }]);
  });

  describe("stop under a message the registry does not lead", () => {
    it("closes an old message and leaves the live broadcast alone", async () => {
      const { feed, telegram, broadcasts } = setup();
      await broadcasts.start({ chatId: 7, auctionId: AUCTION, viewer });
      feed.emit(stateOf(lot({ version: 1, price: 1500, next: 1750 })));
      await flush();
      await broadcasts.stop(7, 12);
      expect(telegram.edits).toHaveLength(1);
      expect(telegram.edits[0]).toMatchObject({
        target: { messageId: 12 },
        text: "Трансляция остановлена",
      });
      expect(broadcasts.size()).toBe(1);
    });

    it("stops a message of a previous process and keeps restore from reviving it", async () => {
      const seed: BroadcastTarget = {
        chatId: 7,
        messageId: 321,
        auctionId: AUCTION,
        viewer,
      };
      const { telegram, store, broadcasts } = setup({ seed });
      // Нажали раньше, чем восстановление прочитало запись.
      await broadcasts.stop(7, 321);
      expect(telegram.edits[0]).toMatchObject({
        target: { messageId: 321 },
        text: "Трансляция остановлена",
      });
      expect(store.records.size).toBe(0);
      expect(await broadcasts.restore()).toBe(0);
      expect(broadcasts.size()).toBe(0);
    });
  });
});
