// Предел частоты сообщений человека (ADR-068, п. 7): счётчик в памяти
// процесса, после рестарта он начинается заново. Окно — минута, как обещает
// текст предела «Подожди минуту», и начинается с первого сообщения окна.
// Число ниже общего предела Telegram на одну группу — порядка двадцати
// сообщений в минуту на всех, — потому что копии всех людей идут в одну
// супергруппу.
export const messagesPerWindow = 10;
export const windowMs = 60_000;

// Предел числа окон: память не растёт с числом людей. Старейшее окно
// вытесняется первым — его человек давно молчит.
const windowLimit = 10_000;

/**
 * `pass` — сообщение копируется; `notify` — первое сверх предела в окне,
 * человек получает текст предела; `drop` — остальные сверх предела, без
 * копии и без ответа.
 */
export type Admission = "pass" | "notify" | "drop";

export type RateLimiter = {
  admit(telegramId: number): Admission;
};

export function createRateLimiter(now: () => number = Date.now): RateLimiter {
  const windows = new Map<number, { startedAt: number; count: number }>();
  return {
    admit(telegramId) {
      const at = now();
      let current = windows.get(telegramId);
      if (current === undefined || at - current.startedAt >= windowMs) {
        windows.delete(telegramId);
        current = { startedAt: at, count: 0 };
        windows.set(telegramId, current);
        if (windows.size > windowLimit) {
          const oldest = windows.keys().next().value;
          if (oldest !== undefined) windows.delete(oldest);
        }
      }
      current.count += 1;
      if (current.count <= messagesPerWindow) return "pass";
      return current.count === messagesPerWindow + 1 ? "notify" : "drop";
    },
  };
}
