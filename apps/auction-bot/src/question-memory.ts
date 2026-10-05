// Открытые вопросы чатов в памяти процесса (дизайн-код, «Вопросы»): по ним
// бот удаляет брошенный вопрос, когда человек ушёл к другому действию. Шаг
// вопроса и адресат лежат в его кнопке, поэтому рестарт теряет только уборку,
// а не ответ: вопрос, заданный до рестарта, по-прежнему его принимает.
export type QuestionMemory = {
  remember(chatId: number, messageId: number): void;
  forget(chatId: number, messageId: number): void;
  // Забирает и забывает все открытые вопросы чата.
  takeAll(chatId: number): number[];
};

// Чатов с открытым вопросом немного: старейший вытесняется, и его вопрос
// остаётся в чате, как после рестарта.
const CHAT_LIMIT = 10_000;

export function createQuestionMemory(limit = CHAT_LIMIT): QuestionMemory {
  const open = new Map<number, Set<number>>();
  return {
    remember(chatId, messageId) {
      const ids = open.get(chatId) ?? new Set<number>();
      ids.add(messageId);
      open.delete(chatId);
      open.set(chatId, ids);
      while (open.size > limit) {
        const oldest = open.keys().next().value;
        if (oldest === undefined) break;
        open.delete(oldest);
      }
    },
    forget(chatId, messageId) {
      const ids = open.get(chatId);
      if (ids === undefined) return;
      ids.delete(messageId);
      if (ids.size === 0) open.delete(chatId);
    },
    takeAll(chatId) {
      const ids = open.get(chatId);
      open.delete(chatId);
      return ids === undefined ? [] : [...ids];
    },
  };
}
