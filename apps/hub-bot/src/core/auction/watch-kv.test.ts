import { describe, expect, it, vi } from "vitest";
import type { WatchTarget } from "./live-cards.js";
import type { LiveScreensKv } from "./live-kv-link.js";
import { createWatchKvStore } from "./watch-kv.js";

// KV в памяти: ядро не знает test kit поверхностей, поэтому своя фикстура.
type MemoryKv = {
  values: Map<string, string>;
  get: (key: string) => Promise<{
    operation: "PUT" | "DEL";
    string: () => string;
  } | null>;
  put: (key: string, data: unknown) => Promise<number>;
  delete: (key: string) => Promise<void>;
};

function createMemoryKv(fail: () => boolean = () => false): MemoryKv {
  const values = new Map<string, string>();
  return {
    values,
    get: async (key) => {
      if (fail()) throw new Error("kv unavailable");
      const value = values.get(key);
      return value === undefined
        ? null
        : { operation: "PUT", string: () => value };
    },
    put: async (key, data) => {
      if (fail()) throw new Error("kv unavailable");
      values.set(key, String(data));
      return values.size;
    },
    delete: async (key) => {
      if (fail()) throw new Error("kv unavailable");
      values.delete(key);
    },
  };
}

const target: WatchTarget = {
  chatId: 4242,
  messageId: 9,
  auctionId: "0192f0aa-0000-7000-8000-000000000001",
  lotId: "0192f0aa-0000-7000-8000-000000000002",
  page: 2,
  viewer: { identityId: "id-1", rights: ["place-bids"] },
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

describe("watch record store", () => {
  it("keeps one record per chat under its own key", async () => {
    const kv = createMemoryKv();
    const store = createWatchKvStore({
      kv: withKeys(kv),
      onError: () => {},
    });
    await store.save(target);
    await store.save({ ...target, messageId: 10 });

    expect([...kv.values.keys()]).toEqual(["watch.4242"]);
    await expect(store.list()).resolves.toEqual([{ ...target, messageId: 10 }]);
  });

  it("does not pick up the records of the console and the floor", async () => {
    const kv = createMemoryKv();
    await kv.put("console.4242", JSON.stringify({ ...target, person: {} }));
    const store = createWatchKvStore({
      kv: withKeys(kv),
      onError: () => {},
    });
    await store.save(target);

    await expect(store.list()).resolves.toEqual([target]);
  });

  it("removes the record", async () => {
    const kv = createMemoryKv();
    const store = createWatchKvStore({
      kv: withKeys(kv),
      onError: () => {},
    });
    await store.save(target);
    await store.remove(target.chatId);

    await expect(store.list()).resolves.toEqual([]);
  });

  it("treats a record of another shape or under another key as absent", async () => {
    const kv = createMemoryKv();
    await kv.put("watch.1", "not json");
    await kv.put("watch.2", JSON.stringify({ chatId: 2 }));
    await kv.put("watch.3", JSON.stringify({ ...target, chatId: 4 }));
    const store = createWatchKvStore({
      kv: withKeys(kv),
      onError: () => {},
    });

    await expect(store.list()).resolves.toEqual([]);
  });

  it("does not throw when the bucket is unavailable", async () => {
    const onError = vi.fn();
    const store = createWatchKvStore({
      kv: withKeys(createMemoryKv(() => true)),
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
