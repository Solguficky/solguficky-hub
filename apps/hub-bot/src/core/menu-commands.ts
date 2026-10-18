import type { Api } from "grammy";
import { countFailure } from "./failures.js";
import type { Logger } from "./logging.js";

export type BotCommand = { command: string; description: string };

// Список команд кнопки меню клиента — у каждой поверхности свой
// (`botCommands` рядом с её экранами), запись — общая. Команды — постоянный
// вход в разделы, а `/menu` открывает корневое меню — общего родителя
// разделов (решение владельца по прогону 12 октября 2026 года, PER-592).
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
): Promise<boolean> {
  const scope = { type: "chat" as const, chat_id: chatId };
  try {
    if (commands === undefined) {
      await api.deleteMyCommands({ scope });
    } else {
      await api.setMyCommands(commands, { scope });
    }
    return true;
  } catch (cause) {
    countFailure("dependency_unavailable");
    logger?.warn("chat bot commands not registered", {
      error_category: "dependency_unavailable",
      error: cause instanceof Error ? cause.message : String(cause),
    });
    return false;
  }
}

/** Сверка списка команд чата с правами: см. `createChatCommandsSync`. */
export type ChatCommandsSync = (
  api: Pick<Api, "setMyCommands" | "deleteMyCommands">,
  chatId: number,
  commands: readonly BotCommand[] | undefined,
) => Promise<void>;

/**
 * Список команд чата сверяется с правами на каждом действии человека, а не
 * только на `/start` и при выдаче прав (PER-592): права меняются и без них —
 * выдачей до выкладки, снятием. Что стоит в чате, процесс помнит сам, и
 * Telegram получает вызов, только когда желаемый список с памятью
 * расходится. После рестарта память пуста, и первое действие держателя права
 * пишет его список заново — так права, выданные до выкладки, доходят до
 * клиента.
 * Отказ Telegram в память не попадает: следующее действие повторит запись.
 * Память ограничена `limit` чатами: самый давний вытесняется и потом просто
 * пишется ещё раз.
 */
export function createChatCommandsSync(
  logger?: Logger,
  limit = 10_000,
): ChatCommandsSync {
  const written = new Map<number, string>();
  return async (api, chatId, commands) => {
    const print =
      commands === undefined
        ? "-"
        : commands.map((entry) => entry.command).join(" ");
    const known = written.get(chatId);
    if (known === print) return;
    // Чат, которого процесс ещё не видел — после рестарта или вытесненный из
    // памяти, — без своего списка не трогается: иначе после каждой выкладки
    // первое действие каждого человека стоило бы вызова Bot API. Цена —
    // список, оставшийся от прав, снятых, пока процесс этот чат не помнил: он
    // уходит, только когда права снова выдадут и снимут в живом процессе, а до
    // того `/manage` из него отвечает отказом без права.
    if (known === undefined && commands === undefined) return;
    if (!(await registerChatCommands(api, chatId, commands, logger))) return;
    written.delete(chatId);
    written.set(chatId, print);
    if (written.size > limit) {
      const [oldest] = written.keys();
      if (oldest !== undefined) written.delete(oldest);
    }
  };
}
