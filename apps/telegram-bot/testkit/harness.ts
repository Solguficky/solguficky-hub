import type { Transformer } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import type { Dispatcher } from "../src/application/dispatcher.js";
import { createDispatcher } from "../src/application/dispatcher.js";
import type {
  CommunityAdministrator,
  IdentityResolver,
} from "../src/identity/port.js";
import type { LogFields, Logger } from "../src/logging.js";
import { createBot } from "../src/presentation/bot.js";

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

export function createHarness(
  identity: IdentityResolver & Partial<CommunityAdministrator>,
  dispatcher: Dispatcher = createDispatcher(),
) {
  const { logger, records } = createCapturingLogger();
  const bot = createBot({
    token: "111:test-token",
    dispatcher,
    identity,
    logger,
  });
  bot.botInfo = botInfo;
  const calls: RecordedCall[] = [];
  const recorder: Transformer = (_prev, method, payload) => {
    calls.push(recordCall(method, payload));
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
