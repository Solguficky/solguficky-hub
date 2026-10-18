import type { KV, KvEntry } from "@nats-io/kv";

// Bucket пар «человек ↔ тема» (ADR-068, п. 8; имя — ADR-044 от имени
// сервиса). Объявляет его таблица топологии AppHost (ADR-050) со сроком
// записи 180 дней и одной версией: бот к нему только привязывается.
export function supportTopicsBucket(service: string): string {
  return `${service}-topics`;
}

export type PairKv = Pick<KV, "get" | "put" | "delete">;

/**
 * Пара в обе стороны, группа — в обоих ключах: после смены группы номера тем
 * начинаются заново, и пара старой группы иначе отдала бы ответ не тому
 * человеку. Пара другой группы поэтому просто не находится.
 */
export type PairStore = {
  threadOf(telegramId: number): Promise<number | undefined>;
  personOf(threadId: number): Promise<number | undefined>;
  /**
   * Пишет пару и переписывает её на каждом сообщении человека и доставленном
   * ответе: срок записи bucket'а отсчитывается от последней записи ключа.
   * Порядок «тема → человек», потом «человек → тема»: сбой между ними даёт
   * человеку лишнюю тему, но не теряет ответ оператора.
   */
  bind(telegramId: number, threadId: number): Promise<void>;
  /** Тема не найдена в Telegram: пара снимается, сначала со стороны человека. */
  unbind(telegramId: number, threadId: number): Promise<void>;
};

const numeric = /^\d+$/;

// Bucket — общее хранилище, и прочитанное оттуда — ввод: запись не той формы
// считается отсутствующей и переписывается следующей парой.
function idOf(entry: KvEntry | null): number | undefined {
  if (entry === null || entry.operation !== "PUT") return undefined;
  const raw = entry.string();
  if (!numeric.test(raw)) return undefined;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

export function createPairStore(kv: PairKv, groupId: number): PairStore {
  const personKey = (telegramId: number) => `person.${groupId}.${telegramId}`;
  const topicKey = (threadId: number) => `topic.${groupId}.${threadId}`;
  return {
    threadOf: async (telegramId) => idOf(await kv.get(personKey(telegramId))),
    personOf: async (threadId) => idOf(await kv.get(topicKey(threadId))),
    async bind(telegramId, threadId) {
      await kv.put(topicKey(threadId), String(telegramId));
      await kv.put(personKey(telegramId), String(threadId));
    },
    async unbind(telegramId, threadId) {
      await kv.delete(personKey(telegramId));
      await kv.delete(topicKey(threadId));
    },
  };
}
