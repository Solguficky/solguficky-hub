import { InlineKeyboard, type MiddlewareFn } from "grammy";
import { z } from "zod";
import type { ShellContext } from "../../../core/bot/shell.js";
import { markUpdateFailed } from "../../../core/bot/tracing.js";
import { countFailure, type FailureCategory } from "../../../core/failures.js";
import type { LogFields, Logger } from "../../../core/logging.js";
import type { RpcMetadata } from "../../../core/rpc-metadata.js";
import {
  blockedHubAccessText,
  decideHubAccess,
  hubAccessErrors,
  invitationOnlyHub,
} from "../application/hub-access.js";
import type { Person } from "../application/types.js";
import type { CommunityDay } from "../community-time.js";
import {
  type IdentityResolver,
  type ResolveIdentityResult,
  toResolveIdentityInput,
} from "../identity/port.js";
import {
  grpcFailureCategory,
  unavailableCategory,
} from "./failure-category.js";
import { parseCommand } from "./parse-update.js";
import type { ScreenId } from "./screens/catalog.js";
import { escapeHtml, refusalText, screenText } from "./screens/kit.js";
import { screenMark } from "./screens/show.js";
import { actionBudgetMs } from "./waiting.js";

// Шёпот в чате сообщества (ADR-078, пп. 3–5; PER-683): ответ на невидимую
// команду, который видит только её автор. Каркас общий у всех команд чата:
// разбор невидимой команды, `ResolveIdentity`, ответы человеку без права хаба,
// заблокированному и при сбое Identity и сам шёпот. Команда — запись реестра
// `WhisperCommands`: она получает допущенного человека и отдаёт свой кадр, а
// каркас её не знает. Так `/lot` (PER-685) встаёт рядом с `/meetups`.
//
// Что шёпот несёт (ADR-078, п. 4): только то, что человек и так видит в боте,
// и вход в бот. Деньги, ставки, данные других людей и то, что может стать
// скрытым позже, шёпотом не уходят — это правило каждого кадра команды.
// Кнопки шёпота — только ссылки: нажатия из чата этот каркас не обрабатывает
// (подписка кнопкой на шёпоте — PER-686).
//
// Доставку шёпота бот не наблюдает и не дублирует (ADR-078, п. 5): `200` —
// это «принято». Повтора нет: человек повторяет команду сам.

/** Кадр шёпота — запись каталога с префиксом `whisper-`. */
export type WhisperScreenId = Extract<ScreenId, `whisper-${string}`>;

/** Кнопка шёпота — ссылка в бот. Знак «↗» ставит отправитель. */
export type WhisperLink = { label: string; url: string };

export type WhisperFrame = {
  id: WhisperScreenId;
  /** HTML: заголовок жирным первой строкой и абзацы, как у экрана лички. */
  text: string;
  /** По ссылке в ряд; пусто — шёпот без клавиатуры. */
  links: readonly WhisperLink[];
};

/** Что команда получает от каркаса: человек уже допущен к хабу. */
export type WhisperRequest = {
  person: Person;
  /** Бюджет сервисов общий с `ResolveIdentity`: ответ укладывается в окно. */
  meta: RpcMetadata;
  /** Имя бота для ссылок `t.me/<имя>`. */
  botUsername: string;
  today: CommunityDay;
};

export type WhisperAnswer =
  | { kind: "frame"; frame: WhisperFrame }
  // Сбой сервиса команды: человек получает шёпот о недоступности, а причина
  // уходит в запись границы.
  | {
      kind: "failed";
      message: string;
      category: FailureCategory;
      error: string;
      grpcCode?: string;
    };

export type WhisperCommand = {
  /** `use_case` записи границы и заголовка вызова сервисов. */
  useCase: string;
  answer(request: WhisperRequest): Promise<WhisperAnswer>;
};

/** Реестр невидимых команд чата сообщества: имя команды без «/». */
export type WhisperCommands = Readonly<Record<string, WhisperCommand>>;

export const openBotLabel = "Открыть бота";

export function botLink(botUsername: string): string {
  return `https://t.me/${botUsername}`;
}

// Невидимая команда приходит с `message_id = 0` и своим
// `ephemeral_message_id`: по нему шёпот отвечает на неё. Обычная команда в
// чате сообщества его не несёт, и ответ на неё увидели бы все — она остаётся
// без ответа (docs/learning/telegram-bot-api/ephemeral-messages.md).
const InvisibleCommandSchema = z.object({
  message: z.object({
    ephemeral_message_id: z.number().int(),
    chat: z.object({
      id: z.number().int(),
      type: z.enum(["group", "supergroup"]),
    }),
    from: z.object({
      id: z.number().int(),
      is_bot: z.boolean(),
      username: z.string().optional(),
    }),
    text: z.string(),
  }),
});

export type InvisibleCommand = {
  name: string;
  chatId: number;
  ephemeralMessageId: number;
  telegramUserId: number;
  telegramUsername?: string;
};

/** Невидимая команда этому боту из группы; всё остальное — `undefined`. */
export function parseInvisibleCommand(
  raw: unknown,
  botUsername: string | undefined,
): InvisibleCommand | undefined {
  const parsed = InvisibleCommandSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const { message } = parsed.data;
  if (message.from.is_bot) return undefined;
  const command = parseCommand(message.text, botUsername);
  if (command === undefined || command === "foreign") return undefined;
  return {
    name: command.name,
    chatId: message.chat.id,
    ephemeralMessageId: message.ephemeral_message_id,
    telegramUserId: message.from.id,
    ...(message.from.username === undefined
      ? {}
      : { telegramUsername: message.from.username }),
  };
}

/**
 * Ответ на невидимые команды чата сообщества. Стоит сразу за допуском чата
 * (`community-chat.ts`): до него из групп доходит только чат сообщества.
 * Команду не из реестра, обычную команду и всё остальное отдаёт дальше.
 *
 * Путь лички шёпот не проходит: ни ожидания с «печатает…» — в группе его
 * увидели бы все, — ни вопросов, ни списка команд по правам.
 */
export function createCommunityWhisper(options: {
  commands: WhisperCommands;
  identity: IdentityResolver;
  logger: Logger;
  today: () => CommunityDay;
}): MiddlewareFn<ShellContext> {
  const { commands, identity, logger, today } = options;
  return async (ctx, next) => {
    const command = parseInvisibleCommand(ctx.update, ctx.me.username);
    const entry =
      command === undefined || !Object.hasOwn(commands, command.name)
        ? undefined
        : commands[command.name];
    if (command === undefined || entry === undefined) {
      await next();
      return;
    }
    const record = await whisperBack(ctx, command, entry, identity, today);
    writeRecord(logger, ctx, record);
  };
}

type WhisperRecord = {
  level: "info" | "warn" | "error";
  message: string;
  useCase: string;
  screen: WhisperScreenId;
  identityId?: string;
  failure?: { category: FailureCategory; error: string; grpcCode?: string };
  replyError?: string;
};

async function whisperBack(
  ctx: ShellContext,
  command: InvisibleCommand,
  entry: WhisperCommand,
  identity: IdentityResolver,
  today: () => CommunityDay,
): Promise<WhisperRecord> {
  // Окно шёпота — 15 секунд от команды (ADR-078); бюджет сервисов у действия
  // тот же, что в личке, и ответ уходит с запасом.
  const meta: RpcMetadata = {
    requestId: ctx.requestId,
    useCase: entry.useCase,
    deadlineAt: Date.now() + actionBudgetMs,
  };
  const botUsername = ctx.me.username;
  const resolved = await identity.resolve(
    toResolveIdentityInput(
      BigInt(command.telegramUserId),
      command.telegramUsername,
    ),
    meta,
  );
  const decided = await decide(resolved, entry, {
    meta,
    botUsername,
    today,
  });
  const record: WhisperRecord = {
    ...decided.record,
    useCase: entry.useCase,
    screen: decided.frame.id,
  };
  try {
    await sendWhisper(ctx, command, decided.frame);
    return record;
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : String(cause);
    // Отказ Telegram — шёпот вне окна, `BOT_NOT_ADMIN`: повтора нет, человек
    // повторит команду сам. Прежняя причина записи остаётся главной.
    return record.failure === undefined
      ? {
          ...record,
          level: "warn",
          message: "community whisper not sent",
          failure: { category: "dependency_unavailable", error },
        }
      : { ...record, replyError: error };
  }
}

type Decided = {
  frame: WhisperFrame;
  record: Omit<WhisperRecord, "useCase" | "screen">;
};

async function decide(
  resolved: ResolveIdentityResult,
  entry: WhisperCommand,
  context: {
    meta: RpcMetadata;
    botUsername: string;
    today: () => CommunityDay;
  },
): Promise<Decided> {
  if (resolved.kind !== "resolved") {
    return {
      frame: unavailableFrame,
      record: {
        level: "error",
        ...(resolved.kind === "rejected"
          ? {
              message: "identity rejected the request",
              failure: {
                category: grpcFailureCategory(resolved.code),
                error: errorText(resolved.cause),
                grpcCode: resolved.code,
              },
            }
          : {
              message: "identity unavailable",
              failure: {
                category: unavailableCategory(resolved.cause),
                error: errorText(resolved.cause),
              },
            }),
      },
    };
  }
  const identityId = resolved.identityId;
  const access = decideHubAccess(resolved.rights, resolved.blocked);
  if (access !== "admitted") {
    // Из чата заявка не ставится (ADR-078, п. 3): `RequestAccess` зовёт
    // только кнопка кадра в личке, куда ведёт «Открыть бота».
    return {
      frame:
        access === "blocked"
          ? blockedFrame
          : invitationFrame(context.botUsername),
      record: {
        level: "warn",
        message: "hub access denied",
        identityId,
        failure: { category: "authorization", error: hubAccessErrors[access] },
      },
    };
  }
  const person: Person = { identityId, rights: resolved.rights };
  let answer: WhisperAnswer;
  try {
    answer = await entry.answer({
      person,
      meta: context.meta,
      botUsername: context.botUsername,
      today: context.today(),
    });
  } catch (cause) {
    answer = {
      kind: "failed",
      message: "community whisper failed",
      category: "unexpected",
      error: errorText(cause),
    };
  }
  if (answer.kind === "frame") {
    return {
      frame: answer.frame,
      record: { level: "info", message: "community whisper sent", identityId },
    };
  }
  return {
    frame: unavailableFrame,
    record: {
      level: "error",
      message: answer.message,
      identityId,
      failure: {
        category: answer.category,
        error: answer.error,
        ...(answer.grpcCode === undefined ? {} : { grpcCode: answer.grpcCode }),
      },
    },
  };
}

// Смысл кадра лички «только по приглашению» (дополнение ADR-060 от
// 2026-10-25): заявку здесь не ставят, и кнопка ведёт в личку, где её ставит
// «Подать заявку» — ник из белого списка она пропустит (ADR-078, п. 3).
const invitationWhisper = [
  "Вход открыт по списку, который ведут администраторы сообщества. Если ник уже в списке, открой бота и нажми «Подать заявку».",
  "Аукционы сообщества — в боте аукциона.",
] as const;

function invitationFrame(botUsername: string): WhisperFrame {
  return {
    id: "whisper-invitation-only",
    text: screenText(
      invitationOnlyHub.title,
      ...invitationWhisper.map(escapeHtml),
    ),
    links: [{ label: openBotLabel, url: botLink(botUsername) }],
  };
}

// Отказ заблокированному — тот же кадр, что в личке (ADR-078, п. 3).
const blockedFrame: WhisperFrame = {
  id: "whisper-no-access",
  text: refusalText(blockedHubAccessText),
  links: [],
};

// Кнопки «Повторить» у шёпота нет: нажатие из чата этот лист не обрабатывает,
// и повтор — сама команда (ADR-078, п. 5).
const unavailableFrame: WhisperFrame = {
  id: "whisper-unavailable",
  text: refusalText(
    "Не получилось загрузить данные. Это на моей стороне.\n\nПовтори команду через минуту.",
  ),
  links: [],
};

// Подпись кнопки не длиннее, чем Telegram покажет без обрыва (`buttonText`
// экранов), вместе со знаком ссылки.
const linkSign = " ↗";
const labelLimit = 64;

function linkText(label: string): string {
  const room = labelLimit - linkSign.length;
  const fitted = label.length <= room ? label : `${label.slice(0, room - 1)}…`;
  return `${fitted}${linkSign}`;
}

async function sendWhisper(
  ctx: ShellContext,
  command: InvisibleCommand,
  frame: WhisperFrame,
): Promise<void> {
  await ctx.api.sendMessage(command.chatId, frame.text, {
    ...screenMark(frame.id),
    parse_mode: "HTML",
    // Повод шёпота: ответ на невидимую команду и её автор. Без повода бот без
    // прав администратора получает `400 BOT_NOT_ADMIN` (RFC-003).
    reply_parameters: { ephemeral_message_id: command.ephemeralMessageId },
    ephemeral_message_parameters: { receiver_user_id: command.telegramUserId },
    ...(frame.links.length === 0
      ? {}
      : {
          reply_markup: InlineKeyboard.from(
            frame.links.map((link) => [
              InlineKeyboard.url(linkText(link.label), link.url),
            ]),
          ),
        }),
  });
}

// Каркас записи границы (logging.md): Telegram id человека и id чата в запись
// не идут, человек назван `identity_id` после разрешения личности.
function writeRecord(
  logger: Logger,
  ctx: ShellContext,
  record: WhisperRecord,
): void {
  const fields: LogFields = {
    operation: "message",
    result: record.failure === undefined ? "ok" : "error",
    use_case: record.useCase,
    screen: record.screen,
  };
  if (ctx.requestId !== "") fields.request_id = ctx.requestId;
  fields.duration_us = Number(
    (process.hrtime.bigint() - ctx.startedAt) / 1000n,
  );
  if (record.identityId !== undefined) fields.identity_id = record.identityId;
  if (record.failure !== undefined) {
    countFailure(record.failure.category);
    markUpdateFailed(ctx.updateSpan, record.failure.category);
    fields.error_category = record.failure.category;
    fields.error = record.failure.error;
    if (record.failure.grpcCode !== undefined) {
      fields.grpc_code = record.failure.grpcCode;
    }
  }
  if (record.replyError !== undefined) fields.reply_error = record.replyError;
  logger[record.level](record.message, fields);
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
