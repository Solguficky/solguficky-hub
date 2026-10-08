import type { SendResult } from "./port.js";

// Ответ Bot API об отказе в той форме, в какой его несёт GrammyError. Разбор по
// полям, а не `instanceof`: пакет grammy не тянет, а у бота и пакета были бы
// разные копии класса, и проверка молча давала бы `false`.
type TelegramErrorReply = {
  error_code: number;
  parameters?: { retry_after?: number };
};

function isTelegramErrorReply(cause: unknown): cause is TelegramErrorReply {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "error_code" in cause &&
    typeof cause.error_code === "number"
  );
}

// 403 — получатель заблокировал бота или удалил аккаунт: повтор не поможет, и
// бесконечные попытки запрещены. 429 несёт готовую паузу. Остальные 4xx —
// нарушение формы запроса, 5xx и сетевой сбой — временная недоступность.
export function classifyTelegramFailure(cause: unknown): SendResult {
  if (isTelegramErrorReply(cause)) {
    if (cause.error_code === 403) return { kind: "bot-blocked", cause };
    if (cause.error_code === 429) {
      const seconds = cause.parameters?.retry_after ?? 1;
      return { kind: "rate-limited", retryAfterMs: seconds * 1_000, cause };
    }
    if (cause.error_code >= 500) return { kind: "unavailable", cause };
    return { kind: "rejected", cause };
  }
  // HttpError, истёкший таймаут и прочий сбой до ответа Telegram.
  return { kind: "unavailable", cause };
}
