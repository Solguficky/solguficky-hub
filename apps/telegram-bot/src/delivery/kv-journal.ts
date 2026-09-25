import type { KV } from "@nats-io/kv";
import { z } from "zod";
import type { DeliveryJournal, DeliveryRecord } from "./port.js";

// Bucket объявляет платформа рядом с durable (ADR-050, ADR-052), бот к нему
// только привязывается: создай его бот сам, настройки хранения разошлись бы с
// таблицей топологии молча.
export const deliveryJournalBucket = "telegram-bot-deliveries";

const RecordSchema = z.object({
  state: z.enum(["delivered", "dropped", "retrying"]),
  attempts: z.number().int().nonnegative(),
  reason: z.string().optional(),
  at: z.string(),
});

export type JournalStore = Pick<KV, "get" | "put">;

export function createKvJournal(store: JournalStore): DeliveryJournal {
  return {
    async read(notificationId) {
      try {
        const entry = await store.get(notificationId);
        if (entry === null || entry.operation !== "PUT") {
          return { kind: "ok", record: undefined };
        }
        // Запись пишет только этот компонент, но bucket — общее хранилище, а
        // прочитанное оттуда — ввод. Нечитаемая запись не должна подавлять
        // доставку: она считается отсутствующей, и худший исход — дубль.
        const parsed = RecordSchema.safeParse(safeJson(entry.string()));
        return {
          kind: "ok",
          record: parsed.success ? toRecord(parsed.data) : undefined,
        };
      } catch (cause) {
        return { kind: "unavailable", cause };
      }
    },
    async write(notificationId, record) {
      try {
        await store.put(notificationId, JSON.stringify(record));
        return { kind: "ok" };
      } catch (cause) {
        return { kind: "unavailable", cause };
      }
    },
  };
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function toRecord(value: z.infer<typeof RecordSchema>): DeliveryRecord {
  const record: DeliveryRecord = {
    state: value.state,
    attempts: value.attempts,
    at: value.at,
  };
  if (value.reason !== undefined) record.reason = value.reason;
  return record;
}
