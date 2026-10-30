// Темп правок сообщений вне update (PER-336): живые экраны — карточки финала,
// а за ними пульт ведущего и экран помощника — правятся по потоку аукциона,
// и на залпе ставок правок больше, чем Telegram примет. Лимиты Bot API:
// около 30 сообщений в секунду на бота и около одного в секунду на чат; сверх
// них — `429` с `retry_after`.
//
// У сообщения одна ячейка ожидания: новая правка вытесняет ту, что ещё не
// ушла. Промежуточные состояния теряются, последнее — никогда: экран живой, и
// важна цена сейчас, а не путь к ней. Очередь — по времени, когда сообщение
// стало ждать: горячая карточка, которую правят на каждой ставке, не отнимает
// очередь у остальных.
//
// Фоновая полоса (PER-826, PER-837): слежение за торгами правит карточку лота
// каждого следящего на каждую ставку, и их десятки. Её правки идут после
// остальных и стартуют, только пока своих стартов в окне меньше
// `BACKGROUND_SLOTS` из 25: у карточек без слежения и пульта всегда остаётся
// запас, и слежение их не задерживает. Считаются именно её старты, а не все: иначе пятнадцать правок
// карточек в секунду оставили бы десять свободных мест без дела.

export type EditOutcome =
  | { kind: "done" }
  // `429`: Telegram назвал паузу. Встаёт весь бот — лимит общий.
  | { kind: "retry-after"; ms: number };

export type EditTask = () => Promise<EditOutcome>;

export type Clock = {
  now(): number;
  // Отложенный вызов; ответ — его отмена.
  later(run: () => void, ms: number): () => void;
};

const realClock: Clock = {
  now: () => Date.now(),
  later(run, ms) {
    const timer = setTimeout(run, ms);
    timer.unref?.();
    return () => clearTimeout(timer);
  },
};

export type EditLimiter = {
  /**
   * Правка сообщения `key` в чате `chatId`; вытесняет ждущую правку того же.
   * `background` — фоновая полоса: правка уступает очередь остальным.
   */
  submit(
    chatId: number,
    key: string,
    task: EditTask,
    lane?: "background",
  ): void;
  /** Снять ждущую правку: сообщения больше нет или оно уже не живое. */
  drop(key: string): void;
  /** Сколько сообщений ждёт правки. */
  waiting(): number;
  close(): void;
};

// Ниже 30 в секунду на бота: тот же лимит делят ответы на нажатия и доставка
// уведомлений, которые лимитер не видит.
export const EDITS_PER_SECOND = 25;
// Сколько правок в окне может занять фоновая полоса, пока остальные ждут.
export const BACKGROUND_SLOTS = 15;
export const CHAT_INTERVAL_MS = 1_000;
const WINDOW_MS = 1_000;

type Waiting = {
  chatId: number;
  task: EditTask;
  since: number;
  background: boolean;
};

export function createEditLimiter(
  options: {
    perSecond?: number;
    backgroundSlots?: number;
    chatIntervalMs?: number;
    clock?: Clock;
    // Правка бросила — не `429` и не известный отказ: пишет поверхность.
    onError?: (key: string, cause: unknown) => void;
  } = {},
): EditLimiter {
  const perSecond = options.perSecond ?? EDITS_PER_SECOND;
  const backgroundSlots = Math.min(
    options.backgroundSlots ?? BACKGROUND_SLOTS,
    perSecond,
  );
  const chatIntervalMs = options.chatIntervalMs ?? CHAT_INTERVAL_MS;
  const clock = options.clock ?? realClock;
  const waiting = new Map<string, Waiting>();
  const inFlight = new Set<string>();
  // Когда чат снова можно править.
  const chatFree = new Map<number, number>();
  // Моменты начала правок за последнее окно.
  let starts: number[] = [];
  // Из них — старты фоновой полосы.
  let backgroundStarts: number[] = [];
  let pausedUntil = 0;
  let cancelWake: (() => void) | undefined;
  let wakeAt = Number.POSITIVE_INFINITY;
  let closed = false;

  const wake = (at: number) => {
    if (closed || at >= wakeAt) return;
    cancelWake?.();
    wakeAt = at;
    cancelWake = clock.later(
      () => {
        cancelWake = undefined;
        wakeAt = Number.POSITIVE_INFINITY;
        pump();
      },
      Math.max(0, at - clock.now()),
    );
  };

  const start = (key: string, entry: Waiting, now: number) => {
    waiting.delete(key);
    inFlight.add(key);
    starts.push(now);
    if (entry.background) backgroundStarts.push(now);
    chatFree.set(entry.chatId, now + chatIntervalMs);
    void entry
      .task()
      .then((outcome) => {
        if (outcome.kind === "retry-after") {
          pausedUntil = Math.max(pausedUntil, clock.now() + outcome.ms);
          // Правка не прошла: если новой нет, ждёт эта же.
          if (!waiting.has(key)) waiting.set(key, entry);
        }
      })
      .catch((cause: unknown) => options.onError?.(key, cause))
      .finally(() => {
        inFlight.delete(key);
        pump();
      });
  };

  const pump = () => {
    if (closed) return;
    const now = clock.now();
    starts = starts.filter((at) => at > now - WINDOW_MS);
    backgroundStarts = backgroundStarts.filter((at) => at > now - WINDOW_MS);
    for (const [chatId, at] of chatFree) {
      if (at <= now) chatFree.delete(chatId);
    }
    if (now < pausedUntil) {
      wake(pausedUntil);
      return;
    }
    let next = Number.POSITIVE_INFINITY;
    const queue = [...waiting.entries()]
      .filter(([key]) => !inFlight.has(key))
      .sort(
        ([, a], [, b]) =>
          Number(a.background) - Number(b.background) || a.since - b.since,
      );
    for (const [key, entry] of queue) {
      if (starts.length >= perSecond) {
        next = Math.min(next, (starts[0] ?? now) + WINDOW_MS);
        break;
      }
      if (entry.background && backgroundStarts.length >= backgroundSlots) {
        next = Math.min(next, (backgroundStarts[0] ?? now) + WINDOW_MS);
        // Остальные в очереди — тоже фоновые: передние уже обслужены.
        break;
      }
      const free = chatFree.get(entry.chatId) ?? 0;
      if (free > now) {
        next = Math.min(next, free);
        continue;
      }
      start(key, entry, now);
    }
    if (next !== Number.POSITIVE_INFINITY) wake(next);
  };

  return {
    submit(chatId, key, task, lane) {
      if (closed) return;
      const prior = waiting.get(key);
      waiting.set(key, {
        chatId,
        task,
        since: prior?.since ?? clock.now(),
        background: lane === "background",
      });
      pump();
    },
    drop(key) {
      waiting.delete(key);
    },
    waiting: () => waiting.size,
    close() {
      closed = true;
      cancelWake?.();
      waiting.clear();
    },
  };
}
