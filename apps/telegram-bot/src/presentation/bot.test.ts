import { Code, ConnectError } from "@connectrpc/connect";
import { BotError, Context, type Transformer } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Dispatcher } from "../application/dispatcher.js";
import { createDispatcher } from "../application/dispatcher.js";
import { createIdentityResolver } from "../identity/client.js";
import type { IdentityResolver } from "../identity/port.js";
import type { LogFields, Logger } from "../logging.js";
import { createBot } from "./bot.js";

const botInfo: UserFromGetMe = {
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

type ApiMethod = Parameters<Transformer>[1];
type ApiPayload = Parameters<Transformer>[2];

type RecordedCall = {
  method: ApiMethod;
  payload: ApiPayload;
};

type LogRecord = {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  fields: LogFields;
};

function messageUpdate(text = "/start"): Update {
  return {
    update_id: 1,
    message: {
      message_id: 7,
      date: 0,
      chat: { id: 42, type: "private", first_name: "tester" },
      from: { id: 42, is_bot: false, first_name: "tester" },
      text,
    },
  };
}

function ignoredUpdate(): Update {
  return {
    update_id: 2,
    message: {
      message_id: 8,
      date: 0,
      chat: { id: 42, type: "private", first_name: "tester" },
      from: { id: 42, is_bot: true, first_name: "otherbot" },
    },
  };
}

function callbackUpdate(data: string, fromId = 42): Update {
  return {
    update_id: 3,
    callback_query: {
      id: "callback-1",
      chat_instance: "chat-1",
      from: { id: fromId, is_bot: false, first_name: "tester" },
      data,
      message: {
        message_id: 9,
        date: 0,
        chat: { id: 42, type: "private", first_name: "tester" },
      },
    },
  };
}

function replyUpdate(options: {
  text: string;
  fromId: number;
  replyMessageId: number;
  replyFromId: number;
}): Update {
  return {
    update_id: 4,
    message: {
      message_id: 10,
      date: 0,
      chat: { id: 42, type: "private", first_name: "tester" },
      from: { id: options.fromId, is_bot: false, first_name: "tester" },
      text: options.text,
      reply_to_message: {
        message_id: options.replyMessageId,
        date: 0,
        chat: { id: 42, type: "private", first_name: "tester" },
        from: {
          id: options.replyFromId,
          is_bot: options.replyFromId === 1,
          first_name: "sender",
        },
      } as never,
    },
  };
}

function recordCall(method: ApiMethod, payload: ApiPayload): RecordedCall {
  return { method, payload };
}

function createCapturingLogger(): { logger: Logger; records: LogRecord[] } {
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

function resolvedIdentity(): IdentityResolver {
  return {
    resolve: async () => ({
      kind: "resolved",
      identityId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd",
      globalRoles: [],
    }),
  };
}

function createHarness(
  identity: IdentityResolver,
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

function sendMessageText(call: RecordedCall | undefined): string | undefined {
  if (call === undefined || call.method !== "sendMessage") {
    return undefined;
  }
  if (!("text" in call.payload)) {
    return undefined;
  }
  const text = call.payload.text;
  return typeof text === "string" ? text : undefined;
}

function expectBoundary(
  record: LogRecord | undefined,
  expected: {
    level: LogRecord["level"];
    result: "ok" | "error";
    error_category?: string;
  },
): void {
  expect(record).toBeDefined();
  if (record === undefined) {
    return;
  }
  expect(record.level).toBe(expected.level);
  expect(record.fields.operation).toBe("message");
  expect(record.fields.result).toBe(expected.result);
  expect(typeof record.fields.request_id).toBe("string");
  expect(record.fields.request_id).not.toBe("");
  expect(typeof record.fields.duration_us).toBe("number");
  if (expected.result === "error") {
    expect(record.fields.error_category).toBe(expected.error_category);
    expect(typeof record.fields.error).toBe("string");
    expect(record.fields.error).not.toBe("");
  } else {
    expect(record.fields.error_category).toBeUndefined();
    expect(record.fields.error).toBeUndefined();
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("presentation adapter", () => {
  it("does not treat a command replying to a user as a stale form answer", async () => {
    const { bot, calls } = createHarness(resolvedIdentity());
    await bot.init();
    await bot.handleUpdate(
      replyUpdate({
        text: "/start",
        fromId: 42,
        replyMessageId: 8,
        replyFromId: 42,
      }),
    );
    expect(
      sendMessageText(calls.find((call) => call.method === "sendMessage")),
    ).toContain("Привет.");
  });

  it("does not dispatch another user's answer to a pending question", async () => {
    const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValueOnce({
      kind: "ask",
      field: "title",
      meetup: {
        id: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34ce",
        title: "",
        description: "",
        venue: "",
        lifecycle: "planned",
        visibility: "hidden",
      },
    });
    const { bot } = createHarness(resolvedIdentity(), { execute });
    await bot.init();
    await bot.handleUpdate(
      callbackUpdate("v1:manage:new:AZLzpLXGfY6fChssPU5fYA"),
    );
    await bot.handleUpdate(
      replyUpdate({
        text: "Чужое название",
        fromId: 43,
        replyMessageId: 102,
        replyFromId: 1,
      }),
    );
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it("resolves identity and replies to /start", async () => {
    const { bot, calls, records } = createHarness(resolvedIdentity());
    await bot.init();
    await bot.handleUpdate(messageUpdate());
    expect(sendMessageText(calls[0])).toContain("Привет.");
    expect(records.some((record) => record.level === "info")).toBe(false);
    expectBoundary(records[0], { level: "debug", result: "ok" });
    expect(calls[0]?.payload).toMatchObject({
      reply_markup: {
        inline_keyboard: [
          [{ text: "Ближайшие сходки", callback_data: "v1:nav:hub" }],
          [{ text: "Управление сходками", callback_data: "v1:manage:menu" }],
        ],
      },
    });
  });

  it("renders an empty meetup list as an empty state", async () => {
    const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue({
      kind: "meetup-list",
      meetups: [],
    });
    const { bot, calls } = createHarness(resolvedIdentity(), { execute });
    await bot.init();
    await bot.handleUpdate(callbackUpdate("v1:nav:hub"));
    expect(calls[0]?.method).toBe("answerCallbackQuery");
    expect(calls[1]).toMatchObject({
      method: "editMessageText",
      payload: {
        text: expect.stringContaining("ни одной запланированной сходки"),
        reply_markup: {
          inline_keyboard: [
            [{ text: "Обновить", callback_data: "v1:nav:hub" }],
          ],
        },
      },
    });
  });

  it("groups dated meetups before meetups without a date", async () => {
    const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue({
      kind: "meetup-list",
      meetups: [
        {
          id: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34ce",
          title: "Без даты",
        },
        {
          id: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cf",
          title: "Настолки",
          schedule: { year: 2026, month: 8, day: 15 },
        },
      ],
    });
    const { bot, calls } = createHarness(resolvedIdentity(), { execute });
    await bot.init();
    await bot.handleUpdate(callbackUpdate("v1:nav:hub"));
    expect(calls[1]).toMatchObject({
      method: "editMessageText",
      payload: {
        text: expect.stringMatching(
          /^Ближайшие сходки\n\nС датой\n• 15 авг, сб — Настолки\n\nБез даты\n• Без даты$/,
        ),
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "Без даты",
                callback_data: "v1:view:AZjypHwefTqbIU-OEqs0zg",
              },
            ],
            [
              {
                text: "Настолки",
                callback_data: "v1:view:AZjypHwefTqbIU-OEqs0zw",
              },
            ],
            [{ text: "Обновить", callback_data: "v1:nav:hub" }],
          ],
        },
      },
    });
  });

  it("renders Meetups unavailability as E-05 instead of an empty list", async () => {
    const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue({
      kind: "dependency-rejected",
      reason: "unavailable",
    });
    const { bot, calls } = createHarness(resolvedIdentity(), { execute });
    await bot.init();
    await bot.handleUpdate(callbackUpdate("v1:nav:hub"));
    expect(calls[1]).toMatchObject({
      method: "editMessageText",
      payload: {
        text: expect.stringContaining("Не получилось загрузить сходки"),
        reply_markup: {
          inline_keyboard: [
            [{ text: "Повторить", callback_data: "v1:nav:hub" }],
          ],
        },
      },
    });
  });

  it("renders a dispatcher rejection as E-05 instead of going silent", async () => {
    const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue({
      kind: "rejected",
      reason: "meetups-not-configured",
    });
    const { bot, calls } = createHarness(resolvedIdentity(), { execute });
    await bot.init();
    await bot.handleUpdate(callbackUpdate("v1:nav:hub"));
    expect(calls[1]).toMatchObject({
      method: "editMessageText",
      payload: {
        text: expect.stringContaining("Не получилось загрузить сходки"),
      },
    });
  });

  it("fails closed on a callback and edits the screen after acknowledging it", async () => {
    const execute = vi.fn<Dispatcher["execute"]>();
    const identity: IdentityResolver = {
      resolve: async () => ({ kind: "unavailable", cause: new Error("down") }),
    };
    const { bot, calls } = createHarness(identity, { execute });
    await bot.init();
    await bot.handleUpdate(callbackUpdate("v1:nav:hub"));

    expect(calls.map((call) => call.method)).toEqual([
      "answerCallbackQuery",
      "editMessageText",
    ]);
    expect(calls[1]).toMatchObject({
      payload: {
        text: expect.stringContaining("Это на моей стороне"),
        reply_markup: {
          inline_keyboard: [
            [{ text: "Повторить", callback_data: "v1:nav:hub" }],
          ],
        },
      },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("rebuilds an outdated callback from current Meetups state", async () => {
    const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue({
      kind: "meetup-list",
      meetups: [],
    });
    const { bot, calls } = createHarness(resolvedIdentity(), { execute });
    await bot.init();
    await bot.handleUpdate(callbackUpdate("v2:nav:hub"));

    expect(calls[0]?.method).toBe("answerCallbackQuery");
    expect(execute).toHaveBeenCalledWith({
      identity: {
        identityId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd",
        globalRoles: [],
      },
      intent: "list-visible-meetups",
      requestId: expect.any(String),
    });
    expect(calls[1]).toMatchObject({
      method: "editMessageText",
      payload: { text: expect.stringContaining("ни одной запланированной") },
    });
  });

  it("opens a meetup from the parsed deep link payload", async () => {
    const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue({
      kind: "meetup-card",
      meetup: {
        id: "0192f3a4-b5c6-7d8e-9f0a-1b2c3d4e5f60",
        title: "Настолки",
        description: "Берём свои игры",
        venue: "Циферблат",
        lifecycle: "planned",
        visibility: "visible",
      },
    });
    const { bot, calls } = createHarness(resolvedIdentity(), { execute });
    await bot.init();
    await bot.handleUpdate(messageUpdate("/start m_AZLzpLXGfY6fChssPU5fYA"));
    expect(execute).toHaveBeenCalledWith({
      identity: {
        identityId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd",
        globalRoles: [],
      },
      intent: "view-meetup",
      meetupId: "0192f3a4-b5c6-7d8e-9f0a-1b2c3d4e5f60",
      requestId: expect.any(String),
    });
    expect(calls[0]).toMatchObject({
      method: "sendRichMessage",
      payload: {
        rich_message: {
          html: expect.stringContaining("Статус: запланирована, видна"),
        },
      },
    });
  });

  it("answers a deep link when Meetups is unavailable", async () => {
    const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue({
      kind: "dependency-rejected",
      reason: "unavailable",
    });
    const { bot, calls, records } = createHarness(resolvedIdentity(), {
      execute,
    });
    await bot.init();
    await bot.handleUpdate(messageUpdate("/start m_AZLzpLXGfY6fChssPU5fYA"));
    expect(sendMessageText(calls[0])).toContain("Это на моей стороне");
    expectBoundary(records[0], {
      level: "warn",
      result: "error",
      error_category: "dependency_unavailable",
    });
  });

  it("resolves repeated /start updates independently", async () => {
    const resolve = vi.fn(resolvedIdentity().resolve);
    const { bot, calls } = createHarness({ resolve });
    await bot.init();
    await bot.handleUpdate(messageUpdate());
    await bot.handleUpdate({ ...messageUpdate(), update_id: 2 });
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(calls.filter((call) => call.method === "sendMessage")).toHaveLength(
      2,
    );
  });

  it("does not resolve identity for unrelated text", async () => {
    const resolve = vi.fn(resolvedIdentity().resolve);
    const { bot, calls } = createHarness({ resolve });
    await bot.init();
    await bot.handleUpdate(messageUpdate("hello"));
    expect(resolve).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("replies fail-closed when identity is unavailable", async () => {
    const identity: IdentityResolver = {
      resolve: async () => ({ kind: "unavailable", cause: new Error("down") }),
    };
    const { bot, calls, records } = createHarness(identity);
    await bot.init();
    await bot.handleUpdate(messageUpdate());
    expect(sendMessageText(calls[0])).toContain("Это на моей стороне.");
    expectBoundary(records[0], {
      level: "error",
      result: "error",
      error_category: "dependency_unavailable",
    });
    expect(records[0]?.fields.error).toBe("down");
    expect(records[0]?.fields.use_case).toBe("start");
  });

  it("resolves /start with a bot mention", async () => {
    const { bot, calls } = createHarness(resolvedIdentity());
    await bot.init();
    await bot.handleUpdate(messageUpdate("/START@stub_bot"));
    expect(sendMessageText(calls[0])).toContain("Привет.");
  });

  it("does not resolve identity for /start mentioned for another bot", async () => {
    const resolve = vi.fn(resolvedIdentity().resolve);
    const { bot, calls } = createHarness({ resolve });
    await bot.init();
    await bot.handleUpdate(messageUpdate("/start@other_bot"));
    expect(resolve).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("replies fail-closed when identity rpc exceeds the deadline", async () => {
    const identity = createIdentityResolver({
      resolveIdentity: () =>
        Promise.reject(new ConnectError("deadline", Code.DeadlineExceeded)),
    });
    const { bot, calls, records } = createHarness(identity);
    await bot.init();
    await bot.handleUpdate(messageUpdate());
    expect(sendMessageText(calls[0])).toContain("Это на моей стороне.");
    expectBoundary(records[0], {
      level: "error",
      result: "error",
      error_category: "timeout",
    });
  });

  it("separates a refused request from an unavailable identity", async () => {
    const identity = createIdentityResolver({
      resolveIdentity: () =>
        Promise.reject(
          new ConnectError(
            "telegram_user_id must be positive",
            Code.InvalidArgument,
          ),
        ),
    });
    const { bot, calls, records } = createHarness(identity);
    await bot.init();
    await bot.handleUpdate(messageUpdate());
    expect(sendMessageText(calls[0])).toContain("Это на моей стороне.");
    expectBoundary(records[0], {
      level: "error",
      result: "error",
      error_category: "invariant",
    });
    expect(records[0]?.fields.grpc_code).toBe("InvalidArgument");
    expect(records[0]?.fields.use_case).toBe("start");
  });

  it("carries the boundary request id into the identity call", async () => {
    let seenRequestId: string | undefined;
    const identity: IdentityResolver = {
      resolve: async (_input, requestId) => {
        seenRequestId = requestId;
        return {
          kind: "resolved",
          identityId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd",
          globalRoles: [],
        };
      },
    };
    const { bot, records } = createHarness(identity);
    await bot.init();
    await bot.handleUpdate(messageUpdate());
    expect(seenRequestId).toBe(records[0]?.fields.request_id);
    expect(seenRequestId).not.toBe("");
  });

  it("logs ignored updates with the boundary skeleton", async () => {
    const { bot, calls, records } = createHarness(resolvedIdentity());
    await bot.init();
    await bot.handleUpdate(ignoredUpdate());
    expect(calls).toEqual([]);
    expectBoundary(records[0], { level: "debug", result: "ok" });
    expect(records[0]?.fields.use_case).toBeUndefined();
  });

  it("logs malformed updates without a use_case", async () => {
    const { bot, calls, records } = createHarness(resolvedIdentity());
    await bot.init();
    await bot.handleUpdate({
      update_id: 1,
      message: {
        message_id: 1.5,
        date: 0,
        chat: { id: 42, type: "private", first_name: "tester" },
        from: { id: 42, is_bot: false, first_name: "tester" },
        text: "/start",
      },
    });
    expect(calls).toEqual([]);
    expectBoundary(records[0], {
      level: "warn",
      result: "error",
      error_category: "invariant",
    });
    expect(records[0]?.fields.use_case).toBeUndefined();
  });

  it("logs unexpected handler failures with stack and request context", async () => {
    const identity: IdentityResolver = {
      resolve: async () => {
        throw new Error("boom");
      },
    };
    const { bot, records } = createHarness(identity);
    await bot.init();
    await bot.handleUpdate(messageUpdate());
    expectBoundary(records[0], {
      level: "error",
      result: "error",
      error_category: "unexpected",
    });
    expect(records[0]?.fields.error).toBe("boom");
    expect(typeof records[0]?.fields.stack).toBe("string");
    expect(records[0]?.fields.stack).toContain("boom");
  });

  it("keeps identity_unavailable when the fail-closed reply is rejected", async () => {
    const identity: IdentityResolver = {
      resolve: async () => ({ kind: "unavailable", cause: new Error("down") }),
    };
    const { logger, records } = createCapturingLogger();
    const bot = createBot({
      token: "111:test-token",
      dispatcher: createDispatcher(),
      identity,
      logger,
    });
    bot.botInfo = botInfo;
    const failing: Transformer = () =>
      Promise.reject(new Error("Forbidden: bot was blocked by the user"));
    bot.api.config.use(failing);
    await bot.init();
    await bot.handleUpdate(messageUpdate());
    expectBoundary(records[0], {
      level: "error",
      result: "error",
      error_category: "dependency_unavailable",
    });
    expect(records[0]?.fields.error).toBe("down");
    expect(records[0]?.fields.reply_error).toContain("Forbidden");
  });

  it("does not resolve identity for a photo without text", async () => {
    const resolve = vi.fn(async () => {
      throw new Error("identity should not run");
    });
    const { bot, calls, records } = createHarness({
      resolve,
    });
    await bot.init();
    await bot.handleUpdate({
      update_id: 3,
      message: {
        message_id: 9,
        date: 0,
        chat: { id: 42, type: "private", first_name: "tester" },
        from: { id: 42, is_bot: false, first_name: "tester" },
        photo: [
          {
            file_id: "file",
            file_unique_id: "uniq",
            width: 1,
            height: 1,
          },
        ],
      },
    });
    expect(resolve).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    expectBoundary(records[0], { level: "debug", result: "ok" });
  });

  it("logs a caught error without request fields when middleware did not run", async () => {
    const { bot, records } = createHarness(resolvedIdentity());
    await bot.init();
    const ctx = new Context({ update_id: 9 }, bot.api, botInfo);
    await bot.errorHandler(
      new BotError(new Error("bare context"), ctx as never), // Context from grammY has no requestId until middleware
    );
    expect(records[0]?.level).toBe("error");
    expect(records[0]?.fields.result).toBe("error");
    expect(records[0]?.fields.error_category).toBe("unexpected");
    expect(records[0]?.fields.error).toBe("bare context");
    expect(records[0]?.fields.request_id).toBeUndefined();
    expect(records[0]?.fields.duration_us).toBeUndefined();
  });
});
