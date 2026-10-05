import type { Transformer } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import type { Dispatcher } from "../src/application/dispatcher.js";
import { createDispatcher } from "../src/application/dispatcher.js";
import { inMemberCircle } from "../src/application/hub-access.js";
import type {
  ApplicationAdministrator,
  ApplicationModerator,
  CommunityAdministrator,
  IdentityResolver,
  RoleRequester,
  SourceChannelAdministrator,
} from "../src/identity/port.js";
import type { LogFields, Logger } from "../src/logging.js";
import { type BotRuntime, createBot } from "../src/presentation/bot.js";
import { noopTracing, type Tracing } from "../src/tracing.js";
import { inspectCall, reportViolations } from "./screen-lint.js";

// Харнесс бота без Telegram: `botInfo` подставляется, поэтому `bot.init()` не
// ходит в Bot API, а исходящие вызовы записывает трансформер grammY. Общий для
// L0 (`bot.test.ts`, соседи подменены) и L2 (`tests/contour/bot-wire`, соседи
// настоящие): уровни различаются тем, что передано в `identity` и
// `dispatcher`, а не устройством харнесса.

export const botInfo: UserFromGetMe = {
  id: 1,
  is_bot: true,
  first_name: "stub",
  username: "stub_bot",
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};

export type ApiMethod = Parameters<Transformer>[1];
export type ApiPayload = Parameters<Transformer>[2];

export type RecordedCall = {
  method: ApiMethod;
  payload: ApiPayload;
};

export type LogRecord = {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  fields: LogFields;
};

function recordCall(method: ApiMethod, payload: ApiPayload): RecordedCall {
  return { method, payload };
}

export function createCapturingLogger(): {
  logger: Logger;
  records: LogRecord[];
} {
  const records: LogRecord[] = [];
  const push =
    (level: LogRecord["level"]): Logger[LogRecord["level"]] =>
    (message, fields) => {
      records.push({ level, message, fields: fields ?? {} });
    };
  return {
    records,
    logger: {
      debug: push("debug"),
      info: push("info"),
      warn: push("warn"),
      error: push("error"),
    },
  };
}

/**
 * Что ещё получает бот: экраны аукциона и их память процесса, а также ответ
 * Telegram на вызов, которому мало `true`, — например, правка rich-сообщения
 * с загрузкой фото, из ответа которой бот берёт `file_id`.
 */
export type HarnessOptions = Partial<
  Pick<
    BotRuntime,
    | "auction"
    | "auctionParents"
    | "lotPhotos"
    | "communityTimeZone"
    | "auctionBotUsername"
    | "files"
  >
> & {
  respond?: (method: ApiMethod, payload: ApiPayload) => unknown;
};

/**
 * Вход на `/start` для фейка, у которого его нет: ответ выводится из его же
 * разрешения личности, как ответил бы Identity человеку с такой личностью —
 * заблокированному `blocked`, кругу `member` «уже есть», остальным заявку.
 * Тест, которому важен сам вход, передаёт `requestRole` явно.
 */
export function withEntry<T extends IdentityResolver & Partial<RoleRequester>>(
  identity: T,
): T & RoleRequester {
  if (identity.requestRole !== undefined) {
    // Поле проверено строкой выше; сужение обобщённого `T` компилятор до
    // пересечения не доводит.
    return identity as T & RoleRequester;
  }
  return {
    ...identity,
    async requestRole(input, meta) {
      const resolved = await identity.resolve(
        {
          telegramUserId: input.telegramUserId,
          ...(input.telegramUsername === undefined
            ? {}
            : { telegramUsername: input.telegramUsername }),
        },
        meta,
      );
      if (resolved.kind !== "resolved") return resolved;
      return {
        kind: "answered",
        identityId: resolved.identityId,
        globalRoles: resolved.globalRoles,
        outcome: resolved.blocked
          ? "blocked"
          : inMemberCircle(resolved.globalRoles)
            ? "already-held"
            : "pending",
      };
    },
  };
}

/**
 * `calls` передаётся снаружи, когда рестарт процесса нужно показать в том же
 * чате: новый бот теряет память, а история сообщений у человека остаётся.
 */
export function createHarness(
  identity: IdentityResolver &
    Partial<RoleRequester> &
    Partial<CommunityAdministrator> &
    Partial<ApplicationAdministrator> &
    Partial<SourceChannelAdministrator> &
    Partial<ApplicationModerator>,
  dispatcher: Dispatcher = createDispatcher(),
  calls: RecordedCall[] = [],
  tracing: Tracing = noopTracing(),
  presentation?: "rich" | "plain",
  /** Закреплённый день сообщества: от него зависят заготовки дат. */
  today?: () => { year: number; month: number; day: number },
  options: HarnessOptions = {},
) {
  const { logger, records } = createCapturingLogger();
  const { respond, ...runtime } = options;
  const bot = createBot({
    token: "111:test-token",
    dispatcher,
    identity: withEntry(identity),
    logger,
    tracing,
    ...(presentation === undefined ? {} : { presentation }),
    ...(today === undefined ? {} : { today }),
    ...runtime,
  });
  bot.botInfo = botInfo;
  const recorder: Transformer = (_prev, method, payload) => {
    calls.push(recordCall(method, payload));
    // Каждый экран сверяется с каталогом и дизайн-кодом в момент отправки;
    // найденное снимает хук набора (`lint-setup.ts`) либо пульт.
    reportViolations(inspectCall(method, payload));
    // Ответ с полем `ok` — готовый ответ Bot API, в том числе отказ: из него
    // grammY сам соберёт GrammyError. Остальное — результат успешного вызова.
    const answer = respond?.(method, payload);
    if (answer instanceof Error) return Promise.reject(answer);
    if (typeof answer === "object" && answer !== null && "ok" in answer) {
      return Promise.resolve(answer as never);
    }
    if (answer !== undefined) {
      return Promise.resolve({ ok: true, result: answer as never });
    }
    if (method === "sendMessage") {
      return Promise.resolve({
        ok: true,
        result: {
          message_id: 100 + calls.length,
          date: 0,
          chat: { id: 42, type: "private", first_name: "tester" },
        } as never,
      });
    }
    return Promise.resolve({ ok: true, result: true as never }); // ApiCallResult depends on method; fixture never calls prev
  };
  bot.api.config.use(recorder);
  return { bot, calls, records };
}
