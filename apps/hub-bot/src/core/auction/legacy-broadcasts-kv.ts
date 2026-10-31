import { z } from "zod";
import type { Logger } from "../logging.js";
import { reportLiveStoreFailure } from "./live-failures.js";
import type { LiveKvLink } from "./live-kv-link.js";

// Записи отдельных сообщений трансляции хода торгов (PER-826), которых больше
// нет: слежение живёт в самой карточке лота (PER-837, ключ `watch.<чат>`).
// Бот читает записи прежней выкладки один раз после старта, правит их
// сообщения и снимает записи; писать сюда он не умеет.

const KIND = "broadcast";

const RecordSchema = z.object({
  chatId: z.number().int(),
  messageId: z.number().int(),
});

export type LegacyBroadcast = z.infer<typeof RecordSchema>;

export type LegacyBroadcastStore = {
  list(): Promise<readonly LegacyBroadcast[]>;
  remove(chatId: number): Promise<void>;
};

const keyOf = (chatId: number) => `${KIND}.${chatId}`;

/** Хранилище поверх ленивого соединения: нет bucket'а — записей нет. Методы не бросают. */
export function createLegacyBroadcastStore(
  link: LiveKvLink,
  logger: Logger,
): LegacyBroadcastStore {
  return {
    async list() {
      const kv = await link.kv();
      if (kv === undefined) return [];
      try {
        const found: LegacyBroadcast[] = [];
        for await (const key of await kv.keys(`${KIND}.>`)) {
          const entry = await kv.get(key);
          if (entry === null || entry.operation !== "PUT") continue;
          let json: unknown;
          try {
            json = JSON.parse(entry.string());
          } catch {
            continue;
          }
          const parsed = RecordSchema.safeParse(json);
          if (parsed.success && keyOf(parsed.data.chatId) === key) {
            found.push(parsed.data);
          }
        }
        return found;
      } catch (cause) {
        reportLiveStoreFailure(logger, "list", cause);
        return [];
      }
    },
    async remove(chatId) {
      const kv = await link.kv();
      if (kv === undefined) return;
      try {
        await kv.delete(keyOf(chatId));
      } catch (cause) {
        reportLiveStoreFailure(logger, "remove", cause);
      }
    },
  };
}
