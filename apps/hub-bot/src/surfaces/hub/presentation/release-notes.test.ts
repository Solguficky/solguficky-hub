import type { Update } from "grammy/types";
import { describe, expect, it, vi } from "vitest";
import {
  createHarness,
  type RecordedCall,
} from "../../../../testkit/harness.js";
import { noteCatalog } from "../../../core/release-notes.js";
import { noopTracing } from "../../../core/tracing.js";
import { createDispatcher } from "../application/dispatcher.js";
import type { IdentityResolver } from "../identity/port.js";
import type { Meetups } from "../meetups/port.js";
import type { Notifications } from "../notifications/port.js";

const latestId = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3401";
const olderId = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3402";

const notes = noteCatalog([
  {
    id: "known",
    surfaces: ["hub"],
    text: "Под сводкой аукциона теперь кнопка на каждый лот.",
  },
  {
    id: "second",
    surfaces: ["hub"],
    text: "Закрытый лот больше нельзя добавить в избранное.",
  },
]);

const identity: IdentityResolver = {
  resolve: async () => ({
    kind: "resolved",
    identityId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd",
    rights: ["access-hub"],
    blocked: false,
  }),
};

function callbackUpdate(data: string): Update {
  return {
    update_id: 3,
    callback_query: {
      id: "callback-1",
      chat_instance: "chat-1",
      from: { id: 42, is_bot: false, first_name: "tester" },
      data,
      message: {
        message_id: 9,
        date: 0,
        chat: { id: 42, type: "private", first_name: "tester" },
        from: { id: 1, is_bot: true, first_name: "bot" },
        text: "Что нового",
      },
    },
  };
}

function buttons(payload: unknown): { text: string; callback_data?: string }[] {
  const markup = (
    payload as {
      reply_markup?: {
        inline_keyboard?: { text: string; callback_data?: string }[][];
      };
    }
  ).reply_markup;
  return (markup?.inline_keyboard ?? []).flat();
}

function screenText(calls: readonly RecordedCall[]): string {
  const call = screen(calls);
  const text = call?.payload;
  return text !== undefined && "text" in text && typeof text.text === "string"
    ? text.text
    : "";
}

function screen(calls: readonly RecordedCall[]): RecordedCall | undefined {
  return calls.find(
    (call) =>
      call.method === "editMessageText" || call.method === "sendMessage",
  );
}

function port(overrides: Partial<Notifications>): Notifications {
  return {
    getGlobalPreferences: vi.fn(),
    getMeetupPreferences: vi.fn(),
    setSubscription: vi.fn(),
    setGlobalCategory: vi.fn(),
    setMeetupCategory: vi.fn(),
    getAuctionNotifications: vi.fn(),
    setAuctionNotifications: vi.fn(),
    broadcastToMeetupSubscribers: vi.fn(),
    broadcastToCommunity: vi.fn(),
    reportReleaseNotes: vi.fn(),
    listReleaseSummaries: vi.fn(),
    getReleaseSummary: vi.fn(),
    ...overrides,
  } as Notifications;
}

describe("what's new", () => {
  it("shows the latest summary, pages to the older one and has no forward arrow", async () => {
    const getReleaseSummary = vi.fn(async (summaryId: string) => {
      if (summaryId === olderId) {
        return {
          kind: "ok" as const,
          view: {
            summary: {
              id: olderId,
              summarizedAt: "2026-10-13T00:00:00Z",
              recordIds: ["second"],
            },
            newerId: latestId,
          },
        };
      }
      return {
        kind: "ok" as const,
        view: {
          summary: {
            id: latestId,
            summarizedAt: "2026-10-14T12:00:00Z",
            recordIds: ["known"],
          },
          olderId,
        },
      };
    });
    const dispatcher = createDispatcher(
      undefined,
      port({
        listReleaseSummaries: vi.fn().mockResolvedValue({
          kind: "ok",
          page: {
            summaries: [
              {
                id: latestId,
                summarizedAt: "2026-10-14T12:00:00Z",
                recordIds: ["known"],
              },
            ],
          },
        }),
        getReleaseSummary,
      }),
      undefined,
      undefined,
      undefined,
      undefined,
      notes,
    );
    const { bot, calls } = createHarness(
      identity,
      dispatcher,
      [],
      noopTracing(),
      undefined,
      () => ({ year: 2026, month: 10, day: 20 }),
      { communityTimeZone: "UTC" },
    );
    await bot.init();
    await bot.handleUpdate(callbackUpdate("v1:wn"));
    const latest = screen(calls);
    expect(screenText(calls)).toContain(
      "Под сводкой аукциона теперь кнопка на каждый лот.",
    );
    expect(screenText(calls)).toContain("Сводка: 14 октября, ср");
    expect(screenText(calls)).not.toContain("Только аукцион");
    const latestButtons = buttons(latest?.payload);
    expect(latestButtons.map((button) => button.text)).toEqual([
      "←",
      "‹ Помощь",
    ]);
    const older = latestButtons.find((button) => button.text === "←");
    calls.length = 0;
    await bot.handleUpdate(callbackUpdate(older?.callback_data ?? ""));
    const previous = screen(calls);
    expect(screenText(calls)).toContain(
      "Закрытый лот больше нельзя добавить в избранное.",
    );
    expect(buttons(previous?.payload).map((button) => button.text)).toEqual([
      "→",
      "‹ Помощь",
    ]);
  });

  it("says there is nothing new and still opens help after a notifications failure", async () => {
    const dispatcher = createDispatcher(
      undefined,
      port({
        listReleaseSummaries: vi
          .fn()
          .mockResolvedValueOnce({
            kind: "ok",
            page: { summaries: [] },
          })
          .mockResolvedValueOnce({
            kind: "unavailable",
            cause: new Error("unimplemented"),
          }),
      }),
      undefined,
      undefined,
      undefined,
      undefined,
      notes,
    );
    const { bot, calls } = createHarness(identity, dispatcher);
    await bot.init();
    await bot.handleUpdate(callbackUpdate("v1:wn"));
    expect(screenText(calls)).toContain("Пока ничего нового.");
    expect(
      buttons(screen(calls)?.payload).map((button) => button.text),
    ).toEqual(["‹ Помощь"]);

    calls.length = 0;
    await bot.handleUpdate(callbackUpdate("v1:wn"));
    expect(
      buttons(screen(calls)?.payload).map((button) => button.text),
    ).toEqual(["Повторить", "‹ Сходки"]);

    calls.length = 0;
    await bot.handleUpdate({
      update_id: 4,
      message: {
        message_id: 11,
        date: 0,
        chat: { id: 42, type: "private", first_name: "tester" },
        from: { id: 42, is_bot: false, first_name: "tester" },
        text: "/help",
      },
    });
    expect(screenText(calls)).toContain("<b>Помощь</b>");
    expect(
      buttons(screen(calls)?.payload).map((button) => button.text),
    ).toContain("Что нового");
  });

  it("turns the category off from the summary and shows the switch", async () => {
    const setGlobalCategory = vi.fn().mockResolvedValue({
      kind: "ok",
      preferences: {
        categories: [
          { category: "published", enabled: true },
          { category: "release", enabled: false },
        ],
      },
    });
    const dispatcher = createDispatcher(
      { get: vi.fn() } as unknown as Meetups,
      port({
        setGlobalCategory,
        getGlobalPreferences: vi.fn().mockResolvedValue({
          kind: "ok",
          preferences: {
            categories: [
              { category: "published", enabled: true },
              { category: "release", enabled: false },
            ],
          },
        }),
      }),
    );
    const { bot, calls } = createHarness(identity, dispatcher);
    await bot.init();
    await bot.handleUpdate({
      update_id: 8,
      callback_query: {
        id: "callback-8",
        chat_instance: "chat-1",
        from: { id: 42, is_bot: false, first_name: "tester" },
        data: "v1:notify:off:release",
        message: {
          message_id: 12,
          date: 0,
          chat: { id: 42, type: "private", first_name: "tester" },
          from: { id: 1, is_bot: true, first_name: "bot" },
          text: "Новое в боте · 14 октября",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "Не присылать новое в боте",
                  callback_data: "v1:notify:off:release",
                },
              ],
            ],
          },
        },
      },
    });
    expect(setGlobalCategory).toHaveBeenCalledWith(
      "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd",
      "release",
      false,
      expect.any(Object),
    );
    expect(screenText(calls)).toContain("новое в боте");

    calls.length = 0;
    await bot.handleUpdate(callbackUpdate("v1:notify:global"));
    const labels = buttons(screen(calls)?.payload).map((button) => button.text);
    expect(labels.at(-2)).toBe("🔕 Выкл · Новое в боте");
    expect(labels.at(-1)).toBe("‹ Настройки");
  });
});
