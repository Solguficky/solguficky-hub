import type { Api } from "grammy";
import { countFailure } from "../failures.js";
import type { Logger } from "../logging.js";

// Экран, который открывает команда меню. Это те же экраны, что за кнопками
// главного экрана и списка сходок: меню даёт к ним вход, а не новый сценарий.
export type NavScreen = "hub" | "archive" | "notify-global";

// Состав меню записан в брифе бота, раздел «Меню команд». Управления здесь нет
// намеренно: список администраторов живёт в Identity и на старте недоступен,
// а показывать всем команду, на которой большинству откажут, незачем.
export const botCommands = [
  { command: "start", description: "Главное меню" },
  { command: "meetups", description: "Ближайшие сходки" },
  { command: "archive", description: "Архив сходок" },
  { command: "notifications", description: "Настройки уведомлений" },
] as const;

// Map, а не объект: имя команды приходит от человека, и `/constructor` на
// объекте нашёл бы свойство прототипа.
export const screenCommands: ReadonlyMap<string, NavScreen> = new Map([
  ["meetups", "hub"],
  ["archive", "archive"],
  ["notifications", "notify-global"],
]);

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
