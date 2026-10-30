import { z } from "zod";
import type { Viewer } from "../../auction-ui/index.js";
import type { Logger } from "../logging.js";
import type { BroadcastStore, BroadcastTarget } from "./broadcast.js";
import { reportLiveStoreFailure } from "./live-failures.js";
import type { LiveKvLink, LiveScreensKv } from "./live-kv-link.js";

// Запись открытых трансляций хода торгов в JetStream KV (PER-826): по одной на
// чат, ключ `broadcast.<чат>` в том же bucket'е, что пульт и «Ставки зала»
// хаба (PER-815). Срок записи — двое суток от последней записи ключа, как у
// них: трансляция живёт час финала. Права в записи не источник допуска:
// Auction проверяет их при каждой подписке на поток.

const KIND = "broadcast";

const RecordSchema = z.object({
  chatId: z.number().int(),
  messageId: z.number().int(),
  auctionId: z.string().min(1),
  viewer: z.object({
    identityId: z.string().min(1),
    rights: z.array(z.string()),
  }),
});

const keyOf = (chatId: number) => `${KIND}.${chatId}`;

function parse(raw: string): BroadcastTarget | undefined {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const parsed = RecordSchema.safeParse(json);
  if (!parsed.success) return undefined;
  return {
    ...parsed.data,
    viewer: {
      ...parsed.data.viewer,
      rights: parsed.data.viewer.rights as Viewer["rights"],
    },
  };
}

/**
 * Хранилище трансляций. Методы не бросают: bucket — общее хранилище и может
 * быть недоступен, а трансляция тогда живёт, как без него, и отказ уходит в
 * лог. Нечитаемая запись считается отсутствующей и из списка выпадает.
 */
export function createBroadcastKvStore(options: {
  kv: LiveScreensKv;
  onError: (operation: "save" | "remove" | "list", cause: unknown) => void;
}): BroadcastStore {
  const { kv, onError } = options;
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
        const targets: BroadcastTarget[] = [];
        for await (const key of await kv.keys(`${KIND}.>`)) {
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

/** Хранилище поверх ленивого соединения: нет bucket'а — записей нет. */
export function createBroadcastStore(
  link: LiveKvLink,
  logger: Logger,
): BroadcastStore {
  const lazy = async <T>(
    use: (store: BroadcastStore) => Promise<T>,
    fallback: T,
  ): Promise<T> => {
    const kv = await link.kv();
    if (kv === undefined) return fallback;
    return use(
      createBroadcastKvStore({
        kv,
        onError: (operation, cause) =>
          reportLiveStoreFailure(logger, operation, cause),
      }),
    );
  };
  return {
    save: (target) => lazy((each) => each.save(target), undefined),
    remove: (chatId) => lazy((each) => each.remove(chatId), undefined),
    list: () => lazy((each) => each.list(), []),
  };
}
