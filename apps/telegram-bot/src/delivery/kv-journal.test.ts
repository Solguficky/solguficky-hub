import type { KvEntry } from "@nats-io/kv";
import { describe, expect, it } from "vitest";
import { createKvJournal, type JournalStore } from "./kv-journal.js";

function entry(value: string, operation: KvEntry["operation"] = "PUT") {
  return { operation, string: () => value } as unknown as KvEntry;
}

// Хранилище в памяти ровно в той части KV, которую журнал трогает.
function memoryStore(initial: Record<string, KvEntry> = {}): JournalStore {
  const values = new Map(Object.entries(initial));
  return {
    get: async (key: string) => values.get(key) ?? null,
    put: async (key: string, data: unknown) => {
      values.set(key, entry(String(data)));
      return values.size;
    },
  } as JournalStore;
}

describe("kv journal", () => {
  it("reads back what it wrote", async () => {
    const journal = createKvJournal(memoryStore());
    const record = {
      state: "dropped" as const,
      attempts: 2,
      reason: "bot_blocked",
      at: "2026-09-26T10:00:00.000Z",
    };
    await expect(journal.write("n-1", record)).resolves.toEqual({ kind: "ok" });
    await expect(journal.read("n-1")).resolves.toEqual({ kind: "ok", record });
  });

  it("treats a missing or deleted key as no record", async () => {
    const journal = createKvJournal(memoryStore({ deleted: entry("", "DEL") }));
    await expect(journal.read("absent")).resolves.toEqual({
      kind: "ok",
      record: undefined,
    });
    await expect(journal.read("deleted")).resolves.toEqual({
      kind: "ok",
      record: undefined,
    });
  });

  // Нечитаемая запись не подавляет доставку: худший исход — дубль, а не потеря.
  it("treats an unreadable record as absent", async () => {
    const journal = createKvJournal(
      memoryStore({ broken: entry("{not json"), odd: entry('{"state":"x"}') }),
    );
    await expect(journal.read("broken")).resolves.toEqual({
      kind: "ok",
      record: undefined,
    });
    await expect(journal.read("odd")).resolves.toEqual({
      kind: "ok",
      record: undefined,
    });
  });

  it("reports a store failure as unavailable", async () => {
    const failing = {
      get: async () => {
        throw new Error("timeout");
      },
      put: async () => {
        throw new Error("timeout");
      },
    } as unknown as JournalStore;
    const journal = createKvJournal(failing);
    await expect(journal.read("n-1")).resolves.toMatchObject({
      kind: "unavailable",
    });
    await expect(
      journal.write("n-1", { state: "delivered", attempts: 1, at: "t" }),
    ).resolves.toMatchObject({ kind: "unavailable" });
  });
});
