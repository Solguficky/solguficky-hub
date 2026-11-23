import type { KV } from "@nats-io/kv";
import { validateKey } from "@nats-io/kv/internal";
import { describe, expect, it } from "vitest";
import { createCapturingLogger } from "../../../../testkit/harness.js";
import {
  announcementPostKey,
  announcementPostsBucket,
  createAnnouncementPostRegistry,
} from "./announcement-posts-kv.js";

// Постоянный реестр постов анонсов (PER-926): запись создаётся один раз и не
// перезаписывается повтором, а недоступность шины не превращается в происхождение.

function fakeKv(options: { failPut?: boolean } = {}) {
  const values = new Map<string, { value: string; revision: number }>();
  let revision = 0;
  const kv = {
    async get(key: string) {
      const entry = values.get(key);
      return entry === undefined
        ? null
        : {
            operation: "PUT",
            revision: entry.revision,
            string: () => entry.value,
          };
    },
    async put(key: string, value: string, opts?: { previousSeq?: number }) {
      if (options.failPut === true) throw new Error("kv unavailable");
      if (opts?.previousSeq !== undefined && opts.previousSeq !== revision) {
        throw new Error("wrong sequence");
      }
      revision += 1;
      values.set(key, { value, revision });
      return revision;
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

  it("writes keys accepted by the real KV client", () => {
    // Ключ с двоеточием отклоняется validateKey ещё до обращения к серверу.
    expect(() =>
      validateKey(announcementPostKey(record.chatId, record.messageId)),
    ).not.toThrow();
    expect(() => validateKey(`${record.chatId}:${record.messageId}`)).toThrow();
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
      seq: 1,
    });
  });

  it("reads a missing or corrupt entry as missing", async () => {
    const kv = fakeKv();
    const store = registry(kv);
    expect(await store.read(-1, 2)).toEqual({ kind: "missing" });
    await kv.put(`${record.chatId}.${record.messageId}`, "not json");
    expect(await store.read(record.chatId, record.messageId)).toEqual({
      kind: "missing",
    });
  });

  it("holds an edit lock across the external call and releases it once", async () => {
    const store = registry(fakeKv());
    expect(await store.remember(record)).toEqual({ kind: "stored" });
    const first = await store.read(record.chatId, record.messageId);
    if (first.kind !== "found") throw new Error("no record");

    const begun = await store.beginEdit(
      first.record,
      first.seq,
      "op-1",
      Date.now() + 60_000,
    );
    expect(begun.ok).toBe(true);
    if (!begun.ok) return;
    // Повторное подтверждение на той же ревизии не получает блок.
    expect(
      await store.beginEdit(
        first.record,
        first.seq,
        "op-2",
        Date.now() + 60_000,
      ),
    ).toEqual({ ok: false });
    const locked = await store.read(record.chatId, record.messageId);
    expect(locked.kind === "found" && locked.record.editing?.token).toBe(
      "op-1",
    );

    await store.finishEdit(first.record, begun.seq, "op-1", "print");
    const released = await store.read(record.chatId, record.messageId);
    expect(
      released.kind === "found" && released.record.editing,
    ).toBeUndefined();
    expect(released.kind === "found" && released.record.lastPrint).toBe(
      "print",
    );
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
