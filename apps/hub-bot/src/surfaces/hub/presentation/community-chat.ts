import type { Api, Context, MiddlewareFn } from "grammy";
import type { ShellContext } from "../../../core/bot/shell.js";
import { countFailure } from "../../../core/failures.js";
import type { LogFields, Logger } from "../../../core/logging.js";
import {
  type BotCommand,
  createChatCommandsSync,
} from "../../../core/menu-commands.js";

// Допуск групп (ADR-078, п. 2): бот хаба работает в личке и в одном чате
// сообщества, id которого задаёт среда. Из любой другой группы он выходит на
// первом же update из неё — и когда его туда добавили, и когда он состоял там
// до выкладки — и ничего в ней не обрабатывает. Исключение — миграция:
// перевод обычной группы в супергруппу меняет id, и update новой супергруппы с
// `migrate_from_chat_id`, равным id сообщества, выхода не вызывает, а новый id
// уходит в лог: настройку среды обновляет человек.
//
// Новый id процесс помнит до рестарта (ADR-078, дополнение 2026-11-13): из
// новой супергруппы бот не выходит и ничего в ней не обрабатывает — иначе
// первое же служебное событие после миграции вывело бы его из самого чата
// сообщества. Связь старого и нового id берётся только из служебных полей
// сообщения о миграции: `migrate_from_chat_id` в новой супергруппе и
// `migrate_to_chat_id` в старой группе. После рестарта без обновлённой
// настройки память пуста, и бот из новой супергруппы выйдет.
//
// Каналы под правило не подпадают: в канале медиа ботов бот хаба —
// администратор, и посты оттуда он показывает людям (ADR-057, дополнение
// 2026-10-27).

export type ChatAdmission =
  // Личка, канал или update без чата: всё идёт, как прежде.
  | { kind: "other" }
  | { kind: "community" }
  // Супергруппа, в которую перевели чат сообщества: о ней говорит сообщение
  // о миграции или память процесса.
  | { kind: "migrated"; chatId: number }
  // Чужая группа. `leave` ложно, когда бота в ней уже нет: его вывели или он
  // вышел сам, и о выходе Telegram сообщил этим же update.
  | { kind: "foreign"; chatId: number; leave: boolean };

type AdmissionInput = Pick<Context, "chat" | "message" | "myChatMember">;

export function admitChat(
  ctx: AdmissionInput,
  communityChatId: number,
  migrated: ReadonlySet<number> = new Set(),
): ChatAdmission {
  const chat = ctx.chat;
  if (chat === undefined) return { kind: "other" };
  if (chat.type !== "group" && chat.type !== "supergroup") {
    return { kind: "other" };
  }
  if (chat.id === communityChatId) return { kind: "community" };
  if (
    ctx.message?.migrate_from_chat_id === communityChatId ||
    migrated.has(chat.id)
  ) {
    return { kind: "migrated", chatId: chat.id };
  }
  const status = ctx.myChatMember?.new_chat_member.status;
  return {
    kind: "foreign",
    chatId: chat.id,
    leave: status !== "left" && status !== "kicked",
  };
}

export type CommunityChat = {
  chatId: number;
  // Пишет невидимые команды в scope чата сообщества, если процесс их ещё не
  // записал. Зовётся на старте и после каждого update из чата сообщества.
  registerCommands(
    api: Pick<Api, "setMyCommands" | "deleteMyCommands">,
  ): Promise<void>;
  // Первый middleware поверхности после оболочки: чужая группа и миграция
  // дальше него не идут.
  gate: MiddlewareFn<ShellContext>;
};

export function createCommunityChat(options: {
  chatId: number;
  commands: readonly BotCommand[];
  logger: Logger;
}): CommunityChat {
  const { chatId, commands, logger } = options;
  // Сверка та же, что у списков команд лички (PER-592): память процесса
  // «чат → записанный список», вызов Telegram только при расхождении, отказ
  // в память не попадает и повторяется на следующем update из чата. Так меню
  // доходит до клиента и тогда, когда запись на старте отказала.
  const sync = createChatCommandsSync(logger);
  const registerCommands: CommunityChat["registerCommands"] = (api) =>
    sync(api, chatId, commands);
  // Супергруппы, в которые перевели чат сообщества, — до рестарта.
  const migrated = new Set<number>();
  // Id группы — не Telegram id человека (logging.md): без него человек не
  // узнает, на что поменять настройку среды. Пишется один раз на супергруппу.
  const remember = (ctx: ShellContext, newChatId: number): void => {
    if (migrated.has(newChatId)) return;
    migrated.add(newChatId);
    logger.warn("community chat migrated", {
      ...boundaryFields(ctx, "ok"),
      community_chat_id: newChatId,
    });
  };
  const gate: MiddlewareFn<ShellContext> = async (ctx, next) => {
    const admission = admitChat(ctx, chatId, migrated);
    switch (admission.kind) {
      case "other":
        await next();
        return;
      case "community": {
        // Старая группа тоже сообщает о миграции — полем `migrate_to_chat_id`.
        const movedTo = ctx.message?.migrate_to_chat_id;
        if (movedTo !== undefined) remember(ctx, movedTo);
        await next();
        // После ответа: шёпот укладывается в 15 секунд от команды (ADR-078).
        await registerCommands(ctx.api);
        return;
      }
      case "migrated":
        // Команды здесь не обрабатываются до обновления настройки: это не
        // чат сообщества, пока среда его так не назвала.
        if (migrated.has(admission.chatId)) {
          logger.info(
            "migrated community chat update ignored",
            boundaryFields(ctx, "ok"),
          );
          return;
        }
        remember(ctx, admission.chatId);
        return;
      case "foreign":
        await leaveForeignGroup(ctx, admission, logger);
        return;
    }
  };
  return { chatId, registerCommands, gate };
}

async function leaveForeignGroup(
  ctx: ShellContext,
  admission: Extract<ChatAdmission, { kind: "foreign" }>,
  logger: Logger,
): Promise<void> {
  if (!admission.leave) {
    logger.info("foreign group update ignored", boundaryFields(ctx, "ok"));
    return;
  }
  try {
    await ctx.api.leaveChat(admission.chatId);
    logger.info("foreign group left", boundaryFields(ctx, "ok"));
  } catch (cause) {
    // Не вышел — следующий update из этой группы попробует снова; update
    // при этом всё равно дальше не идёт.
    countFailure("dependency_unavailable");
    logger.warn("foreign group not left", {
      ...boundaryFields(ctx, "error"),
      error_category: "dependency_unavailable",
      error: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

// Каркас записи границы (logging.md): операция — вид update, а id чужой
// группы в запись не идёт — он не нужен никому, кроме самого выхода.
function boundaryFields(ctx: ShellContext, result: "ok" | "error"): LogFields {
  const operation =
    Object.keys(ctx.update).find((key) => key !== "update_id") ?? "update";
  const fields: LogFields = { operation, result };
  if (ctx.requestId !== undefined && ctx.requestId !== "") {
    fields.request_id = ctx.requestId;
  }
  if (ctx.startedAt !== undefined) {
    fields.duration_us = Number(
      (process.hrtime.bigint() - ctx.startedAt) / 1000n,
    );
  }
  return fields;
}
