import type { KV } from "@nats-io/kv";
import { describe, expect, it } from "vitest";
import { createCapturingLogger } from "../../../../testkit/harness.js";
import {
  announcementPostsBucket,
  createAnnouncementPostRegistry,
} from "./announcement-posts-kv.js";

// Постоянный реестр постов анонсов (PER-926): запись создаётся один раз и не
// перезаписывается повтором, а недоступность шины не превращается в происхождение.

function fakeKv(options: { failPut?: boolean } = {}) {
  const values = new Map<string, string>();
  const kv = {
    async get(key: string) {
      const raw = values.get(key);
      return raw === undefined ? null : { operation: "PUT", string: () => raw };
    },
    async put(key: string, value: string, opts?: { previousSeq?: number }) {
      if (options.failPut === true) throw new Error("kv unavailable");
      if (opts?.previousSeq === 0 && values.has(key)) {
        throw new Error("wrong sequence");
      }
      values.set(key, value);
      return 1;
    },
    async delete(key: string) {
      values.delete(key);
    },
    async keys() {
      return values.keys();
    },
  };
  return kv as unknown as KV;
}

const record = {
  chatId: -1001234567890,
  messageId: 28,
  meetupId: "0192f3a4-b5c6-7d8e-9f0a-1b2c3d4e5f60",
  signature: "Анна",
  keyboard: {
    text: "Открыть сходку ↗",
    url: "https://t.me/test_bot?start=m_x",
  },
};

function registry(kv: KV) {
  return createAnnouncementPostRegistry({
    url: "nats://unused",
    service: "hub-bot",
    logger: createCapturingLogger().logger,
    kv,
  });
}

describe("announcement post registry", () => {
  it("uses a dedicated bucket named after the service", () => {
    expect(announcementPostsBucket("hub-bot")).toBe(
      "hub-bot-announcement-posts",
    );
  });

  it("stores provenance once and never overwrites it on retry", async () => {
    const store = registry(fakeKv());
    expect(await store.remember(record)).toEqual({ kind: "stored" });
    expect(
      await store.remember({
        ...record,
        signature: "Борис",
        keyboard: { text: "Другая", url: "https://t.me/other" },
      }),
    ).toEqual({ kind: "exists" });
    expect(await store.read(record.chatId, record.messageId)).toEqual({
      kind: "found",
      record,
    });
  });

  it("reads a missing or corrupt entry as missing", async () => {
    const kv = fakeKv();
    const store = registry(kv);
    expect(await store.read(-1, 2)).toEqual({ kind: "missing" });
    await kv.put(`${record.chatId}:${record.messageId}`, "not json");
    expect(await store.read(record.chatId, record.messageId)).toEqual({
      kind: "missing",
    });
  });

  it("reports a failed write as unavailable without creating provenance", async () => {
    const kv = fakeKv({ failPut: true });
    const store = registry(kv);
    const written = await store.remember(record);
    expect(written.kind).toBe("unavailable");
    expect(await store.read(record.chatId, record.messageId)).toEqual({
      kind: "missing",
    });
  });
});
