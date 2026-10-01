import { encodeAuctionCallback } from "@solguficky/auction-bot-ui";
import type { Transformer } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import { describe, expect, it, vi } from "vitest";
import { createBot } from "./bot.js";
import type { PortsFactory } from "./clients.js";
import type { Logger } from "./logging.js";

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

function makeBot(ports: PortsFactory) {
  const bot = createBot({
    token: "111:test-token",
    environment: "prod",
    ports,
    logger: silent,
    botInfo,
  });
  const calls: Array<{ method: string; payload: unknown }> = [];
  const recorder: Transformer = (_prev, method, payload) => {
    calls.push({ method, payload });
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
});

function startUpdate(message: NonNullable<Update["message"]>): Update {
  return { update_id: 1, message };
}

describe("auction bot", () => {
  it("answers /start with the entry shell and no trading buttons", async () => {
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
    expect(calls[0]?.payload).not.toHaveProperty("reply_markup");
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
        ],
      },
    });
    expect(ports).toHaveBeenCalledWith(expect.any(String));
  });
});
