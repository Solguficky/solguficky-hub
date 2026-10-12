import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";
import { WithdrawnReason } from "../../../gen/auction/v1/auction_pb.js";
import {
  AuctionWatchSchema,
  LotSnapshotSchema,
} from "../../../gen/auction/v1/auction_service_pb.js";
import type { Viewer } from "../../auction-ui/index.js";
import {
  type AuctionWatchSource,
  type AuctionWatchState,
  createAuctionWatches,
  watchStateOf,
} from "./watch.js";

const AUCTION_ID = "01929b7e-5c1d-7a3f-8e4b-0000000000a1";
const ALICE: Viewer = { identityId: "alice", rights: ["place-bids"] };
const BOB: Viewer = { identityId: "bob", rights: ["place-bids"] };

const state = (finished = false): AuctionWatchState => ({
  auctionId: AUCTION_ID,
  finished,
  lineup: [],
});

// Поток, который ведёт тест: каждое открытие — свой канал, в который тест
// кладёт состояния, обрыв или конец.
function scriptedSource() {
  const opened: {
    viewer: Viewer;
    push(state: AuctionWatchState): void;
    fail(cause: Error): void;
    signal: AbortSignal;
  }[] = [];
  const source: AuctionWatchSource = (request, signal) => ({
    [Symbol.asyncIterator]() {
      const queue: (AuctionWatchState | Error)[] = [];
      let wake: (() => void) | undefined;
      const poke = () => {
        wake?.();
        wake = undefined;
      };
      opened.push({
        viewer: request.viewer,
        push: (s) => {
          queue.push(s);
          poke();
        },
        fail: (cause) => {
          queue.push(cause);
          poke();
        },
        signal,
      });
      signal.addEventListener("abort", poke);
      return {
        async next(): Promise<IteratorResult<AuctionWatchState>> {
          for (;;) {
            if (signal.aborted) return { done: true, value: undefined };
            const head = queue.shift();
            if (head instanceof Error) throw head;
            if (head !== undefined) return { done: false, value: head };
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
        },
      };
    },
  });
  return { source, opened };
}

const flush = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

describe("auction watches", () => {
  it("opens one stream per auction for every subscriber", async () => {
    const { source, opened } = scriptedSource();
    const watches = createAuctionWatches({ source, sleep: async () => {} });
    const seen: string[] = [];
    watches.subscribe(AUCTION_ID, ALICE, () => seen.push("alice"));
    watches.subscribe(AUCTION_ID, BOB, () => seen.push("bob"));
    await flush();
    expect(opened).toHaveLength(1);
    opened[0]?.push(state());
    await flush();
    expect(seen).toEqual(["alice", "bob"]);
    expect(watches.open()).toBe(1);
  });

  it("closes the stream when the last subscriber leaves", async () => {
    const { source, opened } = scriptedSource();
    const watches = createAuctionWatches({ source, sleep: async () => {} });
    const leaveAlice = watches.subscribe(AUCTION_ID, ALICE, () => {});
    const leaveBob = watches.subscribe(AUCTION_ID, BOB, () => {});
    await flush();
    leaveAlice();
    expect(opened[0]?.signal.aborted).toBe(false);
    leaveBob();
    expect(opened[0]?.signal.aborted).toBe(true);
    expect(watches.open()).toBe(0);
  });

  // Отказ потока может быть отказом прав смотрящего: следующая попытка идёт
  // правами другого подписчика, а не того же.
  it("reconnects after a failure with another subscriber's rights", async () => {
    const { source, opened } = scriptedSource();
    const errors: unknown[] = [];
    const watches = createAuctionWatches({
      source,
      sleep: async () => {},
      onError: (_id, cause) => errors.push(cause),
    });
    const seen: AuctionWatchState[] = [];
    watches.subscribe(AUCTION_ID, ALICE, (s) => seen.push(s));
    watches.subscribe(AUCTION_ID, BOB, () => {});
    await flush();
    opened[0]?.fail(new Error("permission denied"));
    await flush();
    expect(errors).toHaveLength(1);
    expect(opened.map((o) => o.viewer.identityId)).toEqual(["alice", "bob"]);
    // Первое сообщение нового потока — состояние целиком.
    opened[1]?.push(state());
    await flush();
    expect(seen).toHaveLength(1);
  });

  it("ends the subscription when the auction is finished", async () => {
    const { source, opened } = scriptedSource();
    const watches = createAuctionWatches({ source, sleep: async () => {} });
    const seen: boolean[] = [];
    watches.subscribe(AUCTION_ID, ALICE, (s) => seen.push(s.finished));
    await flush();
    opened[0]?.push(state(true));
    await flush();
    expect(seen).toEqual([true]);
    expect(opened).toHaveLength(1);
    expect(watches.open()).toBe(0);
  });

  it("keeps the stream when a listener throws", async () => {
    const { source, opened } = scriptedSource();
    const errors: unknown[] = [];
    const watches = createAuctionWatches({
      source,
      sleep: async () => {},
      onError: (_id, cause) => errors.push(cause),
    });
    const seen: number[] = [];
    watches.subscribe(AUCTION_ID, ALICE, () => {
      throw new Error("listener");
    });
    watches.subscribe(AUCTION_ID, BOB, () => seen.push(1));
    await flush();
    opened[0]?.push(state());
    opened[0]?.push(state());
    await flush();
    expect(seen).toEqual([1, 1]);
    expect(errors).toHaveLength(2);
  });
});

describe("auction watches on joining and on refusals", () => {
  // Изменение между чтением карточки и подпиской не проходит мимо: новый
  // подписчик открытого потока получает последнее состояние.
  it("hands the last state to a subscriber that joins an open stream", async () => {
    const { source, opened } = scriptedSource();
    const watches = createAuctionWatches({ source, sleep: async () => {} });
    watches.subscribe(AUCTION_ID, ALICE, () => {});
    await flush();
    opened[0]?.push(state());
    await flush();
    const seen: AuctionWatchState[] = [];
    watches.subscribe(AUCTION_ID, BOB, (s) => seen.push(s));
    await flush();
    expect(seen).toHaveLength(1);
    expect(opened).toHaveLength(1);
  });

  // Права отказали у всех подписчиков подряд: повторять нечем, и поток
  // закрывается, а не переподключается без конца.
  it("ends the stream when the rights of every subscriber are refused", async () => {
    const { source, opened } = scriptedSource();
    const watches = createAuctionWatches({ source, sleep: async () => {} });
    const ended: string[] = [];
    watches.subscribe(
      AUCTION_ID,
      ALICE,
      () => {},
      () => ended.push("alice"),
    );
    watches.subscribe(
      AUCTION_ID,
      BOB,
      () => {},
      () => ended.push("bob"),
    );
    await flush();
    const denied = () => new ConnectError("no rights", Code.PermissionDenied);
    opened[0]?.fail(denied());
    await flush();
    opened[1]?.fail(denied());
    await flush();
    expect(ended).toEqual(["alice", "bob"]);
    expect(watches.open()).toBe(0);
    expect(opened).toHaveLength(2);
  });

  it("keeps reconnecting while the neighbour is only unavailable", async () => {
    const { source, opened } = scriptedSource();
    const watches = createAuctionWatches({ source, sleep: async () => {} });
    watches.subscribe(AUCTION_ID, ALICE, () => {});
    await flush();
    for (let i = 0; i < 3; i += 1) {
      opened[i]?.fail(new ConnectError("down", Code.Unavailable));
      await flush();
    }
    expect(opened).toHaveLength(4);
    expect(watches.open()).toBe(1);
  });
});

describe("watch state of an AuctionWatch message", () => {
  it("reads finished, the active lot and the lineup", () => {
    const lot = create(LotSnapshotSchema, {
      id: "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b3c",
      auctionId: AUCTION_ID,
      version: 5n,
      status: {
        case: "withdrawn",
        value: WithdrawnReason.BY_ORGANIZER,
      },
    });
    const parsed = watchStateOf(
      create(AuctionWatchSchema, {
        auction: {
          id: AUCTION_ID,
          status: { case: "finished", value: {} },
        },
        activeLot: lot,
        lineup: [lot],
      }),
    );
    expect(parsed.finished).toBe(true);
    expect(parsed.activeLot?.version).toBe(5);
    expect(parsed.lineup).toHaveLength(1);
  });

  it("refuses a message without an auction", () => {
    expect(() => watchStateOf(create(AuctionWatchSchema, {}))).toThrow(
      "auction watch message without an auction",
    );
  });
});
