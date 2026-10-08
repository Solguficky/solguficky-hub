import type { Api } from "grammy";
import { countFailure } from "../../../core/failures.js";
import type { Logger } from "../../../core/logging.js";

// Состав меню записан в брифе бота, раздел «Меню команд». Команда одна: разделы
// — ближайшие сходки, архив, уведомления, управление — открываются кнопками
// стартового экрана, и вторая дорога к ним в кнопке меню клиента только
// удлиняла список (решение владельца, PER-468). Управления здесь нет и потому,
// что список администраторов живёт в Identity и на старте недоступен, а
// показывать всем команду, на которой большинству откажут, незачем.
// `/start` в меню нет: его читают как команду первого запуска, и в главное
// меню возвращает `/menu` (PER-401). Сам `/start` и его deep link работают
// по-прежнему, а `/menu` разбирается как `/start` без payload.
export const botCommands = [
  { command: "menu", description: "Главное меню" },
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
    countFailure("dependency_unavailable");
    logger.warn("bot commands not registered", {
      error_category: "dependency_unavailable",
      error: cause instanceof Error ? cause.message : String(cause),
    });
  }
}
