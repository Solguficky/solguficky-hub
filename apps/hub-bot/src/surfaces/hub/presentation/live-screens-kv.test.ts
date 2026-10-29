import { describe, expect, it, vi } from "vitest";
import { createMemoryKv } from "../../../../testkit/support.js";
import type { LiveScreenTarget } from "./live-screens.js";
import {
  createLiveScreenKvStore,
  type LiveScreensKv,
  liveScreensBucket,
} from "./live-screens-kv.js";

const target: LiveScreenTarget = {
  chatId: -1001234,
  messageId: 9,
  auctionId: "0192f0aa-0000-7000-8000-000000000001",
  person: { identityId: "id-1", rights: ["run-auctions"] },
  params: { page: 1, sort: { metric: "bids", direction: "descending" } },
};

// KV в памяти умеет get, put и delete; список ключей добавляет тест.
function withKeys(kv: ReturnType<typeof createMemoryKv>): LiveScreensKv {
  return {
    ...kv,
    keys: async (filter?: string | string[]) => {
      const prefix = String(filter).replace(/>$/, "");
      const found = [...kv.values.keys()].filter((key) =>
        key.startsWith(prefix),
      );
      return (async function* () {
        yield* found;
      })();
    },
  } as unknown as LiveScreensKv;
}

describe("live screen record store", () => {
  it("names the bucket after the service", () => {
    expect(liveScreensBucket("hub-bot")).toBe("hub-bot-live-screens");
  });

  it("saves one record per chat and reads it back", async () => {
    const kv = createMemoryKv();
    const store = createLiveScreenKvStore({
      kv: withKeys(kv),
      kind: "console",
      onError: () => {},
    });
    await store.save(target);
    await store.save({ ...target, messageId: 10 });

    expect([...kv.values.keys()]).toEqual(["console.-1001234"]);
    await expect(store.list()).resolves.toEqual([{ ...target, messageId: 10 }]);
  });

  it("keeps the kinds apart", async () => {
    const kv = createMemoryKv();
    const keyed = withKeys(kv);
    const console = createLiveScreenKvStore({
      kv: keyed,
      kind: "console",
      onError: () => {},
    });
    const floor = createLiveScreenKvStore({
      kv: keyed,
      kind: "floor",
      onError: () => {},
    });
    await console.save(target);
    await floor.save({ ...target, params: { page: 0 } });

    await expect(console.list()).resolves.toHaveLength(1);
    await expect(floor.list()).resolves.toEqual([
      { ...target, params: { page: 0 } },
    ]);
  });

  it("removes the record", async () => {
    const kv = createMemoryKv();
    const store = createLiveScreenKvStore({
      kv: withKeys(kv),
      kind: "console",
      onError: () => {},
    });
    await store.save(target);
    await store.remove(target.chatId);

    await expect(store.list()).resolves.toEqual([]);
  });

  it("treats a record of another shape as absent", async () => {
    const kv = createMemoryKv();
    await kv.put("console.1", "not json");
    await kv.put("console.2", JSON.stringify({ chatId: 2 }));
    await kv.put("console.3", JSON.stringify({ ...target, chatId: 4 }));
    const store = createLiveScreenKvStore({
      kv: withKeys(kv),
      kind: "console",
      onError: () => {},
    });

    await expect(store.list()).resolves.toEqual([]);
  });

  it("does not throw when the bucket is unavailable", async () => {
    const onError = vi.fn();
    const kv = createMemoryKv(() => true);
    const store = createLiveScreenKvStore({
      kv: withKeys(kv),
      kind: "console",
      onError,
    });

    await expect(store.save(target)).resolves.toBeUndefined();
    await expect(store.remove(1)).resolves.toBeUndefined();
    expect(onError.mock.calls.map(([operation]) => operation)).toEqual([
      "save",
      "remove",
    ]);
  });
});
