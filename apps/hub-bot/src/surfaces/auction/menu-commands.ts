import type { Api } from "grammy";
import type { Logger } from "./logging.js";

// Команды кнопки меню клиента — постоянный вход (дизайн-код, «Навигация»).
// В меню возвращает `/menu`, как в боте хаба: `/start` читают как команду
// первого запуска, и в списке его нет (решение владельца 7 октября 2026 года,
// PER-472). Сам `/start` с кодом канала работает по-прежнему, а `/menu`
// разбирается как `/start` без кода. `/faq` открывает FAQ с любого места бота.
export const botCommands = [
  { command: "menu", description: "Меню аукциона" },
  { command: "faq", description: "Правила и FAQ" },
] as const;

// Меню — удобство, а не условие работы: отказ Telegram пишется в лог и не
// выбрасывается, иначе он остановил бы процесс до начала polling. Прежний
// список при этом остаётся в клиенте, а следующий старт повторяет запись.
export async function registerCommands(
  api: Pick<Api, "setMyCommands">,
  logger: Logger,
): Promise<void> {
  try {
    // Бот отвечает только в личных чатах, поэтому и меню видно только там.
    await api.setMyCommands(botCommands, {
      scope: { type: "all_private_chats" },
    });
    logger.info("bot commands registered");
  } catch (cause) {
    logger.warn("bot commands not registered", {
      error_category: "dependency_unavailable",
      error: cause instanceof Error ? cause.message : String(cause),
    });
  }
}
