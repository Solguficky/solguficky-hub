import type { KV } from "@nats-io/kv";
import { z } from "zod";
import type { Person } from "../application/types.js";
import type { LiveScreenStore, LiveScreenTarget } from "./live-screens.js";

// Запись открытых живых экранов в JetStream KV (PER-815, дополнение ADR-030 от
// 2026-10-29): по одной записи на чат и вид экрана, ключ `<вид>.<чат>`. Bucket
// объявляет таблица топологии AppHost (ADR-050), срок записи — двое суток от
// последней записи ключа: экран живёт час финала, а запись старого пульта не
// должна копиться.

export const liveScreensBucket = (service: string): string =>
  `${service}-live-screens`;

export type LiveScreensKv = Pick<KV, "get" | "put" | "delete" | "keys">;

// Права в записи — не источник допуска: Auction проверяет их при каждом чтении
// и подписке, а незнакомое право адаптер дерева отбрасывает.
const RecordSchema = z.object({
  chatId: z.number().int(),
  messageId: z.number().int(),
  auctionId: z.string().min(1),
  person: z.object({
    identityId: z.string().min(1),
    rights: z.array(z.string()),
  }),
  params: z.object({
    page: z.number().int().nonnegative(),
    sort: z
      .object({
        metric: z.enum(["bids", "participants", "growth"]),
        direction: z.enum(["ascending", "descending"]),
      })
      .optional(),
    media: z.boolean().optional(),
  }),
});

function parse(raw: string): LiveScreenTarget | undefined {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const parsed = RecordSchema.safeParse(json);
  if (!parsed.success) return undefined;
  const { person, params, ...rest } = parsed.data;
  return {
    ...rest,
    person: { ...person, rights: person.rights as Person["rights"] },
    params: {
      page: params.page,
      ...(params.sort === undefined ? {} : { sort: params.sort }),
      ...(params.media === true ? { media: true } : {}),
    },
  };
}

/**
 * Хранилище одного вида экрана. Методы не бросают: bucket — общее хранилище и
 * может быть недоступен, а экран тогда живёт, как без него, и отказ уходит в
 * `onError`. Нечитаемая запись считается отсутствующей и из списка выпадает.
 */
export function createLiveScreenKvStore(options: {
  kv: LiveScreensKv;
  kind: string;
  onError: (operation: "save" | "remove" | "list", cause: unknown) => void;
}): LiveScreenStore {
  const { kv, kind, onError } = options;
  const keyOf = (chatId: number) => `${kind}.${chatId}`;
  return {
    async save(target) {
      try {
        await kv.put(keyOf(target.chatId), JSON.stringify(target));
      } catch (cause) {
        onError("save", cause);
      }
    },
    async remove(chatId) {
      try {
        await kv.delete(keyOf(chatId));
      } catch (cause) {
        onError("remove", cause);
      }
    },
    async list() {
      try {
        const targets: LiveScreenTarget[] = [];
        for await (const key of await kv.keys(`${kind}.>`)) {
          const entry = await kv.get(key);
          if (entry === null || entry.operation !== "PUT") continue;
          const target = parse(entry.string());
          if (target !== undefined && keyOf(target.chatId) === key) {
            targets.push(target);
          }
        }
        return targets;
      } catch (cause) {
        onError("list", cause);
        return [];
      }
    },
  };
}
