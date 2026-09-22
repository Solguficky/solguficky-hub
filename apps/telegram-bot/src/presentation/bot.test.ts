import { Code, ConnectError } from "@connectrpc/connect";
import { Api, BotError, Context, type Transformer } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Dispatcher } from "../application/dispatcher.js";
import { createDispatcher } from "../application/dispatcher.js";
import {
  blockedHubAccessText,
  pendingHubAccessText,
} from "../application/hub-access.js";
import * as failures from "../failures.js";
import { createIdentityResolver } from "../identity/client.js";
import type {
  CommunityAdministrator,
  IdentityResolver,
} from "../identity/port.js";
import type { LogFields, Logger } from "../logging.js";
import {
  createBot,
  parseTelegramEnvironment,
  type TelegramEnvironment,
} from "./bot.js";

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
  replyText?: string | undefined;
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
        text: options.replyText,
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

function publishedMeetup() {
  return {
    id: "0192f3a4-b5c6-7d8e-9f0a-1b2c3d4e5f60",
    title: "Настолки",
    description: "Берём свои игры",
    venue: "Циферблат",
    lifecycle: "planned" as const,
    visibility: "visible" as const,
    version: 1,
  };
}

function draftMeetup() {
  return {
    ...publishedMeetup(),
    title: "",
    description: "",
    venue: "",
    visibility: "hidden" as const,
  };
}

function resolvedIdentity(
  globalRoles: readonly string[] = ["member"],
  blocked = false,
): IdentityResolver {
  return {
    resolve: async () => ({
      kind: "resolved",
      identityId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd",
      globalRoles,
      blocked,
    }),
  };
}

function createHarness(
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
    operation?: "message" | "callback_query";
    use_case?: string;
  },
): void {
  expect(record).toBeDefined();
  if (record === undefined) {
    return;
  }
  expect(record.level).toBe(expected.level);
  expect(record.fields.operation).toBe(expected.operation ?? "message");
  expect(record.fields.result).toBe(expected.result);
  expect(typeof record.fields.request_id).toBe("string");
  expect(record.fields.request_id).not.toBe("");
  expect(typeof record.fields.duration_us).toBe("number");
  if (expected.use_case !== undefined) {
    expect(record.fields.use_case).toBe(expected.use_case);
  }
  if (expected.result === "error") {
    expect(record.fields.error_category).toBe(expected.error_category);
    expect(typeof record.fields.error).toBe("string");
    expect(record.fields.error).not.toBe("");
  } else {
    expect(record.fields.error_category).toBeUndefined();
    expect(record.fields.error).toBeUndefined();
  }
}

function refusedIdentity(): IdentityResolver {
  return createIdentityResolver({
    resolveIdentity: () =>
      Promise.reject(
        new ConnectError(
          "telegram_user_id must be positive",
          Code.InvalidArgument,
        ),
      ),
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
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
        version: 1,
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
    expectBoundary(records[0], {
      level: "debug",
      result: "ok",
      operation: "message",
      use_case: "find_meetup",
    });
    expect(calls[0]?.payload).toMatchObject({
      reply_markup: {
        inline_keyboard: [
          [{ text: "Ближайшие сходки", callback_data: "v1:nav:hub" }],
          [{ text: "Управление сходками", callback_data: "v1:manage:menu" }],
        ],
      },
    });
  });

  it("shows the waiting frame on /start when the person has no member role", async () => {
    const execute = vi.fn<Dispatcher["execute"]>();
    const { bot, calls, records } = createHarness(resolvedIdentity([]), {
      execute,
    });
    await bot.init();
    await bot.handleUpdate(messageUpdate());
    expect(sendMessageText(calls[0])).toBe(pendingHubAccessText);
    expect(calls[0]?.payload).not.toHaveProperty("reply_markup");
    expect(execute).not.toHaveBeenCalled();
    expectBoundary(records[0], {
      level: "warn",
      result: "error",
      error_category: "authorization",
      use_case: "find_meetup",
    });
    expect(records[0]?.fields.error).toBe("hub_access_pending");
    expect(records[0]?.fields.identity_id).toBe(
      "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd",
    );
  });

  it("shows the closed frame on /start when the person is blocked", async () => {
    const execute = vi.fn<Dispatcher["execute"]>();
    const { bot, calls, records } = createHarness(
      resolvedIdentity(["member"], true),
      { execute },
    );
    await bot.init();
    await bot.handleUpdate(messageUpdate());
    expect(sendMessageText(calls[0])).toBe(blockedHubAccessText);
    expect(execute).not.toHaveBeenCalled();
    expectBoundary(records[0], {
      level: "warn",
      result: "error",
      error_category: "authorization",
      use_case: "find_meetup",
    });
    expect(records[0]?.fields.error).toBe("hub_access_blocked");
  });

  it("does not show meetups to a pending person by list or deep link", async () => {
    const execute = vi.fn<Dispatcher["execute"]>();
    const { bot, calls, records } = createHarness(
      resolvedIdentity(["public"]),
      {
        execute,
      },
    );
    await bot.init();
    await bot.handleUpdate(callbackUpdate("v1:nav:hub"));
    await bot.handleUpdate(messageUpdate("/start m_AZLzpLXGfY6fChssPU5fYA"));
    expect(execute).not.toHaveBeenCalled();
    expect(calls[1]).toMatchObject({
      method: "editMessageText",
      payload: { text: pendingHubAccessText },
    });
    expect(JSON.stringify(calls[1]?.payload)).not.toContain("v1:nav:hub");
    expect(sendMessageText(calls[2])).toBe(pendingHubAccessText);
    expect(records.map((record) => record.fields.error)).toEqual([
      "hub_access_pending",
      "hub_access_pending",
    ]);
  });

  it("does not open management for a person outside the member circle", async () => {
    const execute = vi.fn<Dispatcher["execute"]>();
    const { bot, calls } = createHarness(resolvedIdentity(["public"]), {
      execute,
    });
    await bot.init();
    await bot.handleUpdate(callbackUpdate("v1:manage:menu"));
    expect(execute).not.toHaveBeenCalled();
    expect(calls[1]).toMatchObject({
      method: "editMessageText",
      payload: { text: pendingHubAccessText },
    });
  });

  it("opens /start for an admin without a stored member row", async () => {
    const { bot, calls } = createHarness(resolvedIdentity(["admin"]));
    await bot.init();
    await bot.handleUpdate(messageUpdate());
    expect(sendMessageText(calls[0])).toContain("Привет.");
    expect(sendMessageText(calls[0])).not.toBe(pendingHubAccessText);
  });

  it("renders the community screen from current Identity state", async () => {
    const community = vi
      .fn<CommunityAdministrator["community"]>()
      .mockResolvedValue({
        kind: "ok",
        value: {
          members: [
            {
              identityId: "0192f3a4-b5c6-7d8e-9f0a-1b2c3d4e5f60",
              telegramUsername: "waiting",
              admitted: false,
            },
          ],
          allowedUsernames: ["invited"],
        },
      });
    const identity = { ...resolvedIdentity(["admin"]), community };
    const { bot, calls } = createHarness(identity);
    await bot.init();
    await bot.handleUpdate(callbackUpdate("v1:community:list"));

    expect(community).toHaveBeenCalledWith(
      expect.objectContaining({ globalRoles: ["admin"] }),
      expect.objectContaining({ useCase: "manage_community" }),
    );
    expect(calls[1]).toMatchObject({
      method: "editMessageText",
      payload: { text: expect.stringContaining("@waiting") },
    });
    expect(JSON.stringify(calls[1]?.payload)).toContain("v1:community:admit:");
    expect(JSON.stringify(calls[1]?.payload)).toContain("@invited");
  });

  it("lets Identity refuse community management for a non-admin", async () => {
    const community = vi
      .fn<CommunityAdministrator["community"]>()
      .mockResolvedValue({ kind: "forbidden" });
    const identity = { ...resolvedIdentity(["member"]), community };
    const { bot, calls, records } = createHarness(identity);
    await bot.init();
    await bot.handleUpdate(callbackUpdate("v1:community:list"));

    expect(community).toHaveBeenCalledOnce();
    expect(calls[1]).toMatchObject({
      method: "editMessageText",
      payload: { text: "Identity не разрешил управление составом." },
    });
    expectBoundary(records[0], {
      level: "warn",
      result: "error",
      operation: "callback_query",
      error_category: "authorization",
      use_case: "manage_community",
    });
  });

  it("keeps Identity unavailability distinct from a hub access refusal", async () => {
    const identity: IdentityResolver = {
      resolve: async () => ({ kind: "unavailable", cause: new Error("down") }),
    };
    const { bot, calls, records } = createHarness(identity);
    await bot.init();
    await bot.handleUpdate(messageUpdate());
    expect(sendMessageText(calls[0])).toContain("Это на моей стороне");
    expect(sendMessageText(calls[0])).not.toBe(pendingHubAccessText);
    expect(sendMessageText(calls[0])).not.toBe(blockedHubAccessText);
    expectBoundary(records[0], {
      level: "error",
      result: "error",
      error_category: "dependency_unavailable",
    });
  });

  it("logs a missing meetup as visibility, not as hub access", async () => {
    const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue({
      kind: "meetup-not-found",
    });
    const { bot, calls, records } = createHarness(resolvedIdentity(), {
      execute,
    });
    await bot.init();
    await bot.handleUpdate(messageUpdate("/start m_AZLzpLXGfY6fChssPU5fYA"));
    expect(sendMessageText(calls[0])).toBe(
      "Сходка не найдена или больше недоступна.",
    );
    expectBoundary(records[0], {
      level: "warn",
      result: "error",
      error_category: "visibility",
      use_case: "view_meetup",
    });
    expect(records[0]?.fields.error).toBe("meetup_not_visible");
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
            [{ text: "Уведомления", callback_data: "v1:notify:global" }],
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
            [{ text: "Уведомления", callback_data: "v1:notify:global" }],
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
    const { bot, calls, records } = createHarness(identity, { execute });
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
    expectBoundary(records[0], {
      level: "error",
      result: "error",
      error_category: "dependency_unavailable",
      operation: "callback_query",
      use_case: "find_meetup",
    });
  });

  it("records an Identity refusal while handling a form answer", async () => {
    let available = true;
    const identity: IdentityResolver = {
      resolve: async () =>
        available
          ? {
              kind: "resolved",
              identityId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd",
              globalRoles: ["member"],
              blocked: false,
            }
          : { kind: "unavailable", cause: new Error("down") },
    };
    const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue({
      kind: "ask",
      field: "title",
      meetup: {
        id: "0192f3a4-b5c6-7d8e-9f0a-1b2c3d4e5f60",
        title: "",
        description: "",
        venue: "",
        lifecycle: "planned",
        visibility: "hidden",
        version: 1,
      },
    });
    const { bot, calls, records } = createHarness(identity, { execute });
    await bot.init();
    await bot.handleUpdate(
      callbackUpdate("v1:manage:new:AZLzpLXGfY6fChssPU5fYA"),
    );
    available = false;
    await bot.handleUpdate(
      replyUpdate({
        text: "Настолки",
        fromId: 42,
        replyMessageId: 102,
        replyFromId: 1,
      }),
    );

    expect(sendMessageText(calls.at(-1))).toContain("Это на моей стороне");
    expectBoundary(records.at(-1), {
      level: "error",
      result: "error",
      error_category: "dependency_unavailable",
      use_case: "create_meetup",
    });
  });

  it("recovers a one-field edit from the replied bot message after restart", async () => {
    const meetup = publishedMeetup();
    const updated = { ...meetup, venue: "Новый зал" };
    const execute = vi.fn<Dispatcher["execute"]>(async (request) =>
      request.intent === "view-meetup"
        ? { kind: "meetup-card", meetup }
        : { kind: "meetup-updated", meetup: updated },
    );
    const first = createHarness(resolvedIdentity(["admin"]), { execute });
    await first.bot.init();
    await first.bot.handleUpdate(
      callbackUpdate("v1:manage:field:AZLzpLXGfY6fChssPU5fYA:venue"),
    );
    const question = first.calls.find((call) => call.method === "sendMessage");
    const questionText = sendMessageText(question);
    expect(questionText).toContain("Сейчас: Циферблат");
    expect(questionText).toContain(
      "Шаг: v1:manage:field:AZLzpLXGfY6fChssPU5fYA:venue",
    );

    const restarted = createHarness(resolvedIdentity(["admin"]), { execute });
    await restarted.bot.init();
    await restarted.bot.handleUpdate(
      replyUpdate({
        text: "Новый зал",
        fromId: 42,
        replyMessageId: 102,
        replyFromId: 1,
        replyText: questionText,
      }),
    );

    expect(execute).toHaveBeenLastCalledWith({
      identity: {
        identityId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd",
        globalRoles: ["admin"],
      },
      intent: "update-meetup-field",
      field: "venue",
      value: "Новый зал",
      meetupId: meetup.id,
      requestId: expect.any(String),
      useCase: "update_meetup",
    });
    expect(
      restarted.calls.some(
        (call) => sendMessageText(call) === "Изменение сохранено.",
      ),
    ).toBe(true);
  });

  it("asks before unpublishing and refusal performs no state command", async () => {
    const meetup = publishedMeetup();
    const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue({
      kind: "meetup-card",
      meetup,
    });
    const { bot, calls } = createHarness(resolvedIdentity(["admin"]), {
      execute,
    });
    await bot.init();

    await bot.handleUpdate(
      callbackUpdate("v1:manage:unpublish:AZLzpLXGfY6fChssPU5fYA"),
    );
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenLastCalledWith(
      expect.objectContaining({ intent: "view-meetup" }),
    );
    expect(calls.at(-1)).toMatchObject({
      method: "editMessageText",
      payload: {
        text: expect.stringContaining("Точно скрыть сходку"),
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "Да, продолжить",
                callback_data:
                  "v1:manage:confirm-unpublish:AZLzpLXGfY6fChssPU5fYA",
              },
            ],
            [
              {
                text: "Нет",
                callback_data: "v1:manage:status:AZLzpLXGfY6fChssPU5fYA",
              },
            ],
          ],
        },
      },
    });

    await bot.handleUpdate(
      callbackUpdate("v1:manage:status:AZLzpLXGfY6fChssPU5fYA"),
    );
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenLastCalledWith(
      expect.objectContaining({ intent: "view-meetup" }),
    );
  });

  it("executes cancellation only from the confirmation callback", async () => {
    const meetup = publishedMeetup();
    const cancelled = { ...meetup, lifecycle: "cancelled" as const };
    const execute = vi.fn<Dispatcher["execute"]>(async (request) =>
      request.intent === "view-meetup"
        ? { kind: "meetup-card", meetup }
        : {
            kind: "meetup-state-changed",
            action: "cancel",
            meetup: cancelled,
          },
    );
    const { bot } = createHarness(resolvedIdentity(["admin"]), { execute });
    await bot.init();

    await bot.handleUpdate(
      callbackUpdate("v1:manage:cancel:AZLzpLXGfY6fChssPU5fYA"),
    );
    expect(execute).toHaveBeenCalledTimes(1);
    await bot.handleUpdate(
      callbackUpdate("v1:manage:confirm-cancel:AZLzpLXGfY6fChssPU5fYA"),
    );
    expect(execute).toHaveBeenLastCalledWith({
      identity: {
        identityId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd",
        globalRoles: ["admin"],
      },
      intent: "change-meetup-state",
      action: "cancel",
      meetupId: meetup.id,
      requestId: expect.any(String),
      useCase: "update_meetup",
    });
  });

  it("answers an old management button from an already cancelled meetup", async () => {
    const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue({
      kind: "meetup-card",
      meetup: { ...publishedMeetup(), lifecycle: "cancelled" },
    });
    const { bot, calls } = createHarness(resolvedIdentity(["admin"]), {
      execute,
    });
    await bot.init();

    await bot.handleUpdate(
      callbackUpdate("v1:manage:cancel:AZLzpLXGfY6fChssPU5fYA"),
    );

    expect(calls.at(-1)).toMatchObject({
      method: "editMessageText",
      payload: { text: expect.stringContaining("уже отменена") },
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("refuses a stale republish button from a cancelled meetup", async () => {
    const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue({
      kind: "meetup-card",
      meetup: {
        ...publishedMeetup(),
        lifecycle: "cancelled",
        visibility: "hidden",
      },
    });
    const { bot, calls } = createHarness(resolvedIdentity(["admin"]), {
      execute,
    });
    await bot.init();

    await bot.handleUpdate(
      callbackUpdate("v1:manage:republish:AZLzpLXGfY6fChssPU5fYA"),
    );

    expect(calls.at(-1)).toMatchObject({
      method: "editMessageText",
      payload: { text: expect.stringContaining("уже отменена") },
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenLastCalledWith(
      expect.objectContaining({ intent: "view-meetup" }),
    );
  });

  it("republishes a hidden meetup from the status screen", async () => {
    const hidden = { ...publishedMeetup(), visibility: "hidden" as const };
    const visible = publishedMeetup();
    const execute = vi.fn<Dispatcher["execute"]>(async (request) =>
      request.intent === "view-meetup"
        ? { kind: "meetup-card", meetup: hidden }
        : { kind: "published", meetup: visible },
    );
    const { bot, calls } = createHarness(resolvedIdentity(["admin"]), {
      execute,
    });
    await bot.init();

    await bot.handleUpdate(
      callbackUpdate("v1:manage:republish:AZLzpLXGfY6fChssPU5fYA"),
    );

    expect(execute).toHaveBeenLastCalledWith({
      identity: {
        identityId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd",
        globalRoles: ["admin"],
      },
      intent: "publish-meetup",
      meetupId: visible.id,
      requestId: expect.any(String),
      useCase: "update_meetup",
    });
    expect(calls.at(-1)).toMatchObject({ method: "editMessageText" });
  });

  /// Конфликт версий — не молчаливая перезапись и не общий сбой: человек видит
  /// актуальные данные рядом со своим несохранённым вводом, а повторить правку
  /// может, только отправив значение заново (PER-78).
  it("shows the current meetup and the saved value on a version conflict", async () => {
    const changed = { ...publishedMeetup(), title: "Чужая правка", version: 2 };
    const execute = vi
      .fn<Dispatcher["execute"]>()
      .mockResolvedValueOnce({
        kind: "ask",
        field: "title",
        meetup: draftMeetup(),
      })
      .mockResolvedValueOnce({
        kind: "conflict",
        meetup: changed,
        field: "title",
        input: "Моя правка",
      });
    const { bot, calls, records } = createHarness(resolvedIdentity(), {
      execute,
    });
    await bot.init();
    await bot.handleUpdate(
      callbackUpdate("v1:manage:new:AZLzpLXGfY6fChssPU5fYA"),
    );
    await bot.handleUpdate(
      replyUpdate({
        text: "Моя правка",
        fromId: 42,
        replyMessageId: 102,
        replyFromId: 1,
      }),
    );

    expect(calls.at(-1)).toMatchObject({
      method: "sendMessage",
      payload: {
        text: expect.stringContaining(
          "Сходка уже изменилась. Ваши изменения не сохранены. Проверьте актуальные данные и повторите.",
        ),
        reply_markup: { force_reply: true, selective: true },
      },
    });
    expect(sendMessageText(calls.at(-1))).toContain("Сейчас: Чужая правка");
    expect(sendMessageText(calls.at(-1))).toContain(
      "Ваше значение: Моя правка",
    );
    expectBoundary(records.at(-1), {
      level: "warn",
      result: "error",
      error_category: "invariant",
      use_case: "create_meetup",
    });
    expect(records.at(-1)?.fields.error).toBe("version_conflict");
  });

  it("asks to confirm publication again after a version conflict", async () => {
    const changed = { ...publishedMeetup(), version: 2 };
    const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue({
      kind: "conflict",
      meetup: changed,
    });
    const { bot, calls, records } = createHarness(resolvedIdentity(), {
      execute,
    });
    await bot.init();
    await bot.handleUpdate(
      callbackUpdate("v1:manage:publish:AZLzpLXGfY6fChssPU5fYA"),
    );

    expect(calls.at(-1)).toMatchObject({
      method: "sendMessage",
      payload: {
        text: expect.stringContaining(
          "Проверь данные и подтверди публикацию ещё раз.",
        ),
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "Опубликовать",
                callback_data: "v1:manage:publish:AZLzpLXGfY6fChssPU5fYA",
              },
            ],
          ],
        },
      },
    });
    expectBoundary(records.at(-1), {
      level: "warn",
      result: "error",
      error_category: "invariant",
      operation: "callback_query",
      use_case: "create_meetup",
    });
  });

  it("asks to confirm a cancellation again after a version conflict", async () => {
    const meetup = publishedMeetup();
    const changed = { ...meetup, version: 2 };
    const execute = vi.fn<Dispatcher["execute"]>(async (request) =>
      request.intent === "view-meetup"
        ? { kind: "meetup-card", meetup }
        : { kind: "conflict", meetup: changed, action: "cancel" },
    );
    const { bot, calls, records } = createHarness(resolvedIdentity(["admin"]), {
      execute,
    });
    await bot.init();
    await bot.handleUpdate(
      callbackUpdate("v1:manage:cancel:AZLzpLXGfY6fChssPU5fYA"),
    );
    await bot.handleUpdate(
      callbackUpdate("v1:manage:confirm-cancel:AZLzpLXGfY6fChssPU5fYA"),
    );

    expect(calls.at(-1)).toMatchObject({
      method: "editMessageText",
      payload: {
        text: expect.stringContaining(
          "Проверь данные и подтверди действие ещё раз.",
        ),
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "Отменить сходку",
                callback_data:
                  "v1:manage:confirm-cancel:AZLzpLXGfY6fChssPU5fYA",
              },
            ],
          ],
        },
      },
    });
    expectBoundary(records.at(-1), {
      level: "warn",
      result: "error",
      error_category: "invariant",
      operation: "callback_query",
      use_case: "update_meetup",
    });
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
        globalRoles: ["member"],
      },
      intent: "list-visible-meetups",
      requestId: expect.any(String),
      useCase: "find_meetup",
    });
    expect(calls[1]).toMatchObject({
      method: "editMessageText",
      payload: { text: expect.stringContaining("ни одной запланированной") },
    });
  });

  it("replies after publication with a start link and navigation", async () => {
    const meetup = publishedMeetup();
    const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue({
      kind: "published",
      meetup,
    });
    const { bot, calls, records } = createHarness(resolvedIdentity(), {
      execute,
    });
    await bot.init();
    await bot.handleUpdate(
      callbackUpdate("v1:manage:publish:AZLzpLXGfY6fChssPU5fYA"),
    );
    const reply = calls.find((call) => call.method === "sendMessage");
    expect(sendMessageText(reply)).toBe(
      "Сходка создана. Теперь она видна в списке.\n\nСсылка для чата:\nhttps://t.me/stub_bot?start=m_AZLzpLXGfY6fChssPU5fYA",
    );
    expect(reply?.payload).toMatchObject({
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "Открыть сходку",
              callback_data: "v1:view:AZLzpLXGfY6fChssPU5fYA",
            },
            { text: "К управлению", callback_data: "v1:manage:menu" },
          ],
        ],
      },
    });
    const published = records.find(
      (record) => record.message === "meetup published",
    );
    expectBoundary(published, {
      level: "debug",
      result: "ok",
      operation: "callback_query",
      use_case: "create_meetup",
    });
    expect(published?.fields.meetup_id).toBe(
      "0192f3a4-b5c6-7d8e-9f0a-1b2c3d4e5f60",
    );
    expect(JSON.stringify(published?.fields)).not.toContain("start=");
    expect(JSON.stringify(published?.fields)).not.toContain("m_AZL");
    expect(published?.fields).not.toHaveProperty("payload");
    expect(published?.fields).not.toHaveProperty("link");
  });

  it("records meetup_id when publication is rejected", async () => {
    const counted = vi.spyOn(failures, "countFailure");
    const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue({
      kind: "dependency-rejected",
      reason: "forbidden",
    });
    const { bot, records } = createHarness(resolvedIdentity(), { execute });
    await bot.init();
    await bot.handleUpdate(
      callbackUpdate("v1:manage:publish:AZLzpLXGfY6fChssPU5fYA"),
    );
    const rejected = records.find(
      (record) => record.message === "meetup publish rejected",
    );
    expectBoundary(rejected, {
      level: "warn",
      result: "error",
      error_category: "authorization",
      operation: "callback_query",
      use_case: "create_meetup",
    });
    expect(counted).toHaveBeenCalledOnce();
    expect(counted).toHaveBeenCalledWith("authorization");
    expect(rejected?.fields.meetup_id).toBe(
      "0192f3a4-b5c6-7d8e-9f0a-1b2c3d4e5f60",
    );
    expect(JSON.stringify(rejected?.fields)).not.toContain("start=");
    expect(JSON.stringify(rejected?.fields)).not.toContain("m_AZL");
  });

  it("shows the domain's rejection message for a stale republish attempt", async () => {
    const meetup = publishedMeetup();
    const execute = vi.fn<Dispatcher["execute"]>(async (request) =>
      request.intent === "view-meetup"
        ? { kind: "meetup-card", meetup }
        : {
            kind: "dependency-rejected",
            reason: "invalid",
            message: "meetup is already published",
          },
    );
    const { bot, calls } = createHarness(resolvedIdentity(["admin"]), {
      execute,
    });
    await bot.init();
    await bot.handleUpdate(
      callbackUpdate("v1:manage:republish:AZLzpLXGfY6fChssPU5fYA"),
    );
    expect(calls.at(-1)).toMatchObject({
      method: "editMessageText",
      payload: {
        text: expect.stringContaining("meetup is already published"),
      },
    });
  });

  it("opens the published meetup from the generated start link", async () => {
    const meetup = publishedMeetup();
    const execute = vi
      .fn<Dispatcher["execute"]>()
      .mockResolvedValueOnce({ kind: "published", meetup })
      .mockResolvedValueOnce({ kind: "meetup-card", meetup });
    const { bot, calls } = createHarness(resolvedIdentity(), { execute });
    await bot.init();
    await bot.handleUpdate(
      callbackUpdate("v1:manage:publish:AZLzpLXGfY6fChssPU5fYA"),
    );
    const text = sendMessageText(
      calls.find((call) => call.method === "sendMessage"),
    );
    const payload = text?.match(/\?start=(m_[A-Za-z0-9_-]{22})/)?.[1];
    expect(payload).toBe("m_AZLzpLXGfY6fChssPU5fYA");
    await bot.handleUpdate(messageUpdate(`/start ${payload}`));
    expect(execute).toHaveBeenLastCalledWith({
      identity: {
        identityId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd",
        globalRoles: ["member"],
      },
      intent: "view-meetup",
      meetupId: "0192f3a4-b5c6-7d8e-9f0a-1b2c3d4e5f60",
      requestId: expect.any(String),
      useCase: "view_meetup",
    });
    expect(calls.at(-1)).toMatchObject({
      method: "sendRichMessage",
      payload: {
        rich_message: {
          html: expect.stringContaining("Статус: запланирована, видна"),
        },
      },
    });
  });

  it("answers a hidden meetup deep link like a missing meetup", async () => {
    const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue({
      kind: "meetup-not-found",
    });
    const { bot, calls } = createHarness(resolvedIdentity(), { execute });
    await bot.init();
    await bot.handleUpdate(messageUpdate("/start m_AZLzpLXGfY6fChssPU5fYA"));
    expect(sendMessageText(calls[0])).toBe(
      "Сходка не найдена или больше недоступна.",
    );
    expect(calls[0]?.payload).toMatchObject({
      reply_markup: {
        inline_keyboard: [[{ text: "К списку", callback_data: "v1:nav:hub" }]],
      },
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
        version: 1,
      },
    });
    const { bot, calls } = createHarness(resolvedIdentity(), { execute });
    await bot.init();
    await bot.handleUpdate(messageUpdate("/start m_AZLzpLXGfY6fChssPU5fYA"));
    expect(execute).toHaveBeenCalledWith({
      identity: {
        identityId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd",
        globalRoles: ["member"],
      },
      intent: "view-meetup",
      meetupId: "0192f3a4-b5c6-7d8e-9f0a-1b2c3d4e5f60",
      requestId: expect.any(String),
      useCase: "view_meetup",
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
      use_case: "view_meetup",
    });
  });

  it("does not report a dispatcher rejection as dependency unavailability", async () => {
    const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue({
      kind: "rejected",
      reason: "meetups-not-configured",
    });
    const { bot, records } = createHarness(resolvedIdentity(), { execute });
    await bot.init();
    await bot.handleUpdate(messageUpdate("/start m_AZLzpLXGfY6fChssPU5fYA"));

    expectBoundary(records[0], {
      level: "error",
      result: "error",
      error_category: "unexpected",
      use_case: "view_meetup",
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
    expect(records[0]?.fields.use_case).toBe("find_meetup");
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
    expect(records[0]?.fields.use_case).toBe("find_meetup");
  });

  it("carries the boundary request id into the identity call", async () => {
    let seenRequestId: string | undefined;
    let seenUseCase: string | undefined;
    const identity: IdentityResolver = {
      resolve: async (_input, meta) => {
        seenRequestId = meta?.requestId;
        seenUseCase = meta?.useCase;
        return {
          kind: "resolved",
          identityId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd",
          globalRoles: ["member"],
          blocked: false,
        };
      },
    };
    const { bot, records } = createHarness(identity);
    await bot.init();
    await bot.handleUpdate(messageUpdate());
    expect(seenRequestId).toBe(records[0]?.fields.request_id);
    expect(seenRequestId).not.toBe("");
    expect(seenUseCase).toBe("find_meetup");
    expect(records[0]?.fields.use_case).toBe("find_meetup");
  });

  it("sends view_meetup to identity when a meetup deep link starts the chain", async () => {
    let seenUseCase: string | undefined;
    const identity: IdentityResolver = {
      resolve: async (_input, meta) => {
        seenUseCase = meta?.useCase;
        return {
          kind: "resolved",
          identityId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd",
          globalRoles: ["member"],
          blocked: false,
        };
      },
    };
    const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue({
      kind: "meetup-not-found",
    });
    const { bot } = createHarness(identity, { execute });
    await bot.init();
    await bot.handleUpdate(messageUpdate("/start m_AZLzpLXGfY6fChssPU5fYA"));
    expect(seenUseCase).toBe("view_meetup");
  });

  it("uses different operation values for message and callback records", async () => {
    const { bot, records } = createHarness(refusedIdentity());
    await bot.init();
    await bot.handleUpdate(messageUpdate());
    await bot.handleUpdate(callbackUpdate("v1:nav:hub"));
    expect(records[0]?.fields.operation).toBe("message");
    expect(records[1]?.fields.operation).toBe("callback_query");
    expect(records[0]?.fields.operation).not.toBe(records[1]?.fields.operation);
  });

  it("records a successful callback, not only its failures", async () => {
    const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue({
      kind: "meetup-list",
      meetups: [],
    });
    const { bot, records } = createHarness(resolvedIdentity(), { execute });
    await bot.init();
    await bot.handleUpdate(callbackUpdate("v1:nav:hub"));
    expectBoundary(records[0], {
      level: "debug",
      result: "ok",
      operation: "callback_query",
      use_case: "find_meetup",
    });
  });

  it.each([
    {
      name: "list",
      data: "v1:nav:hub",
      result: { kind: "meetup-list" as const, meetups: [] },
      use_case: "find_meetup",
      message: "meetup list sent",
    },
    {
      name: "card",
      data: "v1:view:AZLzpLXGfY6fChssPU5fYA",
      result: { kind: "meetup-card" as const, meetup: publishedMeetup() },
      use_case: "view_meetup",
      message: "meetup card sent",
    },
    {
      name: "menu",
      data: "v1:manage:menu",
      result: undefined,
      use_case: "create_meetup",
      message: "manage menu sent",
    },
    {
      name: "draft",
      data: "v1:manage:new:AZLzpLXGfY6fChssPU5fYA",
      result: {
        kind: "ask" as const,
        field: "title" as const,
        meetup: draftMeetup(),
      },
      use_case: "create_meetup",
      message: "meetup form step sent",
    },
    {
      name: "publish",
      data: "v1:manage:publish:AZLzpLXGfY6fChssPU5fYA",
      result: { kind: "published" as const, meetup: publishedMeetup() },
      use_case: "create_meetup",
      message: "meetup published",
    },
    {
      name: "outdated",
      data: "v2:nav:hub",
      result: { kind: "meetup-list" as const, meetups: [] },
      use_case: "find_meetup",
      message: "meetup list sent",
    },
  ])(
    "records exactly one $name callback boundary at debug",
    async ({ data, result, use_case, message }) => {
      const execute =
        result === undefined
          ? vi.fn<Dispatcher["execute"]>().mockImplementation(() => {
              throw new Error("dispatcher should not run");
            })
          : vi.fn<Dispatcher["execute"]>().mockResolvedValue(result);
      const { bot, records } = createHarness(resolvedIdentity(), { execute });
      await bot.init();
      await bot.handleUpdate(callbackUpdate(data));
      expect(records).toHaveLength(1);
      expect(records.some((record) => record.level === "info")).toBe(false);
      expectBoundary(records[0], {
        level: "debug",
        result: "ok",
        operation: "callback_query",
        use_case,
      });
      expect(records[0]?.message).toBe(message);
    },
  );

  it("records a rejected callback screen as an error", async () => {
    const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue({
      kind: "dependency-rejected",
      reason: "unavailable",
    });
    const { bot, records } = createHarness(resolvedIdentity(), { execute });
    await bot.init();
    await bot.handleUpdate(callbackUpdate("v1:nav:hub"));
    expectBoundary(records[0], {
      level: "warn",
      result: "error",
      error_category: "dependency_unavailable",
      operation: "callback_query",
      use_case: "find_meetup",
    });
  });

  it("keeps use_case on an unexpected callback failure", async () => {
    const execute = vi.fn<Dispatcher["execute"]>().mockImplementation(() => {
      throw new Error("boom");
    });
    const { bot, records } = createHarness(resolvedIdentity(), { execute });
    await bot.init();
    await bot.handleUpdate(
      callbackUpdate("v1:manage:publish:AZLzpLXGfY6fChssPU5fYA"),
    );
    expectBoundary(records[0], {
      level: "error",
      result: "error",
      error_category: "unexpected",
      operation: "callback_query",
      use_case: "create_meetup",
    });
    expect(records[0]?.fields.error).toBe("boom");
    expect(typeof records[0]?.fields.stack).toBe("string");
  });

  it("keeps use_case when acknowledging a callback fails", async () => {
    const { logger, records } = createCapturingLogger();
    const bot = createBot({
      token: "111:test-token",
      dispatcher: createDispatcher(),
      identity: resolvedIdentity(),
      logger,
    });
    bot.botInfo = botInfo;
    const failing: Transformer = (_prev, method) =>
      method === "answerCallbackQuery"
        ? Promise.reject(new Error("query is too old"))
        : Promise.resolve({ ok: true, result: true as never });
    bot.api.config.use(failing);
    await bot.init();
    await bot.handleUpdate(callbackUpdate("v1:view:AZLzpLXGfY6fChssPU5fYA"));
    expectBoundary(records[0], {
      level: "error",
      result: "error",
      error_category: "unexpected",
      operation: "callback_query",
      use_case: "view_meetup",
    });
    expect(records[0]?.fields.error).toBe("query is too old");
  });

  it("logs malformed callback data without its payload", async () => {
    const counted = vi.spyOn(failures, "countFailure");
    const { bot, records } = createHarness(resolvedIdentity());
    await bot.init();
    await bot.handleUpdate(callbackUpdate("v1:view:short"));
    expect(records).toHaveLength(1);
    expectBoundary(records[0], {
      level: "warn",
      result: "error",
      error_category: "invariant",
      operation: "callback_query",
    });
    expect(records[0]?.fields.use_case).toBeUndefined();
    expect(records[0]?.fields.stack).toBeUndefined();
    expect(counted).toHaveBeenCalledOnce();
    expect(counted).toHaveBeenCalledWith("invariant");
    expect(JSON.stringify(records[0]?.fields)).not.toContain("short");
  });

  it("keeps malformed callback data as invariant when acknowledgement fails", async () => {
    const counted = vi.spyOn(failures, "countFailure");
    const { logger, records } = createCapturingLogger();
    const bot = createBot({
      token: "111:test-token",
      dispatcher: createDispatcher(),
      identity: resolvedIdentity(),
      logger,
    });
    bot.botInfo = botInfo;
    const failing: Transformer = (_prev, method) =>
      method === "answerCallbackQuery"
        ? Promise.reject(new Error("query is too old"))
        : Promise.resolve({ ok: true, result: true as never });
    bot.api.config.use(failing);
    await bot.init();
    await bot.handleUpdate(callbackUpdate("v1:view:short"));
    expect(records).toHaveLength(1);
    expectBoundary(records[0], {
      level: "warn",
      result: "error",
      error_category: "invariant",
      operation: "callback_query",
    });
    expect(records[0]?.fields.stack).toBeUndefined();
    expect(records[0]?.fields.reply_error).toBe("query is too old");
    expect(counted).toHaveBeenCalledOnce();
    expect(counted).toHaveBeenCalledWith("invariant");
  });

  it("records a foreign answer to a pending question", async () => {
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
        version: 1,
      },
    });
    const { bot, records } = createHarness(resolvedIdentity(), { execute });
    await bot.init();
    await bot.handleUpdate(
      callbackUpdate("v1:manage:new:AZLzpLXGfY6fChssPU5fYA"),
    );
    const before = records.length;
    await bot.handleUpdate(
      replyUpdate({
        text: "Чужое название",
        fromId: 43,
        replyMessageId: 102,
        replyFromId: 1,
      }),
    );
    expect(records.length).toBe(before + 1);
    expectBoundary(records.at(-1), {
      level: "debug",
      result: "ok",
      operation: "message",
      use_case: "create_meetup",
    });
  });

  it("records view_meetup when identity refuses opening a meetup", async () => {
    const { bot, records } = createHarness(refusedIdentity());
    await bot.init();
    await bot.handleUpdate(messageUpdate("/start m_AZLzpLXGfY6fChssPU5fYA"));
    expectBoundary(records[0], {
      level: "error",
      result: "error",
      error_category: "invariant",
      use_case: "view_meetup",
    });
  });

  it("records view_meetup when identity refuses a meetup callback", async () => {
    const { bot, records } = createHarness(refusedIdentity());
    await bot.init();
    await bot.handleUpdate(callbackUpdate("v1:view:AZLzpLXGfY6fChssPU5fYA"));
    expectBoundary(records[0], {
      level: "error",
      result: "error",
      error_category: "invariant",
      operation: "callback_query",
      use_case: "view_meetup",
    });
  });

  it("records create_meetup when identity refuses publication", async () => {
    const { bot, records } = createHarness(refusedIdentity());
    await bot.init();
    await bot.handleUpdate(
      callbackUpdate("v1:manage:publish:AZLzpLXGfY6fChssPU5fYA"),
    );
    expectBoundary(records[0], {
      level: "error",
      result: "error",
      error_category: "invariant",
      operation: "callback_query",
      use_case: "create_meetup",
    });
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
      use_case: "find_meetup",
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

async function requestedUrl(
  environment: TelegramEnvironment | undefined,
): Promise<string | undefined> {
  const { logger } = createCapturingLogger();
  const runtime = {
    token: "111:test-token",
    dispatcher: createDispatcher(),
    identity: resolvedIdentity(),
    logger,
  };
  const bot = createBot(
    environment === undefined ? runtime : { ...runtime, environment },
  );
  const urls: string[] = [];
  // URL строит сам grammY из опций, которые ему отдал createBot: подменяется
  // только транспорт. Иначе тест проверял бы собственную склейку строки, а не
  // ту, по которой пойдут вызовы Bot API.
  const api = new Api(bot.api.token, {
    ...bot.api.options,
    fetch: (input: Parameters<typeof fetch>[0]) => {
      urls.push(String(input));
      return Promise.resolve(Response.json({ ok: true, result: botInfo }));
    },
  });
  await api.getMe();
  return urls[0];
}

describe("telegram environment", () => {
  it("reads an absent or empty variable as production", () => {
    expect(parseTelegramEnvironment(undefined)).toBe("prod");
    expect(parseTelegramEnvironment("")).toBe("prod");
  });

  it("accepts exactly the two known values", () => {
    expect(parseTelegramEnvironment("prod")).toBe("prod");
    expect(parseTelegramEnvironment("test")).toBe("test");
  });

  it("refuses an unknown value instead of falling back to production", () => {
    expect(parseTelegramEnvironment("Test")).toBeUndefined();
    expect(parseTelegramEnvironment("production")).toBeUndefined();
    expect(parseTelegramEnvironment(" test")).toBeUndefined();
  });

  it("calls the test server when the test environment is chosen", async () => {
    await expect(requestedUrl("test")).resolves.toBe(
      "https://api.telegram.org/bot111:test-token/test/getMe",
    );
  });

  it("calls production without the variable and with the production value", async () => {
    await expect(requestedUrl(undefined)).resolves.toBe(
      "https://api.telegram.org/bot111:test-token/getMe",
    );
    await expect(requestedUrl("prod")).resolves.toBe(
      "https://api.telegram.org/bot111:test-token/getMe",
    );
  });
});

type RenderedScreen = {
  text?: string;
  reply_markup?: {
    inline_keyboard: { text: string; callback_data: string }[][];
  };
};

// `ApiPayload` размечен методом Bot API, и обращение к полю кадра из union не
// проходит по типам. Сужение стоит одной функцией, а не приведением в каждом
// ожидании.
function screen(call: RecordedCall | undefined): RenderedScreen {
  return (call?.payload ?? {}) as RenderedScreen;
}

describe("notification frames", () => {
  const token = "AZjypHwefTqbIU-OEqs0zw";
  const meetupId = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cf";
  const meetup = {
    id: meetupId,
    title: "Настолки у Лёши",
    description: "",
    venue: "",
    lifecycle: "planned" as const,
    visibility: "visible" as const,
    version: 1,
  };

  it("offers subscribing from the card and carries the target state", async () => {
    const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue({
      kind: "meetup-card",
      meetup,
      subscribed: false,
    });
    const { bot, calls } = createHarness(resolvedIdentity(), { execute });
    await bot.init();
    await bot.handleUpdate(callbackUpdate(`v1:view:${token}`));
    const keyboard = screen(calls[1]).reply_markup;
    expect(keyboard?.inline_keyboard[0]).toEqual([
      { text: "Подписаться", callback_data: `v1:notify:sub:${token}:1` },
      { text: "Уведомления", callback_data: `v1:notify:settings:${token}` },
    ]);
  });

  it("offers unsubscribing when the person already follows the meetup", async () => {
    const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue({
      kind: "meetup-card",
      meetup,
      subscribed: true,
    });
    const { bot, calls } = createHarness(resolvedIdentity(), { execute });
    await bot.init();
    await bot.handleUpdate(callbackUpdate(`v1:view:${token}`));
    const keyboard = screen(calls[1]).reply_markup;
    expect(keyboard?.inline_keyboard[0]?.[0]).toEqual({
      text: "Отписаться",
      callback_data: `v1:notify:sub:${token}:0`,
    });
  });

  // Notifications не ответил: состояние подписки не показывается вовсе, а не
  // подставляется выдуманным «выключены». Вход в кадр настроек при этом
  // остаётся — он от состояния подписки не зависит.
  it("hides only the subscription button when the subscription state is unknown", async () => {
    const execute = vi
      .fn<Dispatcher["execute"]>()
      .mockResolvedValue({ kind: "meetup-card", meetup });
    const { bot, calls } = createHarness(resolvedIdentity(), { execute });
    await bot.init();
    await bot.handleUpdate(callbackUpdate(`v1:view:${token}`));
    const data = (screen(calls[1]).reply_markup?.inline_keyboard ?? [])
      .flat()
      .map((button) => button.callback_data);
    expect(data).toContain(`v1:notify:settings:${token}`);
    expect(data.some((value) => value.startsWith("v1:notify:sub:"))).toBe(
      false,
    );
  });

  // Подписку нажали в карточке — карточка и возвращается, с обновлённой
  // кнопкой, а не подменяется кадром настроек.
  it("answers a subscription press with the card, not the settings frame", async () => {
    const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue({
      kind: "meetup-card",
      meetup,
      subscribed: true,
    });
    const { bot, calls } = createHarness(resolvedIdentity(), { execute });
    await bot.init();
    await bot.handleUpdate(callbackUpdate(`v1:notify:sub:${token}:1`));
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: "set-meetup-subscription",
        subscribed: true,
      }),
    );
    const data = (screen(calls[1]).reply_markup?.inline_keyboard ?? [])
      .flat()
      .map((button) => button.callback_data);
    expect(data).toContain(`v1:notify:sub:${token}:0`);
    expect(data).toContain(`v1:view:${token}`);
  });

  // Кадр настроек кнопки подписки не несёт: действие живёт в карточке, и макет
  // этого экрана его не показывает.
  it("keeps the subscription action out of the settings frame", async () => {
    const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue({
      kind: "meetup-notification-settings",
      meetup,
      subscribed: false,
      categories: [
        { category: "changes", enabled: true, differsFromGlobal: false },
      ],
    });
    const { bot, calls } = createHarness(resolvedIdentity(), { execute });
    await bot.init();
    await bot.handleUpdate(callbackUpdate(`v1:notify:settings:${token}`));
    const data = (screen(calls[1]).reply_markup?.inline_keyboard ?? [])
      .flat()
      .map((button) => button.callback_data);
    expect(data.some((value) => value.startsWith("v1:notify:sub:"))).toBe(
      false,
    );
    expect(data).toContain(`v1:view:${token}`);
  });

  // Отказ по природе, а не один «сбой на моей стороне»: «Повторить» на отказе
  // по праву и на устаревшем экране не лечит ничего.
  it.each([
    ["forbidden", "Notifications не разрешил это действие.", "v1:nav:hub"],
    ["invalid", "Этот экран устарел.", "v1:notify:global"],
    ["conflict", "Это уже сделано.", "v1:notify:global"],
  ])(
    "renders a %s refusal as its own frame",
    async (reason, expected, retry) => {
      const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue(
        reason === "invalid"
          ? { kind: "dependency-rejected", reason, message: "bad category" }
          : {
              kind: "dependency-rejected",
              reason: reason as "forbidden" | "conflict",
            },
      );
      const { bot, calls } = createHarness(resolvedIdentity(), { execute });
      await bot.init();
      await bot.handleUpdate(callbackUpdate("v1:notify:global"));
      const rendered = screen(calls[1]);
      expect(rendered.text).toContain(expected);
      const data = (rendered.reply_markup?.inline_keyboard ?? [])
        .flat()
        .map((button) => button.callback_data);
      expect(data).toContain(retry);
    },
  );

  it("renders the meetup frame with checkboxes, the divergence mark and the pinning warning", async () => {
    const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue({
      kind: "meetup-notification-settings",
      meetup,
      subscribed: true,
      categories: [
        { category: "changes", enabled: true, differsFromGlobal: false },
        { category: "reminder", enabled: true, differsFromGlobal: true },
      ],
    });
    const { bot, calls } = createHarness(resolvedIdentity(), { execute });
    await bot.init();
    await bot.handleUpdate(callbackUpdate(`v1:notify:settings:${token}`));
    const payload = screen(calls[1]);
    expect(payload.text).toContain("Уведомления: Настолки у Лёши");
    expect(payload.text).toContain(
      "Переключение здесь закрепляет значение за этой сходкой",
    );
    expect(payload.reply_markup?.inline_keyboard[0]?.[0]).toEqual({
      text: "[x] Изменения данных и статуса",
      callback_data: `v1:notify:set:${token}:changes:0`,
    });
    expect(payload.reply_markup?.inline_keyboard[1]?.[0]).toEqual({
      text: "[x] Напоминание перед началом · отличается",
      callback_data: `v1:notify:set:${token}:reminder:0`,
    });
  });

  it("renders the global frame over the whole dictionary", async () => {
    const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue({
      kind: "global-notification-settings",
      categories: [
        { category: "published", enabled: true },
        { category: "announcement", enabled: false },
      ],
    });
    const { bot, calls } = createHarness(resolvedIdentity(), { execute });
    await bot.init();
    await bot.handleUpdate(callbackUpdate("v1:notify:global"));
    const payload = screen(calls[1]);
    expect(payload.text).toContain("Настройка действует для всех сходок");
    expect(payload.reply_markup?.inline_keyboard[0]?.[0]).toEqual({
      text: "[x] Новые сходки",
      callback_data: "v1:notify:gset:published:0",
    });
    expect(payload.reply_markup?.inline_keyboard[1]?.[0]).toEqual({
      text: "[ ] Объявления сообщества",
      callback_data: "v1:notify:gset:announcement:1",
    });
  });

  // E-05: отказ Notifications приходит кадром о сбое, а не пустым списком
  // категорий, который человек прочитал бы как «всё выключено».
  it("renders a Notifications refusal as E-05 instead of an empty frame", async () => {
    const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue({
      kind: "dependency-rejected",
      reason: "unavailable",
    });
    const { bot, calls } = createHarness(resolvedIdentity(), { execute });
    await bot.init();
    await bot.handleUpdate(callbackUpdate("v1:notify:global"));
    expect(screen(calls[1]).text).toContain("Это на моей стороне");
  });
});
