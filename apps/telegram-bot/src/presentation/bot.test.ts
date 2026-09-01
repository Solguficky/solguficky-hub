import type { Transformer } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import { describe, expect, it } from "vitest";
import { createDispatcher } from "../application/dispatcher.js";
import type { IdentityResolver } from "../identity/port.js";
import { createLogger } from "../logging.js";
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

function messageUpdate(): Update {
  return {
    update_id: 1,
    message: {
      message_id: 7,
      date: 0,
      chat: { id: 42, type: "private", first_name: "tester" },
      from: { id: 42, is_bot: false, first_name: "tester" },
      text: "ping",
    },
  };
}

function createHarness(identity: IdentityResolver) {
  const bot = createBot({
    token: "111:test-token",
    dispatcher: createDispatcher(),
    identity,
    logger: createLogger("error"),
  });
  bot.botInfo = botInfo;
  const calls: Array<{ method: string; payload: unknown }> = [];
  const recorder: Transformer = (_prev, method, payload) => {
    calls.push({ method, payload });
    return Promise.resolve({ ok: true, result: true as never });
  };
  bot.api.config.use(recorder);
  return { bot, calls };
}

describe("presentation adapter", () => {
  it("replies with the stub after identity resolution", async () => {
    const identity: IdentityResolver = {
      resolve: async () => ({
        kind: "resolved",
        identityId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd",
        globalRoles: [],
      }),
    };
    const { bot, calls } = createHarness(identity);
    await bot.init();
    await bot.handleUpdate(messageUpdate());
    expect(calls[0]?.method).toBe("sendMessage");
    const payload = calls[0]?.payload as { text?: string } | undefined;
    expect(payload?.text).toBe("заглушка");
  });

  it("replies fail-closed when identity is unavailable", async () => {
    const identity: IdentityResolver = {
      resolve: async () => ({ kind: "unavailable", cause: new Error("down") }),
    };
    const { bot, calls } = createHarness(identity);
    await bot.init();
    await bot.handleUpdate(messageUpdate());
    expect(calls[0]?.method).toBe("sendMessage");
    const payload = calls[0]?.payload as { text?: string } | undefined;
    expect(payload?.text).toBe("недоступно");
  });
});
