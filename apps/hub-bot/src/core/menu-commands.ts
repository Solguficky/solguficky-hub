import type { Api } from "grammy";
import { countFailure } from "./failures.js";
import type { Logger } from "./logging.js";

export type BotCommand = { command: string; description: string };

// Список команд кнопки меню клиента — у каждой поверхности свой
// (`botCommands` рядом с её экранами), запись — общая. Команды — постоянный
// вход: корневого экрана «Меню» нет, разделы открываются командами (решение
// владельца 10 октября 2026 года).
//
// Меню — удобство, а не условие работы: отказ Telegram пишется в лог и не
// выбрасывается, иначе он остановил бы процесс до начала polling. Прежний
// список при этом остаётся в клиенте, а следующий старт повторяет запись.
export async function registerCommands(
  api: Pick<Api, "setMyCommands">,
  commands: readonly BotCommand[],
  logger: Logger,
): Promise<void> {
  try {
    // Бот отвечает только в личных чатах, поэтому и меню видно только там.
    await api.setMyCommands(commands, {
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

/**
 * Список команд одного личного чата поверх общего: держателю права получить
 * команду своего раздела, остальным — снять прежний список чата. `undefined`
 * снимает список чата, и клиент снова показывает общий. Отказ Telegram, как у
 * общего списка, пишется в лог и действие человека не роняет.
 */
export async function registerChatCommands(
  api: Pick<Api, "setMyCommands" | "deleteMyCommands">,
  chatId: number,
  commands: readonly BotCommand[] | undefined,
  logger?: Logger,
): Promise<void> {
  const scope = { type: "chat" as const, chat_id: chatId };
  try {
    if (commands === undefined) {
      await api.deleteMyCommands({ scope });
    } else {
      await api.setMyCommands(commands, { scope });
    }
  } catch (cause) {
    countFailure("dependency_unavailable");
    logger?.warn("chat bot commands not registered", {
      error_category: "dependency_unavailable",
      error: cause instanceof Error ? cause.message : String(cause),
    });
  }
}
