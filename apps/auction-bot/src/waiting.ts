import type { Context } from "grammy";

// Правило ожидания дизайн-кода (docs/design/bot/design-code.md, «Ожидание»).
// Человек видит ожидание двумя индикаторами клиента: спиннером на нажатой
// кнопке, пока бот не ответил на нажатие, и строкой «печатает…». Бот хаба
// держит то же правило у себя: код ботов не общий (ADR-044).

/** На все сервисы у одного действия; дальше — кадр «недоступно». */
export const actionBudgetMs = 5_000;
/** Позже этого ответ на нажатие не уходит: лимит Telegram — около 12 секунд. */
export const pressWatchdogMs = 8_000;
/** Столько человек ждёт молча, прежде чем увидит «печатает…». */
export const typingAfterMs = 1_000;
/** Статус держится 5 секунд, поэтому повтор идёт раньше. */
export const typingEveryMs = 4_000;

export type Waiting = {
  /** Момент, после которого к сервисам больше не ходят. */
  readonly deadlineAt: number;
  /** Бот пошёл к сервису: с этого момента человек ждёт. */
  begin(): void;
  /** Конец обработки: ответ на нажатие, если его ещё не было, и остановка таймеров. */
  finish(): Promise<void>;
  /** Отказ ответа на нажатие: действие он не отменяет, его пишет запись границы. */
  readonly answerError: string | undefined;
};

// Вызовы, после которых человек ещё ничего не увидел: сам ответ на нажатие,
// индикатор и удаление прежнего сообщения после нового.
const quietMethods: ReadonlySet<string> = new Set([
  "answerCallbackQuery",
  "sendChatAction",
  "deleteMessage",
]);

/**
 * Заводит ожидание одного update. Ответ на нажатие уходит вместе с первым
 * видимым вызовом Bot API: до него клиент сам крутит индикатор на кнопке.
 * Ставится на `ctx.api` этого update, поэтому ни один путь доставки ответ не
 * обходит и не дублирует.
 */
export function startWaiting(ctx: Context): Waiting {
  const startedAt = Date.now();
  let answered = ctx.callbackQuery === undefined;
  let answerError: string | undefined;
  let begun = false;
  let shown = false;
  let finished = false;
  let typing: NodeJS.Timeout | undefined;

  // Один раз и без текста: всплывающего текста у бота аукциона нет. Не
  // бросает — отказ ответа доставку экрана не отменяет.
  const answer = async (): Promise<void> => {
    if (answered) return;
    answered = true;
    try {
      await ctx.answerCallbackQuery();
    } catch (cause) {
      answerError = cause instanceof Error ? cause.message : String(cause);
    }
  };

  const stopTyping = (): void => {
    clearTimeout(typing);
    typing = undefined;
  };
  const showTyping = (): void => {
    typing = undefined;
    if (shown || finished) return;
    // Индикатор — побочный сигнал: его отказ ничего не меняет в действии.
    ctx.replyWithChatAction("typing").catch(() => undefined);
    typing = setTimeout(showTyping, typingEveryMs);
    typing.unref();
  };

  const watchdog =
    ctx.callbackQuery === undefined
      ? undefined
      : setTimeout(() => {
          void answer();
        }, pressWatchdogMs);
  watchdog?.unref();

  ctx.api.config.use(async (prev, method, payload, signal) => {
    if (!quietMethods.has(method)) {
      shown = true;
      stopTyping();
      await answer();
    }
    return prev(method, payload, signal);
  });

  return {
    deadlineAt: startedAt + actionBudgetMs,
    begin() {
      if (begun || shown || finished || ctx.chat === undefined) return;
      begun = true;
      typing = setTimeout(
        showTyping,
        Math.max(0, startedAt + typingAfterMs - Date.now()),
      );
      typing.unref();
    },
    async finish() {
      finished = true;
      stopTyping();
      clearTimeout(watchdog);
      await answer();
    },
    get answerError() {
      return answerError;
    },
  };
}
