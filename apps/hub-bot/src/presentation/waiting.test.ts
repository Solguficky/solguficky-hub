import type { Update } from "grammy/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness, type RecordedCall } from "../../testkit/harness.js";
import type { Dispatcher } from "../application/dispatcher.js";
import type { ExecuteResult } from "../application/types.js";
import type { IdentityResolver } from "../identity/port.js";
import {
  actionBudgetMs,
  pressWatchdogMs,
  typingAfterMs,
  typingEveryMs,
} from "./waiting.js";

// L0: правило ожидания на собранном боте. Сервис здесь — обещание, которое
// тест держит открытым, а время — фальшивые таймеры: так видно, что человек
// получает между нажатием и результатом.

const chat = { id: 42, type: "private" as const, first_name: "tester" };
const from = { id: 42, is_bot: false, first_name: "tester" };

function press(data: string, message: Record<string, unknown> = {}): Update {
  return {
    update_id: 3,
    callback_query: {
      id: "callback-1",
      chat_instance: "chat-1",
      from,
      data,
      message: { message_id: 9, date: 0, chat, ...message },
    },
  };
}

function resolved(): IdentityResolver {
  return {
    resolve: vi.fn<IdentityResolver["resolve"]>().mockResolvedValue({
      kind: "resolved",
      identityId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd",
      globalRoles: ["member"],
      blocked: false,
    }),
  };
}

/** Сервис, который отвечает, когда скажет тест. */
function pendingService() {
  let respond: (result: ExecuteResult) => void = () => undefined;
  const execute = vi.fn<Dispatcher["execute"]>().mockImplementation(
    () =>
      new Promise<ExecuteResult>((resolveResult) => {
        respond = resolveResult;
      }),
  );
  return { execute, respond: (result: ExecuteResult) => respond(result) };
}

const emptyList: ExecuteResult = { kind: "meetup-list", meetups: [] };
const methods = (calls: readonly RecordedCall[]) =>
  calls.map((call) => call.method);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("waiting", () => {
  it("answers the press together with the result, not before the service", async () => {
    const service = pendingService();
    const { bot, calls } = createHarness(resolved(), service);
    await bot.init();

    const handled = bot.handleUpdate(press("v1:nav:hub"));
    await vi.advanceTimersByTimeAsync(typingAfterMs - 1);
    expect(methods(calls)).toEqual([]);

    service.respond(emptyList);
    await handled;
    expect(methods(calls)).toEqual(["answerCallbackQuery", "editMessageText"]);
    expect(calls[0]?.payload).not.toHaveProperty("text");
  });

  it("shows typing after a second and keeps it until the screen is out", async () => {
    const service = pendingService();
    const { bot, calls } = createHarness(resolved(), service);
    await bot.init();

    const handled = bot.handleUpdate(press("v1:nav:hub"));
    await vi.advanceTimersByTimeAsync(typingAfterMs);
    expect(methods(calls)).toEqual(["sendChatAction"]);
    expect(calls[0]?.payload).toMatchObject({ chat_id: 42, action: "typing" });

    await vi.advanceTimersByTimeAsync(typingEveryMs);
    expect(methods(calls)).toEqual(["sendChatAction", "sendChatAction"]);

    service.respond(emptyList);
    await handled;
    await vi.advanceTimersByTimeAsync(typingEveryMs * 2);
    expect(methods(calls)).toEqual([
      "sendChatAction",
      "sendChatAction",
      "answerCallbackQuery",
      "editMessageText",
    ]);
  });

  it("answers a hanging press by the watchdog and only once", async () => {
    const service = pendingService();
    const { bot, calls } = createHarness(resolved(), service);
    await bot.init();

    const handled = bot.handleUpdate(press("v1:nav:hub"));
    await vi.advanceTimersByTimeAsync(pressWatchdogMs);
    expect(
      methods(calls).filter((method) => method !== "sendChatAction"),
    ).toEqual(["answerCallbackQuery"]);

    service.respond(emptyList);
    await handled;
    expect(
      methods(calls).filter((method) => method !== "sendChatAction"),
    ).toEqual(["answerCallbackQuery", "editMessageText"]);
  });

  it("shows typing while a command waits for the service", async () => {
    const service = pendingService();
    const { bot, calls } = createHarness(resolved(), service);
    await bot.init();

    const handled = bot.handleUpdate({
      update_id: 1,
      message: { message_id: 7, date: 0, chat, from, text: "/menu" },
    });
    await vi.advanceTimersByTimeAsync(typingAfterMs);
    expect(methods(calls)).toEqual(["sendChatAction"]);

    service.respond({ kind: "message", text: "Привет" });
    await handled;
    expect(methods(calls)).toEqual(["sendChatAction", "sendMessage"]);
  });

  it("stays silent for a message it ignores", async () => {
    const identity = resolved();
    const { bot, calls } = createHarness(identity);
    await bot.init();

    await bot.handleUpdate({
      update_id: 1,
      message: { message_id: 7, date: 0, chat, from, text: "просто текст" },
    });
    await vi.advanceTimersByTimeAsync(pressWatchdogMs);

    expect(calls).toEqual([]);
    expect(identity.resolve).not.toHaveBeenCalled();
  });

  it("gives every service call of one action the same deadline", async () => {
    vi.setSystemTime(1_000_000);
    const identity = resolved();
    const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue(emptyList);
    const { bot } = createHarness(identity, { execute });
    await bot.init();

    await bot.handleUpdate(press("v1:nav:hub"));

    const deadlineAt = 1_000_000 + actionBudgetMs;
    expect(identity.resolve).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ deadlineAt }),
    );
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ deadlineAt }),
    );
  });

  it("confirms a toggle with a popup text", async () => {
    const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue({
      kind: "global-notification-settings",
      categories: [{ category: "published", enabled: true }],
    });
    const { bot, calls } = createHarness(resolved(), { execute });
    await bot.init();

    await bot.handleUpdate(press("v1:notify:gset:published:1"));

    expect(methods(calls)).toEqual(["answerCallbackQuery", "editMessageText"]);
    expect(calls[0]?.payload).toMatchObject({
      text: "Включено: новые сходки.",
    });
  });

  it("says a retry failed again instead of redrawing the same refusal", async () => {
    const down: IdentityResolver = {
      resolve: async () => ({ kind: "unavailable", cause: new Error("down") }),
    };
    const { bot, calls } = createHarness(down);
    await bot.init();
    await bot.handleUpdate(press("v1:nav:hub"));
    const refusal = calls.find((call) => call.method === "editMessageText");
    const shown = refusal?.payload as
      | { text?: string; reply_markup?: { inline_keyboard?: unknown } }
      | undefined;
    calls.length = 0;

    await bot.handleUpdate(
      press("v1:nav:hub", {
        // Telegram возвращает видимый текст, без разметки.
        text: shown?.text?.replace(/<[^>]+>/g, ""),
        reply_markup: {
          inline_keyboard: JSON.parse(
            JSON.stringify(shown?.reply_markup?.inline_keyboard),
          ),
        },
      }),
    );

    expect(methods(calls)).toEqual(["answerCallbackQuery"]);
    expect(calls[0]?.payload).toMatchObject({ text: "Пока не получилось." });
  });
});
