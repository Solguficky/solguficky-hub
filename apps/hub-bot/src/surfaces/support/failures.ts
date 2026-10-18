// Отказы Bot API, которые переписка поддержки различает. Разбор по полям
// ответа, а не `instanceof GrammyError`: так же разбирает механика доставки
// (`src/core/delivery/telegram.ts`). Описание отказа — единственное, чем
// Telegram отличает закрытую тему от удалённой, поэтому подстроки закреплены
// тестами, а незнакомый отказ уходит в общий «не дошло» или «Telegram отказал».
export type TelegramRefusal =
  // Тема закрыта: бот откроет её снова.
  | "topic-closed"
  // Темы нет: удалена или не найдена — бот снимет пару и заведёт новую.
  | "topic-missing"
  // Сообщение такого вида Telegram не копирует.
  | "not-copyable"
  // Человек остановил бота или удалил аккаунт.
  | "stopped"
  | "other";

type TelegramErrorReply = { error_code: number; description?: string };

function isTelegramErrorReply(cause: unknown): cause is TelegramErrorReply {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "error_code" in cause &&
    typeof cause.error_code === "number"
  );
}

const topicMissing = [
  "message thread not found",
  "topic_deleted",
  "topic_id_invalid",
  "thread not found",
];

export function classifyRefusal(cause: unknown): TelegramRefusal {
  if (!isTelegramErrorReply(cause)) return "other";
  if (cause.error_code === 403) return "stopped";
  const description = (cause.description ?? "").toLowerCase();
  if (cause.error_code !== 400) return "other";
  if (description.includes("topic_closed")) return "topic-closed";
  if (topicMissing.some((needle) => description.includes(needle))) {
    return "topic-missing";
  }
  if (description.includes("can't be copied")) return "not-copyable";
  return "other";
}
