import { encodeAuctionCallback } from "@solguficky/auction-bot-ui";
import type { Transformer } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import { describe, expect, it, vi } from "vitest";
import { createBot } from "./bot.js";
import type { PortsFactory } from "./clients.js";
import { entryCallback } from "./faq.js";
import { createLogger, type Logger } from "./logging.js";

const botInfo: UserFromGetMe = {
  id: 1,
  is_bot: true,
  first_name: "stub",
  username: "stub_auction_bot",
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

const lotId = "01926f3c-8b7a-7cde-8f00-0123456789ab";
const from = { id: 42, is_bot: false, first_name: "Person" };
const privateChat = { id: 42, type: "private" as const, first_name: "Person" };

const silent: Logger = { info: () => {}, warn: () => {}, error: () => {} };

function makeBot(
  ports: PortsFactory,
  options: { logger?: Logger; refuse?: Record<string, string> } = {},
) {
  const bot = createBot({
    token: "111:test-token",
    environment: "prod",
    ports,
    logger: options.logger ?? silent,
    botInfo,
  });
  const calls: Array<{ method: string; payload: unknown }> = [];
  // Результат зависит от метода, фикстура его не знает: единственное
  // ослабление типа в тесте. Отказ Bot API задаётся описанием по методу.
  const recorder: Transformer = (_prev, method, payload) => {
    calls.push({ method, payload });
    const description = options.refuse?.[method];
    if (description !== undefined) {
      return Promise.resolve({ ok: false, error_code: 400, description });
    }
    return Promise.resolve({ ok: true, result: true as never });
  };
  bot.api.config.use(recorder);
  return { bot, calls };
}

const publicPorts: PortsFactory = () => ({
  identity: {
    resolveIdentity: async () => ({
      identityId: "01926f3c-8b7a-7cde-8f00-00000000000a",
      globalRoles: ["public"],
      blocked: false,
    }),
  },
  auction: {
    getLot: async () => ({ lotId, auctionId: lotId, version: 1 }),
  },
  faq: {
    acknowledged: async () => true,
    acknowledge: async () => {},
  },
});

function startUpdate(message: NonNullable<Update["message"]>): Update {
  return { update_id: 1, message };
}

describe("auction bot", () => {
  it("keeps completion across bot instances and permits reopening FAQ", async () => {
    let acknowledged = false;
    const ports: PortsFactory = (requestId) => ({
      ...publicPorts(requestId),
      faq: {
        acknowledged: async () => acknowledged,
        acknowledge: async () => {
          acknowledged = true;
        },
      },
    });
    const first = makeBot(ports);
    const start = startUpdate({
      message_id: 1,
      date: 0,
      chat: privateChat,
      from,
      text: "/start",
      entities: [{ type: "bot_command", offset: 0, length: 6 }],
    });
    await first.bot.handleUpdate(start);
    expect(first.calls[0]?.payload).toMatchObject({
      text: expect.stringContaining("Что продаём"),
    });
    expect(acknowledged).toBe(false);
    const press = (action: "menu" | "faq"): Update => ({
      update_id: 2,
      callback_query: {
        id: "entry-cb",
        from,
        chat_instance: "ci",
        data: entryCallback(action),
        message: { message_id: 7, date: 0, chat: privateChat, text: "old" },
      },
    });
    await first.bot.handleUpdate(press("menu"));
    expect(acknowledged).toBe(true);
    const restarted = makeBot(ports);
    await restarted.bot.handleUpdate(start);
    expect(restarted.calls[0]?.payload).toMatchObject({
      text: expect.stringContaining("Выберите раздел"),
    });
    await restarted.bot.handleUpdate(press("faq"));
    expect(restarted.calls.at(-1)?.payload).toMatchObject({
      text: expect.stringContaining("Что продаём"),
    });
  });

  it("answers /start with the menu for a returning admitted participant", async () => {
    const { bot, calls } = makeBot(publicPorts);
    await bot.handleUpdate(
      startUpdate({
        message_id: 1,
        date: 0,
        chat: privateChat,
        from,
        text: "/start",
        entities: [{ type: "bot_command", offset: 0, length: 6 }],
      }),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("sendMessage");
    expect(calls[0]?.payload).toMatchObject({
      chat_id: 42,
      text: expect.stringContaining("Аукцион"),
    });
    expect(calls[0]?.payload).toMatchObject({
      reply_markup: {
        inline_keyboard: [
          [{ text: "Аукционы", callback_data: expect.any(String) }],
          [{ text: "Правила и FAQ", callback_data: expect.any(String) }],
        ],
      },
    });
  });

  it("stays silent in a group", async () => {
    const { bot, calls } = makeBot(publicPorts);
    await bot.handleUpdate(
      startUpdate({
        message_id: 1,
        date: 0,
        chat: { id: -100, type: "group", title: "Group" },
        from,
        text: "/start",
        entities: [{ type: "bot_command", offset: 0, length: 6 }],
      }),
    );
    expect(calls).toEqual([]);
  });

  it("answers the press before calling services and edits the screen through the gateway", async () => {
    const order: string[] = [];
    const ports = vi.fn<PortsFactory>((requestId) => {
      const base = publicPorts(requestId);
      return {
        identity: {
          resolveIdentity: async (user) => {
            order.push("identity");
            return base.identity.resolveIdentity(user);
          },
        },
        auction: base.auction,
        faq: base.faq,
      };
    });
    const { bot, calls } = makeBot(ports);
    const recorder: Transformer = (prev, method, payload, signal) => {
      order.push(method);
      return prev(method, payload, signal);
    };
    bot.api.config.use(recorder);
    await bot.handleUpdate({
      update_id: 2,
      callback_query: {
        id: "cb",
        from,
        chat_instance: "ci",
        data: encodeAuctionCallback({ kind: "lot", lotId }),
        message: {
          message_id: 7,
          date: 0,
          chat: privateChat,
          text: "old",
        },
      },
    } as Update);
    expect(order.indexOf("answerCallbackQuery")).toBeLessThan(
      order.indexOf("identity"),
    );
    const edit = calls.find((call) => call.method === "editMessageText");
    expect(edit?.payload).toMatchObject({
      text: expect.stringContaining(lotId),
      reply_markup: {
        inline_keyboard: [
          [{ text: "Обновить", callback_data: expect.any(String) }],
          [{ text: "Правила и FAQ", callback_data: expect.any(String) }],
          [{ text: "В меню", callback_data: expect.any(String) }],
        ],
      },
    });
    expect(ports).toHaveBeenCalledWith(expect.any(String));
  });

  it("sends a new message when the pressed message cannot be edited", async () => {
    const { bot, calls } = makeBot(publicPorts, {
      refuse: { editMessageText: "Bad Request: message can't be edited" },
    });
    await bot.handleUpdate(lotPress());
    const sent = calls.find((call) => call.method === "sendMessage");
    expect(sent?.payload).toMatchObject({
      chat_id: 42,
      text: expect.stringContaining(lotId),
    });
  });

  it("logs the frame of the update without Telegram identifiers", async () => {
    const lines: string[] = [];
    const logger = createLogger("info", (line) => lines.push(line));
    const { bot } = makeBot(publicPorts, { logger });
    await bot.handleUpdate(lotPress());
    const record = JSON.parse(lines.at(-1) ?? "{}");
    expect(record).toMatchObject({
      service: "auction-bot",
      operation: "callback",
      result: "ok",
      screen: "auction",
      request_id: expect.any(String),
      duration_us: expect.any(Number),
      identity_id: "01926f3c-8b7a-7cde-8f00-00000000000a",
    });
    expect(lines.join("")).not.toContain('"42"');
    expect(lines.join("")).not.toContain("v1:auc");
  });
});

function lotPress(): Update {
  return {
    update_id: 3,
    callback_query: {
      id: "cb",
      from,
      chat_instance: "ci",
      data: encodeAuctionCallback({ kind: "lot", lotId }),
      message: { message_id: 7, date: 0, chat: privateChat, text: "old" },
    },
  } as Update;
}
