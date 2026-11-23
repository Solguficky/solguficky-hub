import { type KV, Kvm } from "@nats-io/kv";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { z } from "zod";
import { reportLiveStoreFailure } from "../../../core/auction/live-failures.js";
import { natsConnectOptions } from "../../../core/delivery/index.js";
import type { Logger } from "../../../core/logging.js";

// Постоянный реестр постов анонсов (PER-926, решение владельца 2026-11-23):
// запись по (чат, сообщение) хранит исходную сходку, подпись и клавиатуру.
// Bucket объявляет платформа (ADR-050), бот только привязывается к нему. Без
// записи правка недоступна: бот не выводит происхождение из /attach или ручной
// привязки ссылки и не перезаписывает чужую клавиатуру текущей сходкой.

export const announcementPostsBucket = (service: string): string =>
  `${service}-announcement-posts`;

const RecordSchema = z.object({
  chatId: z.number().int(),
  messageId: z.number().int(),
  meetupId: z.string().min(1),
  signature: z.string().min(1),
  keyboard: z.object({
    text: z.string().min(1),
    url: z.string().min(1),
  }),
});

export type AnnouncementPostRecord = z.infer<typeof RecordSchema>;

export type AnnouncementPostEntry =
  | { kind: "found"; record: AnnouncementPostRecord }
  | { kind: "missing" }
  | { kind: "unavailable"; cause: unknown };

export type AnnouncementPostWrite =
  | { kind: "stored" }
  | { kind: "exists" }
  | { kind: "unavailable"; cause: unknown };

export type AnnouncementPostRegistry = {
  /** Только создание: существующая запись не перезаписывается. */
  remember(record: AnnouncementPostRecord): Promise<AnnouncementPostWrite>;
  read(chatId: number, messageId: number): Promise<AnnouncementPostEntry>;
  close(): Promise<void>;
};

// Ключ NATS KV допускает только [-/=.\w] (проверка validateKey в библиотеке):
// двоеточие здесь нельзя, поэтому чат и сообщение разделяются точкой.
export const announcementPostKey = (
  chatId: number,
  messageId: number,
): string => `${chatId}.${messageId}`;
const keyOf = announcementPostKey;

function parse(raw: string, key: string): AnnouncementPostRecord | undefined {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const parsed = RecordSchema.safeParse(json);
  if (!parsed.success) return undefined;
  const keyMatches = keyOf(parsed.data.chatId, parsed.data.messageId) === key;
  return keyMatches ? parsed.data : undefined;
}

export function createAnnouncementPostRegistry(options: {
  url: string;
  service: string;
  logger: Logger;
  /** Тесты подменяют привязку, не поднимая NATS. */
  kv?: KV;
}): AnnouncementPostRegistry {
  const { logger } = options;
  let connection: Promise<{ nats: NatsConnection; kv: KV }> | null = null;
  let closed = false;

  const open = async () => {
    const nats = await connect({
      ...natsConnectOptions(options.url),
      name: announcementPostsBucket(options.service),
      maxReconnectAttempts: -1,
    });
    try {
      const kv = await new Kvm(nats).open(
        announcementPostsBucket(options.service),
      );
      // open только привязывается; без status отсутствие bucket'а всплыло бы
      // на каждой операции, а не одной записью о соединении.
      await kv.status();
      return { nats, kv };
    } catch (cause) {
      await nats.close();
      throw cause;
    }
  };

  const bound = async (): Promise<KV | undefined> => {
    if (closed) return undefined;
    if (options.kv !== undefined) return options.kv;
    connection ??= open();
    try {
      return (await connection).kv;
    } catch (cause) {
      connection = null;
      reportLiveStoreFailure(logger, "connect", cause);
      return undefined;
    }
  };

  return {
    async remember(record) {
      const kv = await bound();
      if (kv === undefined) {
        return { kind: "unavailable", cause: "no_connection" };
      }
      const key = keyOf(record.chatId, record.messageId);
      const value = JSON.stringify(record);
      try {
        const existing = await kv.get(key);
        if (existing !== null && existing.operation !== "DEL") {
          return { kind: "exists" };
        }
        // previousSeq: 0 — создать только отсутствующий ключ: повтор после
        // сбоя или второй пишущий не перезапишут исходное происхождение.
        await kv.put(key, value, { previousSeq: 0 });
        return { kind: "stored" };
      } catch (cause) {
        // Parallelная запись уже успела: происхождение осталось исходным.
        try {
          const after = await kv.get(key);
          if (after !== null && after.operation !== "DEL") {
            return { kind: "exists" };
          }
        } catch {
          // Недоступность второй проверки не меняет вердикт первой.
        }
        reportLiveStoreFailure(logger, "save", cause);
        return { kind: "unavailable", cause };
      }
    },
    async read(chatId, messageId) {
      const kv = await bound();
      if (kv === undefined) {
        return { kind: "unavailable", cause: "no_connection" };
      }
      const key = keyOf(chatId, messageId);
      try {
        const entry = await kv.get(key);
        if (entry === null || entry.operation === "DEL") {
          return { kind: "missing" };
        }
        const record = parse(entry.string(), key);
        return record === undefined
          ? { kind: "missing" }
          : { kind: "found", record };
      } catch (cause) {
        reportLiveStoreFailure(logger, "list", cause);
        return { kind: "unavailable", cause };
      }
    },
    async close() {
      closed = true;
      const pending = connection;
      connection = null;
      if (pending === null) return;
      const opened = await pending.catch(() => undefined);
      if (opened !== undefined && !opened.nats.isClosed()) {
        await opened.nats.drain().catch(() => opened.nats.close());
      }
    },
  };
}
