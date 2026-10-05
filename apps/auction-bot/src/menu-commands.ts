import type { Api } from "grammy";
import type { Logger } from "./logging.js";

// Команды кнопки меню клиента — постоянный вход (дизайн-код, «Навигация»).
// `/faq` открывает FAQ с любого места бота; своей команды меню у бота нет, и в
// меню возвращает `/start`.
export const botCommands = [
  { command: "start", description: "Меню аукциона" },
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
