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
import { meetupsSectionStartLink } from "./meetup-deep-link.js";
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
// Кнопки шёпота — ссылки в бот и действия на самом шёпоте (PER-686). Нажатие
// каркас забирает раньше обработчиков лички, проводит тем же путём Identity и
// допуска и отдаёт записи реестра `WhisperActions`; её кадр правит шёпот на
// месте. Следующее действие встаёт записью рядом, как команда.
//
// Доставку шёпота бот не наблюдает и не дублирует (ADR-078, п. 5): `200` —
// это «принято». Повтора нет: человек повторяет команду сам.

/** Кадр шёпота — запись каталога с префиксом `whisper-`. */
export type WhisperScreenId = Extract<ScreenId, `whisper-${string}`>;

/** Кнопка шёпота — ссылка в бот. Знак «↗» ставит отправитель. */
export type WhisperLink = { label: string; url: string };

/** Кнопка действия на самом шёпоте; данные — из `whisperActionData`. */
export type WhisperPress = { label: string; data: string };

export type WhisperButton = WhisperLink | WhisperPress;

export type WhisperFrame = {
  id: WhisperScreenId;
  /** HTML: заголовок жирным первой строкой и абзацы, как у экрана лички. */
  text: string;
  /** По кнопке в ряд; пусто — шёпот без клавиатуры. */
  buttons: readonly WhisperButton[];
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
  // `refused` — действие отказало подделке или устаревшей кнопке: шёпот
  // показывает кадр, а причина уходит в запись границы предупреждением.
  | { kind: "frame"; frame: WhisperFrame; refused?: string }
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
  /** `argument` — текст команды после её имени, без краевых пробелов. */
  answer(
    request: WhisperRequest & { argument: string },
  ): Promise<WhisperAnswer>;
};

/** Реестр невидимых команд чата сообщества: имя команды без «/». */
export type WhisperCommands = Readonly<Record<string, WhisperCommand>>;

/**
 * Невидимая команда, на которую ответил шёпот: Telegram приносит её с
 * нажатием в `reply_to_message` (RFC-003, «Шёпот в группе», прогон
 * 2026-11-19). Каркас отдаёт её действию, только если команду написал тот же
 * человек и этому боту: то, что не помещается в 64 байта данных кнопки, —
 * ссылку и название `/attach` (PER-885), — действие читает отсюда.
 */
export type WhisperCommandEcho = {
  name: string;
  argument: string;
  ephemeralMessageId: number;
  /** Момент команды по часам Telegram, в миллисекундах. */
  sentAt: number;
};

export type WhisperAction = {
  /** `use_case` записи границы и заголовка вызова сервисов. */
  useCase: string;
  /**
   * `argument` — хвост данных кнопки после имени действия, недоверенный;
   * `chatId` — чат шёпота; `command` — команда, на которую он ответил.
   */
  answer(
    request: WhisperRequest & {
      argument: string;
      chatId: number;
      command?: WhisperCommandEcho;
    },
  ): Promise<WhisperAnswer>;
};

/** Реестр действий на шёпоте: имя действия в данных кнопки. */
export type WhisperActions = Readonly<Record<string, WhisperAction>>;

// Домен данных кнопок шёпота.
const actionPrefix = "v1:w:";

/** Данные кнопки действия шёпота: `v1:w:<действие>:<аргумент>`. */
export function whisperActionData(action: string, argument: string): string {
  return `${actionPrefix}${action}:${argument}`;
}

export const openBotLabel = "Открыть бота";

/**
 * Куда ведёт «Открыть бота» (R-6 оркестратора эпика по Q-7 владельца): голая
 * ссылка `t.me/<бот>` у того, кто уже писал боту, открывает чат без нового
 * сообщения. Ссылка со `start` присылает `/start meetups`, и бот отвечает по
 * праву человека: держателю — «Сходки», без права — приветствие с «Подать
 * заявку», заблокированному — отказ.
 */
export function openBotLink(botUsername: string): string {
  return meetupsSectionStartLink(botUsername);
}

// Невидимая команда приходит с `message_id = 0` и своим
// `ephemeral_message_id`: по нему шёпот отвечает на неё. Обычная команда в
// чате сообщества его не несёт, и ответ на неё увидели бы все — она остаётся
// без ответа (docs/learning/telegram-bot-api/ephemeral-messages.md).
const InvisibleCommandSchema = z.object({
  message: z.object({
    ephemeral_message_id: z.number().int(),
    date: z.number().int(),
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
  /** Текст после имени команды, без краевых пробелов; пусто — без аргумента. */
  argument: string;
  chatId: number;
  ephemeralMessageId: number;
  /** Момент команды по часам Telegram, в миллисекундах: от него идёт окно. */
  sentAt: number;
  telegramUserId: number;
  telegramUsername?: string;
};

/**
 * Имя команды этому боту и текст после него. Имя читается по первой строке:
 * разбор лички ждёт команду в одну строку, а аргумент `/attach` может
 * переноситься. Desktop дописывает к команде имя бота (`/attach@бот`), и оно
 * в аргумент не попадает.
 */
function commandOf(
  text: string,
  botUsername: string | undefined,
): { name: string; argument: string } | undefined {
  const [head = ""] = text.split("\n", 1);
  const command = parseCommand(head, botUsername);
  if (command === undefined || command === "foreign") return undefined;
  return {
    name: command.name,
    argument: text.replace(/^\/\S*/, "").trim(),
  };
}

/** Невидимая команда этому боту из группы; всё остальное — `undefined`. */
export function parseInvisibleCommand(
  raw: unknown,
  botUsername: string | undefined,
): InvisibleCommand | undefined {
  const parsed = InvisibleCommandSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const { message } = parsed.data;
  if (message.from.is_bot) return undefined;
  const command = commandOf(message.text, botUsername);
  if (command === undefined) return undefined;
  return {
    ...command,
    chatId: message.chat.id,
    ephemeralMessageId: message.ephemeral_message_id,
    sentAt: message.date * 1_000,
    telegramUserId: message.from.id,
    ...(message.from.username === undefined
      ? {}
      : { telegramUsername: message.from.username }),
  };
}

// Нажатие на шёпоте приходит с `message.ephemeral_message_id` самого шёпота,
// а `date` у нажатия нет: окно считается от приёма (ephemeral-messages.md).
const WhisperPressSchema = z.object({
  callback_query: z.object({
    id: z.string(),
    data: z.string().optional(),
    from: z.object({
      id: z.number().int(),
      is_bot: z.boolean(),
      username: z.string().optional(),
    }),
    message: z.object({
      ephemeral_message_id: z.number().int(),
      chat: z.object({
        id: z.number().int(),
        type: z.enum(["group", "supergroup"]),
      }),
      // Команда, на которую ответил шёпот. Неразборчивая не роняет нажатие:
      // действие без неё получает только данные кнопки.
      reply_to_message: z.unknown().optional(),
    }),
  }),
});

const RepliedCommandSchema = z.object({
  ephemeral_message_id: z.number().int(),
  date: z.number().int(),
  from: z.object({ id: z.number().int() }),
  text: z.string(),
});

export type WhisperPressUpdate = {
  callbackQueryId: string;
  /** Имя действия и хвост; нет — данные не из домена шёпота. */
  action?: { name: string; argument: string };
  /** Невидимая команда того же человека этому боту, на которую ответил шёпот. */
  command?: WhisperCommandEcho;
  chatId: number;
  ephemeralMessageId: number;
  telegramUserId: number;
  telegramUsername?: string;
};

/** Нажатие кнопки на шёпоте в группе; всё остальное — `undefined`. */
export function parseWhisperPress(
  raw: unknown,
  botUsername?: string,
): WhisperPressUpdate | undefined {
  const parsed = WhisperPressSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const { callback_query: query } = parsed.data;
  const replied = RepliedCommandSchema.safeParse(
    query.message.reply_to_message,
  );
  // Чужая команда — не повод: шёпот видит только его адресат, но данные
  // нажатия недоверенные, а автор команды Telegram подтверждает сам.
  const named =
    replied.success && replied.data.from.id === query.from.id
      ? commandOf(replied.data.text, botUsername)
      : undefined;
  const command: WhisperCommandEcho | undefined =
    named === undefined || !replied.success
      ? undefined
      : {
          ...named,
          ephemeralMessageId: replied.data.ephemeral_message_id,
          sentAt: replied.data.date * 1_000,
        };
  const data = query.data ?? "";
  const rest = data.startsWith(actionPrefix)
    ? data.slice(actionPrefix.length)
    : undefined;
  const split = rest === undefined ? -1 : rest.indexOf(":");
  return {
    callbackQueryId: query.id,
    ...(rest === undefined || split <= 0
      ? {}
      : {
          action: {
            name: rest.slice(0, split),
            argument: rest.slice(split + 1),
          },
        }),
    ...(command === undefined ? {} : { command }),
    chatId: query.message.chat.id,
    ephemeralMessageId: query.message.ephemeral_message_id,
    telegramUserId: query.from.id,
    ...(query.from.username === undefined
      ? {}
      : { telegramUsername: query.from.username }),
  };
}

/**
 * Ответ на невидимые команды чата сообщества. Стоит сразу за допуском чата
 * (`community-chat.ts`): до него из групп доходит только чат сообщества.
 * Команду не из реестра, обычную команду и всё остальное отдаёт дальше.
 *
 * Путь лички шёпот не проходит: ни ожидания с «печатает…» — в группе его
 * увидели бы все, — ни вопросов, ни списка команд по правам.
 *
 * Нажатие на шёпоте (PER-686) каркас забирает целиком, с любыми данными: к
 * обработчикам лички оно не идёт — правка сообщения по нему задела бы шёпот,
 * у которого `message_id` нет.
 */
export function createCommunityWhisper(options: {
  commands: WhisperCommands;
  actions?: WhisperActions;
  identity: IdentityResolver;
  logger: Logger;
  today: () => CommunityDay;
}): MiddlewareFn<ShellContext> {
  const { commands, identity, logger, today } = options;
  const actions = options.actions ?? {};
  return async (ctx, next) => {
    const press = parseWhisperPress(ctx.update, ctx.me.username);
    if (press !== undefined) {
      const record = await pressBack(ctx, press, actions, identity, today);
      writeRecord(logger, ctx, record);
      return;
    }
    const command = parseInvisibleCommand(ctx.update, ctx.me.username);
    const entry =
      command === undefined || !Object.hasOwn(commands, command.name)
        ? undefined
        : commands[command.name];
    if (command === undefined || entry === undefined) {
      await next();
      return;
    }
    // Команда, чьё окно уже прошло, — хвост очереди после рестарта или
    // затора: шёпот на неё сервер отвергнет, и сервисы её не видят.
    if (Date.now() >= command.sentAt + whisperWindowMs) {
      writeRecord(logger, ctx, {
        level: "info",
        message: "community whisper window expired",
        useCase: entry.useCase,
      });
      return;
    }
    const record = await whisperBack(ctx, command, entry, identity, today);
    writeRecord(logger, ctx, record);
  };
}

/**
 * Окно шёпота: бот без прав администратора шепчет только в ответ, в течение
 * 15 секунд от команды (ADR-078; RFC-003, «Шёпот в группе»).
 */
export const whisperWindowMs = 15_000;
// Запас окна на сам вызов Telegram после сервисов.
const sendReserveMs = 1_000;

type WhisperRecord = {
  level: "info" | "warn" | "error";
  message: string;
  useCase: string;
  // Нет у команды, которая пришла после окна: шёпота на неё не было.
  screen?: WhisperScreenId;
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
  // Бюджет сервисов у действия тот же, что в личке, но не дальше окна шёпота:
  // команда могла ждать в очереди update'ов, а окно идёт от неё самой.
  const meta: RpcMetadata = {
    requestId: ctx.requestId,
    useCase: entry.useCase,
    deadlineAt: Math.min(
      Date.now() + actionBudgetMs,
      command.sentAt + whisperWindowMs - sendReserveMs,
    ),
  };
  const botUsername = ctx.me.username;
  const resolved = await identity.resolve(
    toResolveIdentityInput(
      BigInt(command.telegramUserId),
      command.telegramUsername,
    ),
    meta,
  );
  const decided = await decide(
    resolved,
    (request) => entry.answer({ ...request, argument: command.argument }),
    { meta, botUsername, today },
  );
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

async function pressBack(
  ctx: ShellContext,
  press: WhisperPressUpdate,
  actions: WhisperActions,
  identity: IdentityResolver,
  today: () => CommunityDay,
): Promise<WhisperRecord> {
  // Окно правки идёт от нажатия, а `date` у нажатия нет: отсчёт от приёма.
  const receivedAt = Date.now();
  const action = press.action;
  const entry =
    action === undefined || !Object.hasOwn(actions, action.name)
      ? undefined
      : actions[action.name];
  // Ответ на нажатие снимает часы с кнопки; его отказ шёпоту не мешает.
  const answered = ctx.api
    .answerCallbackQuery(press.callbackQueryId)
    .catch(() => undefined);
  if (action === undefined || entry === undefined) {
    // Кнопка не из реестра — подделка или кнопка прежней выкладки: шёпот не
    // трогается, сервисы не зовутся.
    await answered;
    return {
      level: "info",
      message: "community whisper press ignored",
      useCase: "community_whisper",
    };
  }
  const meta: RpcMetadata = {
    requestId: ctx.requestId,
    useCase: entry.useCase,
    deadlineAt: Math.min(
      receivedAt + actionBudgetMs,
      receivedAt + whisperWindowMs - sendReserveMs,
    ),
  };
  const resolved = await identity.resolve(
    toResolveIdentityInput(
      BigInt(press.telegramUserId),
      press.telegramUsername,
    ),
    meta,
  );
  const decided = await decide(
    resolved,
    (request) =>
      entry.answer({
        ...request,
        argument: action.argument,
        chatId: press.chatId,
        ...(press.command === undefined ? {} : { command: press.command }),
      }),
    { meta, botUsername: ctx.me.username, today },
  );
  await answered;
  const record: WhisperRecord = {
    ...decided.record,
    useCase: entry.useCase,
    screen: decided.frame.id,
  };
  try {
    await editWhisper(ctx, press, decided.frame);
    return record;
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : String(cause);
    // Тот же кадр уже на шёпоте — правка ничего не меняет, и это не отказ.
    if (error.includes("message is not modified")) return record;
    // Отказ Telegram — окно прошло, шёпот исчез: повтора нет, человек
    // повторит команду сам. Прежняя причина записи остаётся главной.
    return record.failure === undefined
      ? {
          ...record,
          level: "warn",
          message: "community whisper not edited",
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
  answerFor: (request: WhisperRequest) => Promise<WhisperAnswer>,
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
    answer = await answerFor({
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
      record:
        answer.refused === undefined
          ? { level: "info", message: "community whisper sent", identityId }
          : {
              level: "warn",
              message: "community whisper action refused",
              identityId,
              failure: { category: "visibility", error: answer.refused },
            },
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
    buttons: [{ label: openBotLabel, url: openBotLink(botUsername) }],
  };
}

// Отказ заблокированному — тот же кадр, что в личке (ADR-078, п. 3).
const blockedFrame: WhisperFrame = {
  id: "whisper-no-access",
  text: refusalText(blockedHubAccessText),
  buttons: [],
};

// Кнопки «Повторить» у шёпота нет: повтор — сама команда (ADR-078, п. 5). Тем
// же кадром правится шёпот, когда действие на нём не удалось: исход тогда не
// подтверждён, и прежний кадр мог бы показывать состояние неверно.
const unavailableFrame: WhisperFrame = {
  id: "whisper-unavailable",
  text: refusalText(
    "Не получилось загрузить данные. Это на моей стороне.\n\nПовтори команду через минуту.",
  ),
  buttons: [],
};

// Подпись кнопки не длиннее, чем Telegram покажет без обрыва (`buttonText`
// экранов), вместе со знаком ссылки. Режется по символам, а не по единицам
// UTF-16: половина эмодзи в названии сделала бы строку невалидной, и Telegram
// отверг бы весь шёпот.
const linkSign = " ↗";
const labelLimit = 64;

function linkText(label: string): string {
  const room = labelLimit - linkSign.length;
  const symbols = Array.from(label);
  const fitted =
    symbols.length <= room ? label : `${symbols.slice(0, room - 1).join("")}…`;
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
    ...keyboardOf(frame),
  });
}

// Шёпот правится своим методом по трём адресным параметрам, а не
// `editMessageText`: `message_id` у него нет (ephemeral-messages.md). Шёпот
// видит только адресат, поэтому нажавший и есть получатель.
async function editWhisper(
  ctx: ShellContext,
  press: WhisperPressUpdate,
  frame: WhisperFrame,
): Promise<void> {
  await ctx.api.editEphemeralMessageText(
    press.chatId,
    press.telegramUserId,
    press.ephemeralMessageId,
    frame.text,
    { ...screenMark(frame.id), parse_mode: "HTML", ...keyboardOf(frame) },
  );
}

function keyboardOf(frame: WhisperFrame): { reply_markup?: InlineKeyboard } {
  return frame.buttons.length === 0
    ? {}
    : {
        reply_markup: InlineKeyboard.from(
          frame.buttons.map((button) => [
            "url" in button
              ? InlineKeyboard.url(linkText(button.label), button.url)
              : InlineKeyboard.text(button.label, button.data),
          ]),
        ),
      };
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
  };
  if (record.screen !== undefined) fields.screen = record.screen;
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
