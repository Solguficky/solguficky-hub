import { Code, ConnectError } from "@connectrpc/connect";
import { Api, BotError, Context, GrammyError, type Transformer } from "grammy";
import type { Update } from "grammy/types";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import {
  botInfo,
  createCapturingLogger,
  createHarness,
  type LogRecord,
  type RecordedCall,
  withEntry,
} from "../../../../testkit/harness.js";
import type {
  AccessRight,
  RoleRequestOutcome,
} from "../../../auction-ui/index.js";
import type { TelegramEnvironment } from "../../../core/config.js";
import * as failures from "../../../core/failures.js";
import { noopTracing } from "../../../core/tracing.js";
import type { Dispatcher } from "../application/dispatcher.js";
import { createDispatcher } from "../application/dispatcher.js";
import {
  blockedHubAccessText,
  declinedHubAccessText,
  pendingHubAccessText,
} from "../application/hub-access.js";
import { rejectedValueText } from "../application/meetup-form.js";
import { createIdentityResolver } from "../identity/client.js";
import type {
  ApplicationAdministrator,
  ApplicationCard,
  ApplicationModerator,
  ApplicationQueueRead,
  CommunityAdministrator,
  IdentityResolver,
  RefusedApplication,
  RoleRequester,
  SourceChannel,
  SourceChannelAdministrator,
  TelegramRecipientResolver,
} from "../identity/port.js";
import type { MeetupSnapshot } from "../meetups/port.js";
import type { CategoryState, MeetupCategory } from "../notifications/port.js";
import { createBot } from "./bot.js";
import { tokenToUuid, uuidToToken } from "./meetup-deep-link.js";
import { auctionFaqData } from "./parse-callback.js";
import { refusalText } from "./screens/kit.js";

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

function callbackMessageUpdate(
  data: string,
  message: Record<string, unknown>,
  fromId = 42,
): Update {
  const update = callbackUpdate(data, fromId);
  if (update.callback_query === undefined) return update;
  return {
    ...update,
    callback_query: {
      ...update.callback_query,
      message: {
        message_id: 9,
        date: 0,
        chat: { id: 42, type: "private", first_name: "tester" },
        ...message,
      },
    },
  };
}

function forwardedReplyUpdate(replyMessageId: number): Update {
  return {
    update_id: 5,
    message: {
      message_id: 11,
      date: 0,
      chat: { id: 42, type: "private", first_name: "tester" },
      from: { id: 42, is_bot: false, first_name: "tester" },
      forward_origin: {
        type: "channel",
        date: 0,
        chat: { id: -1001234567890, type: "channel", title: "Сообщество" },
        message_id: 77,
      },
      reply_to_message: {
        message_id: replyMessageId,
        date: 0,
        chat: { id: 42, type: "private", first_name: "tester" },
        from: { id: 1, is_bot: true, first_name: "stub" },
        text: "Пришли материал",
        // grammY's ReplyMessage intersects Message with a required `undefined`
        // property, which is uninhabitable under exactOptionalPropertyTypes.
      } as never,
    },
  };
}

// Клавиатура вопроса: режим ответа и «Отмена» с его шагом.
function cancel(data: string) {
  return {
    force_reply: true,
    inline_keyboard: [[{ text: "Отмена", callback_data: data }]],
  };
}

function replyUpdate(options: {
  text: string;
  fromId: number;
  replyMessageId: number;
  replyFromId: number;
  replyText?: string | undefined;
  replyEntities?: unknown;
  // Клавиатура вопроса: Telegram возвращает её в ответе, и по кнопке «Отмена»
  // бот читает шаг вопроса.
  replyMarkup?: unknown;
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
        entities: options.replyEntities,
        ...(options.replyMarkup === undefined
          ? {}
          : { reply_markup: options.replyMarkup }),
      } as never,
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
    author: "0192f0a0-0000-7000-8000-00000000a001",
    version: 1,
    materials: [],
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

const resolvedId = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd";

// Права участника — по умолчанию у любого незаблокированного: роль едет
// транзитом и «Управление» до PER-534, а пускает право. Гостю и постороннему
// тест передаёт права явно.
const MEMBER_RIGHTS: readonly AccessRight[] = ["hub", "auction"];

function resolvedIdentity(
  globalRoles: readonly string[] = ["member"],
  blocked = false,
  rights: readonly AccessRight[] = blocked ? [] : MEMBER_RIGHTS,
): IdentityResolver {
  return {
    resolve: async () => ({
      kind: "resolved",
      identityId: resolvedId,
      globalRoles,
      rights,
      blocked,
    }),
  };
}

// Telegram возвращает в нажатии видимый текст сообщения, а не его разметку:
// так тест отдаёт боту то, что тот получил бы на самом деле.
function visible(text: string): string {
  return text
    .replace(/<[^>]+>/g, "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&");
}

// Номер последнего сообщения бота: фикстура отвечает на sendMessage
// идентификатором `100 + номер вызова`. Вопрос — всегда новое сообщение, и
// ответ на него адресуется этим номером.
function lastQuestionId(calls: readonly RecordedCall[]): number {
  const index = calls.findLastIndex((call) => call.method === "sendMessage");
  return 100 + index + 1;
}

function _sendMessageEntities(call: RecordedCall | undefined): unknown {
  if (call === undefined || call.method !== "sendMessage") return undefined;
  return "entities" in call.payload ? call.payload.entities : undefined;
}

// Сообщения, которые бот отправил, по порядку. Последним вызовом после ответа
// на вопрос идёт снятие его клавиатуры, поэтому «последнее сообщение» ищется
// среди отправок, а не среди всех вызовов.
function sentMessages(calls: readonly RecordedCall[]): RecordedCall[] {
  return calls.filter((call) => call.method === "sendMessage");
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
  it("renders materials in collection order and gives files an open action", async () => {
    const meetup = {
      ...publishedMeetup(),
      materials: [
        {
          id: "0199c0de-0000-7000-8000-000000000001",
          title: "Опрос: кто идёт",
          source: {
            kind: "message-link" as const,
            url: "https://t.me/c/1234567890/77",
          },
        },
        {
          id: "0199c0de-0000-7000-8000-000000000002",
          title: "Афиша",
          source: {
            kind: "file" as const,
            fileId: "bot-file-id",
            fileKind: "document" as const,
          },
        },
      ],
    };
    const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue({
      kind: "meetup-card",
      meetup,
    });
    const { bot, calls } = createHarness(resolvedIdentity(), { execute });
    await bot.init();

    await bot.handleUpdate(callbackUpdate("v1:view:AZLzpLXGfY6fChssPU5fYA"));

    const rich = calls.find((call) => call.method === "editMessageText");
    const serialized = JSON.stringify(rich?.payload);
    expect(serialized).toContain(
      '1. <a href=\\"https://t.me/c/1234567890/77\\">Опрос: кто идёт</a>',
    );
    expect(serialized).toContain("2. Афиша (файл)");
    expect(serialized.indexOf("Опрос: кто идёт")).toBeLessThan(
      serialized.indexOf("Афиша"),
    );
    // Кнопок файлов на карточке нет: файл открывается из «Материалов».
    expect(serialized).not.toContain("v1:mm:file:");
    expect(serialized).toContain("v1:mm:list:AZLzpLXGfY6fChssPU5fYA");
  });

  describe("card posters", () => {
    const poster = (index: number) => ({
      id: `0199c0de-0000-7000-8000-00000000000${index}`,
      title: `Афиша ${index}`,
      source: {
        kind: "file" as const,
        fileId: `photo-${index}`,
        fileKind: "photo" as const,
      },
    });
    const cardWith = (materials: ReturnType<typeof poster>[]) =>
      vi.fn<Dispatcher["execute"]>().mockResolvedValue({
        kind: "meetup-card",
        meetup: { ...publishedMeetup(), materials },
      });
    const view = "v1:view:AZLzpLXGfY6fChssPU5fYA";

    it("edits the pressed message into a rich card with the photos as media", async () => {
      const { bot, calls } = createHarness(resolvedIdentity(), {
        execute: cardWith([poster(1), poster(2)]),
      });
      await bot.init();

      await bot.handleUpdate(callbackUpdate(view));

      const edit = calls.find((call) => call.method === "editMessageText");
      expect(edit?.payload).toMatchObject({
        rich_message: {
          media: [
            { id: "p1", media: { type: "photo", media: "photo-1" } },
            { id: "p2", media: { type: "photo", media: "photo-2" } },
          ],
        },
      });
      expect(JSON.stringify(edit?.payload)).toContain("tg-slideshow");
      expect(calls.map((call) => call.method)).not.toContain("sendPhoto");
    });

    it("sends the plain card without media", async () => {
      const { bot, calls } = createHarness(
        resolvedIdentity(),
        { execute: cardWith([poster(1), poster(2)]) },
        [],
        undefined,
        "plain",
      );
      await bot.init();

      await bot.handleUpdate(callbackUpdate(view));

      const shown = JSON.stringify(calls.at(-1)?.payload);
      expect(shown).not.toContain("tg://photo");
      expect(shown).not.toContain("rich_message");
      expect(shown).toContain("1. Афиша 1 (файл)");
    });

    it("falls back to the card without posters when Telegram rejects the photos", async () => {
      const { bot, calls, records } = createHarness(resolvedIdentity(), {
        execute: cardWith([poster(1), poster(2)]),
      });
      bot.api.config.use((prev, method, payload, signal) =>
        JSON.stringify(payload).includes("tg://photo")
          ? Promise.reject(
              new GrammyError(
                "rejected",
                {
                  ok: false,
                  error_code: 400,
                  description: "Bad Request: wrong file identifier",
                },
                method,
                payload,
              ),
            )
          : prev(method, payload, signal),
      );
      await bot.init();

      await bot.handleUpdate(callbackUpdate(view));

      const last = calls.at(-1);
      expect(last?.method).toBe("sendRichMessage");
      expect(JSON.stringify(last?.payload)).not.toContain("tg://photo");
      expect(JSON.stringify(last?.payload)).toContain("1. Афиша 1 (файл)");
      // Деградация видна оператору: причина едет в запись границы.
      expect(JSON.stringify(records)).toContain(
        "Bad Request: wrong file identifier",
      );
    });

    it("does not resend the card when the failure is not about the photos", async () => {
      const { bot, calls } = createHarness(resolvedIdentity(), {
        execute: cardWith([poster(1), poster(2)]),
      });
      bot.api.config.use((prev, method, payload, signal) =>
        JSON.stringify(payload).includes("tg://photo")
          ? Promise.reject(new Error("socket hang up"))
          : prev(method, payload, signal),
      );
      await bot.init();

      await bot.handleUpdate(callbackUpdate(view));

      expect(
        calls.filter(
          (call) =>
            call.method === "sendRichMessage" &&
            !JSON.stringify(call.payload).includes("tg://photo"),
        ),
      ).toEqual([]);
    });

    it("opens a stored photo as a photo", async () => {
      const meetup = { ...publishedMeetup(), materials: [poster(1)] };
      const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue({
        kind: "meetup-card",
        meetup,
      });
      const { bot, calls } = createHarness(resolvedIdentity(), { execute });
      await bot.init();

      await bot.handleUpdate(
        callbackUpdate(
          `v1:mm:file:AZLzpLXGfY6fChssPU5fYA:${uuidToToken(meetup.materials[0]?.id ?? "")}`,
        ),
      );

      const methods = calls.map((call) => call.method);
      expect(methods).toContain("sendPhoto");
      expect(methods).not.toContain("sendDocument");
    });
  });

  it("paginates a long material collection for every meetup viewer", async () => {
    const materials = Array.from({ length: 25 }, (_, index) => ({
      id: `0199c0de-0000-7000-8000-${(index + 1).toString(16).padStart(12, "0")}`,
      title: `Материал ${index + 1} ${"подробности ".repeat(12)}`,
      source: {
        kind: "message-link" as const,
        url: `https://t.me/community/${index + 1}`,
      },
    }));
    const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue({
      kind: "meetup-card",
      meetup: { ...publishedMeetup(), materials },
    });
    const { bot, calls } = createHarness(resolvedIdentity(["member"]), {
      execute,
    });
    await bot.init();

    await bot.handleUpdate(callbackUpdate("v1:view:AZLzpLXGfY6fChssPU5fYA"));

    const card = calls.find((call) => call.method === "editMessageText");
    const cardPayload = JSON.stringify(card?.payload);
    expect(cardPayload.length).toBeLessThan(4_096);
    expect(cardPayload).toContain("…и ещё 5");
    expect(cardPayload).toContain("v1:mm:list:");

    await bot.handleUpdate(callbackUpdate("v1:mm:list:AZLzpLXGfY6fChssPU5fYA"));

    const page = calls
      .filter((call) => call.method === "editMessageText")
      .at(-1);
    expect(page).toMatchObject({
      payload: { text: expect.stringContaining("<b>Материалы · 1 из 4</b>") },
    });
    expect(JSON.stringify(page?.payload)).toContain(
      "v1:mm:list:AZLzpLXGfY6fChssPU5fYA:1",
    );
  });

  it("does not open material attachment for a non-admin", async () => {
    const execute = vi.fn<Dispatcher["execute"]>();
    const { bot, calls, records } = createHarness(
      resolvedIdentity(["member"]),
      {
        execute,
      },
    );
    await bot.init();

    await bot.handleUpdate(callbackUpdate("v1:mm:add:AZLzpLXGfY6fChssPU5fYA"));

    expect(execute).not.toHaveBeenCalled();
    expect(calls.at(-1)).toMatchObject({
      method: "editMessageText",
      payload: {
        text: refusalText("Это действие доступно организатору сходки."),
      },
    });
    expectBoundary(records[0], {
      level: "warn",
      result: "error",
      operation: "callback_query",
      error_category: "authorization",
      use_case: "update_meetup",
    });
  });

  it("attaches a forwarded message only after title and confirmation", async () => {
    const meetup = publishedMeetup();
    const execute = vi.fn<Dispatcher["execute"]>(async (request) => {
      if (request.intent === "view-meetup") {
        return { kind: "meetup-card", meetup };
      }
      if (request.intent === "attach-material") {
        return {
          kind: "material-attached",
          meetup: { ...meetup, materials: [request.material] },
        };
      }
      return { kind: "rejected", reason: "unexpected" };
    });
    const { bot, calls } = createHarness(resolvedIdentity(["admin"]), {
      execute,
    });
    await bot.init();

    await bot.handleUpdate(callbackUpdate("v1:mm:add:AZLzpLXGfY6fChssPU5fYA"));
    await bot.handleUpdate(forwardedReplyUpdate(lastQuestionId(calls)));
    await bot.handleUpdate(
      replyUpdate({
        text: "Опрос: кто идёт",
        fromId: 42,
        replyMessageId: lastQuestionId(calls),
        replyFromId: 1,
      }),
    );

    expect(
      execute.mock.calls.some(
        ([request]) => request.intent === "attach-material",
      ),
    ).toBe(false);
    const confirmation = calls.at(-1);
    expect(confirmation?.method).toBe("sendMessage");
    if (
      confirmation?.method !== "sendMessage" ||
      !("reply_markup" in confirmation.payload) ||
      !("text" in confirmation.payload)
    )
      return;
    const keyboard = confirmation.payload.reply_markup;
    const callbackData = JSON.stringify(keyboard).match(
      /v1:mm:ca:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:\d+/,
    )?.[0];
    expect(callbackData).toBeDefined();
    if (callbackData === undefined) return;
    // Версия — та карточка, с которой начато прикрепление, а не чтение при
    // подтверждении.
    expect(callbackData.endsWith(`:${meetup.version}`)).toBe(true);
    await bot.handleUpdate(
      callbackMessageUpdate(callbackData, {
        text: visible(String(confirmation.payload.text)),
        reply_markup: keyboard,
      }),
    );

    expect(execute).toHaveBeenLastCalledWith(
      expect.objectContaining({
        intent: "attach-material",
        meetupId: meetup.id,
        expectedVersion: meetup.version,
        material: expect.objectContaining({
          title: "Опрос: кто идёт",
          source: {
            kind: "message-link",
            url: "https://t.me/c/1234567890/77",
          },
        }),
      }),
    );
  });

  // Источник принимается только ответом на вопрос. Отказ — своё сообщение
  // исхода с «Ввести заново», а новый вопрос задаёт эта кнопка: фотография
  // после отказа не остаётся вне формы (прогон PER-395).
  it("refuses the source with an outcome and asks again on re-entry", async () => {
    const execute = vi.fn<Dispatcher["execute"]>(async (request) =>
      request.intent === "view-meetup"
        ? { kind: "meetup-card", meetup: publishedMeetup() }
        : { kind: "rejected", reason: "unexpected" },
    );
    const { bot, calls } = createHarness(resolvedIdentity(["admin"]), {
      execute,
    });
    await bot.init();

    await bot.handleUpdate(callbackUpdate("v1:mm:add:AZLzpLXGfY6fChssPU5fYA"));
    await bot.handleUpdate(
      replyUpdate({
        text: "document link",
        fromId: 42,
        replyMessageId: lastQuestionId(calls),
        replyFromId: 1,
      }),
    );

    const rejection = sentMessages(calls).at(-1);
    expect(rejection?.method).toBe("sendMessage");
    // Прежний вопрос снимается после того, как ушёл новый.
    expect(calls.at(-1)?.method).toBe("editMessageReplyMarkup");
    expect(JSON.stringify(rejection?.payload)).toContain("нельзя дать ссылку");
    expect(JSON.stringify(rejection?.payload)).not.toContain("force_reply");
    expect(JSON.stringify(rejection?.payload)).toContain(
      '"text":"Ввести заново","callback_data":"v1:mm:add:AZLzpLXGfY6fChssPU5fYA"',
    );
    expect(JSON.stringify(rejection?.payload)).toContain(
      '"text":"‹ Материалы"',
    );

    await bot.handleUpdate(callbackUpdate("v1:mm:add:AZLzpLXGfY6fChssPU5fYA"));
    await bot.handleUpdate(forwardedReplyUpdate(lastQuestionId(calls)));

    expect(JSON.stringify(sentMessages(calls).at(-1)?.payload)).toContain(
      "Как назвать материал",
    );
  });

  it("passes a confirmed file id to Meetups", async () => {
    const meetup = publishedMeetup();
    const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue({
      kind: "material-attached",
      meetup,
    });
    const { bot, calls } = createHarness(resolvedIdentity(["admin"]), {
      execute,
    });
    await bot.init();

    await bot.handleUpdate(
      callbackMessageUpdate(
        "v1:mm:ca:AZLzpLXGfY6fChssPU5fYA:AZnA3gAAAAAAAABfP4Lqmw:4",
        {
          caption: "Прикрепить материал?\n\nНазвание: Афиша",
          document: {
            file_id: "bot-file-id",
            file_unique_id: "unique",
            file_name: "poster.pdf",
          },
        },
      ),
    );

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: "attach-material",
        expectedVersion: 4,
        material: expect.objectContaining({
          title: "Афиша",
          source: { kind: "file", fileId: "bot-file-id", fileKind: "document" },
        }),
      }),
    );
    // Экран в сообщении с файлом не живёт: оно остаётся следом без кнопок,
    // а материалы приходят новым сообщением.
    expect(calls.map((call) => call.method)).toEqual([
      "answerCallbackQuery",
      "editMessageCaption",
      "sendMessage",
    ]);
    expect(calls[1]?.payload).toMatchObject({ caption: "Прикреплено: Афиша" });
    expect(JSON.stringify(calls[1]?.payload)).not.toContain("callback_data");
    expect(sendMessageText(calls[2])).toContain("<b>Материалы</b>");
  });

  it("removes a material only after confirming that the original stays", async () => {
    const material = {
      id: "0199c0de-0000-7000-8000-00000000009a",
      title: "Уточнение по времени",
      source: {
        kind: "message-link" as const,
        url: "https://t.me/c/1234567890/78",
      },
    };
    const meetup = { ...publishedMeetup(), version: 6, materials: [material] };
    const execute = vi.fn<Dispatcher["execute"]>(async (request) =>
      request.intent === "view-meetup"
        ? { kind: "meetup-card", meetup }
        : { kind: "material-removed", meetup: publishedMeetup() },
    );
    const { bot, calls } = createHarness(resolvedIdentity(["admin"]), {
      execute,
    });
    await bot.init();
    const data = "v1:mm:rm:AZLzpLXGfY6fChssPU5fYA:AZnA3gAAcACAAAAAAAAAmg";

    await bot.handleUpdate(callbackUpdate(data));

    expect(
      execute.mock.calls.some(
        ([request]) => request.intent === "remove-material",
      ),
    ).toBe(false);
    expect(calls.at(-1)).toMatchObject({
      method: "editMessageText",
      payload: {
        text: expect.stringContaining("Оригинал в Telegram останется на месте"),
      },
    });
    const confirm = `${data.replace("v1:mm:rm:", "v1:mm:cr:")}:6`;
    expect(JSON.stringify(calls.at(-1)?.payload)).toContain(confirm);
    await bot.handleUpdate(callbackUpdate(confirm));

    expect(execute).toHaveBeenLastCalledWith(
      expect.objectContaining({
        intent: "remove-material",
        meetupId: meetup.id,
        materialId: material.id,
        expectedVersion: 6,
      }),
    );
  });

  it("keeps the attach confirmation and renews its version on a version conflict", async () => {
    const fresh = {
      ...publishedMeetup(),
      title: "Настолки в субботу",
      version: 5,
    };
    const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue({
      kind: "conflict",
      meetup: fresh,
    });
    const { bot, calls, records } = createHarness(resolvedIdentity(["admin"]), {
      execute,
    });
    await bot.init();

    await bot.handleUpdate(
      callbackMessageUpdate(
        "v1:mm:ca:AZLzpLXGfY6fChssPU5fYA:AZnA3gAAAAAAAABfP4Lqmw:4",
        {
          caption: "Прикрепить материал?\n\nНазвание: Афиша",
          document: {
            file_id: "bot-file-id",
            file_unique_id: "unique",
            file_name: "poster.pdf",
          },
        },
      ),
    );

    // Подпись с названием и файлом не переписывается: по ней бот читает
    // материал при повторном нажатии.
    expect(calls.some((call) => call.method === "editMessageCaption")).toBe(
      false,
    );
    const markup = calls.find(
      (call) => call.method === "editMessageReplyMarkup",
    );
    expect(JSON.stringify(markup?.payload)).toContain(
      "v1:mm:ca:AZLzpLXGfY6fChssPU5fYA:AZnA3gAAAAAAAABfP4Lqmw:5",
    );
    expect(calls.at(-1)).toMatchObject({
      method: "sendMessage",
      payload: { text: expect.stringContaining("Сходка уже изменилась.") },
    });
    expect(records.at(-1)?.fields.error).toBe("version_conflict");
  });

  it.each([
    [
      "attach",
      "v1:mm:confirm-add:AZLzpLXGfY6fChssPU5fYA:AZnA3gAAAAAAAABfP4Lqmw",
      ["v1:mm:ca:AZLzpLXGfY6fChssPU5fYA:AZnA3gAAAAAAAABfP4Lqmw:3"],
      ["Сходка уже изменилась."],
    ],
    [
      "remove",
      "v1:mm:confirm-rm:AZLzpLXGfY6fChssPU5fYA:AZnA3gAAcACAAAAAAAAAmg",
      // Снятие отвечает экраном исхода: предмет — материал, возврат — список.
      ["v1:mm:list:AZLzpLXGfY6fChssPU5fYA", "«Уточнение по времени»"],
      ["<b>Сходка уже изменилась</b>", "Твои изменения не сохранены."],
    ],
  ])(
    "answers a %s confirmation without a version by the current card instead of a command",
    async (_, data, renewed, texts) => {
      // Материал кнопки снятия ещё на месте, а материала кнопки прикрепления
      // ещё нет: ни одна цель не достигнута, и ответом остаётся кадр конфликта.
      const current = {
        ...publishedMeetup(),
        version: 3,
        materials: [
          {
            id: "0199c0de-0000-7000-8000-00000000009a",
            title: "Уточнение по времени",
            source: {
              kind: "message-link" as const,
              url: "https://t.me/c/1234567890/78",
            },
          },
        ],
      };
      const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue({
        kind: "meetup-card",
        meetup: current,
      });
      const { bot, calls } = createHarness(resolvedIdentity(["admin"]), {
        execute,
      });
      await bot.init();

      await bot.handleUpdate(
        callbackMessageUpdate(data, {
          caption: "Прикрепить материал?\n\nНазвание: Афиша",
          document: {
            file_id: "bot-file-id",
            file_unique_id: "unique",
            file_name: "poster.pdf",
          },
        }),
      );

      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledWith(
        expect.objectContaining({ intent: "view-meetup" }),
      );
      for (const part of [...renewed, ...texts]) {
        expect(JSON.stringify(calls)).toContain(part);
      }
    },
  );

  it("answers a confirmation without a version for an already removed material as done", async () => {
    const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue({
      kind: "meetup-card",
      meetup: { ...publishedMeetup(), version: 3 },
    });
    const { bot, calls } = createHarness(resolvedIdentity(["admin"]), {
      execute,
    });
    await bot.init();

    await bot.handleUpdate(
      callbackUpdate(
        "v1:mm:confirm-rm:AZLzpLXGfY6fChssPU5fYA:AZnA3gAAcACAAAAAAAAAmg",
      ),
    );

    expect(execute).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(calls)).not.toContain("Сходка уже изменилась.");
    expect(JSON.stringify(calls)).toContain("Пока ничего не прикреплено.");
  });

  it("refuses a confirmation without a version from a non-admin without reading the meetup", async () => {
    const execute = vi.fn<Dispatcher["execute"]>();
    const { bot, calls } = createHarness(resolvedIdentity(["member"]), {
      execute,
    });
    await bot.init();

    await bot.handleUpdate(
      callbackUpdate(
        "v1:mm:confirm-rm:AZLzpLXGfY6fChssPU5fYA:AZnA3gAAcACAAAAAAAAAmg",
      ),
    );

    expect(execute).not.toHaveBeenCalled();
    expect(JSON.stringify(calls)).toContain(
      "Это действие доступно организатору сходки.",
    );
  });

  it("still tells about the conflict when the attach confirmation cannot be edited", async () => {
    const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue({
      kind: "conflict",
      meetup: { ...publishedMeetup(), version: 5 },
    });
    const { bot, calls, records } = createHarness(resolvedIdentity(["admin"]), {
      execute,
    });
    bot.api.config.use((prev, method, payload, signal) =>
      method === "editMessageReplyMarkup"
        ? Promise.reject(new Error("Bad Request: message to edit not found"))
        : prev(method, payload, signal),
    );
    await bot.init();

    await bot.handleUpdate(
      callbackMessageUpdate(
        "v1:mm:ca:AZLzpLXGfY6fChssPU5fYA:AZnA3gAAAAAAAABfP4Lqmw:4",
        {
          caption: "Прикрепить материал?\n\nНазвание: Афиша",
          document: {
            file_id: "bot-file-id",
            file_unique_id: "unique",
            file_name: "poster.pdf",
          },
        },
      ),
    );

    expect(calls.at(-1)).toMatchObject({
      method: "sendMessage",
      payload: {
        text: expect.stringContaining(
          "Начни прикрепление заново из карточки сходки.",
        ),
      },
    });
    expect(records.at(-1)?.fields.error).toBe("version_conflict");
  });

  // Конфликт версии при снятии материала — экран исхода с возвратом к списку,
  // а не повторное подтверждение: изменения не сохранены, данные надо перечитать.
  it("answers a material removal version conflict with an outcome screen", async () => {
    const fresh = { ...publishedMeetup(), version: 7 };
    const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue({
      kind: "conflict",
      meetup: fresh,
    });
    const { bot, calls, records } = createHarness(resolvedIdentity(["admin"]), {
      execute,
    });
    await bot.init();

    await bot.handleUpdate(
      callbackUpdate(
        "v1:mm:cr:AZLzpLXGfY6fChssPU5fYA:AZnA3gAAcACAAAAAAAAAmg:6",
      ),
    );

    expect(calls.at(-1)).toMatchObject({
      method: "editMessageText",
      payload: {
        text: expect.stringContaining("<b>Сходка уже изменилась</b>"),
      },
    });
    expect(JSON.stringify(calls.at(-1)?.payload)).toContain(
      "Твои изменения не сохранены. Проверь актуальные данные и повтори.",
    );
    expect(JSON.stringify(calls.at(-1)?.payload)).toContain(
      '"text":"‹ Материалы","callback_data":"v1:mm:list:AZLzpLXGfY6fChssPU5fYA"',
    );
    expect(JSON.stringify(calls.at(-1)?.payload)).not.toContain("v1:mm:cr:");
    expect(records.at(-1)?.fields.error).toBe("version_conflict");
  });
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
        author: "0192f0a0-0000-7000-8000-00000000a001",
        version: 1,
        materials: [],
      },
    });
    const { bot, calls } = createHarness(resolvedIdentity(), { execute });
    await bot.init();
    await bot.handleUpdate(
      callbackUpdate("v1:manage:new:AZLzpLXGfY6fChssPU5fYA"),
    );
    await bot.handleUpdate(
      replyUpdate({
        text: "Чужое название",
        fromId: 43,
        replyMessageId: lastQuestionId(calls),
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
    expect(records).toHaveLength(1);
    expectBoundary(records[0], {
      level: "info",
      result: "ok",
      operation: "message",
      use_case: "find_meetup",
    });
    // Управление солегуфику недоступно, и вход в него он не видит (PER-396).
    expect(calls[0]?.payload).toMatchObject({
      reply_markup: {
        inline_keyboard: [
          [
            { text: "Ближайшие сходки", callback_data: "v1:nav:hub" },
            { text: "Архив", callback_data: "v1:nav:archive" },
          ],
          [{ text: "Уведомления", callback_data: "v1:notify:global" }],
        ],
      },
    });
    expect(JSON.stringify(calls)).not.toContain("v1:manage:menu");
  });

  it("offers management on /start to an admin", async () => {
    const { bot, calls } = createHarness(resolvedIdentity(["admin"]));
    await bot.init();
    await bot.handleUpdate(messageUpdate());
    expect(calls[0]?.payload).toMatchObject({
      reply_markup: {
        inline_keyboard: [
          [
            { text: "Ближайшие сходки", callback_data: "v1:nav:hub" },
            { text: "Архив", callback_data: "v1:nav:archive" },
          ],
          [{ text: "Уведомления", callback_data: "v1:notify:global" }],
          [{ text: "Управление", callback_data: "v1:manage:menu" }],
        ],
      },
    });
  });

  it("shows the waiting frame on /start when the person has no member role", async () => {
    const execute = vi.fn<Dispatcher["execute"]>();
    const { bot, calls, records } = createHarness(
      resolvedIdentity([], false, []),
      {
        execute,
      },
    );
    await bot.init();
    await bot.handleUpdate(messageUpdate());
    expect(sendMessageText(calls[0])).toBe(
      refusalText(pendingHubAccessText(resolvedId, undefined)),
    );
    // За кадром ожидания экранов нет, и кнопок у него нет.
    expect(JSON.stringify(calls[0]?.payload)).not.toContain("callback_data");
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
    expect(sendMessageText(calls[0])).toBe(refusalText(blockedHubAccessText));
    expect(execute).not.toHaveBeenCalled();
    expectBoundary(records[0], {
      level: "warn",
      result: "error",
      error_category: "authorization",
      use_case: "find_meetup",
    });
    expect(records[0]?.fields.error).toBe("hub_access_blocked");
  });

  // Вход на `/start` (ADR-060): вместо разрешения личности бот зовёт
  // `RequestRole` с кругом хаба, и Identity ставит заявку или гасит белый
  // список. Фейк с явным `requestRole` показывает сам вход, а не вывод
  // харнесса из `resolve`.
  function entering(
    answer: Awaited<ReturnType<RoleRequester["requestRole"]>>,
  ): IdentityResolver & { requestRole: Mock<RoleRequester["requestRole"]> } {
    return {
      resolve: vi.fn<IdentityResolver["resolve"]>(),
      requestRole: vi.fn<RoleRequester["requestRole"]>(async () => answer),
    };
  }
  const answered = (
    outcome: RoleRequestOutcome,
    rights: readonly AccessRight[] = [],
  ) =>
    ({
      kind: "answered",
      identityId: resolvedId,
      globalRoles: [],
      rights,
      outcome,
    }) as const;

  it.each([
    ["/start s_tg_ads", { sourceCode: "tg_ads" }],
    ["/start s_", { sourceCode: "" }],
    ["/start m_AZLzpLXGfY6fChssPU5fYA", {}],
    ["/start", {}],
    // `/menu` — тот же вход: начавший с него тоже получает заявку.
    ["/menu", {}],
  ])(
    "enters on %s through RequestRole into the community queue",
    async (text, code) => {
      const execute = vi.fn<Dispatcher["execute"]>();
      const identity = entering(answered("pending"));
      const { bot, calls } = createHarness(identity, { execute });
      await bot.init();
      await bot.handleUpdate(messageUpdate(text));
      expect(identity.requestRole).toHaveBeenCalledExactlyOnceWith(
        {
          telegramUserId: 42n,
          queue: "community",
          firstName: "tester",
          ...code,
        },
        expect.objectContaining({ requestId: expect.any(String) }),
      );
      // Личность разрешается один раз на update: вход её и устанавливает.
      expect(identity.resolve).not.toHaveBeenCalled();
      expect(sendMessageText(calls[0])).toBe(
        refusalText(pendingHubAccessText(resolvedId, undefined)),
      );
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it("opens /start for a person the allowlist has just admitted", async () => {
    const identity = entering(answered("granted-by-allowlist", MEMBER_RIGHTS));
    const { bot, calls } = createHarness(identity);
    await bot.init();
    await bot.handleUpdate(messageUpdate());
    expect(sendMessageText(calls[0])).toContain("Привет.");
    expect(identity.resolve).not.toHaveBeenCalled();
  });

  it("answers a declined application on /start with a refusal of its own", async () => {
    const execute = vi.fn<Dispatcher["execute"]>();
    const { bot, calls, records } = createHarness(
      entering(answered("declined", ["auction"])),
      { execute },
    );
    await bot.init();
    await bot.handleUpdate(messageUpdate());
    expect(sendMessageText(calls[0])).toBe(refusalText(declinedHubAccessText));
    expect(JSON.stringify(calls[0]?.payload)).not.toContain("callback_data");
    expect(execute).not.toHaveBeenCalled();
    expectBoundary(records[0], {
      level: "warn",
      result: "error",
      error_category: "authorization",
      use_case: "find_meetup",
    });
    expect(records[0]?.fields.error).toBe("hub_access_declined");
    expect(records[0]?.fields.identity_id).toBe(resolvedId);
  });

  it("shows the closed frame on /start by the blocked outcome", async () => {
    const execute = vi.fn<Dispatcher["execute"]>();
    const { bot, calls, records } = createHarness(
      entering(answered("blocked")),
      { execute },
    );
    await bot.init();
    await bot.handleUpdate(messageUpdate());
    expect(sendMessageText(calls[0])).toBe(refusalText(blockedHubAccessText));
    expect(execute).not.toHaveBeenCalled();
    expect(records[0]?.fields.error).toBe("hub_access_blocked");
  });

  // Гостю и постороннему хаб отвечает заявкой без выхода: ни сходок, ни
  // аукциона, ни намёка на бот аукциона, даже когда имя бота настроено
  // (RFC-015, С-4; ADR-064, пункт 5).
  describe("no hint of the auction bot", () => {
    const withAuctionBot = (identity: Parameters<typeof createHarness>[0]) =>
      createHarness(identity, undefined, [], undefined, undefined, undefined, {
        auctionBotUsername: "solguficky_auction_bot",
      });

    it("gives a guest only the pending frame on /start and on a press", async () => {
      const execute = vi.fn<Dispatcher["execute"]>();
      const { bot, calls } = createHarness(
        resolvedIdentity(["public"], false, ["auction"]),
        { execute },
        [],
        undefined,
        undefined,
        undefined,
        { auctionBotUsername: "solguficky_auction_bot" },
      );
      await bot.init();
      await bot.handleUpdate(messageUpdate());
      await bot.handleUpdate(callbackUpdate("v1:nav:hub"));
      expect(execute).not.toHaveBeenCalled();
      expect(calls[0]).toMatchObject({
        method: "sendMessage",
        payload: {
          text: refusalText(pendingHubAccessText(resolvedId, undefined)),
          reply_markup: { inline_keyboard: [[]] },
        },
      });
      expect(calls[2]).toMatchObject({
        method: "editMessageText",
        payload: { reply_markup: { inline_keyboard: [[]] } },
      });
      expect(JSON.stringify(calls)).not.toContain("t.me");
    });

    it.each([
      [
        "a guest after a member decline",
        entering(answered("declined", ["auction"])),
      ],
      ["a person without rights", resolvedIdentity([], false, [])],
      ["a blocked person", resolvedIdentity(["public"], true, [])],
    ])("gives no link to %s", async (_name, identity) => {
      const { bot, calls } = withAuctionBot(identity);
      await bot.init();
      await bot.handleUpdate(messageUpdate());
      expect(JSON.stringify(calls[0]?.payload)).not.toContain("t.me");
      expect(calls[0]?.payload).toMatchObject({
        reply_markup: { inline_keyboard: [[]] },
      });
    });
  });

  // Незнакомый исход по контракту — отказ, но не ответ о заявке: человек
  // получает кадр недоступности, какие бы роли ни пришли рядом.
  it("fails closed on /start when Identity answers an unknown outcome", async () => {
    const execute = vi.fn<Dispatcher["execute"]>();
    const { bot, calls, records } = createHarness(
      entering(answered("unspecified", MEMBER_RIGHTS)),
      { execute },
    );
    await bot.init();
    await bot.handleUpdate(messageUpdate());
    expect(execute).not.toHaveBeenCalled();
    expect(sendMessageText(calls[0])).toContain("Не получилось");
    expectBoundary(records[0], {
      level: "error",
      result: "error",
      error_category: "invariant",
      use_case: "find_meetup",
    });
    expect(records[0]?.fields.error).toBe("role_request_outcome_unspecified");
    expect(records[0]?.fields.identity_id).toBe(resolvedId);
  });

  it("fails closed on /start when the entry is unavailable", async () => {
    const execute = vi.fn<Dispatcher["execute"]>();
    const { bot, calls, records } = createHarness(
      entering({ kind: "unavailable", cause: new Error("down") }),
      { execute },
    );
    await bot.init();
    await bot.handleUpdate(messageUpdate());
    expect(execute).not.toHaveBeenCalled();
    expect(sendMessageText(calls[0])).toContain("Не получилось");
    expectBoundary(records[0], {
      level: "error",
      result: "error",
      error_category: "dependency_unavailable",
      use_case: "find_meetup",
    });
  });

  // Заявку ставит только вход: кнопка лишь проверяет роль.
  it("does not request a role on a button", async () => {
    const identity = {
      ...resolvedIdentity(["public"], false, ["auction"]),
      requestRole: vi.fn<RoleRequester["requestRole"]>(),
    };
    const { bot, calls } = createHarness(identity);
    await bot.init();
    await bot.handleUpdate(callbackUpdate("v1:nav:hub"));
    expect(identity.requestRole).not.toHaveBeenCalled();
    expect(screen(calls[1]).text).toBe(
      refusalText(pendingHubAccessText(resolvedId, undefined)),
    );
  });

  it("does not show meetups to a pending person by list or deep link", async () => {
    const execute = vi.fn<Dispatcher["execute"]>();
    const { bot, calls, records } = createHarness(
      resolvedIdentity(["public"], false, ["auction"]),
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
      payload: {
        text: refusalText(pendingHubAccessText(resolvedId, undefined)),
      },
    });
    expect(JSON.stringify(calls[1]?.payload)).not.toContain("v1:nav:hub");
    expect(sendMessageText(calls[2])).toBe(
      refusalText(pendingHubAccessText(resolvedId, undefined)),
    );
    expect(records.map((record) => record.fields.error)).toEqual([
      "hub_access_pending",
      "hub_access_pending",
    ]);
  });

  it("does not open management for a person outside the member circle", async () => {
    const execute = vi.fn<Dispatcher["execute"]>();
    const { bot, calls } = createHarness(
      resolvedIdentity(["public"], false, ["auction"]),
      {
        execute,
      },
    );
    await bot.init();
    await bot.handleUpdate(callbackUpdate("v1:manage:menu"));
    expect(execute).not.toHaveBeenCalled();
    expect(calls[1]).toMatchObject({
      method: "editMessageText",
      payload: {
        text: refusalText(pendingHubAccessText(resolvedId, undefined)),
      },
    });
  });

  it("opens /start for an admin without a stored member row", async () => {
    const { bot, calls } = createHarness(resolvedIdentity(["admin"]));
    await bot.init();
    await bot.handleUpdate(messageUpdate());
    expect(sendMessageText(calls[0])).toContain("Привет.");
    expect(sendMessageText(calls[0])).not.toBe(
      refusalText(pendingHubAccessText(resolvedId, undefined)),
    );
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
      payload: {
        text: "<b>Состав сообщества</b>\n\nОжидают допуска: 1\nДопущены: 0\nРазрешённые ники: 1",
      },
    });
    expect(JSON.stringify(calls[1]?.payload)).toContain("v1:cm:p");
  });

  describe("closing access", () => {
    const memberId = "0192f3a4-b5c6-7d8e-9f0a-1b2c3d4e5f60";
    const memberToken = uuidToToken(memberId);

    function closing(members: readonly { admitted: boolean }[]) {
      const community = vi
        .fn<CommunityAdministrator["community"]>()
        .mockResolvedValue({
          kind: "ok",
          value: {
            members: members.map(({ admitted }) => ({
              identityId: memberId,
              telegramUsername: "leaving",
              admitted,
            })),
            allowedUsernames: [],
          },
        });
      const block = vi
        .fn<CommunityAdministrator["block"]>()
        .mockResolvedValue({ kind: "ok", value: true });
      return { ...resolvedIdentity(["admin"]), community, block };
    }

    it("asks before closing and does not call Identity to block", async () => {
      const identity = closing([{ admitted: true }]);
      const { bot, calls } = createHarness(identity);
      await bot.init();

      await bot.handleUpdate(callbackUpdate(`v1:cm:bq:${memberToken}:a0`));

      expect(identity.block).not.toHaveBeenCalled();
      expect(calls.at(-1)).toMatchObject({
        method: "editMessageText",
        payload: {
          text: expect.stringContaining("<b>Закрыть доступ?</b>\n\n@leaving"),
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "Да, закрыть доступ",
                  callback_data: `v1:cm:by:${memberToken}:a0`,
                },
              ],
              [{ text: "Нет", callback_data: "v1:cm:a:0" }],
            ],
          },
        },
      });
    });

    // Экран прошлого релиза закрывал доступ одним нажатием: его кнопка, всё
    // ещё стоящая в чате, теперь тоже спрашивает.
    it("asks under a button of the previous release too", async () => {
      const identity = closing([{ admitted: true }]);
      const { bot, calls } = createHarness(identity);
      await bot.init();

      await bot.handleUpdate(
        callbackUpdate(`v1:community:block:${memberToken}`),
      );

      expect(identity.block).not.toHaveBeenCalled();
      expect(JSON.stringify(calls.at(-1)?.payload)).toContain(
        "Да, закрыть доступ",
      );
    });

    it("closes access on the confirmation and says so in the answer", async () => {
      const identity = closing([]);
      const { bot, calls } = createHarness(identity);
      await bot.init();

      await bot.handleUpdate(callbackUpdate(`v1:cm:by:${memberToken}:p`));

      expect(identity.block).toHaveBeenCalledWith(
        expect.objectContaining({ globalRoles: ["admin"] }),
        memberId,
        expect.objectContaining({ useCase: "manage_community" }),
      );
      expect(calls.map((call) => call.method)).toEqual([
        "answerCallbackQuery",
        "editMessageText",
      ]);
      expect(calls[0]?.payload).toMatchObject({ text: "Доступ закрыт." });
      expect(calls[1]?.payload).toMatchObject({
        text: "<b>Ожидают допуска</b>\n\nОчередь пуста.",
      });
    });

    it("returns to the list when the person is already gone", async () => {
      const identity = closing([]);
      const { bot, calls } = createHarness(identity);
      await bot.init();

      await bot.handleUpdate(callbackUpdate(`v1:cm:bq:${memberToken}:a0`));

      expect(calls[0]?.payload).toMatchObject({
        text: "Этого человека уже нет в списке.",
      });
      expect(calls[1]?.payload).toMatchObject({
        text: "<b>Допущенные</b>\n\nПока никого.",
      });
    });
  });

  describe("application card", () => {
    const first: ApplicationCard = {
      applicationId: "0192f3a4-b5c6-7d8e-9f0a-00000000a001",
      identityId: "0192f3a4-b5c6-7d8e-9f0a-0000c0de0001",
      telegramUserId: 77n,
      telegramUsername: "ivan_p",
      firstName: "Иван",
      circle: "public",
      source: { kind: "channel", label: "Солегуфики" },
      createdAtMs: Date.parse("2026-10-02T11:05:00.123Z"),
    };
    const second: ApplicationCard = {
      ...first,
      applicationId: "0192f3a4-b5c6-7d8e-9f0a-00000000a002",
      identityId: "0192f3a4-b5c6-7d8e-9f0a-0000c0de0002",
      telegramUsername: "petr",
      firstName: "Пётр",
      circle: "member",
      createdAtMs: first.createdAtMs + 60_000,
    };
    const cursorOf = (card: ApplicationCard) =>
      `${uuidToToken(card.applicationId)}:${card.createdAtMs.toString(36)}`;
    const shown = (card: ApplicationCard, position: number, total: number) =>
      ({
        kind: "ok",
        value: { card: { application: card, position }, total },
      }) as const;

    // Identity отдаёт очередь по состоянию, по одному чтению на нажатие.
    function moderating(
      reads: readonly { kind: "ok"; value: ApplicationQueueRead }[],
    ) {
      const readApplicationQueue =
        vi.fn<ApplicationModerator["readApplicationQueue"]>();
      for (const read of reads) {
        readApplicationQueue.mockResolvedValueOnce(read);
      }
      return {
        ...resolvedIdentity(["admin"]),
        readApplicationQueue,
        admitApplication: vi
          .fn<ApplicationModerator["admitApplication"]>()
          .mockResolvedValue({
            kind: "ok",
            value: { already: false, outcome: "admitted" },
          }),
        declineApplication: vi
          .fn<ApplicationModerator["declineApplication"]>()
          .mockResolvedValue({
            kind: "ok",
            value: { already: false, outcome: "blocked" },
          }),
      };
    }

    it("opens the oldest card from management", async () => {
      const identity = moderating([shown(first, 1, 2)]);
      const { bot, calls } = createHarness(identity);
      await bot.init();

      await bot.handleUpdate(callbackUpdate("v1:cm:q"));

      expect(identity.readApplicationQueue).toHaveBeenCalledWith(
        expect.objectContaining({ globalRoles: ["admin"] }),
        undefined,
        expect.objectContaining({ useCase: "manage_community" }),
      );
      expect(calls.at(-1)).toMatchObject({
        method: "editMessageText",
        payload: {
          text: expect.stringMatching(
            /^<b>Заявка 1 из 2 · аукцион<\/b>\n\nИван \(@ivan_p\)\nПришёл: канал «Солегуфики» · /,
          ),
        },
      });
    });

    it("admits and edits the card into the next one", async () => {
      const identity = moderating([shown(second, 1, 1)]);
      const { bot, calls } = createHarness(identity);
      await bot.init();

      await bot.handleUpdate(callbackUpdate(`v1:cm:qa:${cursorOf(first)}`));

      expect(identity.admitApplication).toHaveBeenCalledWith(
        expect.objectContaining({ globalRoles: ["admin"] }),
        first.applicationId,
        expect.objectContaining({ useCase: "manage_community" }),
      );
      expect(identity.readApplicationQueue).toHaveBeenCalledWith(
        expect.anything(),
        { createdAtMs: first.createdAtMs, applicationId: first.applicationId },
        expect.anything(),
      );
      expect(calls.map((call) => call.method)).toEqual([
        "answerCallbackQuery",
        "editMessageText",
      ]);
      expect(calls[0]?.payload).toMatchObject({ text: "Человек допущен." });
      expect(JSON.stringify(calls[1]?.payload)).toContain(
        "Заявка 1 из 1 · хаб",
      );
    });

    it("tells the second administrator who decided and how, then moves on", async () => {
      const identity = moderating([shown(second, 1, 1)]);
      identity.admitApplication.mockResolvedValue({
        kind: "ok",
        value: {
          already: true,
          outcome: "blocked",
          decidedBy: { telegramUserId: 7n, telegramUsername: "admin" },
        },
      });
      const { bot, calls } = createHarness(identity);
      await bot.init();

      await bot.handleUpdate(callbackUpdate(`v1:cm:qa:${cursorOf(first)}`));

      expect(calls[0]?.payload).toMatchObject({
        text: "Уже решено: заблокирован, @admin.",
      });
      expect(calls[1]).toMatchObject({ method: "editMessageText" });
      expect(JSON.stringify(calls[1]?.payload)).toContain("Пётр (@petr)");
    });

    it("keeps the same card when the decision was not saved", async () => {
      const identity = moderating([shown(first, 1, 1)]);
      identity.admitApplication.mockResolvedValue({
        kind: "unavailable",
        cause: new Error("down"),
      });
      const { bot, calls } = createHarness(identity);
      await bot.init();

      await bot.handleUpdate(callbackUpdate(`v1:cm:qa:${cursorOf(first)}`));

      expect(identity.readApplicationQueue).toHaveBeenCalledWith(
        expect.anything(),
        {
          createdAtMs: first.createdAtMs,
          applicationId: "0192f3a4-b5c6-7d8e-9f0a-00000000a000",
        },
        expect.anything(),
      );
      expect(calls[0]?.payload).toMatchObject({
        text: "Решение не подтвердилось. Карточка перечитана заново.",
      });
      expect(JSON.stringify(calls[1]?.payload)).toContain("Иван (@ivan_p)");
    });

    it("ends the queue on skipping the last card instead of looping", async () => {
      const identity = moderating([{ kind: "ok", value: { total: 2 } }]);
      const { bot, calls } = createHarness(identity);
      await bot.init();

      await bot.handleUpdate(callbackUpdate(`v1:cm:q:${cursorOf(second)}`));

      expect(identity.readApplicationQueue).toHaveBeenCalledWith(
        expect.anything(),
        {
          createdAtMs: second.createdAtMs,
          applicationId: second.applicationId,
        },
        expect.anything(),
      );
      expect(calls.at(-1)).toMatchObject({
        method: "editMessageText",
        payload: {
          text: "<b>Заявки</b>\n\nОчередь кончилась. Ещё открыто заявок: 2.",
        },
      });
    });

    it("does not open the card for a non-administrator", async () => {
      const identity = {
        ...resolvedIdentity(["member"]),
        readApplicationQueue: vi
          .fn<ApplicationModerator["readApplicationQueue"]>()
          .mockResolvedValue({ kind: "forbidden" }),
      };
      const { bot, calls } = createHarness(identity);
      await bot.init();

      await bot.handleUpdate(callbackUpdate("v1:cm:q"));

      expect(calls.at(-1)).toMatchObject({
        method: "editMessageText",
        payload: {
          text: "<b>Разбирать заявки может только администратор.</b>",
          reply_markup: {
            inline_keyboard: [
              [
                { text: "‹ Управление", callback_data: "v1:manage:menu" },
                { text: "Меню", callback_data: "v1:nav:start" },
              ],
            ],
          },
        },
      });
    });

    it("asks before declining and declines with one press", async () => {
      const identity = moderating([shown(first, 1, 2), shown(second, 1, 1)]);
      const { bot, calls } = createHarness(identity);
      await bot.init();

      await bot.handleUpdate(callbackUpdate(`v1:cm:qd:${cursorOf(first)}`));

      expect(identity.declineApplication).not.toHaveBeenCalled();
      expect(calls.at(-1)).toMatchObject({
        method: "editMessageText",
        payload: { text: expect.stringContaining("<b>Отказать?</b>") },
      });

      await bot.handleUpdate(callbackUpdate(`v1:cm:qy:${cursorOf(first)}`));

      expect(identity.declineApplication).toHaveBeenCalledWith(
        expect.anything(),
        first.applicationId,
        expect.anything(),
      );
      expect(calls.at(-2)?.payload).toMatchObject({
        text: "Отказано: профиль заблокирован.",
      });
      expect(JSON.stringify(calls.at(-1)?.payload)).toContain("Пётр (@petr)");
    });

    it("does not ask about a card another administrator already decided", async () => {
      const identity = moderating([shown(second, 1, 1)]);
      const { bot, calls } = createHarness(identity);
      await bot.init();

      await bot.handleUpdate(callbackUpdate(`v1:cm:qd:${cursorOf(first)}`));

      expect(calls[0]?.payload).toMatchObject({
        text: "Эту заявку уже решили.",
      });
      expect(JSON.stringify(calls[1]?.payload)).toContain("Пётр (@petr)");
    });

    it.each([true, false])(
      "opens an unknown person's card with username %s using only public profile links",
      async (hasUsername) => {
        const { telegramUsername: _, ...withoutUsername } = first;
        const identity = moderating([
          shown(hasUsername ? first : withoutUsername, 1, 1),
        ]);
        const { bot, calls } = createHarness(identity);
        // Пользователь не известен хабу; его публичный username не требует
        // tg://user и не должен влиять на доставку карточки.
        bot.api.config.use((prev, method, payload, signal) =>
          JSON.stringify(payload).includes("tg://user?id=")
            ? Promise.resolve({
                ok: false,
                error_code: 400,
                description: "Bad Request: user not found",
              })
            : prev(method, payload, signal),
        );
        await bot.init();

        await bot.handleUpdate(callbackUpdate("v1:cm:q"));

        expect(calls.at(-1)).toMatchObject({ method: "editMessageText" });
        expect(JSON.stringify(calls.at(-1)?.payload)).toContain(
          "Заявка 1 из 1",
        );
        expect(JSON.stringify(calls.at(-1)?.payload)).not.toContain(
          "tg://user",
        );
        const payload = JSON.stringify(calls.at(-1)?.payload);
        if (hasUsername) {
          expect(payload).toContain("https://t.me/ivan_p");
          expect(payload).toContain("Профиль ↗");
        } else {
          expect(payload).not.toContain("https://t.me/");
          expect(payload).not.toContain("Профиль ↗");
        }
      },
    );

    it("sends the card as a new message when editing is unavailable", async () => {
      const { bot, calls, records } = createHarness(
        moderating([shown(first, 1, 1)]),
      );
      bot.api.config.use((prev, method, payload, signal) =>
        method === "editMessageText"
          ? Promise.resolve({
              ok: false,
              error_code: 400,
              description: "Bad Request: message can't be edited",
            })
          : prev(method, payload, signal),
      );
      await bot.init();

      await bot.handleUpdate(callbackUpdate("v1:cm:q"));

      expect(calls.at(-1)).toMatchObject({
        method: "sendMessage",
        payload: { text: expect.stringContaining("Заявка 1 из 1") },
      });
      expect(records.at(-1)?.fields.result).toBe("ok");
    });

    it.each([400, 403, 500])(
      "shows a failure frame when Telegram rejects a card with %s",
      async (errorCode) => {
        const identity = moderating([shown(second, 1, 1)]);
        const { bot, calls, records } = createHarness(identity);
        bot.api.config.use((prev, method, payload, signal) =>
          "text" in payload && String(payload.text).startsWith("<b>Заявка ")
            ? Promise.resolve({
                ok: false,
                error_code: errorCode,
                description: `card rejected ${method}`,
              })
            : prev(method, payload, signal),
        );
        await bot.init();

        await bot.handleUpdate(callbackUpdate(`v1:cm:qa:${cursorOf(first)}`));

        expect(calls.at(-1)).toMatchObject({
          method: "sendMessage",
          payload: {
            text: expect.stringContaining("Не получилось показать экран"),
            reply_markup: {
              inline_keyboard: [
                [{ text: "Меню", callback_data: "v1:nav:start" }],
              ],
            },
          },
        });
        expect(identity.admitApplication).toHaveBeenCalledTimes(1);
        expect(records.at(-1)?.fields.error).toContain(
          "card rejected editMessageText",
        );
        expect(records.at(-1)?.fields.error).toContain(
          "card rejected sendMessage",
        );
      },
    );
  });

  describe("refused applications", () => {
    const applicationId = "0192f3a4-b5c6-7d8e-9f0a-00000000a001";
    const applicationToken = uuidToToken(applicationId);
    const blocked: RefusedApplication = {
      applicationId,
      identityId: "0192f3a4-b5c6-7d8e-9f0a-00000000b001",
      telegramUserId: 77n,
      telegramUsername: "refused",
      circle: "public",
      outcome: "blocked",
      decidedBy: { telegramUserId: 7n, telegramUsername: "admin" },
      decidedAt: { year: 2026, month: 10, day: 2, hours: 14, minutes: 5 },
    };

    // Identity отдаёт список по состоянию: после пересмотра человека в нём нет.
    function refusing(
      lists: readonly (readonly RefusedApplication[])[],
      changed = true,
    ) {
      const refusedApplications =
        vi.fn<ApplicationAdministrator["refusedApplications"]>();
      for (const list of lists) {
        refusedApplications.mockResolvedValueOnce({ kind: "ok", value: list });
      }
      const reconsiderApplication = vi
        .fn<ApplicationAdministrator["reconsiderApplication"]>()
        .mockResolvedValue({ kind: "ok", value: changed });
      return {
        ...resolvedIdentity(["admin"]),
        refusedApplications,
        reconsiderApplication,
      };
    }

    it("lists the refused with the outcome caption", async () => {
      const identity = refusing([
        [blocked, { ...blocked, circle: "member", outcome: "declined" }],
      ]);
      const { bot, calls } = createHarness(identity);
      await bot.init();

      await bot.handleUpdate(callbackUpdate("v1:cm:r"));

      expect(identity.refusedApplications).toHaveBeenCalledWith(
        expect.objectContaining({ globalRoles: ["admin"] }),
        expect.objectContaining({ useCase: "manage_community" }),
      );
      const text = JSON.stringify(calls.at(-1)?.payload);
      expect(text).toContain("@refused — заявка в аукцион, заблокирован");
      expect(text).toContain("@refused — заявка в хаб, отклонена");
    });

    it("does not open the list for a non-administrator", async () => {
      const identity = {
        ...resolvedIdentity(["member"]),
        refusedApplications: vi
          .fn<ApplicationAdministrator["refusedApplications"]>()
          .mockResolvedValue({ kind: "forbidden" }),
      };
      const { bot, calls } = createHarness(identity);
      await bot.init();

      await bot.handleUpdate(callbackUpdate("v1:cm:r"));

      expect(calls.at(-1)).toMatchObject({
        method: "editMessageText",
        payload: {
          text: "<b>Пересматривать отказы может только администратор.</b>",
          reply_markup: {
            inline_keyboard: [
              [
                { text: "‹ Управление", callback_data: "v1:manage:menu" },
                { text: "Меню", callback_data: "v1:nav:start" },
              ],
            ],
          },
        },
      });
    });

    it("asks before reconsidering and names the consequence", async () => {
      const identity = refusing([[blocked]]);
      const { bot, calls } = createHarness(identity);
      await bot.init();

      await bot.handleUpdate(callbackUpdate(`v1:cm:rq:${applicationToken}:0`));

      expect(identity.reconsiderApplication).not.toHaveBeenCalled();
      expect(calls.at(-1)).toMatchObject({
        method: "editMessageText",
        payload: {
          text: "<b>Пересмотреть отказ?</b>\n\nБлокировка @refused снимется, и сразу откроется доступ к аукциону.",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "Да, пересмотреть",
                  callback_data: `v1:cm:ry:${applicationToken}:0`,
                },
              ],
              [{ text: "Нет", callback_data: "v1:cm:r:0" }],
            ],
          },
        },
      });
    });

    it("reconsiders with one press and drops the person from the list", async () => {
      const identity = refusing([[]]);
      const { bot, calls, records } = createHarness(identity);
      await bot.init();

      await bot.handleUpdate(callbackUpdate(`v1:cm:ry:${applicationToken}:0`));

      expect(identity.reconsiderApplication).toHaveBeenCalledWith(
        expect.objectContaining({ globalRoles: ["admin"] }),
        applicationId,
        expect.objectContaining({ useCase: "manage_community" }),
      );
      expect(calls.map((call) => call.method)).toEqual([
        "answerCallbackQuery",
        "editMessageText",
      ]);
      expect(calls[0]?.payload).toMatchObject({ text: "Отказ пересмотрен." });
      expect(calls[1]?.payload).toMatchObject({
        text: "<b>Отказанные</b>\n\nПока никого.",
      });
      expectBoundary(records.at(-1), {
        level: "info",
        result: "ok",
        operation: "callback_query",
        use_case: "manage_community",
      });
    });

    it("answers already reconsidered when another administrator was first", async () => {
      const identity = refusing([[]], false);
      const { bot, calls } = createHarness(identity);
      await bot.init();

      await bot.handleUpdate(callbackUpdate(`v1:cm:ry:${applicationToken}:0`));

      expect(calls[0]?.payload).toMatchObject({ text: "Уже пересмотрено." });
    });

    it("answers already reconsidered when the refusal left the list before the question", async () => {
      const identity = refusing([[]]);
      const { bot, calls } = createHarness(identity);
      await bot.init();

      await bot.handleUpdate(callbackUpdate(`v1:cm:rq:${applicationToken}:0`));

      expect(calls[0]?.payload).toMatchObject({ text: "Уже пересмотрено." });
      expect(calls[1]?.payload).toMatchObject({
        text: "<b>Отказанные</b>\n\nПока никого.",
      });
    });

    it("says why a declined refusal of a blocked profile stays", async () => {
      const identity = refusing([[blocked]]);
      identity.reconsiderApplication.mockResolvedValue({ kind: "not-refused" });
      const { bot, calls, records } = createHarness(identity);
      await bot.init();

      await bot.handleUpdate(callbackUpdate(`v1:cm:ry:${applicationToken}:0`));

      expect(calls[0]?.payload).toMatchObject({
        text: "Пересмотреть нельзя: профиль заблокирован.",
      });
      expectBoundary(records.at(-1), {
        level: "info",
        result: "ok",
        operation: "callback_query",
        use_case: "manage_community",
      });
    });

    it("opens a full page through the screen linter", async () => {
      const identity = refusing([
        Array.from({ length: 20 }, (_, index) => ({
          ...blocked,
          applicationId: `0192f3a4-b5c6-7d8e-9f0a-${index.toString(16).padStart(12, "0")}`,
          telegramUsername: `user${index}`,
        })),
      ]);
      const { bot, calls } = createHarness(identity);
      await bot.init();

      await bot.handleUpdate(callbackUpdate("v1:cm:r:1"));

      expect(JSON.stringify(calls.at(-1)?.payload)).toContain(
        "<b>Отказанные · 2 из 3</b>",
      );
    });
  });

  // Полные подэкраны проходят через линтер экранов: потолок рядов, словарь и
  // ряд возврата проверяются на странице из восьми строк, а не на пустой.
  it.each([
    ["v1:cm:p", "Ожидают допуска"],
    ["v1:cm:a:1", "Допущенные · 2 из 3"],
    ["v1:cm:u:1", "Разрешённые ники · 2 из 3"],
  ])("opens the full community list %s", async (data, title) => {
    const people = (admitted: boolean, from: number) =>
      Array.from({ length: 20 }, (_, index) => ({
        identityId: `0192f3a4-b5c6-7d8e-9f0a-${(from + index).toString(16).padStart(12, "0")}`,
        telegramUsername: `user${from + index}`,
        admitted,
      }));
    const identity = {
      ...resolvedIdentity(["admin"]),
      community: vi
        .fn<CommunityAdministrator["community"]>()
        .mockResolvedValue({
          kind: "ok",
          value: {
            members: [...people(false, 0), ...people(true, 100)],
            allowedUsernames: Array.from(
              { length: 20 },
              (_, index) => `nick${index}`,
            ),
          },
        }),
    };
    const { bot, calls } = createHarness(identity);
    await bot.init();

    await bot.handleUpdate(callbackUpdate(data));

    expect(calls.at(-1)).toMatchObject({
      method: "editMessageText",
      payload: { text: expect.stringContaining(`<b>${title}</b>`) },
    });
  });

  it("keeps the same person on screen and says so when the admission is not saved", async () => {
    const firstId = "0192f3a4-b5c6-7d8e-9f0a-1b2c3d4e5f60";
    const secondId = "0192f3a4-b5c6-7d8e-9f0a-1b2c3d4e5f61";
    const identity = {
      ...resolvedIdentity(["admin"]),
      community: vi
        .fn<CommunityAdministrator["community"]>()
        .mockResolvedValue({
          kind: "ok",
          value: {
            members: [
              {
                identityId: firstId,
                telegramUsername: "first",
                admitted: false,
              },
              {
                identityId: secondId,
                telegramUsername: "second",
                admitted: false,
              },
            ],
            allowedUsernames: [],
          },
        }),
      admit: vi.fn<CommunityAdministrator["admit"]>().mockResolvedValue({
        kind: "unavailable",
        cause: new Error("deadline exceeded"),
      }),
    };
    const { bot, calls } = createHarness(identity);
    await bot.init();

    await bot.handleUpdate(
      callbackUpdate(
        `v1:cm:ad:${uuidToToken(firstId)}:${uuidToToken(secondId)}`,
      ),
    );

    expect(calls[0]?.payload).toMatchObject({
      text: "Не получилось сохранить. Попробуй ещё раз.",
    });
    expect(calls[1]?.payload).toMatchObject({
      text: expect.stringContaining("@first"),
    });
  });

  it("shows the next person in the queue after an admission", async () => {
    const firstId = "0192f3a4-b5c6-7d8e-9f0a-1b2c3d4e5f60";
    const secondId = "0192f3a4-b5c6-7d8e-9f0a-1b2c3d4e5f61";
    const identity = {
      ...resolvedIdentity(["admin"]),
      community: vi
        .fn<CommunityAdministrator["community"]>()
        .mockResolvedValue({
          kind: "ok",
          value: {
            members: [
              {
                identityId: secondId,
                telegramUsername: "second",
                admitted: false,
              },
            ],
            allowedUsernames: [],
          },
        }),
      admit: vi
        .fn<CommunityAdministrator["admit"]>()
        .mockResolvedValue({ kind: "ok", value: false }),
    };
    const { bot, calls } = createHarness(identity);
    await bot.init();

    await bot.handleUpdate(
      callbackUpdate(
        `v1:cm:ad:${uuidToToken(firstId)}:${uuidToToken(secondId)}`,
      ),
    );

    expect(identity.admit).toHaveBeenCalledWith(
      expect.anything(),
      firstId,
      expect.anything(),
    );
    expect(calls[0]?.payload).toMatchObject({
      text: "Состояние уже было актуальным.",
    });
    expect(calls[1]?.payload).toMatchObject({
      text: "<b>Ожидают допуска</b>\n\n@second\n\nВ очереди: 1",
    });
  });

  // О допуске заявителю пишет канал Notifications по событию Identity
  // (PER-442): экран состава сам ему не пишет, иначе сообщений было бы два.
  it("leaves the admitted person's notice to the notification channel", async () => {
    const admittedId = "0192f3a4-b5c6-7d8e-9f0a-1b2c3d4e5f60";
    const community = vi
      .fn<CommunityAdministrator["community"]>()
      .mockResolvedValue({
        kind: "ok",
        value: { members: [], allowedUsernames: [] },
      });
    const admit = vi
      .fn<CommunityAdministrator["admit"]>()
      .mockResolvedValue({ kind: "ok", value: true });
    const resolveTelegramUserId =
      vi.fn<TelegramRecipientResolver["resolveTelegramUserId"]>();
    const identity = {
      ...resolvedIdentity(["admin"]),
      community,
      admit,
      resolveTelegramUserId,
    };
    const { bot, calls } = createHarness(identity);
    await bot.init();
    await bot.handleUpdate(
      callbackUpdate(`v1:community:admit:${uuidToToken(admittedId)}`),
    );

    expect(admit).toHaveBeenCalled();
    expect(JSON.stringify(calls)).toContain("Человек допущен.");
    expect(resolveTelegramUserId).not.toHaveBeenCalled();
    expect(JSON.stringify(calls)).not.toContain("Доступ открыт");
  });

  it("lets Identity refuse community management for a non-admin", async () => {
    const community = vi
      .fn<CommunityAdministrator["community"]>()
      .mockResolvedValue({ kind: "forbidden" });
    const identity = { ...resolvedIdentity(["member"]), community };
    const { bot, calls, records } = createHarness(identity);
    await bot.init();
    // Старая кнопка из меню бот не сторожит: право решает Identity, а отказ
    // звучит без имени сервиса.
    await bot.handleUpdate(callbackUpdate("v1:community:list"));

    expect(community).toHaveBeenCalledOnce();
    expect(calls[1]).toMatchObject({
      method: "editMessageText",
      payload: {
        text: refusalText(
          "Управлять составом сообщества может только администратор.",
        ),
      },
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
    expect(sendMessageText(calls[0])).not.toBe(
      refusalText(pendingHubAccessText(resolvedId, undefined)),
    );
    expect(sendMessageText(calls[0])).not.toBe(
      refusalText(blockedHubAccessText),
    );
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
      refusalText("Сходка не найдена или больше недоступна."),
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
    // Переход по меню приходит правкой экрана, всплывающего окна нет.
    expect(calls[0]?.method).toBe("answerCallbackQuery");
    expect(calls[0]?.payload).not.toHaveProperty("text");
    expect(calls[1]).toMatchObject({
      method: "editMessageText",
      payload: {
        text: "<b>Ближайшие сходки</b>\n\nПока ни одной запланированной сходки нет.\n\nКогда организатор создаст новую, она появится здесь.",
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "‹ Меню", callback_data: "v1:nav:start" }],
          ],
        },
      },
    });
  });

  it("returns from the meetup list to the start screen by editing the same message", async () => {
    const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue({
      kind: "message",
      text: "Привет. Главный экран.",
    });
    const { bot, calls, records } = createHarness(resolvedIdentity(["admin"]), {
      execute,
    });
    await bot.init();
    await bot.handleUpdate(callbackUpdate("v1:nav:start"));
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ intent: "start" }),
    );
    expect(calls.map((call) => call.method)).toEqual([
      "answerCallbackQuery",
      "editMessageText",
    ]);
    expect(calls[1]).toMatchObject({
      method: "editMessageText",
      payload: {
        message_id: 9,
        text: "<b>Меню</b>\n\nПривет. Главный экран.",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "Ближайшие сходки", callback_data: "v1:nav:hub" },
              { text: "Архив", callback_data: "v1:nav:archive" },
            ],
            [{ text: "Уведомления", callback_data: "v1:notify:global" }],
            [{ text: "Управление", callback_data: "v1:manage:menu" }],
          ],
        },
      },
    });
    expectBoundary(records[0], {
      level: "info",
      result: "ok",
      operation: "callback_query",
      use_case: "find_meetup",
    });
  });

  it("groups dated meetups before meetups without a date", async () => {
    const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue({
      kind: "meetup-list",
      meetups: [
        {
          id: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34ce",
          title: "Без даты",
          visibility: "visible" as const,
        },
        {
          id: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cf",
          title: "Настолки",
          schedule: { year: 2026, month: 8, day: 15 },
          visibility: "visible" as const,
        },
      ],
    });
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-08-01T12:00Z") });
    const { bot, calls } = createHarness(resolvedIdentity(), { execute });
    await bot.init();
    await bot.handleUpdate(callbackUpdate("v1:nav:hub"));
    expect(calls[1]).toMatchObject({
      method: "editMessageText",
      payload: {
        text: "<b>Ближайшие сходки</b>\n\nС датой\n• 15 августа, сб — Настолки\n\nБез даты\n• Без даты",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "15 августа · Настолки",
                callback_data: "v1:view:AZjypHwefTqbIU-OEqs0zw",
              },
            ],
            [
              {
                text: "Без даты",
                callback_data: "v1:view:AZjypHwefTqbIU-OEqs0zg",
              },
            ],
            [{ text: "‹ Меню", callback_data: "v1:nav:start" }],
          ],
        },
      },
    });
  });

  it("marks a hidden meetup in the hub", async () => {
    const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue({
      kind: "meetup-list",
      meetups: [
        {
          id: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34ce",
          title: "Черновик",
          visibility: "hidden" as const,
        },
        {
          id: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cf",
          title: "Настолки",
          visibility: "visible" as const,
        },
      ],
    });
    const { bot, calls } = createHarness(resolvedIdentity(["admin"]), {
      execute,
    });
    await bot.init();
    await bot.handleUpdate(callbackUpdate("v1:nav:hub"));
    expect(calls[1]).toMatchObject({
      method: "editMessageText",
      payload: {
        text: "<b>Ближайшие сходки</b>\n\nБез даты\n• Черновик (скрыта)\n• Настолки",
      },
    });
  });

  it("labels a draft without a title in the hub", async () => {
    const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue({
      kind: "meetup-list",
      meetups: [
        {
          id: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34ce",
          title: "",
          visibility: "visible" as const,
        },
      ],
    });
    const { bot, calls } = createHarness(resolvedIdentity(["admin"]), {
      execute,
    });
    await bot.init();
    await bot.handleUpdate(callbackUpdate("v1:nav:hub"));
    expect(calls[1]).toMatchObject({
      method: "editMessageText",
      payload: {
        text: "<b>Ближайшие сходки</b>\n\nБез даты\n• Без названия",
        reply_markup: {
          inline_keyboard: expect.arrayContaining([
            [
              {
                text: "Без названия",
                callback_data: "v1:view:AZjypHwefTqbIU-OEqs0zg",
              },
            ],
          ]),
        },
      },
    });
  });

  it("labels a cancelled draft without a title in the archive", async () => {
    const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue({
      kind: "archived-meetup-list",
      meetups: [
        {
          id: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34ce",
          title: "",
          visibility: "hidden" as const,
          status: "cancelled" as const,
        },
      ],
    });
    const { bot, calls } = createHarness(resolvedIdentity(["admin"]), {
      execute,
    });
    await bot.init();
    await bot.handleUpdate(callbackUpdate("v1:nav:archive"));
    const text = (calls[1] as { payload: { text: string } } | undefined)
      ?.payload.text;
    expect(text).toContain("• Без названия (отменена)");
  });

  it("offers the hidden meetups section in the management menu", async () => {
    const { bot, calls } = createHarness(resolvedIdentity(["admin"]));
    await bot.init();
    await bot.handleUpdate(callbackUpdate("v1:manage:menu"));
    expect(JSON.stringify(calls[1]?.payload)).toContain(
      '{"text":"Скрытые сходки","callback_data":"v1:manage:hidden"}',
    );
    expect(JSON.stringify(calls[1]?.payload)).toContain(
      '{"text":"Отказанные","callback_data":"v1:cm:r"}',
    );
  });

  it("lists only hidden meetups in the hidden section", async () => {
    const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue({
      kind: "meetup-list",
      meetups: [
        {
          id: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34ce",
          title: "",
          visibility: "hidden" as const,
        },
        {
          id: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cf",
          title: "Настолки",
          schedule: { year: 2026, month: 8, day: 15 },
          visibility: "visible" as const,
        },
      ],
    });
    const { bot, calls, records } = createHarness(resolvedIdentity(["admin"]), {
      execute,
    });
    await bot.init();
    await bot.handleUpdate(callbackUpdate("v1:manage:hidden"));
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ intent: "list-visible-meetups" }),
    );
    expect(calls[1]).toMatchObject({
      method: "editMessageText",
      payload: {
        text: "<b>Скрытые сходки</b>\n\n• Без названия",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "Без названия",
                callback_data: "v1:view:AZjypHwefTqbIU-OEqs0zg",
              },
            ],
            [
              { text: "‹ Управление", callback_data: "v1:manage:menu" },
              { text: "Меню", callback_data: "v1:nav:start" },
            ],
          ],
        },
      },
    });
    expectBoundary(records[0], {
      level: "info",
      result: "ok",
      operation: "callback_query",
      use_case: "find_meetup",
    });
  });

  it("shows an empty hidden section when Meetups returns nothing hidden", async () => {
    const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue({
      kind: "meetup-list",
      meetups: [
        {
          id: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cf",
          title: "Настолки",
          visibility: "visible" as const,
        },
      ],
    });
    const { bot, calls } = createHarness(resolvedIdentity(), { execute });
    await bot.init();
    await bot.handleUpdate(callbackUpdate("v1:manage:hidden"));
    expect(calls[1]).toMatchObject({
      method: "editMessageText",
      payload: {
        text: expect.stringContaining("Скрытых сходок нет."),
        reply_markup: {
          inline_keyboard: [
            [
              { text: "‹ Управление", callback_data: "v1:manage:menu" },
              { text: "Меню", callback_data: "v1:nav:start" },
            ],
          ],
        },
      },
    });
  });

  it("renders an empty archive as an empty state", async () => {
    const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue({
      kind: "archived-meetup-list",
      meetups: [],
    });
    const { bot, calls } = createHarness(resolvedIdentity(), { execute });
    await bot.init();
    await bot.handleUpdate(callbackUpdate("v1:nav:archive"));
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ intent: "list-archived-meetups" }),
    );
    expect(calls[1]).toMatchObject({
      method: "editMessageText",
      payload: { text: expect.stringContaining("Архив пока пуст") },
    });
  });

  it("distinguishes held, cancelled and past meetups in the archive", async () => {
    const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue({
      kind: "archived-meetup-list",
      meetups: [
        {
          id: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34ce",
          title: "Состоялась",
          visibility: "visible" as const,
          status: "held" as const,
        },
        {
          id: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cf",
          title: "Отменена",
          visibility: "visible" as const,
          status: "cancelled" as const,
        },
        {
          id: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34d0",
          title: "Прошла",
          visibility: "visible" as const,
          status: "past" as const,
        },
      ],
    });
    const { bot, calls } = createHarness(resolvedIdentity(), { execute });
    await bot.init();
    await bot.handleUpdate(callbackUpdate("v1:nav:archive"));
    const text = (calls[1] as { payload: { text: string } } | undefined)
      ?.payload.text;
    expect(text).toContain("Состоялась (состоялась)");
    expect(text).toContain("Отменена (отменена)");
    expect(text).toContain("Прошла (прошла)");
  });

  it("shows a hold confirmation and executes only after confirming", async () => {
    const meetup = publishedMeetup();
    const held = { ...meetup, lifecycle: "held" as const };
    const execute = vi.fn<Dispatcher["execute"]>(async (request) =>
      request.intent === "view-meetup"
        ? { kind: "meetup-card", meetup }
        : { kind: "meetup-state-changed", action: "hold", meetup: held },
    );
    const { bot, calls } = createHarness(resolvedIdentity(["admin"]), {
      execute,
    });
    await bot.init();

    await bot.handleUpdate(
      callbackUpdate("v1:manage:hold:AZLzpLXGfY6fChssPU5fYA"),
    );
    expect(execute).toHaveBeenCalledTimes(1);
    expect(calls.at(-1)).toMatchObject({
      method: "editMessageText",
      payload: {
        text: "<b>Отметить сходку состоявшейся?</b>\n\n«Настолки»\nОтменить нельзя: состоявшаяся сходка в план не возвращается.",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "Да, отметить состоявшейся",
                callback_data:
                  "v1:manage:confirm-hold:AZLzpLXGfY6fChssPU5fYA:1",
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
      callbackUpdate("v1:manage:confirm-hold:AZLzpLXGfY6fChssPU5fYA"),
    );
    expect(execute).toHaveBeenLastCalledWith({
      identity: {
        identityId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd",
        globalRoles: ["admin"],
        rights: ["hub", "auction"],
      },
      intent: "change-meetup-state",
      action: "hold",
      meetupId: meetup.id,
      requestId: expect.any(String),
      useCase: "update_meetup",
      deadlineAt: expect.any(Number),
    });
  });

  it("answers a stale hold button on an already held meetup without confirming", async () => {
    const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue({
      kind: "meetup-card",
      meetup: { ...publishedMeetup(), lifecycle: "held" },
    });
    const { bot, calls } = createHarness(resolvedIdentity(["admin"]), {
      execute,
    });
    await bot.init();

    await bot.handleUpdate(
      callbackUpdate("v1:manage:hold:AZLzpLXGfY6fChssPU5fYA"),
    );

    expect(calls.at(-1)).toMatchObject({
      method: "editMessageText",
      payload: { text: expect.stringContaining("уже отмечена состоявшейся") },
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("renders Meetups unavailability as E-05 instead of an empty list", async () => {
    const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue({
      kind: "dependency-rejected",
      reason: "unavailable",
    });
    const { bot, calls } = createHarness(resolvedIdentity(), { execute });
    await bot.init();
    await bot.handleUpdate(callbackUpdate("v1:nav:hub"));
    // Экран на время ожидания не правится: после сбоя соседа заменять нечего,
    // и последним человек видит кадр E-05.
    expect(calls.map((call) => call.method)).toEqual([
      "answerCallbackQuery",
      "editMessageText",
    ]);
    expect(calls[0]?.payload).not.toHaveProperty("text");
    expect(calls[1]).toMatchObject({
      method: "editMessageText",
      payload: {
        text: expect.stringContaining("Не получилось загрузить сходки"),
        reply_markup: {
          inline_keyboard: [
            [{ text: "Повторить", callback_data: "v1:nav:hub" }],
            [{ text: "Меню", callback_data: "v1:nav:start" }],
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
            [{ text: "Меню", callback_data: "v1:nav:start" }],
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
              rights: ["hub", "auction"],
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
        author: "0192f0a0-0000-7000-8000-00000000a001",
        version: 1,
        materials: [],
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
        replyMessageId: lastQuestionId(calls),
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
    expect(questionText).not.toContain("Шаг:");
    expect(questionText).not.toContain("v1:manage");
    // Шаг лежит в кнопке «Отмена», а не в тексте вопроса.
    expect(question?.payload).toMatchObject({
      reply_markup: {
        force_reply: true,
        inline_keyboard: [
          [
            {
              text: "Отмена",
              callback_data: "v1:q:fe:AZLzpLXGfY6fChssPU5fYA:venue:42",
            },
          ],
        ],
      },
    });

    const restarted = createHarness(resolvedIdentity(["admin"]), { execute });
    await restarted.bot.init();
    await restarted.bot.handleUpdate(
      replyUpdate({
        text: "Новый зал",
        fromId: 42,
        replyMessageId: lastQuestionId(first.calls),
        replyFromId: 1,
        replyText: questionText,
        replyMarkup: (
          question?.payload as { reply_markup?: unknown } | undefined
        )?.reply_markup,
      }),
    );

    expect(execute).toHaveBeenLastCalledWith({
      identity: {
        identityId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd",
        globalRoles: ["admin"],
        rights: ["hub", "auction"],
      },
      intent: "update-meetup-field",
      field: "venue",
      value: "Новый зал",
      meetupId: meetup.id,
      requestId: expect.any(String),
      useCase: "update_meetup",
      deadlineAt: expect.any(Number),
    });
    // Ответ на вопрос — одно сообщение: экран исхода с названием сходки.
    // Вопрос закрывается после него: упавшая отправка не теряет шаг.
    const answered = restarted.calls.slice(-2);
    expect(answered.map((call) => call.method)).toEqual([
      "sendMessage",
      "editMessageReplyMarkup",
    ]);
    expect(sendMessageText(answered[0])).toBe(
      "<b>Изменение сохранено</b>\n\n«Настолки»",
    );
    expect(JSON.stringify(answered[0]?.payload)).toContain("‹ Сходка");
  });

  // Вопрос после рестарта знает, кому задан, из своей кнопки, и чужой ответ
  // отбрасывает так же, как до рестарта (PER-461).
  it.each([
    { data: "v1:q:fe:AZLzpLXGfY6fChssPU5fYA:venue:42", kind: "a field" },
    { data: "v1:q:pm:AZLzpLXGfY6fChssPU5fYA:42", kind: "a publish moment" },
  ])(
    "ignores a foreign answer to $kind question after restart",
    async ({ data }) => {
      const execute = vi.fn<Dispatcher["execute"]>();
      const restarted = createHarness(resolvedIdentity(["admin"]), {
        execute,
      });
      await restarted.bot.init();
      await restarted.bot.handleUpdate(
        replyUpdate({
          text: "05.10.2026 19:00",
          fromId: 7,
          replyMessageId: 77,
          replyFromId: 1,
          replyText: "Вопрос",
          replyMarkup: cancel(data),
        }),
      );

      expect(execute).not.toHaveBeenCalled();
      expect(restarted.calls).toEqual([]);
    },
  );

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
        text: "<b>Скрыть сходку из общего списка?</b>\n\n«Настолки»",
        reply_markup: {
          inline_keyboard: [
            [
              {
                // Скрытие обратимо, поэтому кнопка не красится.
                text: "Да, скрыть из списка",
                // Версия сходки на экране едет в «Да» (PER-472).
                callback_data:
                  "v1:manage:confirm-unpublish:AZLzpLXGfY6fChssPU5fYA:1",
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

  // «Да» несёт версию, которую человек видел, и она уходит в команду;
  // кнопка прошлого релиза без версии работает по-прежнему (PER-472).
  it.each([
    [
      "v1:manage:confirm-unpublish:AZLzpLXGfY6fChssPU5fYA:7",
      { expectedVersion: 7 },
    ],
    ["v1:manage:confirm-unpublish:AZLzpLXGfY6fChssPU5fYA", {}],
  ])("passes the version of %s to the state command", async (data, version) => {
    const meetup = publishedMeetup();
    const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue({
      kind: "meetup-state-changed",
      action: "unpublish",
      meetup: { ...meetup, visibility: "hidden" },
    });
    const { bot } = createHarness(resolvedIdentity(["admin"]), { execute });
    await bot.init();

    await bot.handleUpdate(callbackUpdate(data));

    const request = execute.mock.calls.at(-1)?.[0];
    expect(request).toMatchObject({
      intent: "change-meetup-state",
      action: "unpublish",
      ...version,
    });
    if (!("expectedVersion" in version)) {
      expect(request).not.toHaveProperty("expectedVersion");
    }
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
        rights: ["hub", "auction"],
      },
      intent: "change-meetup-state",
      action: "cancel",
      meetupId: meetup.id,
      requestId: expect.any(String),
      useCase: "update_meetup",
      deadlineAt: expect.any(Number),
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
        rights: ["hub", "auction"],
      },
      intent: "publish-meetup",
      meetupId: visible.id,
      requestId: expect.any(String),
      useCase: "update_meetup",
      deadlineAt: expect.any(Number),
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
        replyMessageId: lastQuestionId(calls),
        replyFromId: 1,
      }),
    );

    const conflict = sentMessages(calls).at(-1);
    expect(conflict).toMatchObject({
      method: "sendMessage",
      payload: {
        text: expect.stringContaining(
          "<b>Сходка уже изменилась</b>\n\nТвои изменения не сохранены. Проверь актуальные данные и повтори.",
        ),
      },
    });
    expect(sendMessageText(conflict)).toContain("Сейчас: Чужая правка");
    expect(sendMessageText(conflict)).toContain("Твоё значение: Моя правка");
    // Исход не вопрос: ответ ждёт «Ввести заново», а прежний вопрос закрыт.
    expect(JSON.stringify(conflict?.payload)).not.toContain("force_reply");
    expect(JSON.stringify(conflict?.payload)).toContain(
      '"text":"Ввести заново","callback_data":"v1:manage:draft:AZLzpLXGfY6fChssPU5fYA:title"',
    );
    expect(calls.at(-1)?.method).toBe("editMessageReplyMarkup");
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
                text: "Да, опубликовать",
                callback_data: "v1:manage:publish:AZLzpLXGfY6fChssPU5fYA",
              },
            ],
            [
              {
                text: "Нет",
                callback_data: "v1:view:AZLzpLXGfY6fChssPU5fYA",
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

  it("answers a cancellation version conflict with an outcome screen", async () => {
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
        text: "<b>Сходка уже изменилась</b>\n\n«Настолки»\n\nТвои изменения не сохранены. Проверь актуальные данные и повтори.",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "‹ Сходка",
                callback_data: "v1:view:AZLzpLXGfY6fChssPU5fYA",
              },
              { text: "Меню", callback_data: "v1:nav:start" },
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
        rights: ["hub", "auction"],
      },
      intent: "list-visible-meetups",
      requestId: expect.any(String),
      useCase: "find_meetup",
      deadlineAt: expect.any(Number),
    });
    expect(calls[1]).toMatchObject({
      method: "editMessageText",
      payload: { text: expect.stringContaining("ни одной запланированной") },
    });
  });

  it("edits the pressed screen into the publication outcome with a start link", async () => {
    const meetup = publishedMeetup();
    const execute = vi.fn<Dispatcher["execute"]>(async (request) =>
      request.intent === "view-meetup"
        ? { kind: "meetup-card", meetup }
        : { kind: "published", meetup },
    );
    const { bot, calls, records } = createHarness(resolvedIdentity(["admin"]), {
      execute,
    });
    await bot.init();
    await bot.handleUpdate(
      callbackUpdate("v1:manage:publish:AZLzpLXGfY6fChssPU5fYA"),
    );
    expect(calls.some((call) => call.method.startsWith("send"))).toBe(false);
    const edited = calls.find((call) => call.method === "editMessageText");
    expect(edited?.payload).toMatchObject({
      text: "<b>Сходка опубликована</b>\n\n«Настолки»\n\nТеперь она видна в списке. Ссылка для чата: https://t.me/stub_bot?start=m_AZLzpLXGfY6fChssPU5fYA",
      parse_mode: "HTML",
    });
    // Исход — свой экран: ряды карточки на нём не стоят, возврат — «‹ Сходка».
    expect(JSON.stringify(edited?.payload)).toContain(
      '"text":"‹ Сходка","callback_data":"v1:view:AZLzpLXGfY6fChssPU5fYA"',
    );
    expect(JSON.stringify(edited?.payload)).not.toContain(
      "v1:manage:status:AZLzpLXGfY6fChssPU5fYA",
    );
    // Ряды карточки — после «‹ Сходка».
    await bot.handleUpdate(callbackUpdate("v1:view:AZLzpLXGfY6fChssPU5fYA"));
    expect(JSON.stringify(calls.at(-1)?.payload)).toContain(
      "v1:manage:status:AZLzpLXGfY6fChssPU5fYA",
    );
    const published = records.find(
      (record) => record.message === "meetup published",
    );
    expectBoundary(published, {
      level: "info",
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

  it("answers a double publish tap with one publication message", async () => {
    const meetup = publishedMeetup();
    // Второе нажатие use case отдаёт карточкой: сходка уже видна (E-09).
    const execute = vi
      .fn<Dispatcher["execute"]>()
      .mockResolvedValueOnce({ kind: "published", meetup })
      .mockResolvedValueOnce({ kind: "published", meetup, repeated: true });
    const { bot, calls } = createHarness(resolvedIdentity(["admin"]), {
      execute,
    });
    await bot.init();
    await bot.handleUpdate(
      callbackUpdate("v1:manage:publish:AZLzpLXGfY6fChssPU5fYA"),
    );
    await bot.handleUpdate(
      callbackUpdate("v1:manage:publish:AZLzpLXGfY6fChssPU5fYA"),
    );
    expect(calls.filter((call) => call.method.startsWith("send"))).toHaveLength(
      0,
    );
    const announced = calls.filter((call) =>
      JSON.stringify(call.payload).includes("Сходка опубликована"),
    );
    expect(announced).toHaveLength(1);
    expect(calls.at(-1)).toMatchObject({
      method: "editMessageText",
      payload: {
        text: expect.stringContaining("«Настолки»"),
      },
    });
    // Правка стёрла сообщение первой публикации, но ссылка для чата осталась
    // на экране (PER-461).
    expect(calls.at(-1)?.payload).toMatchObject({
      text: "<b>Сходка уже опубликована</b>\n\n«Настолки»\n\nСсылка для чата: https://t.me/stub_bot?start=m_AZLzpLXGfY6fChssPU5fYA",
    });
  });

  it("redraws a stale preview by the current state without a new message", async () => {
    const current = { ...publishedMeetup(), title: "Настолки у Лёши" };
    const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue({
      kind: "published",
      meetup: current,
      repeated: true,
    });
    const { bot, calls, records } = createHarness(resolvedIdentity(["admin"]), {
      execute,
    });
    await bot.init();
    await bot.handleUpdate(
      callbackMessageUpdate("v1:manage:publish:AZLzpLXGfY6fChssPU5fYA", {
        text: "Проверь сходку\n\nНастолки",
      }),
    );
    expect(calls.filter((call) => call.method.startsWith("send"))).toHaveLength(
      0,
    );
    expect(JSON.stringify(calls)).not.toContain("Сходка опубликована");
    expect(calls.at(-1)).toMatchObject({
      method: "editMessageText",
      payload: {
        text: expect.stringContaining("«Настолки у Лёши»"),
      },
    });
    expectBoundary(
      records.find((record) => record.message === "meetup published"),
      {
        level: "info",
        result: "ok",
        operation: "callback_query",
        use_case: "create_meetup",
      },
    );
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

  it("redraws the card when the status publish button repeats a publication", async () => {
    const meetup = publishedMeetup();
    // Снимок ещё скрыт, но между чтениями сходку опубликовали: use case
    // отдаёт повтор, и кнопка статуса рисует его той же карточкой.
    const execute = vi.fn<Dispatcher["execute"]>(async (request) =>
      request.intent === "view-meetup"
        ? { kind: "meetup-card", meetup: { ...meetup, visibility: "hidden" } }
        : { kind: "published", meetup, repeated: true },
    );
    const { bot, calls, records } = createHarness(resolvedIdentity(["admin"]), {
      execute,
    });
    await bot.init();
    await bot.handleUpdate(
      callbackUpdate("v1:manage:republish:AZLzpLXGfY6fChssPU5fYA"),
    );
    expect(calls.at(-1)).toMatchObject({
      method: "editMessageText",
      payload: { rich_message: { html: expect.stringContaining("Настолки") } },
    });
    expect(
      records.find((record) => record.message === "meetup published"),
    ).toBeDefined();
  });

  // Текст отказа сервиса несёт метку: она не должна дойти ни до одного вызова
  // Bot API, но обязана остаться в записи границы вместе с кодом (PER-397).
  const leak = "SENTINEL-397 expected_version must be positive";
  const rejection = (code: Code) => ({
    kind: "dependency-rejected" as const,
    reason: "invalid" as const,
    cause: new ConnectError(leak, code),
    ...(code === Code.FailedPrecondition
      ? { precondition: true as const }
      : {}),
  });

  it.each([
    {
      name: "state action rejected as invalid",
      update: () =>
        callbackUpdate("v1:manage:republish:AZLzpLXGfY6fChssPU5fYA"),
      result: rejection(Code.InvalidArgument),
      shown: "Это на моей стороне.",
      grpc: "InvalidArgument",
    },
    {
      name: "state action on a stale screen",
      update: () =>
        callbackUpdate("v1:manage:republish:AZLzpLXGfY6fChssPU5fYA"),
      result: rejection(Code.FailedPrecondition),
      shown: "Сейчас это действие недоступно.",
      grpc: "FailedPrecondition",
    },
    {
      name: "material rejected as invalid",
      update: () =>
        callbackMessageUpdate(
          "v1:mm:ca:AZLzpLXGfY6fChssPU5fYA:AZnA3gAAAAAAAABfP4Lqmw:4",
          {
            caption: "Прикрепить материал?\n\nНазвание: Афиша",
            document: {
              file_id: "bot-file-id",
              file_unique_id: "unique",
              file_name: "poster.pdf",
            },
          },
        ),
      result: rejection(Code.InvalidArgument),
      shown: "Это на моей стороне.",
      grpc: "InvalidArgument",
    },
    {
      name: "broadcast rejected as invalid",
      update: () =>
        callbackMessageUpdate("v1:bc:cs:AZnA3gAAAAAAAABfP4Lqmw", {
          text: "Выше — текст для участников сообщества.",
          reply_to_message: {
            message_id: 8,
            date: 0,
            chat: { id: 42, type: "private", first_name: "tester" },
            from: { id: 1, is_bot: true, first_name: "stub" },
            text: "Переносим начало на вечер.",
          },
        }),
      result: rejection(Code.InvalidArgument),
      shown: "Сообщение не принято. Ничего не отправлено.",
      grpc: "InvalidArgument",
    },
    {
      name: "form value rejected by Meetups",
      update: () => callbackUpdate("v1:manage:new:AZLzpLXGfY6fChssPU5fYA"),
      result: {
        kind: "ask" as const,
        field: "title" as const,
        meetup: draftMeetup(),
        error: rejectedValueText,
        rejected: new ConnectError(leak, Code.InvalidArgument),
      },
      // Причина — экран исхода: заголовок и остаток; вопрос задаёт «Ввести заново».
      shown: "Это значение не подошло",
      also: "Ввести заново",
      grpc: "InvalidArgument",
    },
    {
      name: "publication rejected from the form",
      update: () => callbackUpdate("v1:manage:publish:AZLzpLXGfY6fChssPU5fYA"),
      result: rejection(Code.InvalidArgument),
      shown: "Это на моей стороне.",
      grpc: "InvalidArgument",
    },
    {
      name: "notification setting rejected as invalid",
      update: () => callbackUpdate("v1:notify:global"),
      result: rejection(Code.InvalidArgument),
      shown: "Этот экран устарел.",
      grpc: "InvalidArgument",
    },
  ])(
    "keeps the service text out of the reply for a $name",
    async ({ update, result, shown, also, grpc }) => {
      const meetup = publishedMeetup();
      const execute = vi.fn<Dispatcher["execute"]>(async (request) =>
        request.intent === "view-meetup"
          ? { kind: "meetup-card", meetup }
          : result,
      );
      const { bot, calls, records } = createHarness(
        resolvedIdentity(["admin"]),
        { execute },
      );
      await bot.init();
      await bot.handleUpdate(update());

      const sent = visible(JSON.stringify(calls.map((call) => call.payload)));
      expect(sent).toContain(shown);
      if (also !== undefined) expect(sent).toContain(also);
      expect(sent).not.toContain("SENTINEL-397");
      expect(sent).not.toMatch(/invalid_argument|failed_precondition/);
      const record = records.at(-1);
      expect(record?.level).toBe("warn");
      expect(record?.fields.error_category).toBe("invariant");
      expect(record?.fields.grpc_code).toBe(grpc);
      expect(record?.fields.error).toContain("SENTINEL-397");
    },
  );

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
    const text = JSON.stringify(
      calls.find((call) => call.method === "editMessageText")?.payload,
    );
    const payload = text.match(/\?start=(m_[A-Za-z0-9_-]{22})/)?.[1];
    expect(payload).toBe("m_AZLzpLXGfY6fChssPU5fYA");
    await bot.handleUpdate(messageUpdate(`/start ${payload}`));
    expect(execute).toHaveBeenLastCalledWith({
      identity: {
        identityId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd",
        globalRoles: ["member"],
        rights: ["hub", "auction"],
      },
      intent: "view-meetup",
      meetupId: "0192f3a4-b5c6-7d8e-9f0a-1b2c3d4e5f60",
      requestId: expect.any(String),
      useCase: "view_meetup",
      deadlineAt: expect.any(Number),
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
      refusalText("Сходка не найдена или больше недоступна."),
    );
    expect(calls[0]?.payload).toMatchObject({
      reply_markup: {
        inline_keyboard: [
          [
            { text: "‹ Ближайшие", callback_data: "v1:nav:hub" },
            { text: "Меню", callback_data: "v1:nav:start" },
          ],
        ],
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
        author: "0192f0a0-0000-7000-8000-00000000a001",
        version: 1,
        materials: [],
      },
    });
    const { bot, calls } = createHarness(resolvedIdentity(), { execute });
    await bot.init();
    await bot.handleUpdate(messageUpdate("/start m_AZLzpLXGfY6fChssPU5fYA"));
    expect(execute).toHaveBeenCalledWith({
      identity: {
        identityId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd",
        globalRoles: ["member"],
        rights: ["hub", "auction"],
      },
      intent: "view-meetup",
      meetupId: "0192f3a4-b5c6-7d8e-9f0a-1b2c3d4e5f60",
      requestId: expect.any(String),
      useCase: "view_meetup",
      deadlineAt: expect.any(Number),
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

  it("opens the start screen from /menu with the keyboard of the role", async () => {
    const { bot, calls, records } = createHarness(resolvedIdentity());
    await bot.init();
    await bot.handleUpdate(messageUpdate("/menu"));
    expect(sendMessageText(calls[0])).toContain("Привет.");
    expectBoundary(records[0], {
      level: "info",
      result: "ok",
      operation: "message",
      use_case: "find_meetup",
    });
    // Солегуфику вход в управление не показывается (PER-396).
    expect(calls[0]?.payload).toMatchObject({
      reply_markup: {
        inline_keyboard: [
          [
            { text: "Ближайшие сходки", callback_data: "v1:nav:hub" },
            { text: "Архив", callback_data: "v1:nav:archive" },
          ],
          [{ text: "Уведомления", callback_data: "v1:notify:global" }],
        ],
      },
    });
    expect(JSON.stringify(calls)).not.toContain("v1:manage:menu");
  });

  it("does not resolve identity for /start mentioned for another bot", async () => {
    const resolve = vi.fn(resolvedIdentity().resolve);
    const { bot, calls } = createHarness({ resolve });
    await bot.init();
    await bot.handleUpdate(messageUpdate("/start@other_bot"));
    expect(resolve).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  // Прежние команды разделов (PER-345) из меню убраны (PER-468): разделы
  // открываются кнопками стартового экрана, а команда стала неизвестной.
  it("stays silent on a former section command", async () => {
    const execute = vi.fn<Dispatcher["execute"]>();
    const resolve = vi.fn(resolvedIdentity().resolve);
    const { bot, calls } = createHarness({ resolve }, { execute });
    await bot.init();
    for (const text of ["/meetups", "/archive", "/notifications"]) {
      await bot.handleUpdate(messageUpdate(text));
    }
    expect(resolve).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("applies the hub access policy to a blocked person on a button", async () => {
    const execute = vi.fn<Dispatcher["execute"]>();
    const { bot, calls, records } = createHarness(
      resolvedIdentity(["member"], true),
      { execute },
    );
    await bot.init();
    await bot.handleUpdate(callbackUpdate("v1:nav:hub"));
    expect(screen(calls[1]).text).toBe(refusalText(blockedHubAccessText));
    expect(execute).not.toHaveBeenCalled();
    expect(records[0]?.fields.error).toBe("hub_access_blocked");
  });

  it("runs /menu sent as a reply to a pending question and drops the question", async () => {
    const meetup = publishedMeetup();
    const execute = vi.fn<Dispatcher["execute"]>(async (request) => {
      if (request.intent === "view-meetup") {
        return { kind: "meetup-card", meetup };
      }
      if (request.intent === "start") {
        return { kind: "message", text: "Привет" };
      }
      return { kind: "meetup-updated", meetup: { ...meetup, venue: "Зал" } };
    });
    const { bot, calls } = createHarness(resolvedIdentity(["admin"]), {
      execute,
    });
    await bot.init();
    await bot.handleUpdate(
      callbackUpdate("v1:manage:field:AZLzpLXGfY6fChssPU5fYA:venue"),
    );
    const question = calls.find((call) => call.method === "sendMessage");
    expect(question).toBeDefined();
    const questionId = lastQuestionId(calls);
    const replyTo = (text: string) =>
      replyUpdate({
        text,
        fromId: 42,
        replyMessageId: questionId,
        replyFromId: 1,
      });

    await bot.handleUpdate(replyTo("/menu"));
    expect(execute).toHaveBeenLastCalledWith(
      expect.objectContaining({ intent: "start" }),
    );
    expect(sendMessageText(sentMessages(calls).at(-1))).toContain("Привет");
    // Человек ушёл от вопроса: брошенный вопрос удаляется, иначе клиент
    // включал бы режим ответа на него при каждом входе в чат.
    expect(
      calls.find((call) => call.method === "deleteMessage")?.payload,
    ).toMatchObject({ message_id: questionId });

    // Ответ на удалённый вопрос, если он всё же придёт, значением не станет.
    await bot.handleUpdate(replyTo("Зал"));
    expect(execute).not.toHaveBeenCalledWith(
      expect.objectContaining({ intent: "update-meetup-field" }),
    );
  });

  it("still answers the press when Telegram refuses to delete an abandoned question", async () => {
    const meetup = publishedMeetup();
    const execute = vi
      .fn<Dispatcher["execute"]>()
      .mockResolvedValue({ kind: "meetup-card", meetup });
    const { bot, calls } = createHarness(resolvedIdentity(["admin"]), {
      execute,
    });
    bot.api.config.use((prev, method, payload, signal) =>
      method === "deleteMessage"
        ? Promise.reject(new Error("Bad Request: message can't be deleted"))
        : prev(method, payload, signal),
    );
    await bot.init();
    await bot.handleUpdate(
      callbackUpdate("v1:manage:field:AZLzpLXGfY6fChssPU5fYA:venue"),
    );

    await bot.handleUpdate(callbackUpdate("v1:view:AZLzpLXGfY6fChssPU5fYA"));

    expect(calls.at(-1)?.method).toBe("editMessageText");
  });

  it("drops an abandoned question when a button elsewhere is pressed", async () => {
    const meetup = publishedMeetup();
    const execute = vi
      .fn<Dispatcher["execute"]>()
      .mockResolvedValue({ kind: "meetup-card", meetup });
    const { bot, calls } = createHarness(resolvedIdentity(["admin"]), {
      execute,
    });
    await bot.init();
    await bot.handleUpdate(
      callbackUpdate("v1:manage:field:AZLzpLXGfY6fChssPU5fYA:venue"),
    );
    const questionId = lastQuestionId(calls);
    const before = calls.length;

    await bot.handleUpdate(callbackUpdate("v1:view:AZLzpLXGfY6fChssPU5fYA"));

    const after = calls.slice(before);
    expect(
      after.find((call) => call.method === "deleteMessage")?.payload,
    ).toMatchObject({ message_id: questionId });
    expect(after.at(-1)?.method).toBe("editMessageText");

    // Вопрос забыт: второе нажатие удалять уже нечего.
    const second = calls.length;
    await bot.handleUpdate(callbackUpdate("v1:view:AZLzpLXGfY6fChssPU5fYA"));
    expect(calls.slice(second).map((call) => call.method)).not.toContain(
      "deleteMessage",
    );
  });

  it("does not resolve identity for an unknown command", async () => {
    const resolve = vi.fn(resolvedIdentity().resolve);
    const { bot, calls } = createHarness({ resolve });
    await bot.init();
    await bot.handleUpdate(messageUpdate("/help"));
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
          rights: ["hub", "auction"],
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
          rights: ["hub", "auction"],
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
      level: "info",
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
      roles: ["admin"],
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
    "records exactly one $name callback boundary at info",
    async ({ data, roles, result, use_case, message }) => {
      const execute =
        result === undefined
          ? vi.fn<Dispatcher["execute"]>().mockImplementation(() => {
              throw new Error("dispatcher should not run");
            })
          : vi.fn<Dispatcher["execute"]>().mockResolvedValue(result);
      const { bot, records } = createHarness(resolvedIdentity(roles), {
        execute,
      });
      await bot.init();
      await bot.handleUpdate(callbackUpdate(data));
      expect(records).toHaveLength(1);
      expectBoundary(records[0], {
        level: "info",
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

  it("finishes the action when answering the press fails", async () => {
    const { logger, records } = createCapturingLogger();
    const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue({
      kind: "meetup-card",
      meetup: publishedMeetup(),
    });
    const bot = createBot({
      token: "111:test-token",
      dispatcher: { execute },
      identity: withEntry(resolvedIdentity()),
      logger,
      tracing: noopTracing(),
    });
    bot.botInfo = botInfo;
    const sent: string[] = [];
    const failing: Transformer = (_prev, method) => {
      sent.push(method);
      return method === "answerCallbackQuery"
        ? Promise.reject(new Error("query is too old"))
        : Promise.resolve({ ok: true, result: true as never });
    };
    bot.api.config.use(failing);
    await bot.init();
    await bot.handleUpdate(callbackUpdate("v1:view:AZLzpLXGfY6fChssPU5fYA"));
    // Отказ ответа на нажатие действие не отменяет: карточка всё равно
    // приходит, а отказ остаётся в записи границы.
    expect(sent).toEqual(["answerCallbackQuery", "editMessageText"]);
    expectBoundary(records[0], {
      level: "info",
      result: "ok",
      operation: "callback_query",
      use_case: "view_meetup",
    });
    expect(records[0]?.fields.reply_error).toBe("query is too old");
  });

  it("logs malformed callback data without its payload", async () => {
    const counted = vi.spyOn(failures, "countFailure");
    const { bot, calls, records } = createHarness(resolvedIdentity());
    await bot.init();
    await bot.handleUpdate(callbackUpdate("v1:view:short"));
    expect(calls[0]?.method).toBe("answerCallbackQuery");
    expect(calls[0]?.payload).not.toHaveProperty("text");
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
      identity: withEntry(resolvedIdentity()),
      logger,
      tracing: noopTracing(),
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
        author: "0192f0a0-0000-7000-8000-00000000a001",
        version: 1,
        materials: [],
      },
    });
    const { bot, calls, records } = createHarness(resolvedIdentity(), {
      execute,
    });
    await bot.init();
    await bot.handleUpdate(
      callbackUpdate("v1:manage:new:AZLzpLXGfY6fChssPU5fYA"),
    );
    const before = records.length;
    await bot.handleUpdate(
      replyUpdate({
        text: "Чужое название",
        fromId: 43,
        replyMessageId: lastQuestionId(calls),
        replyFromId: 1,
      }),
    );
    expect(records.length).toBe(before + 1);
    expectBoundary(records.at(-1), {
      level: "info",
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
    expectBoundary(records[0], { level: "info", result: "ok" });
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

  it("shows a failure frame when a command response loses its connection", async () => {
    const { bot, calls, records } = createHarness(resolvedIdentity());
    let sends = 0;
    bot.api.config.use((prev, method, payload, signal) => {
      if (method === "sendMessage" && sends++ === 0) {
        return Promise.reject(new Error("connection lost"));
      }
      return prev(method, payload, signal);
    });
    await bot.init();

    await bot.handleUpdate(messageUpdate());

    expect(calls.at(-1)).toMatchObject({
      method: "sendMessage",
      payload: {
        text: expect.stringContaining("Не получилось показать экран"),
      },
    });
    expect(sends).toBe(2);
    expect(records.at(-1)?.fields.error).toContain("connection lost");
  });

  it("records both failures without retrying a rejected failure frame", async () => {
    const { bot, records } = createHarness(resolvedIdentity());
    let sends = 0;
    bot.api.config.use((prev, method, payload, signal) => {
      if (method === "sendMessage") {
        sends++;
        return Promise.resolve({
          ok: false,
          error_code: 403,
          description:
            sends === 1
              ? "original response rejected"
              : "failure frame rejected",
        });
      }
      return prev(method, payload, signal);
    });
    await bot.init();

    await bot.handleUpdate(messageUpdate());

    expect(sends).toBe(2);
    expect(records.at(-1)?.fields.error).toContain(
      "original response rejected",
    );
    expect(records.at(-1)?.fields.reply_error).toContain(
      "failure frame rejected",
    );
  });

  it("restores navigation when opening the menu from a failure frame fails again", async () => {
    const { bot, calls } = createHarness(resolvedIdentity());
    const frameText =
      "Не получилось показать экран. Это на моей стороне.\n\nОткрой меню и проверь состояние перед повтором действия.";
    bot.api.config.use((prev, method, payload, signal) => {
      if (
        (method === "editMessageText" || method === "sendMessage") &&
        "text" in payload &&
        payload.text !== refusalText(frameText)
      ) {
        return Promise.resolve({
          ok: false,
          error_code: 400,
          description: "menu rejected",
        });
      }
      return prev(method, payload, signal);
    });
    await bot.init();

    await bot.handleUpdate(
      callbackMessageUpdate("v1:nav:start", {
        text: "Не получилось показать экран. Это на моей стороне.\n\nОткрой меню и проверь состояние перед повтором действия.",
        entities: [
          {
            type: "bold",
            offset: 0,
            length: "Не получилось показать экран.".length,
          },
        ],
        reply_markup: {
          inline_keyboard: [[{ text: "Меню", callback_data: "v1:nav:start" }]],
        },
      }),
    );

    expect(calls.at(-1)).toMatchObject({
      method: "sendMessage",
      payload: {
        text: refusalText(frameText),
        reply_markup: {
          inline_keyboard: [[{ text: "Меню", callback_data: "v1:nav:start" }]],
        },
      },
    });
  });

  it("does not replace an unchanged screen with a failure frame", async () => {
    const { bot, calls } = createHarness(resolvedIdentity(["admin"]));
    bot.api.config.use((prev, method, payload, signal) =>
      method === "editMessageText"
        ? Promise.resolve({
            ok: false,
            error_code: 400,
            description: "Bad Request: message is not modified",
          })
        : prev(method, payload, signal),
    );
    await bot.init();

    await bot.handleUpdate(callbackUpdate("v1:manage:menu"));

    expect(calls.map((call) => call.method)).toEqual(["answerCallbackQuery"]);
  });

  it("tries one fallback after an original refusal frame is rejected", async () => {
    const { bot, records } = createHarness(refusedIdentity());
    let sends = 0;
    bot.api.config.use((prev, method, payload, signal) => {
      if (method === "sendMessage") {
        sends++;
        return Promise.resolve({
          ok: false,
          error_code: 403,
          description: "failure frame rejected",
        });
      }
      return prev(method, payload, signal);
    });
    await bot.init();

    await bot.handleUpdate(messageUpdate());

    expect(sends).toBe(2);
    expect(records.at(-1)?.fields.reply_error).toContain(
      "failure frame rejected",
    );
  });

  it("shows a fallback when Telegram rejects the original refusal but accepts the fallback", async () => {
    const { bot, calls, records } = createHarness(refusedIdentity());
    let sends = 0;
    bot.api.config.use((prev, method, payload, signal) => {
      if (method === "sendMessage" && sends++ === 0) {
        return Promise.resolve({
          ok: false,
          error_code: 400,
          description: "original refusal rejected",
        });
      }
      return prev(method, payload, signal);
    });
    await bot.init();

    await bot.handleUpdate(messageUpdate());

    expect(sends).toBe(2);
    expect(calls.at(-1)).toMatchObject({
      method: "sendMessage",
      payload: {
        text: expect.stringContaining("Не получилось показать экран"),
      },
    });
    expect(records.at(-1)?.fields.reply_error).toContain(
      "original refusal rejected",
    );
  });

  it("shows a failure frame when Telegram rejects a directly sent material confirmation", async () => {
    const execute = vi.fn<Dispatcher["execute"]>(async (request) =>
      request.intent === "view-meetup"
        ? { kind: "meetup-card", meetup: publishedMeetup() }
        : { kind: "rejected", reason: "unexpected" },
    );
    const { bot, calls, records } = createHarness(resolvedIdentity(["admin"]), {
      execute,
    });
    bot.api.config.use((prev, method, payload, signal) => {
      if (
        method === "sendMessage" &&
        JSON.stringify(payload).includes("v1:mm:ca:")
      ) {
        return Promise.resolve({
          ok: false,
          error_code: 400,
          description: "material confirmation rejected",
        });
      }
      return prev(method, payload, signal);
    });
    await bot.init();
    await bot.handleUpdate(callbackUpdate("v1:mm:add:AZLzpLXGfY6fChssPU5fYA"));
    await bot.handleUpdate(forwardedReplyUpdate(lastQuestionId(calls)));

    await bot.handleUpdate(
      replyUpdate({
        text: "Материал",
        fromId: 42,
        replyMessageId: lastQuestionId(calls),
        replyFromId: 1,
      }),
    );

    expect(calls.at(-1)).toMatchObject({
      method: "sendMessage",
      payload: {
        text: expect.stringContaining("Не получилось показать экран"),
      },
    });
    expect(records.at(-1)?.fields.error).toContain(
      "material confirmation rejected",
    );
    expect(
      execute.mock.calls.some(
        ([request]) => request.intent === "attach-material",
      ),
    ).toBe(false);
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
      identity: withEntry(identity),
      logger,
      tracing: noopTracing(),
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
    expectBoundary(records[0], { level: "info", result: "ok" });
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
    identity: withEntry(resolvedIdentity()),
    logger,
    tracing: noopTracing(),
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

describe("trace buttons", () => {
  const token = "AZjypHwefTqbIU-OEqs0zw";
  const notification = {
    text: "Сообщение организатора: Настолки\n\nВстречаемся у входа",
    reply_markup: {
      inline_keyboard: [
        [{ text: "Открыть сходку", callback_data: `v1:t:view:${token}` }],
      ],
    },
  };

  it("opens the meetup from a notification as a new message", async () => {
    const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue({
      kind: "meetup-card",
      meetup: publishedMeetup(),
    });
    const { bot, calls } = createHarness(resolvedIdentity(), { execute });
    await bot.init();

    await bot.handleUpdate(
      callbackMessageUpdate(`v1:t:view:${token}`, notification),
    );

    // Уведомление — след: слова организатора в нём карточка не затирает.
    expect(calls.map((call) => call.method)).toEqual([
      "answerCallbackQuery",
      "sendRichMessage",
    ]);
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: "view-meetup",
        meetupId: tokenToUuid(token),
      }),
    );
  });

  it("still edits the notification for a button of the previous release", async () => {
    const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue({
      kind: "meetup-card",
      meetup: publishedMeetup(),
    });
    const { bot, calls } = createHarness(resolvedIdentity(), { execute });
    await bot.init();

    await bot.handleUpdate(
      callbackMessageUpdate(`v1:view:${token}`, notification),
    );

    expect(calls.map((call) => call.method)).toEqual([
      "answerCallbackQuery",
      "editMessageText",
    ]);
  });

  it("sends a refusal from a trace button as a new message too", async () => {
    const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue({
      kind: "meetup-not-found",
    });
    const { bot, calls } = createHarness(resolvedIdentity(), { execute });
    await bot.init();

    await bot.handleUpdate(
      callbackMessageUpdate(`v1:t:view:${token}`, notification),
    );

    expect(calls.map((call) => call.method)).toEqual([
      "answerCallbackQuery",
      "sendMessage",
    ]);
  });
});

describe("confirmations", () => {
  const token = "AZLzpLXGfY6fChssPU5fYA";
  const materialToken = "AZnA3gAAAAAAAABfP4Lqmw";
  const keyboardOf = (call: RecordedCall | undefined) =>
    (
      call?.payload as
        | { reply_markup?: { inline_keyboard?: unknown } }
        | undefined
    )?.reply_markup?.inline_keyboard;

  it("asks before removing a material with a plain verb answer", async () => {
    const meetup = {
      ...publishedMeetup(),
      materials: [
        {
          id: tokenToUuid(materialToken),
          title: "Афиша",
          source: {
            kind: "file" as const,
            fileId: "bot-file-id",
            fileKind: "document" as const,
          },
        },
      ],
    };
    const execute = vi
      .fn<Dispatcher["execute"]>()
      .mockResolvedValue({ kind: "meetup-card", meetup });
    const { bot, calls } = createHarness(resolvedIdentity(["admin"]), {
      execute,
    });
    await bot.init();

    await bot.handleUpdate(
      callbackUpdate(`v1:mm:rm:${token}:${materialToken}`),
    );

    expect(calls.at(-1)?.payload).toMatchObject({
      text: "<b>Убрать материал?</b>\n\n«Афиша» исчезнет из сходки. Оригинал в Telegram останется на месте.",
    });
    expect(keyboardOf(calls.at(-1))).toEqual([
      [
        {
          text: "Да, убрать материал",
          callback_data: `v1:mm:cr:${token}:${materialToken}:1`,
        },
      ],
      [{ text: "Нет", callback_data: `v1:mm:list:${token}` }],
    ]);
  });

  it("leaves a declined file as a trace and returns to the materials", async () => {
    const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue({
      kind: "meetup-card",
      meetup: publishedMeetup(),
    });
    const { bot, calls } = createHarness(resolvedIdentity(["admin"]), {
      execute,
    });
    await bot.init();

    await bot.handleUpdate(
      callbackMessageUpdate(`v1:mm:no:${token}`, {
        caption: "Прикрепить материал?\n\nНазвание: Афиша",
        document: { file_id: "bot-file-id", file_unique_id: "unique" },
      }),
    );

    expect(calls.map((call) => call.method)).toEqual([
      "answerCallbackQuery",
      "editMessageCaption",
      "sendMessage",
    ]);
    expect(calls[1]?.payload).toMatchObject({ caption: "Не прикреплено." });
    expect(execute).not.toHaveBeenCalledWith(
      expect.objectContaining({ intent: "attach-material" }),
    );
    expect(sendMessageText(calls[2])).toContain("<b>Материалы</b>");
  });

  it("asks before a broadcast with a plain answer and returns a refusal to the meetup", async () => {
    const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue({
      kind: "meetup-card",
      meetup: publishedMeetup(),
    });
    const { bot, calls } = createHarness(resolvedIdentity(["admin"]), {
      execute,
    });
    await bot.init();
    await bot.handleUpdate(callbackUpdate(`v1:bc:m:${token}`));
    const _question = calls.findLastIndex(
      (call) => call.method === "sendMessage",
    );
    await bot.handleUpdate(
      replyUpdate({
        text: "Встречаемся у входа",
        fromId: 42,
        replyMessageId: lastQuestionId(calls),
        replyFromId: 1,
      }),
    );

    const confirm = sentMessages(calls).at(-1);
    expect(sendMessageText(confirm)).toContain("<b>Отправить подписчикам?</b>");
    expect(keyboardOf(confirm)).toEqual([
      [
        {
          text: "Да, отправить",
          callback_data: expect.stringMatching(/^v1:bc:ms:/),
        },
      ],
      [{ text: "Нет", callback_data: `v1:bc:no:${token}` }],
    ]);

    await bot.handleUpdate(callbackUpdate(`v1:bc:no:${token}`));
    expect(calls.at(-1)?.payload).toMatchObject({
      text: "<b>Не отправлено.</b> Текст никуда не ушёл.",
    });
    expect(keyboardOf(calls.at(-1))).toEqual([
      [
        { text: "‹ Сходка", callback_data: `v1:view:${token}` },
        { text: "Меню", callback_data: "v1:nav:start" },
      ],
    ]);
  });
});

describe("questions", () => {
  const token = "AZLzpLXGfY6fChssPU5fYA";
  const buttonsOf = (call: RecordedCall | undefined) =>
    (
      call?.payload as
        | { reply_markup?: { inline_keyboard?: unknown[][] } }
        | undefined
    )?.reply_markup?.inline_keyboard?.flat();
  const viewing = () =>
    vi.fn<Dispatcher["execute"]>(async (request) =>
      request.intent === "view-meetup"
        ? { kind: "meetup-card", meetup: publishedMeetup() }
        : { kind: "meetup-updated", meetup: publishedMeetup() },
    );

  it("leaves one place to act: the asking screen loses its keyboard", async () => {
    const { bot, calls } = createHarness(resolvedIdentity(["admin"]), {
      execute: viewing(),
    });
    await bot.init();

    await bot.handleUpdate(callbackUpdate(`v1:manage:field:${token}:venue`));

    // Снятие клавиатуры человеку не видно, поэтому ответ на нажатие уходит
    // вместе с вопросом, а не перед ним.
    expect(calls.map((call) => call.method)).toEqual([
      "editMessageReplyMarkup",
      "answerCallbackQuery",
      "sendMessage",
    ]);
    expect(calls[0]?.payload).toMatchObject({ message_id: 9 });
    expect(buttonsOf(calls[0])).toEqual([]);
    expect(calls[2]?.payload).toMatchObject({
      reply_markup: cancel(`v1:q:fe:${token}:venue:42`),
    });
  });

  it("closes the question once its answer is accepted", async () => {
    const { bot, calls } = createHarness(resolvedIdentity(["admin"]), {
      execute: viewing(),
    });
    await bot.init();
    await bot.handleUpdate(callbackUpdate(`v1:manage:field:${token}:venue`));
    const questionId = lastQuestionId(calls);
    const before = calls.length;

    await bot.handleUpdate(
      replyUpdate({
        text: "Новый зал",
        fromId: 42,
        replyMessageId: questionId,
        replyFromId: 1,
      }),
    );

    const closing = calls
      .slice(before)
      .find((call) => call.method === "editMessageReplyMarkup");
    expect(closing?.payload).toMatchObject({ message_id: questionId });
    expect(buttonsOf(closing)).toEqual([]);
  });

  it("keeps the question open when the service did not answer", async () => {
    const execute = vi.fn<Dispatcher["execute"]>(async (request) =>
      request.intent === "view-meetup"
        ? { kind: "meetup-card", meetup: publishedMeetup() }
        : { kind: "dependency-rejected", reason: "timeout" },
    );
    const { bot, calls } = createHarness(resolvedIdentity(["admin"]), {
      execute,
    });
    await bot.init();
    await bot.handleUpdate(callbackUpdate(`v1:manage:field:${token}:venue`));
    const before = calls.length;

    await bot.handleUpdate(
      replyUpdate({
        text: "Новый зал",
        fromId: 42,
        replyMessageId: lastQuestionId(calls),
        replyFromId: 1,
      }),
    );

    expect(calls.slice(before).map((call) => call.method)).not.toContain(
      "editMessageReplyMarkup",
    );
  });

  it("returns a cancelled question to the screen it was asked from", async () => {
    const execute = viewing();
    const { bot, calls } = createHarness(resolvedIdentity(["admin"]), {
      execute,
    });
    await bot.init();

    await bot.handleUpdate(
      callbackMessageUpdate(`v1:q:fe:${token}:venue`, {
        text: "Где встречаемся?",
        reply_markup: cancel(`v1:q:fe:${token}:venue`),
      }),
    );

    // Вопрос удаляется, а карточка приходит новым сообщением: правка вопроса
    // режим ответа в клиенте не снимает. Значение никуда не ушло.
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenLastCalledWith(
      expect.objectContaining({ intent: "view-meetup" }),
    );
    expect(calls.map((call) => call.method)).toEqual([
      "deleteMessage",
      "answerCallbackQuery",
      "sendRichMessage",
    ]);
    expect(calls[0]?.payload).toMatchObject({ message_id: 9 });
  });

  it("edits the cancelled question in place when Telegram refuses to delete it", async () => {
    const execute = viewing();
    const { bot, calls } = createHarness(resolvedIdentity(["admin"]), {
      execute,
    });
    bot.api.config.use((prev, method, payload, signal) =>
      method === "deleteMessage"
        ? Promise.reject(new Error("Bad Request: message can't be deleted"))
        : prev(method, payload, signal),
    );
    await bot.init();

    await bot.handleUpdate(
      callbackMessageUpdate(`v1:q:fe:${token}:venue`, {
        text: "Где встречаемся?",
        reply_markup: cancel(`v1:q:fe:${token}:venue`),
      }),
    );

    expect(calls.at(-1)?.method).toBe("editMessageText");
    expect(calls.at(-1)?.payload).toMatchObject({ message_id: 9 });
  });

  it("forgets a cancelled question: a late answer to it is stale", async () => {
    const execute = viewing();
    const { bot, calls } = createHarness(resolvedIdentity(["admin"]), {
      execute,
    });
    await bot.init();
    await bot.handleUpdate(callbackUpdate(`v1:manage:field:${token}:venue`));
    const questionId = lastQuestionId(calls);
    await bot.handleUpdate(
      callbackMessageUpdate(`v1:q:fe:${token}:venue`, {
        message_id: questionId,
        text: "Где встречаемся?",
        reply_markup: cancel(`v1:q:fe:${token}:venue`),
      }),
    );

    // Экран, в который превратился вопрос, кнопки «Отмена» уже не несёт.
    await bot.handleUpdate(
      replyUpdate({
        text: "Новый зал",
        fromId: 42,
        replyMessageId: questionId,
        replyFromId: 1,
      }),
    );

    expect(execute).not.toHaveBeenCalledWith(
      expect.objectContaining({ intent: "update-meetup-field" }),
    );
    expect(sendMessageText(sentMessages(calls).at(-1))).toContain(
      "Этот вопрос уже устарел.",
    );
  });

  // Вопросы прошлых релизов не знают, кому заданы: маркер шага в тексте и
  // «Отмена» без id. Ответ на них не применяется (PER-461).
  it.each([
    {
      name: "a step marker in the text",
      replyText: "​Где встречаемся?",
      replyEntities: [
        {
          type: "text_link" as const,
          offset: 0,
          length: 1,
          url: `https://t.me/stub_bot#v1:manage:field:${token}:venue`,
        },
      ],
    },
    {
      name: "a cancel button without the asked id",
      replyText: "Где встречаемся?",
      replyMarkup: cancel(`v1:q:fe:${token}:venue`),
    },
  ])(
    "calls a question of the previous release with $name outdated",
    async ({ name: _name, ...replied }) => {
      const execute = viewing();
      const { bot, calls } = createHarness(resolvedIdentity(["admin"]), {
        execute,
      });
      await bot.init();

      await bot.handleUpdate(
        replyUpdate({
          text: "Новый зал",
          fromId: 42,
          replyMessageId: 77,
          replyFromId: 1,
          ...replied,
        }),
      );

      expect(execute).not.toHaveBeenCalled();
      expect(sendMessageText(sentMessages(calls).at(-1))).toContain(
        "Этот вопрос уже устарел.",
      );
    },
  );

  it("sends a restarted material title question back to the materials", async () => {
    const execute = viewing();
    const { bot, calls } = createHarness(resolvedIdentity(["admin"]), {
      execute,
    });
    await bot.init();

    await bot.handleUpdate(
      replyUpdate({
        text: "Афиша",
        fromId: 42,
        replyMessageId: 77,
        replyFromId: 1,
        replyText: "Как назвать материал в карточке?",
        replyMarkup: cancel(`v1:q:mt:${token}`),
      }),
    );

    expect(execute).not.toHaveBeenCalled();
    expect(calls.at(-1)?.payload).toMatchObject({
      text: refusalText("Этот вопрос уже устарел. Прикрепи материал заново."),
      reply_markup: {
        inline_keyboard: [
          [
            { text: "‹ Материалы", callback_data: `v1:mm:list:${token}` },
            { text: "Меню", callback_data: "v1:nav:start" },
          ],
        ],
      },
    });
  });

  it.each([
    `v1:q:pm:${token}`,
    `v1:q:ms:${token}:3`,
    `v1:q:mt:${token}`,
    `v1:q:bm:${token}`,
    `v1:q:bm:${token}:42`,
  ])("cancels %s without a command to the service", async (data) => {
    const execute = viewing();
    const { bot, calls } = createHarness(resolvedIdentity(["admin"]), {
      execute,
    });
    await bot.init();

    await bot.handleUpdate(
      callbackMessageUpdate(data, {
        text: "Вопрос",
        reply_markup: cancel(data),
      }),
    );

    for (const [request] of execute.mock.calls) {
      expect(request.intent).toBe("view-meetup");
    }
    expect(
      calls.find((call) => call.method === "deleteMessage")?.payload,
    ).toMatchObject({ message_id: 9 });
    expect(calls.at(-1)?.method).toMatch(/^send(Rich)?Message$/);
  });

  it("returns a cancelled publication question to the draft it was asked from", async () => {
    const draft: MeetupSnapshot = {
      ...publishedMeetup(),
      visibility: "hidden",
    };
    const execute = vi
      .fn<Dispatcher["execute"]>()
      .mockResolvedValue({ kind: "meetup-card", meetup: draft });
    const { bot, calls } = createHarness(resolvedIdentity(["admin"]), {
      execute,
    });
    await bot.init();

    await bot.handleUpdate(
      callbackMessageUpdate(`v1:q:pd:${token}`, {
        text: "Вопрос",
        reply_markup: cancel(`v1:q:pd:${token}`),
      }),
    );

    const shown = JSON.stringify(calls.at(-1)?.payload);
    expect(shown).toContain(`v1:manage:publish:${token}`);
    expect(shown).not.toContain("v1:manage:cancel:");
  });

  it.each([
    { photo: [{ file_id: "p", file_unique_id: "u", width: 1, height: 1 }] },
    { sticker: { file_id: "s", file_unique_id: "u" } },
  ])(
    "keeps a field question waiting after an answer without text",
    async (content) => {
      const execute = viewing();
      const { bot, calls } = createHarness(resolvedIdentity(["admin"]), {
        execute,
      });
      await bot.init();
      await bot.handleUpdate(callbackUpdate(`v1:manage:field:${token}:venue`));
      const questionId = lastQuestionId(calls);
      const before = calls.length;
      const update = replyUpdate({
        text: "",
        fromId: 42,
        replyMessageId: questionId,
        replyFromId: 1,
        replyText: "Где встречаемся?",
      });
      const message = update.message as unknown as Record<string, unknown>;
      delete message["text"];
      Object.assign(message, content);

      await bot.handleUpdate(update);

      // Отказ — экран исхода без ForceReply: вопрос задаёт «Ввести заново»,
      // шаг тот же; значение никуда не ушло.
      const asked = calls
        .slice(before)
        .find((call) => call.method === "sendMessage");
      expect(asked?.payload).toMatchObject({
        text: "<b>Нужен ответ текстом</b>",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "Ввести заново",
                callback_data: `v1:manage:field:${token}:venue`,
              },
            ],
            [
              { text: "‹ Сходка", callback_data: `v1:view:${token}` },
              { text: "Меню", callback_data: "v1:nav:start" },
            ],
          ],
        },
      });
      expect(JSON.stringify(asked?.payload)).not.toContain("force_reply");
      expect(JSON.stringify(asked?.payload)).not.toContain("устарел");
      // Прежний вопрос закрыт.
      expect(
        calls
          .slice(before)
          .some((call) => call.method === "editMessageReplyMarkup"),
      ).toBe(true);
      expect(execute).not.toHaveBeenCalledWith(
        expect.objectContaining({ intent: "update-meetup-field" }),
      );
    },
  );
});

describe("telegram environment", () => {
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
    author: "0192f0a0-0000-7000-8000-00000000a001",
    version: 1,
    materials: [],
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
    // Карточка открывается правкой экрана, всплывающего окна нет.
    expect(calls[0]?.method).toBe("answerCallbackQuery");
    expect(calls[0]?.payload).not.toHaveProperty("text");
    const keyboard = screen(calls[1]).reply_markup;
    // Без подписки входа в настройки сходки нет: они решают, что присылать
    // по подписке, и рядом с ней читались как второй способ получать
    // уведомления (прогон PER-395).
    expect(keyboard?.inline_keyboard[0]).toEqual([
      {
        text: "Подписаться на сходку",
        callback_data: `v1:notify:sub:${token}:1`,
      },
    ]);
    expect(JSON.stringify(keyboard)).not.toContain("v1:notify:settings");
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
    // Отписка и настройки подписки стоят одним рядом: под карточкой не больше
    // пяти рядов.
    expect(keyboard?.inline_keyboard[0]?.[1]).toEqual({
      text: "Уведомления сходки",
      callback_data: `v1:notify:settings:${token}`,
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
    expect(data).toContain(`v1:notify:settings:${token}`);
  });

  // Из одной кнопки не видно, что даёт подписка (PER-402): ответ на неё
  // называет, что будет приходить, и куда идти за выключенным напоминанием.
  describe("subscription note", () => {
    // Полезная нагрузка записана как unknown: заметка подписки — экран исхода
    // с текстом, карточка идёт rich-сообщением, а отсутствие поля даёт пустую
    // строку, а не падение.
    const cardHtml = (call: RecordedCall | undefined): string => {
      const payload = call?.payload as
        | { text?: string; rich_message?: { html?: string } }
        | undefined;
      return payload?.text ?? payload?.rich_message?.html ?? "";
    };
    const allCategories = (
      enabled: Partial<Record<MeetupCategory, boolean>>,
    ): CategoryState<MeetupCategory>[] =>
      (["changes", "material", "reminder", "organizer"] as const).map(
        (category) => ({ category, enabled: enabled[category] ?? false }),
      );
    const subscribe = async (
      result: Awaited<ReturnType<Dispatcher["execute"]>>,
      data = `v1:notify:sub:${token}:1`,
    ): Promise<string> => {
      const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue(result);
      const { bot, calls } = createHarness(resolvedIdentity(), { execute });
      await bot.init();
      await bot.handleUpdate(callbackUpdate(data));
      return cardHtml(calls[1]);
    };

    it("lists what will come and points to the disabled reminder", async () => {
      const html = await subscribe({
        kind: "meetup-card",
        meetup,
        subscribed: true,
        categories: [
          { category: "changes", enabled: true },
          { category: "material", enabled: true },
          { category: "reminder", enabled: false },
          { category: "organizer", enabled: true },
        ],
      });
      expect(html).toContain(
        "<b>Подписка включена</b>\n\n«Настолки у Лёши»\n\nПо этой сходке будут приходить: изменения данных и статуса, новые материалы, сообщения организатора.",
      );
      expect(html).toContain(
        "Напоминание перед началом выключено, включить его можно в «Уведомлениях сходки».",
      );
    });

    // Перечень берётся из действующих значений: включённое заранее напоминание
    // входит в список, выключенные материалы из него выпадают.
    it("follows the effective values rather than product defaults", async () => {
      const html = await subscribe({
        kind: "meetup-card",
        meetup,
        subscribed: true,
        categories: [
          { category: "changes", enabled: true },
          { category: "material", enabled: false },
          { category: "reminder", enabled: true },
          { category: "organizer", enabled: true },
        ],
      });
      expect(html).toContain(
        "будут приходить: изменения данных и статуса, напоминание перед началом, сообщения организатора.",
      );
      expect(html).not.toContain("новые материалы");
      expect(html).not.toContain("Напоминание перед началом выключено");
    });

    it("says nothing will come when every category is off", async () => {
      const html = await subscribe({
        kind: "meetup-card",
        meetup,
        subscribed: true,
        categories: [
          { category: "changes", enabled: false },
          { category: "material", enabled: false },
          { category: "reminder", enabled: false },
          { category: "organizer", enabled: false },
        ],
      });
      expect(html).toContain("<b>Подписка включена</b>");
      expect(html).toContain(
        "По этой сходке сейчас ничего не приходит: все категории выключены.",
      );
      expect(html).toContain("Включить их можно в «Уведомлениях сходки».");
    });

    // Пропуск категории в ответе неотличим от «выключено»: заметка тогда не
    // говорит ничего, а не «ничего не приходит».
    it.each([
      ["an empty", []],
      ["an incomplete", [{ category: "changes" as const, enabled: true }]],
    ])("adds no note for %s category snapshot", async (_name, categories) => {
      const html = await subscribe({
        kind: "meetup-card",
        meetup,
        subscribed: true,
        categories,
      });
      expect(html).toContain("Настолки у Лёши");
      expect(html).not.toContain("Подписка включена");
    });

    it("adds no note on unsubscribing or on a plain card view", async () => {
      const everything = allCategories({
        changes: true,
        material: true,
        organizer: true,
      });
      const unsubscribed = await subscribe(
        {
          kind: "meetup-card",
          meetup,
          subscribed: false,
          categories: everything,
        },
        `v1:notify:sub:${token}:0`,
      );
      expect(unsubscribed).toContain("Настолки у Лёши");
      expect(unsubscribed).not.toContain("Подписка включена");
      // Категории в результате есть, но заметка — ответ на нажатие, а не
      // свойство карточки: просмотр её не показывает.
      const viewed = await subscribe(
        {
          kind: "meetup-card",
          meetup,
          subscribed: true,
          categories: everything,
        },
        `v1:view:${token}`,
      );
      expect(viewed).toContain("Настолки у Лёши");
      expect(viewed).not.toContain("Подписка включена");
    });
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
    ["forbidden", "Это действие тебе недоступно.", "v1:nav:start"],
    ["invalid", "Этот экран устарел.", "v1:notify:global"],
    ["conflict", "Это уже сделано.", "v1:notify:global"],
  ])(
    "renders a %s refusal as its own frame",
    async (reason, expected, retry) => {
      const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue(
        reason === "invalid"
          ? {
              kind: "dependency-rejected",
              reason,
              cause: new Error("bad category"),
            }
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

  it("renders the meetup frame with toggles, the divergence line and the pinning warning", async () => {
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
    expect(payload.text).toContain(
      "<b>Уведомления сходки</b>\n\n«Настолки у Лёши»",
    );
    expect(payload.text).toContain("закрепляется за ней");
    // Расхождение с общей настройкой называет текст, а не подпись кнопки.
    expect(payload.text).toContain(
      "Отличаются от общих: напоминание перед началом.",
    );
    expect(payload.reply_markup?.inline_keyboard[0]?.[0]).toEqual({
      text: "Вкл · Изменения данных и статуса",
      callback_data: `v1:notify:set:${token}:changes:0`,
    });
    expect(payload.reply_markup?.inline_keyboard[1]?.[0]).toEqual({
      text: "Вкл · Напоминание перед началом",
      callback_data: `v1:notify:set:${token}:reminder:0`,
    });
    expect(payload.reply_markup?.inline_keyboard.at(-1)).toEqual([
      { text: "‹ Сходка", callback_data: `v1:view:${token}` },
      { text: "Меню", callback_data: "v1:nav:start" },
    ]);
  });

  it("renders the global frame over the whole dictionary", async () => {
    const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue({
      kind: "global-notification-settings",
      categories: [
        { category: "changes", enabled: true },
        { category: "published", enabled: true },
        { category: "announcement", enabled: false },
      ],
    });
    const { bot, calls } = createHarness(resolvedIdentity(), { execute });
    await bot.init();
    await bot.handleUpdate(callbackUpdate("v1:notify:global"));
    const payload = screen(calls[1]);
    // Группы называет текст, а кнопки идут в его порядке: сначала то, что
    // приходит без подписки, в каком бы порядке ни ответил Notifications.
    expect(payload.text).toContain("Приходят всем, без подписки");
    expect(payload.text).toContain("По сходкам, на которые ты подписан");
    expect(payload.reply_markup?.inline_keyboard[2]?.[0]).toEqual({
      text: "Вкл · Изменения данных и статуса",
      callback_data: "v1:notify:gset:changes:0",
    });
    expect(payload.reply_markup?.inline_keyboard[0]?.[0]).toEqual({
      text: "Вкл · Новые сходки",
      callback_data: "v1:notify:gset:published:0",
    });
    expect(payload.reply_markup?.inline_keyboard[1]?.[0]).toEqual({
      text: "Выкл · Объявления сообщества",
      callback_data: "v1:notify:gset:announcement:1",
    });
  });

  // Категорию присылает только снимок администратора: бот рисует строку, когда
  // она пришла, и её группу называет текст.
  it("renders access requests between global and meetup categories when the snapshot has them", async () => {
    const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue({
      kind: "global-notification-settings",
      categories: [
        { category: "changes", enabled: true },
        { category: "access", enabled: true },
        { category: "published", enabled: true },
      ],
    });
    const { bot, calls } = createHarness(resolvedIdentity(), { execute });
    await bot.init();
    await bot.handleUpdate(callbackUpdate("v1:notify:global"));
    const payload = screen(calls[1]);
    expect(payload.text).toContain("Только администратору: запросы доступа");
    expect(payload.reply_markup?.inline_keyboard[1]?.[0]).toEqual({
      text: "Вкл · Запросы доступа",
      callback_data: "v1:notify:gset:access:0",
    });
    expect(payload.reply_markup?.inline_keyboard[2]?.[0]).toEqual({
      text: "Вкл · Изменения данных и статуса",
      callback_data: "v1:notify:gset:changes:0",
    });
  });

  it("leaves access requests out when the snapshot does not have them", async () => {
    const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue({
      kind: "global-notification-settings",
      categories: [{ category: "published", enabled: true }],
    });
    const { bot, calls } = createHarness(resolvedIdentity(), { execute });
    await bot.init();
    await bot.handleUpdate(callbackUpdate("v1:notify:global"));
    const payload = screen(calls[1]);
    expect(payload.text).not.toContain("запросы доступа");
    const data = (payload.reply_markup?.inline_keyboard ?? [])
      .flat()
      .map((button) => button.callback_data);
    expect(data.some((value) => value.includes(":access:"))).toBe(false);
  });

  it("toggles access requests and refuses a former admin with the reason", async () => {
    const execute = vi
      .fn<Dispatcher["execute"]>()
      .mockResolvedValueOnce({
        kind: "global-notification-settings",
        categories: [{ category: "access", enabled: false }],
      })
      .mockResolvedValueOnce({
        kind: "dependency-rejected",
        reason: "forbidden",
      });
    const { bot, calls } = createHarness(resolvedIdentity(), { execute });
    await bot.init();
    await bot.handleUpdate(callbackUpdate("v1:notify:gset:access:0"));
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: "set-global-category",
        category: "access",
        enabled: false,
      }),
    );
    const toggled = calls.length;
    expect(
      screen(calls.findLast((call) => call.method !== "answerCallbackQuery"))
        .reply_markup?.inline_keyboard[0]?.[0],
    ).toEqual({
      text: "Выкл · Запросы доступа",
      callback_data: "v1:notify:gset:access:1",
    });
    await bot.handleUpdate(callbackUpdate("v1:notify:gset:access:1"));
    expect(
      screen(
        calls
          .slice(toggled)
          .findLast((call) => call.method !== "answerCallbackQuery"),
      ).text,
    ).toContain("Запросы доступа настраивает только администратор.");
  });

  describe("disabling a category from a notification", () => {
    const notification = {
      text: "Новая сходка: Настолки у Лёши\n12.08.2026 19:00",
      reply_markup: {
        inline_keyboard: [
          [{ text: "Открыть сходку", callback_data: `v1:view:${token}` }],
          [
            {
              text: "Не присылать новые сходки",
              callback_data: "v1:notify:off:published",
            },
          ],
        ],
      },
    };

    it("turns the global category off and keeps the notification text", async () => {
      const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue({
        kind: "global-notification-settings",
        categories: [{ category: "published", enabled: false }],
      });
      const { bot, calls } = createHarness(resolvedIdentity(), { execute });
      await bot.init();
      await bot.handleUpdate(
        callbackMessageUpdate("v1:notify:off:published", notification),
      );
      expect(execute).toHaveBeenCalledWith(
        expect.objectContaining({
          intent: "set-global-category",
          category: "published",
          enabled: false,
        }),
      );
      expect(calls[0]?.method).toBe("answerCallbackQuery");
      expect(calls[1]?.method).toBe("editMessageText");
      const payload = screen(calls[1]);
      expect(payload.text).toContain(notification.text);
      expect(payload.text).toContain("Больше не присылаю: новые сходки");
      expect(payload.reply_markup?.inline_keyboard).toEqual([
        [{ text: "Открыть сходку", callback_data: `v1:view:${token}` }],
        [
          {
            text: "Настроить уведомления",
            callback_data: "v1:t:notify:global",
          },
        ],
      ]);
    });

    it("reports a Notifications failure in a new message and keeps the notification", async () => {
      const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue({
        kind: "dependency-rejected",
        reason: "unavailable",
      });
      const { bot, calls } = createHarness(resolvedIdentity(), { execute });
      await bot.init();
      await bot.handleUpdate(
        callbackMessageUpdate("v1:notify:off:published", notification),
      );
      expect(calls.map((call) => call.method)).toEqual([
        "answerCallbackQuery",
        "sendMessage",
      ]);
      const payload = screen(calls[1]);
      expect(payload.text).toContain("Это на моей стороне");
      // Повтор — та же кнопка в уведомлении: своя кнопка повтора у отказа
      // дописала бы успех под текстом отказа. Выход у кадра один — меню.
      expect(payload.reply_markup?.inline_keyboard).toEqual([
        [{ text: "Меню", callback_data: "v1:nav:start" }],
      ]);
    });

    // Настройка у сходки сильнее общей, поэтому подтверждение не обещает
    // тишины там, где напоминание включено у сходки отдельно.
    it("turns reminders off globally and names what stays on", async () => {
      const reminder = {
        text: "Напоминание: Настолки у Лёши\n12.08.2026 19:00",
        reply_markup: {
          inline_keyboard: [
            [{ text: "Открыть сходку", callback_data: `v1:view:${token}` }],
            [
              {
                text: "Не присылать напоминания",
                callback_data: "v1:notify:off:reminder",
              },
            ],
          ],
        },
      };
      const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue({
        kind: "global-notification-settings",
        categories: [{ category: "reminder", enabled: false }],
      });
      const { bot, calls } = createHarness(resolvedIdentity(), { execute });
      await bot.init();
      await bot.handleUpdate(
        callbackMessageUpdate("v1:notify:off:reminder", reminder),
      );
      expect(execute).toHaveBeenCalledWith(
        expect.objectContaining({
          intent: "set-global-category",
          category: "reminder",
          enabled: false,
        }),
      );
      const payload = screen(calls[1]);
      expect(payload.text).toContain(reminder.text);
      expect(payload.text).toContain(
        "Больше не присылаю напоминания, кроме сходок, где они включены отдельно",
      );
      expect(payload.reply_markup?.inline_keyboard).toEqual([
        [{ text: "Открыть сходку", callback_data: `v1:view:${token}` }],
        [
          {
            text: "Настроить уведомления",
            callback_data: "v1:t:notify:global",
          },
        ],
      ]);
    });
  });

  describe("disabling a meetup category from a change notification", () => {
    const off = `v1:notify:moff:${token}:changes`;
    const notification = {
      text: "Изменения в сходке: Настолки у Лёши\nИзменилось: место",
      reply_markup: {
        inline_keyboard: [
          [{ text: "Открыть сходку", callback_data: `v1:view:${token}` }],
          [{ text: "Не присылать изменения этой сходки", callback_data: off }],
        ],
      },
    };

    // Настройка у сходки сильнее общей: общий выключатель не остановил бы
    // изменения, если у этой сходки категория включена явно.
    it("turns the category off for this meetup and keeps the notification text", async () => {
      const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue({
        kind: "meetup-notification-settings",
        meetup,
        subscribed: true,
        categories: [
          { category: "changes", enabled: false, differsFromGlobal: true },
        ],
      });
      const { bot, calls } = createHarness(resolvedIdentity(), { execute });
      await bot.init();
      await bot.handleUpdate(callbackMessageUpdate(off, notification));
      expect(execute).toHaveBeenCalledWith(
        expect.objectContaining({
          intent: "set-meetup-category",
          meetupId: meetup.id,
          category: "changes",
          enabled: false,
        }),
      );
      expect(calls[1]?.method).toBe("editMessageText");
      const payload = screen(calls[1]);
      expect(payload.text).toContain(notification.text);
      expect(payload.text).toContain(
        "Больше не присылаю по этой сходке изменения данных и статуса, включая снятие с публикации",
      );
      expect(payload.reply_markup?.inline_keyboard).toEqual([
        [{ text: "Открыть сходку", callback_data: `v1:view:${token}` }],
        [
          {
            text: "Уведомления сходки",
            callback_data: `v1:t:notify:settings:${token}`,
          },
        ],
      ]);
    });

    it("reports a meetup that is gone in a new message and keeps the notification", async () => {
      const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue({
        kind: "meetup-not-found",
      });
      const { bot, calls } = createHarness(resolvedIdentity(), { execute });
      await bot.init();
      await bot.handleUpdate(callbackMessageUpdate(off, notification));
      expect(calls.map((call) => call.method)).toEqual([
        "answerCallbackQuery",
        "sendMessage",
      ]);
      expect(screen(calls[1]).text).toContain(
        "пока её снова не опубликуют, уведомлений по ней не будет",
      );
    });
  });

  // Сообщение организатора получают подписчики сходки: кнопка, как у
  // изменений, выключает категорию у этой сходки.
  it("turns organizer messages off for this meetup from an organizer message", async () => {
    const off = `v1:notify:moff:${token}:organizer`;
    const notification = {
      text: "Сообщение организатора: Настолки у Лёши\n\nБерите настолки",
      reply_markup: {
        inline_keyboard: [
          [{ text: "Открыть сходку", callback_data: `v1:view:${token}` }],
          [
            {
              text: "Не присылать сообщения организатора",
              callback_data: off,
            },
          ],
        ],
      },
    };
    const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue({
      kind: "meetup-notification-settings",
      meetup,
      subscribed: true,
      categories: [
        { category: "organizer", enabled: false, differsFromGlobal: true },
      ],
    });
    const { bot, calls } = createHarness(resolvedIdentity(), { execute });
    await bot.init();
    await bot.handleUpdate(callbackMessageUpdate(off, notification));
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: "set-meetup-category",
        meetupId: meetup.id,
        category: "organizer",
        enabled: false,
      }),
    );
    const payload = screen(calls[1]);
    expect(payload.text).toContain(notification.text);
    expect(payload.text).toContain(
      "Больше не присылаю по этой сходке сообщения организатора",
    );
  });

  // Объявление ни к какой сходке не привязано: выключается общая категория.
  it("turns announcements off globally from an announcement", async () => {
    const notification = {
      text: "Объявление сообщества\n\nСбор в пятницу",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "Не присылать объявления",
              callback_data: "v1:notify:off:announcement",
            },
          ],
        ],
      },
    };
    const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue({
      kind: "global-notification-settings",
      categories: [{ category: "announcement", enabled: false }],
    });
    const { bot, calls } = createHarness(resolvedIdentity(), { execute });
    await bot.init();
    await bot.handleUpdate(
      callbackMessageUpdate("v1:notify:off:announcement", notification),
    );
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: "set-global-category",
        category: "announcement",
        enabled: false,
      }),
    );
    const payload = screen(calls[1]);
    expect(payload.text).toContain(notification.text);
    expect(payload.text).toContain("Больше не присылаю: объявления сообщества");
    expect(payload.reply_markup?.inline_keyboard).toEqual([
      [
        {
          text: "Настроить уведомления",
          callback_data: "v1:t:notify:global",
        },
      ],
    ]);
  });

  describe("turning access requests off from a request", () => {
    const off = "v1:notify:off:access";
    const request = {
      text: "Новая заявка на доступ в сообщество",
      reply_markup: {
        inline_keyboard: [
          [{ text: "Открыть очередь", callback_data: "v1:t:cm:p" }],
          [{ text: "Не присылать запросы доступа", callback_data: off }],
        ],
      },
    };

    it("disables the global category and confirms under the request", async () => {
      const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue({
        kind: "global-notification-settings",
        categories: [{ category: "access", enabled: false }],
      });
      const { bot, calls } = createHarness(resolvedIdentity(), { execute });
      await bot.init();
      await bot.handleUpdate(callbackMessageUpdate(off, request));
      expect(execute).toHaveBeenCalledWith(
        expect.objectContaining({
          intent: "set-global-category",
          category: "access",
          enabled: false,
        }),
      );
      const payload = screen(calls[1]);
      expect(payload.text).toContain(request.text);
      expect(payload.text).toContain("Больше не присылаю: запросы доступа");
    });

    // Кнопка пережила роль: сервис отвечает `PERMISSION_DENIED`, и ответ
    // называет причину отдельным сообщением, не стирая уведомление.
    it("answers a stale button of a former admin with the reason", async () => {
      const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue({
        kind: "dependency-rejected",
        reason: "forbidden",
      });
      const { bot, calls } = createHarness(resolvedIdentity(), { execute });
      await bot.init();
      await bot.handleUpdate(callbackMessageUpdate(off, request));
      expect(calls.map((call) => call.method)).toContain("sendMessage");
      expect(calls.map((call) => call.method)).not.toContain("editMessageText");
      expect(
        screen(calls.find((call) => call.method === "sendMessage")).text,
      ).toContain("Запросы доступа настраивает только администратор.");
    });
  });

  describe("confirming a disabled announcement", () => {
    const off = "v1:notify:off:announcement";
    const announcement = (text: string) => ({
      text,
      reply_markup: {
        inline_keyboard: [
          [{ text: "Не присылать объявления", callback_data: off }],
        ],
      },
    });
    const disabled = () =>
      vi.fn<Dispatcher["execute"]>().mockResolvedValue({
        kind: "global-notification-settings",
        categories: [{ category: "announcement", enabled: false }],
      });

    // Рассылка у предела длины: заметка под текстом дала бы 400 на правке.
    it("keeps a text at the Telegram limit and sends the note separately", async () => {
      const long = "а".repeat(4096);
      const { bot, calls } = createHarness(resolvedIdentity(), {
        execute: disabled(),
      });
      await bot.init();
      await bot.handleUpdate(callbackMessageUpdate(off, announcement(long)));
      expect(calls.map((call) => call.method)).toEqual([
        "answerCallbackQuery",
        "editMessageText",
        "sendMessage",
      ]);
      expect(screen(calls[1]).text).toBe(long);
      expect(screen(calls[1]).reply_markup?.inline_keyboard).toEqual([
        [
          {
            text: "Настроить уведомления",
            callback_data: "v1:t:notify:global",
          },
        ],
      ]);
      expect(screen(calls[2]).text).toContain(
        "Больше не присылаю: объявления сообщества",
      );
    });

    // Тело пишет автор: совпадение с заметкой внутри текста подтверждения не
    // отменяет.
    it("still appends the note when the body quotes it", async () => {
      const note =
        "Больше не присылаю: объявления сообщества. Включить снова можно в настройках уведомлений.";
      const text = `Объявление сообщества\n\n${note}\nА это уже текст автора`;
      const { bot, calls } = createHarness(resolvedIdentity(), {
        execute: disabled(),
      });
      await bot.init();
      await bot.handleUpdate(callbackMessageUpdate(off, announcement(text)));
      expect(screen(calls[1]).text).toBe(`${text}\n\n${note}`);
    });

    it("still appends the note when the body ends with it", async () => {
      const note =
        "Больше не присылаю: объявления сообщества. Включить снова можно в настройках уведомлений.";
      const text = `Объявление сообщества\n\n${note}`;
      const { bot, calls } = createHarness(resolvedIdentity(), {
        execute: disabled(),
      });
      await bot.init();
      await bot.handleUpdate(callbackMessageUpdate(off, announcement(text)));
      expect(screen(calls[1]).text).toBe(`${text}\n\n${note}`);
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

describe("deferred publication frames", () => {
  const token = "AZLzpLXGfY6fChssPU5fYA";
  const moment = { year: 2026, month: 10, day: 1, hours: 19, minutes: 30 };
  const admin = {
    identityId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd",
    globalRoles: ["admin"],
    rights: ["hub", "auction"],
  };

  function scheduledDraft(): MeetupSnapshot {
    return {
      ...publishedMeetup(),
      visibility: "hidden",
      publishAt: moment,
    };
  }

  function unscheduledDraft(): MeetupSnapshot {
    const { publishAt: _cleared, ...rest } = scheduledDraft();
    return rest;
  }

  function payloadText(call: RecordedCall | undefined): string {
    return JSON.stringify(call?.payload ?? {});
  }

  it("shows the scheduled moment on the draft card and drops it once cancelled", async () => {
    let meetup = scheduledDraft();
    const execute = vi.fn<Dispatcher["execute"]>(async () => ({
      kind: "meetup-card",
      meetup,
    }));
    const { bot, calls } = createHarness(resolvedIdentity(["admin"]), {
      execute,
    });
    await bot.init();

    await bot.handleUpdate(callbackUpdate(`v1:view:${token}`));
    // На карточке момент читается, а не вводится: дата словами.
    expect(payloadText(calls.at(-1))).toMatch(
      /Публикация назначена на 1 октября( 2026)?, чт, 19:30/,
    );

    meetup = unscheduledDraft();
    await bot.handleUpdate(callbackUpdate(`v1:view:${token}`));
    expect(payloadText(calls.at(-1))).not.toContain("Публикация назначена");
  });

  it("shows the draft with its fields and both ways to publish after the title", async () => {
    const draft = draftMeetup();
    const execute = vi.fn<Dispatcher["execute"]>(async (request) =>
      request.intent === "create-meetup"
        ? { kind: "ask", field: "title", meetup: draft }
        : { kind: "draft", meetup: draft },
    );
    const { bot, calls } = createHarness(resolvedIdentity(["admin"]), {
      execute,
    });
    await bot.init();

    await bot.handleUpdate(callbackUpdate(`v1:manage:new:${token}`));
    await bot.handleUpdate(
      replyUpdate({
        text: "Настолки",
        fromId: 42,
        replyMessageId: lastQuestionId(calls),
        replyFromId: 1,
      }),
    );

    const draftToken = uuidToToken(draft.id);
    const shown = calls.findLast((call) => call.method === "sendRichMessage");
    expect(shown?.payload).toMatchObject({
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "Дата и время",
              callback_data: `v1:manage:draft:${draftToken}:schedule`,
            },
          ],
          [
            {
              text: "Место",
              callback_data: `v1:manage:draft:${draftToken}:venue`,
            },
          ],
          [
            {
              text: "Описание",
              callback_data: `v1:manage:draft:${draftToken}:description`,
            },
          ],
          [
            {
              text: "Опубликовать",
              callback_data: `v1:manage:publish:${draftToken}`,
            },
          ],
          [
            {
              text: "Опубликовать позже",
              callback_data: `v1:manage:publish-later:${draftToken}:d`,
            },
          ],
          [
            { text: "‹ Скрытые", callback_data: "v1:manage:hidden" },
            { text: "Меню", callback_data: "v1:nav:start" },
          ],
        ],
      },
    });
  });

  it("asks about a field from the draft and returns to the draft on cancel", async () => {
    const draft = draftMeetup();
    const draftToken = uuidToToken(draft.id);
    const execute = vi
      .fn<Dispatcher["execute"]>()
      .mockResolvedValue({ kind: "meetup-card", meetup: draft });
    const { bot, calls } = createHarness(resolvedIdentity(["admin"]), {
      execute,
    });
    await bot.init();

    await bot.handleUpdate(
      callbackUpdate(`v1:manage:draft:${draftToken}:venue`),
    );

    const question = calls.findLast((call) => call.method === "sendMessage");
    expect(question?.payload).toMatchObject({
      text: "Где встречаемся?",
      reply_markup: {
        force_reply: true,
        inline_keyboard: [
          [{ text: "Отмена", callback_data: `v1:q:fc:${draftToken}:venue:42` }],
        ],
      },
    });

    await bot.handleUpdate(callbackUpdate(`v1:q:fc:${draftToken}:venue`));

    // Вопрос удалён, черновик пришёл новым сообщением.
    expect(calls.map((call) => call.method)).toContain("deleteMessage");
    expect(calls.at(-1)).toMatchObject({
      method: "sendRichMessage",
      payload: {
        reply_markup: {
          inline_keyboard: expect.arrayContaining([
            [
              {
                text: "Опубликовать",
                callback_data: `v1:manage:publish:${draftToken}`,
              },
            ],
          ]),
        },
      },
    });
    for (const [request] of execute.mock.calls) {
      expect(request.intent).toBe("view-meetup");
    }
  });

  describe("date presets", () => {
    const draft = draftMeetup();
    const draftToken = uuidToToken(draft.id);
    const labels = (call: RecordedCall | undefined) => {
      const payload = call?.payload as
        | { reply_markup?: { inline_keyboard?: { text: string }[][] } }
        | undefined;
      return payload?.reply_markup?.inline_keyboard?.map((row) =>
        row.map((button) => button.text),
      );
    };

    it("opens the date as a screen of day presets without the reply mode", async () => {
      const execute = vi
        .fn<Dispatcher["execute"]>()
        .mockResolvedValue({ kind: "meetup-card", meetup: draft });
      const { bot, calls } = createHarness(
        resolvedIdentity(["admin"]),
        { execute },
        [],
        undefined,
        undefined,
        () => ({ year: 2026, month: 10, day: 1 }),
      );
      await bot.init();

      await bot.handleUpdate(
        callbackUpdate(`v1:manage:draft:${draftToken}:schedule`),
      );

      // Экран правит нажатое сообщение: режима ответа нет, и выбор кнопкой
      // ничего за собой не оставляет.
      const screen = calls.at(-1);
      expect(screen).toMatchObject({
        method: "editMessageText",
        payload: {
          message_id: 9,
          text: expect.stringContaining("Когда встречаемся? Выбери день."),
        },
      });
      expect(JSON.stringify(screen?.payload)).not.toContain("force_reply");
      expect(calls.map((call) => call.method)).not.toContain("sendMessage");
      expect(labels(screen)).toEqual([
        ["чт 1", "пт 2", "сб 3", "вс 4"],
        ["сб 10", "вс 11"],
        ["Другая дата"],
        ["Отмена"],
      ]);
    });

    it("asks the date as text from the other date button", async () => {
      const execute = vi
        .fn<Dispatcher["execute"]>()
        .mockResolvedValue({ kind: "meetup-card", meetup: draft });
      const { bot, calls } = createHarness(resolvedIdentity(["admin"]), {
        execute,
      });
      await bot.init();

      await bot.handleUpdate(
        callbackUpdate(`v1:manage:when:${draftToken}:c:t`),
      );

      // Экран выбора уступает место вопросу: он удаляется, вопрос приходит новым.
      expect(execute).not.toHaveBeenCalled();
      expect(
        calls.find((call) => call.method === "deleteMessage")?.payload,
      ).toMatchObject({ message_id: 9 });
      expect(sentMessages(calls).at(-1)).toMatchObject({
        method: "sendMessage",
        payload: {
          text: "Когда встречаемся? Напиши дату и время: ДД.ММ.ГГГГ ЧЧ:ММ",
          reply_markup: {
            force_reply: true,
            inline_keyboard: [
              [
                {
                  text: "Отмена",
                  callback_data: `v1:q:fc:${draftToken}:schedule:42`,
                },
              ],
            ],
          },
        },
      });
    });

    it("returns from the date screen to the draft on cancel", async () => {
      const execute = vi
        .fn<Dispatcher["execute"]>()
        .mockResolvedValue({ kind: "meetup-card", meetup: draft });
      const { bot, calls } = createHarness(resolvedIdentity(["admin"]), {
        execute,
      });
      await bot.init();

      await bot.handleUpdate(
        callbackUpdate(`v1:manage:when:${draftToken}:c:x`),
      );

      // Обычный возврат правкой: режима ответа у экрана нет, удалять нечего.
      expect(calls.map((call) => call.method)).not.toContain("deleteMessage");
      expect(calls.at(-1)).toMatchObject({
        method: "editMessageText",
        payload: { message_id: 9 },
      });
      expect(JSON.stringify(calls.at(-1)?.payload)).toContain(
        `v1:manage:publish:${draftToken}`,
      );
    });

    it("offers the same presets for the publication moment and schedules a picked time", async () => {
      // Момент получает только сходка с названием (PER-457).
      const titled = { ...draft, title: "Настолки" };
      const execute = vi.fn<Dispatcher["execute"]>(async (request) =>
        request.intent === "view-meetup"
          ? { kind: "meetup-card", meetup: titled }
          : {
              kind: "publication-scheduled",
              meetup: {
                ...titled,
                publishAt: {
                  year: 2026,
                  month: 10,
                  day: 3,
                  hours: 19,
                  minutes: 30,
                },
              },
            },
      );
      const { bot, calls } = createHarness(
        resolvedIdentity(["admin"]),
        { execute },
        [],
        undefined,
        undefined,
        () => ({ year: 2026, month: 10, day: 1 }),
      );
      await bot.init();

      await bot.handleUpdate(
        callbackUpdate(`v1:manage:publish-later:${draftToken}:d`),
      );

      const screen = calls.at(-1);
      expect(screen).toMatchObject({
        method: "editMessageText",
        payload: {
          text: expect.stringContaining("Когда опубликовать сходку?"),
        },
      });
      expect(JSON.stringify(screen?.payload)).not.toContain("force_reply");
      expect(JSON.stringify(screen?.payload)).toContain(
        `v1:manage:when:${draftToken}:d:03102026`,
      );

      await bot.handleUpdate(
        callbackUpdate(`v1:manage:when:${draftToken}:d:031020261930`),
      );

      expect(execute).toHaveBeenLastCalledWith(
        expect.objectContaining({
          intent: "schedule-publication",
          value: "03.10.2026 19:30",
          meetupId: draft.id,
        }),
      );
      expect(calls.at(-1)?.method).toBe("editMessageText");
    });

    it("turns the day presets into time presets in the same message", async () => {
      const execute = vi.fn<Dispatcher["execute"]>();
      const { bot, calls } = createHarness(
        resolvedIdentity(["admin"]),
        { execute },
        [],
        undefined,
        undefined,
        () => ({ year: 2026, month: 10, day: 1 }),
      );
      await bot.init();

      await bot.handleUpdate(
        callbackUpdate(`v1:manage:when:${draftToken}:c:03102026`),
      );

      // Сервис не нужен: день сменяется временем на месте.
      expect(execute).not.toHaveBeenCalled();
      const edited = calls.at(-1);
      expect(edited).toMatchObject({
        method: "editMessageText",
        payload: {
          message_id: 9,
          text: expect.stringContaining("3 октября, сб — во сколько?"),
        },
      });
      expect(labels(edited)).toEqual([
        ["12:00", "15:00", "17:00", "18:00"],
        ["19:00", "19:30", "20:00", "21:00"],
        ["Другой день"],
        ["Другая дата"],
        ["Отмена"],
      ]);
      expect(JSON.stringify(edited?.payload)).toContain(
        `v1:manage:when:${draftToken}:c:x`,
      );
      expect(JSON.stringify(edited?.payload)).not.toContain("force_reply");
    });

    it("takes a time preset as the answer and turns the question into the draft", async () => {
      const execute = vi
        .fn<Dispatcher["execute"]>()
        .mockResolvedValue({ kind: "draft", meetup: draft });
      const { bot, calls, records } = createHarness(
        resolvedIdentity(["admin"]),
        { execute },
      );
      await bot.init();

      await bot.handleUpdate(
        callbackUpdate(`v1:manage:when:${draftToken}:c:031020261930`),
      );

      expect(execute).toHaveBeenCalledWith(
        expect.objectContaining({
          intent: "set-meetup-field",
          field: "schedule",
          value: "03.10.2026 19:30",
          meetupId: draft.id,
        }),
      );
      expect(execute.mock.calls[0]?.[0]).not.toHaveProperty("confirmedPast");
      expect(calls.at(-1)).toMatchObject({
        method: "editMessageText",
        payload: { message_id: 9 },
      });
      expect(JSON.stringify(calls.at(-1)?.payload)).toContain(
        `v1:manage:publish:${draftToken}`,
      );
      expectBoundary(records[0], {
        level: "info",
        result: "ok",
        operation: "callback_query",
        use_case: "create_meetup",
      });
    });

    it("keeps the question waiting when the service fails under a time preset", async () => {
      const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue({
        kind: "dependency-rejected",
        reason: "timeout",
      });
      const { bot, calls } = createHarness(resolvedIdentity(["admin"]), {
        execute,
      });
      await bot.init();

      await bot.handleUpdate(
        callbackUpdate(`v1:manage:when:${draftToken}:c:031020261930`),
      );

      // Клавиатура вопроса на месте: и заготовки, и ответ текстом ещё работают.
      expect(calls.map((call) => call.method)).not.toContain(
        "editMessageReplyMarkup",
      );
      expect(calls.at(-1)?.method).toBe("sendMessage");
    });

    it("shows the saved outcome when the answer lands on an already published meetup", async () => {
      const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue({
        kind: "draft",
        meetup: { ...draft, visibility: "visible" },
      });
      const { bot, calls } = createHarness(resolvedIdentity(["admin"]), {
        execute,
      });
      await bot.init();

      await bot.handleUpdate(
        callbackUpdate(`v1:manage:when:${draftToken}:c:031020261930`),
      );

      const shown = JSON.stringify(calls.at(-1)?.payload);
      // Исход вместо формы черновика: возврат ведёт на карточку, где ряд статуса.
      expect(shown).toContain("<b>Изменение сохранено</b>");
      expect(shown).toContain("v1:view:");
      expect(shown).not.toContain("v1:manage:draft:");
    });

    it("sends a time preset of the edit form to the edit command", async () => {
      const execute = vi
        .fn<Dispatcher["execute"]>()
        .mockResolvedValue({ kind: "meetup-updated", meetup: draft });
      const { bot } = createHarness(resolvedIdentity(["admin"]), { execute });
      await bot.init();

      await bot.handleUpdate(
        callbackUpdate(`v1:manage:when:${draftToken}:e:031020261930`),
      );

      expect(execute).toHaveBeenCalledWith(
        expect.objectContaining({
          intent: "update-meetup-field",
          value: "03.10.2026 19:30",
        }),
      );
    });
  });

  it("opens a published meetup as the card under a stale draft button", async () => {
    const meetup: MeetupSnapshot = { ...draftMeetup(), visibility: "visible" };
    const execute = vi
      .fn<Dispatcher["execute"]>()
      .mockResolvedValue({ kind: "meetup-card", meetup });
    const { bot, calls } = createHarness(resolvedIdentity(["admin"]), {
      execute,
    });
    await bot.init();

    await bot.handleUpdate(
      callbackUpdate(`v1:manage:draft:${uuidToToken(meetup.id)}`),
    );

    const shown = JSON.stringify(calls.at(-1)?.payload);
    expect(shown).toContain("v1:manage:status:");
    expect(shown).not.toContain("v1:manage:draft:");
  });

  it("asks for the moment from the status menu and schedules the answer", async () => {
    // Момент получает только сходка с названием (PER-457).
    const draft = { ...draftMeetup(), title: "Настолки" };
    const execute = vi.fn<Dispatcher["execute"]>(async (request) =>
      request.intent === "view-meetup"
        ? { kind: "meetup-card", meetup: draft }
        : {
            kind: "publication-scheduled",
            meetup: { ...draft, publishAt: moment },
          },
    );
    const { bot, calls, records } = createHarness(resolvedIdentity(["admin"]), {
      execute,
    });
    await bot.init();

    await bot.handleUpdate(callbackUpdate(`v1:manage:status:${token}`));
    expect(payloadText(calls.at(-1))).toContain(
      `"callback_data":"v1:manage:publish-later:${token}"`,
    );
    expect(payloadText(calls.at(-1))).not.toContain("v1:manage:unschedule");

    // Момент выбирают кнопками на экране без режима ответа; текстом его
    // спрашивает «Другая дата».
    await bot.handleUpdate(callbackUpdate(`v1:manage:publish-later:${token}`));
    expect(calls.at(-1)?.method).toBe("editMessageText");
    expect(payloadText(calls.at(-1))).toContain("Когда опубликовать сходку?");
    expect(payloadText(calls.at(-1))).not.toContain("force_reply");

    await bot.handleUpdate(callbackUpdate(`v1:manage:when:${token}:p:t`));
    expect(sentMessages(calls).at(-1)?.method).toBe("sendMessage");
    expect(sendMessageText(sentMessages(calls).at(-1))).toContain(
      "Когда опубликовать сходку?",
    );
    expect(payloadText(sentMessages(calls).at(-1))).toContain(
      `v1:q:pm:${token}`,
    );

    await bot.handleUpdate(
      replyUpdate({
        text: "01.10.2026 19:30",
        fromId: 42,
        replyMessageId: lastQuestionId(calls),
        replyFromId: 1,
      }),
    );
    expect(execute).toHaveBeenLastCalledWith({
      identity: admin,
      intent: "schedule-publication",
      value: "01.10.2026 19:30",
      meetupId: draft.id,
      requestId: expect.any(String),
      useCase: "update_meetup",
      deadlineAt: expect.any(Number),
    });
    expect(sendMessageText(sentMessages(calls).at(-1))).toContain(
      "<b>Публикация назначена на 01.10.2026 19:30</b>",
    );
    expectBoundary(records.at(-1), {
      level: "info",
      result: "ok",
      use_case: "update_meetup",
    });
  });

  it("recovers the moment question from the replied bot message after restart", async () => {
    const draft = draftMeetup();
    const execute = vi.fn<Dispatcher["execute"]>(async (request) =>
      request.intent === "view-meetup"
        ? { kind: "meetup-card", meetup: draft }
        : {
            kind: "publication-scheduled",
            meetup: { ...draft, publishAt: moment },
          },
    );
    const first = createHarness(resolvedIdentity(["admin"]), { execute });
    await first.bot.init();
    await first.bot.handleUpdate(callbackUpdate(`v1:manage:when:${token}:p:t`));
    const question = sentMessages(first.calls).at(-1);
    const questionText = sendMessageText(question);
    expect(questionText).not.toContain("Шаг:");
    expect(questionText).not.toContain("v1:manage");

    const restarted = createHarness(resolvedIdentity(["admin"]), { execute });
    await restarted.bot.init();
    await restarted.bot.handleUpdate(
      replyUpdate({
        text: "01.10.2026 19:30",
        fromId: 42,
        replyMessageId: lastQuestionId(first.calls),
        replyFromId: 1,
        replyText: questionText,
        replyMarkup: (
          question?.payload as { reply_markup?: unknown } | undefined
        )?.reply_markup,
      }),
    );

    expect(execute).toHaveBeenLastCalledWith(
      expect.objectContaining({
        intent: "schedule-publication",
        meetupId: tokenToUuid(token),
      }),
    );
  });

  it("answers a past moment and a published meetup with different frames", async () => {
    const execute = vi
      .fn<Dispatcher["execute"]>()
      .mockResolvedValueOnce({
        kind: "ask-publish-moment",
        meetup: draftMeetup(),
        retry: "past",
      })
      .mockResolvedValueOnce({
        kind: "publication-unavailable",
        meetup: publishedMeetup(),
      });
    const { bot, calls } = createHarness(resolvedIdentity(["admin"]), {
      execute,
    });
    await bot.init();
    const replyMarkup = cancel(`v1:q:pm:${token}:42`);
    const answer = () =>
      bot.handleUpdate(
        replyUpdate({
          text: "01.01.2020 10:00",
          fromId: 42,
          replyMessageId: 7,
          replyFromId: 1,
          replyText: "Когда опубликовать?",
          replyMarkup,
        }),
      );

    await answer();
    const retried = sentMessages(calls).at(-1);
    expect(sendMessageText(retried)).toContain("Это время уже прошло");
    // Отказ — исход без ForceReply: время вводят заново кнопкой.
    expect(JSON.stringify(retried?.payload)).not.toContain("force_reply");
    expect(JSON.stringify(retried?.payload)).toContain(
      `"text":"Ввести заново","callback_data":"v1:manage:publish-later:${token}"`,
    );
    const afterPast = calls.length;

    await answer();
    const answered = JSON.stringify(
      calls.slice(afterPast).map((call) => call.payload),
    );
    expect(answered).toContain(
      JSON.stringify(
        "<b>Сходка уже опубликована</b>\n\n«Настолки»\n\nНазначать публикацию больше не нужно.",
      ).slice(1, -1),
    );
    expect(answered).not.toContain("Это время уже прошло");
  });

  it("answers a stale publish-later button on a published meetup by current state", async () => {
    const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue({
      kind: "meetup-card",
      meetup: publishedMeetup(),
    });
    const { bot, calls } = createHarness(resolvedIdentity(["admin"]), {
      execute,
    });
    await bot.init();

    await bot.handleUpdate(callbackUpdate(`v1:manage:publish-later:${token}`));

    expect(execute).toHaveBeenCalledOnce();
    expect(calls.at(-1)).toMatchObject({
      method: "editMessageText",
      payload: {
        text: refusalText(
          "Сходка уже опубликована. Назначать публикацию больше не нужно.",
        ),
      },
    });
  });

  it("refuses the publish-later button on an untitled draft before asking for a moment", async () => {
    const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue({
      kind: "meetup-card",
      meetup: draftMeetup(),
    });
    const { bot, calls } = createHarness(resolvedIdentity(["admin"]), {
      execute,
    });
    await bot.init();

    await bot.handleUpdate(callbackUpdate(`v1:manage:publish-later:${token}`));

    expect(execute).toHaveBeenCalledOnce();
    expect(calls.at(-1)).toMatchObject({
      method: "editMessageText",
      payload: {
        text: refusalText(
          "У сходки нет названия, а без него публикацию не назначить. Добавь название через «Изменить» на карточке.",
        ),
      },
    });
  });

  it("names the missing title when Meetups refuses a moment for a hidden meetup", async () => {
    // Название стёрли, пока висел вопрос о моменте: FAILED_PRECONDITION
    // назначения различается по перечитанному снимку, а не по тексту статуса.
    const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue({
      kind: "publication-unavailable",
      meetup: draftMeetup(),
    });
    const { bot, calls } = createHarness(resolvedIdentity(["admin"]), {
      execute,
    });
    await bot.init();
    const replyMarkup = cancel(`v1:q:pm:${token}:42`);

    await bot.handleUpdate(
      replyUpdate({
        text: "05.10.2026 19:00",
        fromId: 42,
        replyMessageId: 7,
        replyFromId: 1,
        replyText: "Когда опубликовать?",
        replyMarkup,
      }),
    );

    const answered = JSON.stringify(calls.map((call) => call.payload));
    expect(answered).toContain("У сходки нет названия");
    expect(answered).not.toContain("Сходка уже опубликована");
  });

  it("cancels a scheduled publication only from the confirmation callback", async () => {
    const scheduled = scheduledDraft();
    const execute = vi.fn<Dispatcher["execute"]>(async (request) =>
      request.intent === "view-meetup"
        ? { kind: "meetup-card", meetup: scheduled }
        : {
            kind: "meetup-state-changed",
            action: "unschedule",
            meetup: unscheduledDraft(),
          },
    );
    const { bot, calls } = createHarness(resolvedIdentity(["admin"]), {
      execute,
    });
    await bot.init();

    await bot.handleUpdate(callbackUpdate(`v1:manage:status:${token}`));
    expect(payloadText(calls.at(-1))).toContain(
      `"callback_data":"v1:manage:unschedule:${token}"`,
    );
    expect(payloadText(calls.at(-1))).toContain("Перенести публикацию");

    await bot.handleUpdate(callbackUpdate(`v1:manage:unschedule:${token}`));
    expect(execute).toHaveBeenCalledTimes(2);
    expect(calls.at(-1)).toMatchObject({
      method: "editMessageText",
      payload: {
        text: "<b>Отменить отложенную публикацию?</b>\n\n«Настолки»",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "Да, отменить публикацию",
                callback_data: `v1:manage:confirm-unschedule:${token}:1`,
              },
            ],
            [{ text: "Нет", callback_data: `v1:manage:status:${token}` }],
          ],
        },
      },
    });

    await bot.handleUpdate(
      callbackUpdate(`v1:manage:confirm-unschedule:${token}`),
    );
    expect(execute).toHaveBeenLastCalledWith(
      expect.objectContaining({
        intent: "change-meetup-state",
        action: "unschedule",
        meetupId: tokenToUuid(token),
      }),
    );
    expect(payloadText(calls.at(-1))).not.toContain("Публикация назначена");
  });

  it("does not ask to confirm cancelling a publication that is no longer scheduled", async () => {
    const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue({
      kind: "meetup-card",
      meetup: draftMeetup(),
    });
    const { bot, calls } = createHarness(resolvedIdentity(["admin"]), {
      execute,
    });
    await bot.init();

    await bot.handleUpdate(callbackUpdate(`v1:manage:unschedule:${token}`));

    expect(calls.at(-1)).toMatchObject({
      method: "editMessageText",
      payload: { text: refusalText("Отложенной публикации у сходки уже нет.") },
    });
  });
});

describe("past meetup date", () => {
  const token = "AZLzpLXGfY6fChssPU5fYA";
  const pastSchedule = {
    year: 2026,
    month: 9,
    day: 21,
    hours: 19,
    minutes: 30,
  };

  it("answers a past date with a confirmation frame that carries the date", async () => {
    const meetup = draftMeetup();
    const execute = vi.fn<Dispatcher["execute"]>(async (request) =>
      request.intent === "create-meetup"
        ? { kind: "ask", field: "schedule", meetup }
        : { kind: "confirm-past-schedule", meetup, schedule: pastSchedule },
    );
    const { bot, calls, records } = createHarness(resolvedIdentity(["admin"]), {
      execute,
    });
    await bot.init();
    await bot.handleUpdate(callbackUpdate(`v1:manage:when:${token}:c:t`));
    await bot.handleUpdate(
      replyUpdate({
        text: "21.09.2026 19:30",
        fromId: 42,
        replyMessageId: lastQuestionId(calls),
        replyFromId: 1,
      }),
    );

    expect(sentMessages(calls).at(-1)).toMatchObject({
      method: "sendMessage",
      payload: {
        text: expect.stringContaining("21.09.2026 19:30 уже прошла"),
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "Да, сохранить дату",
                callback_data: `v1:manage:past:${token}:c:210920261930`,
              },
            ],
            [
              {
                // «Нет» задаёт вопрос о дате заново.
                text: "Нет",
                callback_data: `v1:manage:past-retry:${token}:c`,
              },
            ],
          ],
        },
      },
    });
    expect(sendMessageText(sentMessages(calls).at(-1))).toContain(
      "уйдёт в архив",
    );
    expectBoundary(records.at(-1), {
      level: "info",
      result: "ok",
      use_case: "create_meetup",
    });
  });

  it("saves the confirmed date through the same form step", async () => {
    const meetup = draftMeetup();
    const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue({
      kind: "ask",
      field: "venue",
      meetup,
    });
    const { bot, calls, records } = createHarness(resolvedIdentity(["admin"]), {
      execute,
    });
    await bot.init();
    await bot.handleUpdate(
      callbackUpdate(`v1:manage:past:${token}:c:210920261930`),
    );

    expect(calls.map((call) => call.method)).toContain(
      "editMessageReplyMarkup",
    );
    expect(execute).toHaveBeenLastCalledWith({
      identity: {
        identityId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd",
        globalRoles: ["admin"],
        rights: ["hub", "auction"],
      },
      intent: "set-meetup-field",
      field: "schedule",
      value: "21.09.2026 19:30",
      meetupId: meetup.id,
      confirmedPast: true,
      requestId: expect.any(String),
      useCase: "create_meetup",
      deadlineAt: expect.any(Number),
    });
    expectBoundary(records.at(-1), {
      level: "info",
      result: "ok",
      operation: "callback_query",
      use_case: "create_meetup",
    });
  });

  it("asks the date again within the edit flow on retry", async () => {
    const meetup = publishedMeetup();
    const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue({
      kind: "meetup-card",
      meetup,
    });
    const { bot, calls } = createHarness(resolvedIdentity(["admin"]), {
      execute,
    });
    await bot.init();
    await bot.handleUpdate(callbackUpdate(`v1:manage:past-retry:${token}:e`));

    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenLastCalledWith(
      expect.objectContaining({ intent: "view-meetup" }),
    );
    // Кадр подтверждения правится в экран выбора даты: без режима ответа.
    const screen = calls.at(-1);
    expect(screen?.method).toBe("editMessageText");
    expect(JSON.stringify(screen?.payload)).toContain("Сейчас: дата не задана");
    expect(JSON.stringify(screen?.payload)).toContain(
      `v1:manage:when:${token}:e:x`,
    );
    expect(JSON.stringify(screen?.payload)).not.toContain("force_reply");
  });

  it("does not promise a place in the list for a meetup published into the archive", async () => {
    const meetup = { ...publishedMeetup(), schedule: pastSchedule };
    const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue({
      kind: "published",
      meetup,
      archived: true,
    });
    const { bot, calls } = createHarness(resolvedIdentity(), { execute });
    await bot.init();
    await bot.handleUpdate(callbackUpdate(`v1:manage:publish:${token}`));

    const edited = JSON.stringify(
      calls.find((call) => call.method === "editMessageText")?.payload,
    );
    expect(edited).toContain("сразу в архиве");
    expect(edited).not.toContain("видна в списке");
  });

  it("says an edited past date moved the meetup to the archive", async () => {
    const meetup = { ...publishedMeetup(), schedule: pastSchedule };
    const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue({
      kind: "meetup-updated",
      meetup,
      archived: true,
    });
    const { bot, calls } = createHarness(resolvedIdentity(["admin"]), {
      execute,
    });
    await bot.init();
    await bot.handleUpdate(
      callbackUpdate(`v1:manage:past:${token}:e:210920261930`),
    );

    expect(JSON.stringify(calls.at(-1)?.payload)).toContain(
      JSON.stringify(
        "<b>Изменение сохранено</b>\n\n«Настолки»\n\nДата сходки уже прошла, поэтому она в архиве",
      ).slice(1, -1),
    );
  });
});

describe("broadcast frames", () => {
  const meetupToken = "AZLzpLXGfY6fChssPU5fYA";
  const broadcastToken = "AZnA3gAAAAAAAABfP4Lqmw";
  const body = "Переносим начало на вечер.";

  function previewConfirmation(text = body, fromId = 1) {
    return {
      text: "Выше — текст для подписчиков сходки «Настолки».",
      reply_to_message: {
        message_id: 8,
        date: 0,
        chat: { id: 42, type: "private", first_name: "tester" },
        from: { id: fromId, is_bot: fromId === 1, first_name: "stub" },
        text,
      },
    };
  }

  it("shows the broadcast entry on the card to an admin only", async () => {
    const meetup = publishedMeetup();
    const execute = vi
      .fn<Dispatcher["execute"]>()
      .mockResolvedValue({ kind: "meetup-card", meetup });
    const admin = createHarness(resolvedIdentity(["admin"]), { execute });
    const member = createHarness(resolvedIdentity(["member"]), { execute });
    await admin.bot.init();
    await member.bot.init();

    await admin.bot.handleUpdate(callbackUpdate(`v1:view:${meetupToken}`));
    await member.bot.handleUpdate(callbackUpdate(`v1:view:${meetupToken}`));

    expect(JSON.stringify(admin.calls)).toContain(`v1:bc:m:${meetupToken}`);
    expect(JSON.stringify(member.calls)).not.toContain("v1:bc:");
  });

  it("offers the community announcement in management to an admin only", async () => {
    const admin = createHarness(resolvedIdentity(["admin"]));
    const member = createHarness(resolvedIdentity(["member"]));
    await admin.bot.init();
    await member.bot.init();

    await admin.bot.handleUpdate(callbackUpdate("v1:manage:menu"));
    await member.bot.handleUpdate(callbackUpdate("v1:manage:menu"));

    expect(JSON.stringify(admin.calls)).toContain("v1:bc:c");
    expect(JSON.stringify(member.calls)).not.toContain("v1:bc:c");
  });

  it("refuses the old management button to a non-admin without naming a service", async () => {
    const execute = vi.fn<Dispatcher["execute"]>();
    const { bot, calls, records } = createHarness(
      resolvedIdentity(["member"]),
      { execute },
    );
    await bot.init();

    await bot.handleUpdate(callbackUpdate("v1:manage:menu"));

    expect(execute).not.toHaveBeenCalled();
    expect(calls.at(-1)).toMatchObject({
      method: "editMessageText",
      payload: {
        text: refusalText("Управление сходками доступно администратору."),
        reply_markup: {
          inline_keyboard: [[{ text: "Меню", callback_data: "v1:nav:start" }]],
        },
      },
    });
    expect(JSON.stringify(calls)).not.toContain("v1:manage:new:");
    expectBoundary(records[0], {
      level: "warn",
      result: "error",
      operation: "callback_query",
      error_category: "authorization",
      use_case: "create_meetup",
    });
    expect(records[0]?.fields.error).toBe("management_forbidden");
  });

  it("opens the management menu in place of the pressed screen", async () => {
    const { bot, calls } = createHarness(resolvedIdentity(["admin"]));
    await bot.init();

    await bot.handleUpdate(callbackUpdate("v1:manage:menu"));

    expect(calls.map((call) => call.method)).toEqual([
      "answerCallbackQuery",
      "editMessageText",
    ]);
    expect(calls[1]?.payload).toMatchObject({
      message_id: 9,
      text: "<b>Управление</b>",
    });
  });

  it("offers the whole management menu to an admin", async () => {
    const { bot, calls } = createHarness(resolvedIdentity(["admin"]));
    await bot.init();

    await bot.handleUpdate(callbackUpdate("v1:manage:menu"));

    const sent = JSON.stringify(calls);
    expect(sent).toContain("v1:manage:new:");
    expect(sent).toContain("v1:manage:hidden");
    expect(sent).toContain("v1:community:list");
    expect(sent).toContain("v1:bc:c");
  });

  it("does not ask a non-admin for an allowed username", async () => {
    const { bot, calls, records } = createHarness(resolvedIdentity(["member"]));
    await bot.init();

    await bot.handleUpdate(callbackUpdate("v1:community:allow"));

    expect(JSON.stringify(calls)).not.toContain("force_reply");
    expect(calls.at(-1)).toMatchObject({
      method: "editMessageText",
      payload: {
        text: refusalText(
          "Управлять составом сообщества может только администратор.",
        ),
      },
    });
    expectBoundary(records[0], {
      level: "warn",
      result: "error",
      operation: "callback_query",
      error_category: "authorization",
      use_case: "manage_community",
    });
  });

  it("does not ask a non-admin for broadcast text", async () => {
    const execute = vi.fn<Dispatcher["execute"]>();
    const { bot, calls, records } = createHarness(
      resolvedIdentity(["member"]),
      { execute },
    );
    await bot.init();

    await bot.handleUpdate(callbackUpdate(`v1:bc:m:${meetupToken}`));

    expect(execute).not.toHaveBeenCalled();
    expect(calls.at(-1)).toMatchObject({
      method: "editMessageText",
      payload: {
        text: refusalText(
          "Писать подписчикам может только организатор сходки.",
        ),
      },
    });
    expectBoundary(records[0], {
      level: "warn",
      result: "error",
      operation: "callback_query",
      error_category: "authorization",
      use_case: "send_broadcast",
    });
  });

  it("previews the text and warns of irreversibility before anything is sent", async () => {
    const meetup = publishedMeetup();
    const execute = vi
      .fn<Dispatcher["execute"]>()
      .mockResolvedValue({ kind: "meetup-card", meetup });
    const { bot, calls } = createHarness(resolvedIdentity(["admin"]), {
      execute,
    });
    await bot.init();

    await bot.handleUpdate(callbackUpdate(`v1:bc:m:${meetupToken}`));
    expect(sendMessageText(calls.at(-1))).toContain("«Настолки»");
    await bot.handleUpdate(
      replyUpdate({
        text: `  ${body}  `,
        fromId: 42,
        replyMessageId: lastQuestionId(calls),
        replyFromId: 1,
      }),
    );

    expect(
      execute.mock.calls.some(
        ([request]) => request.intent === "send-broadcast",
      ),
    ).toBe(false);
    // Сходку читают при вопросе и не перечитывают на ответе: сбой Meetups в
    // этот момент не должен стоить человеку набранного текста.
    expect(execute).toHaveBeenCalledTimes(1);
    const preview = sentMessages(calls).at(-2);
    const confirmation = sentMessages(calls).at(-1);
    // Предпросмотр — ровно текст рассылки, без заголовка и числа получателей.
    expect(sendMessageText(preview)).toBe(body);
    const text = sendMessageText(confirmation) ?? "";
    expect(text).toContain("Отменить отправку будет нельзя");
    expect(text).toContain("«Настолки»");
    expect(text).not.toMatch(/\d/);
    expect(confirmation?.payload).toMatchObject({
      reply_parameters: { message_id: expect.any(Number) },
    });
    expect(JSON.stringify(confirmation?.payload)).toMatch(
      new RegExp(`v1:bc:ms:${meetupToken}:[A-Za-z0-9_-]{22}`),
    );
    expect(JSON.stringify(confirmation?.payload)).toContain("v1:bc:no");
  });

  it("refuses a broadcast that is too long to send with a re-entry button", async () => {
    const { bot, calls } = createHarness(resolvedIdentity(["admin"]));
    await bot.init();

    await bot.handleUpdate(callbackUpdate("v1:bc:c"));
    await bot.handleUpdate(
      replyUpdate({
        text: "я".repeat(4097),
        fromId: 42,
        replyMessageId: lastQuestionId(calls),
        replyFromId: 1,
      }),
    );

    const retry = sentMessages(calls).at(-1);
    expect(sendMessageText(retry)).toContain("длиннее 4096 символов");
    // Отказ — исход без ForceReply: рассылку вводят заново кнопкой.
    expect(JSON.stringify(retry?.payload)).not.toContain("force_reply");
    expect(JSON.stringify(retry?.payload)).toContain(
      '"text":"Ввести заново","callback_data":"v1:bc:c"',
    );
    // Прежний вопрос закрыт, а кнопка задаёт новый.
    expect(calls.at(-1)?.method).toBe("editMessageReplyMarkup");
    await bot.handleUpdate(callbackUpdate("v1:bc:c"));
    expect(JSON.stringify(calls.at(-1)?.payload)).toContain("force_reply");
  });

  it("sends the previewed text with the key from the button once confirmed", async () => {
    const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue({
      kind: "broadcast-accepted",
      audience: { kind: "community" },
    });
    const { bot, calls, records } = createHarness(resolvedIdentity(["admin"]), {
      execute,
    });
    await bot.init();

    await bot.handleUpdate(
      callbackMessageUpdate(
        `v1:bc:cs:${broadcastToken}`,
        previewConfirmation(),
      ),
    );

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: "send-broadcast",
        audience: { kind: "community" },
        broadcastId: tokenToUuid(broadcastToken),
        body,
      }),
    );
    expect(calls.at(-1)).toMatchObject({
      method: "editMessageText",
      payload: {
        text: refusalText(
          "Объявление принято к отправке участникам сообщества.",
        ),
      },
    });
    expectBoundary(records[0], {
      level: "info",
      result: "ok",
      operation: "callback_query",
      use_case: "send_broadcast",
    });
  });

  // Бот не проверяет право на подтверждении: вызов мимо кадра получает отказ
  // Notifications, и человек видит E-01, а не отправленную рассылку.
  it("answers a Notifications refusal with the permission frame", async () => {
    const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue({
      kind: "dependency-rejected",
      reason: "forbidden",
    });
    const { bot, calls, records } = createHarness(
      resolvedIdentity(["member"]),
      { execute },
    );
    await bot.init();

    await bot.handleUpdate(
      callbackMessageUpdate(
        `v1:bc:ms:${meetupToken}:${broadcastToken}`,
        previewConfirmation(),
      ),
    );

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ intent: "send-broadcast" }),
    );
    expect(calls.at(-1)).toMatchObject({
      method: "editMessageText",
      payload: {
        text: refusalText(
          "Писать подписчикам может только организатор сходки. Ничего не отправлено.",
        ),
      },
    });
    expectBoundary(records[0], {
      level: "warn",
      result: "error",
      operation: "callback_query",
      error_category: "authorization",
      use_case: "send_broadcast",
    });
  });

  it("tells a repeated confirmation that nothing is sent twice", async () => {
    const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue({
      kind: "broadcast-accepted",
      audience: { kind: "community" },
      repeated: true,
    });
    const { bot, calls } = createHarness(resolvedIdentity(["admin"]), {
      execute,
    });
    await bot.init();

    await bot.handleUpdate(
      callbackMessageUpdate(
        `v1:bc:cs:${broadcastToken}`,
        previewConfirmation(),
      ),
    );

    expect(calls.at(-1)).toMatchObject({
      method: "editMessageText",
      payload: {
        text: refusalText(
          "Это сообщение уже принято к отправке раньше. Второй раз оно не уйдёт.",
        ),
      },
    });
  });

  it("offers a retry with the same key when Notifications does not answer", async () => {
    const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue({
      kind: "dependency-rejected",
      reason: "unavailable",
    });
    const { bot, calls } = createHarness(resolvedIdentity(["admin"]), {
      execute,
    });
    await bot.init();
    const data = `v1:bc:ms:${meetupToken}:${broadcastToken}`;

    await bot.handleUpdate(callbackMessageUpdate(data, previewConfirmation()));

    const frame = calls.at(-1);
    expect(frame?.method).toBe("editMessageText");
    expect(JSON.stringify(frame?.payload)).toContain(data);
    expect(JSON.stringify(frame?.payload)).toContain(
      "второй раз сообщение не уйдёт",
    );
  });

  it("refuses a confirmation whose preview is not the bot's own message", async () => {
    const execute = vi.fn<Dispatcher["execute"]>();
    const { bot, calls, records } = createHarness(resolvedIdentity(["admin"]), {
      execute,
    });
    await bot.init();

    await bot.handleUpdate(
      callbackMessageUpdate(
        `v1:bc:cs:${broadcastToken}`,
        previewConfirmation(body, 42),
      ),
    );
    await bot.handleUpdate(
      callbackMessageUpdate(`v1:bc:cs:${broadcastToken}`, {
        text: "без ответа",
      }),
    );

    expect(execute).not.toHaveBeenCalled();
    const frames = calls.filter((call) => call.method === "editMessageText");
    expect(frames).toHaveLength(2);
    expect(JSON.stringify(frames)).toContain("Ничего не отправлено");
    expectBoundary(records[0], {
      level: "warn",
      result: "error",
      operation: "callback_query",
      error_category: "invariant",
      use_case: "send_broadcast",
    });
  });
});

describe("meetup author", () => {
  const organizer = {
    kind: "organizer" as const,
    telegramUsername: "organizer_nick",
  };

  async function viewCard(
    card: Awaited<ReturnType<Dispatcher["execute"]>>,
    presentation?: "rich" | "plain",
  ) {
    const execute = vi.fn<Dispatcher["execute"]>().mockResolvedValue(card);
    const harness = createHarness(
      resolvedIdentity(["member"]),
      { execute },
      [],
      undefined,
      presentation,
    );
    await harness.bot.init();
    await harness.bot.handleUpdate(
      callbackUpdate("v1:view:AZLzpLXGfY6fChssPU5fYA"),
    );
    const card_ = harness.calls.find(
      (call) => call.method === "editMessageText",
    );
    return {
      payload: JSON.stringify(card_?.payload),
      records: harness.records,
    };
  }

  it("tells the author that the meetup is theirs", async () => {
    const { payload } = await viewCard({
      kind: "meetup-card",
      meetup: publishedMeetup(),
      author: { kind: "self" },
    });
    expect(payload).toContain("Ты автор этой сходки");
    expect(payload).not.toContain("Автор:");
  });

  it("names the organizer in the rich card and keeps the username out of the log", async () => {
    const { payload, records } = await viewCard({
      kind: "meetup-card",
      meetup: publishedMeetup(),
      author: organizer,
    });
    expect(payload).toContain("Автор: @organizer_nick");
    expect(JSON.stringify(records)).not.toContain("organizer_nick");
  });

  it("names the organizer in the plain card", async () => {
    const { payload } = await viewCard(
      { kind: "meetup-card", meetup: publishedMeetup(), author: organizer },
      "plain",
    );
    expect(payload).toContain("Автор: @organizer_nick");
  });

  it("draws no author line when there is nothing to name", async () => {
    const { payload } = await viewCard({
      kind: "meetup-card",
      meetup: publishedMeetup(),
    });
    expect(payload).not.toContain("Автор:");
    expect(payload).not.toContain("Ты автор");
  });

  it("keeps the author line on the card redrawn after a state change", async () => {
    const meetup = publishedMeetup();
    const execute = vi.fn<Dispatcher["execute"]>(async (request) =>
      request.intent === "view-meetup"
        ? { kind: "meetup-card", meetup, author: organizer }
        : {
            kind: "meetup-state-changed",
            action: "hold",
            meetup: { ...meetup, lifecycle: "held" as const },
            author: organizer,
          },
    );
    const { bot, calls } = createHarness(resolvedIdentity(["admin"]), {
      execute,
    });
    await bot.init();

    await bot.handleUpdate(
      callbackUpdate("v1:manage:confirm-hold:AZLzpLXGfY6fChssPU5fYA"),
    );

    expect(JSON.stringify(calls.at(-1)?.payload)).toContain(
      "Автор: @organizer_nick",
    );
  });
});

describe("source channels", () => {
  function channels(
    lists: readonly (readonly SourceChannel[])[],
    changed = true,
  ) {
    const sourceChannels =
      vi.fn<SourceChannelAdministrator["sourceChannels"]>();
    for (const list of lists) {
      sourceChannels.mockResolvedValueOnce({ kind: "ok", value: list });
    }
    const createSourceChannel = vi
      .fn<SourceChannelAdministrator["createSourceChannel"]>()
      .mockResolvedValue({ kind: "ok", value: changed });
    return {
      ...resolvedIdentity(["admin"]),
      sourceChannels,
      createSourceChannel,
    };
  }

  function answer(text: string, calls: readonly RecordedCall[]): Update {
    return replyUpdate({
      text,
      fromId: 42,
      replyMessageId: lastQuestionId(calls),
      replyFromId: 1,
    });
  }

  function lastSent(calls: readonly RecordedCall[]): string {
    return JSON.stringify(
      calls.findLast((call) => call.method === "sendMessage")?.payload,
    );
  }

  it("opens from management with a link ready to forward", async () => {
    const identity = channels([[{ code: "tg_ads", label: "Реклама" }]]);
    const { bot, calls } = createHarness(identity);
    await bot.init();

    await bot.handleUpdate(callbackUpdate("v1:sc:l"));

    expect(identity.sourceChannels).toHaveBeenCalledWith(
      expect.objectContaining({ globalRoles: ["admin"] }),
      expect.objectContaining({ useCase: "manage_community" }),
    );
    const text = JSON.stringify(calls.at(-1)?.payload);
    expect(text).toContain("Реклама · tg_ads");
    expect(text).toContain("https://t.me/stub_bot?start=s_tg_ads");
  });

  it("does not open the screen or ask a question for a non-administrator", async () => {
    const identity = {
      ...channels([[]]),
      ...resolvedIdentity(["member"]),
    };
    const { bot, calls } = createHarness(identity);
    await bot.init();

    await bot.handleUpdate(callbackUpdate("v1:sc:l"));
    await bot.handleUpdate(callbackUpdate("v1:sc:a"));

    expect(identity.sourceChannels).not.toHaveBeenCalled();
    expect(JSON.stringify(calls)).not.toContain("force_reply");
    expect(JSON.stringify(calls)).toContain(
      "Вести каналы прихода может только администратор.",
    );
  });

  it("creates a channel by code, then label, and shows it with its link", async () => {
    const identity = channels([[{ code: "tg_ads", label: "Реклама" }]]);
    const { bot, calls } = createHarness(identity);
    await bot.init();

    await bot.handleUpdate(callbackUpdate("v1:sc:a"));
    expect(JSON.stringify(calls.at(-1)?.payload)).toContain(
      '"force_reply":true',
    );
    expect(JSON.stringify(calls.at(-1)?.payload)).toContain("v1:q:cc");

    // Код вне алфавита переспрашивается до вопроса о подписи.
    await bot.handleUpdate(answer("tg ads", calls));
    expect(lastSent(calls)).toContain("<b>Такой код в ссылку не встанет</b>");
    expect(lastSent(calls)).not.toContain("force_reply");
    expect(lastSent(calls)).toContain(
      '"text":"Ввести заново","callback_data":"v1:sc:a"',
    );

    // «Ввести заново» начинает цепочку с кода.
    await bot.handleUpdate(callbackUpdate("v1:sc:a"));
    await bot.handleUpdate(answer(" tg_ads ", calls));
    expect(lastSent(calls)).toContain("Как подписать канал?");
    expect(identity.createSourceChannel).not.toHaveBeenCalled();

    await bot.handleUpdate(answer("Реклама", calls));

    expect(identity.createSourceChannel).toHaveBeenCalledWith(
      expect.objectContaining({ globalRoles: ["admin"] }),
      { code: "tg_ads", label: "Реклама" },
      expect.objectContaining({ useCase: "manage_community" }),
    );
    const screen = JSON.stringify(calls.at(-1)?.payload);
    expect(screen).toContain("Канал заведён.");
    expect(screen).toContain("https://t.me/stub_bot?start=s_tg_ads");
  });

  it("refuses the label with a re-entry button when Identity rejects it", async () => {
    const identity = {
      ...channels([]),
      createSourceChannel: vi
        .fn<SourceChannelAdministrator["createSourceChannel"]>()
        .mockResolvedValue({ kind: "invalid" }),
    };
    const { bot, calls } = createHarness(identity);
    await bot.init();

    await bot.handleUpdate(callbackUpdate("v1:sc:a"));
    await bot.handleUpdate(answer("tg_ads", calls));
    await bot.handleUpdate(answer("x".repeat(65), calls));

    expect(lastSent(calls)).toContain(
      "<b>Подпись — одна строка до 64 символов</b>",
    );
    expect(lastSent(calls)).not.toContain("force_reply");
    // Отказ по подписи возвращает к первому вопросу цепочки — коду.
    expect(lastSent(calls)).toContain(
      '"text":"Ввести заново","callback_data":"v1:sc:a"',
    );
    expect(identity.sourceChannels).not.toHaveBeenCalled();
  });

  it("refuses the label with a re-entry button when Identity is unavailable", async () => {
    const identity = {
      ...channels([]),
      createSourceChannel: vi
        .fn<SourceChannelAdministrator["createSourceChannel"]>()
        .mockResolvedValue({ kind: "unavailable", cause: new Error("down") }),
    };
    const { bot, calls } = createHarness(identity);
    await bot.init();

    await bot.handleUpdate(callbackUpdate("v1:sc:a"));
    await bot.handleUpdate(answer("tg_ads", calls));
    await bot.handleUpdate(answer("Реклама", calls));

    expect(lastSent(calls)).toContain("<b>Канал не сохранился</b>");
    expect(lastSent(calls)).not.toContain("force_reply");
    expect(lastSent(calls)).toContain(
      '"text":"Ввести заново","callback_data":"v1:sc:a"',
    );
    expect(identity.sourceChannels).not.toHaveBeenCalled();
  });

  it("says the channel is saved when only the list fails afterwards", async () => {
    const identity = {
      ...channels([]),
      sourceChannels: vi
        .fn<SourceChannelAdministrator["sourceChannels"]>()
        .mockResolvedValue({ kind: "unavailable", cause: new Error("down") }),
    };
    const { bot, calls } = createHarness(identity);
    await bot.init();

    await bot.handleUpdate(callbackUpdate("v1:sc:a"));
    await bot.handleUpdate(answer("tg_ads", calls));
    await bot.handleUpdate(answer("Реклама", calls));

    expect(identity.createSourceChannel).toHaveBeenCalled();
    expect(JSON.stringify(calls.at(-1)?.payload)).toContain(
      "Канал заведён, но список не загрузился.",
    );
  });

  it("answers /start with a source payload like a plain /start", async () => {
    const plain = createHarness(resolvedIdentity());
    await plain.bot.init();
    await plain.bot.handleUpdate(messageUpdate("/start"));

    const sourced = createHarness(resolvedIdentity());
    await sourced.bot.init();
    await sourced.bot.handleUpdate(messageUpdate("/start s_tg_ads"));
    await sourced.bot.handleUpdate(messageUpdate("/start s_"));

    expect(sourced.calls.map((call) => call.payload)).toEqual([
      ...plain.calls.map((call) => call.payload),
      ...plain.calls.map((call) => call.payload),
    ]);
  });

  it("does not answer /faq on the hub surface", async () => {
    const { bot, calls } = createHarness(resolvedIdentity());
    await bot.init();
    calls.length = 0;

    await bot.handleUpdate(messageUpdate("/faq"));

    expect(calls).toEqual([]);
  });

  it("opens the hub FAQ for an admitted member and keeps the auction return", async () => {
    const { bot, calls, records } = createHarness(resolvedIdentity());
    await bot.init();

    await bot.handleUpdate(
      callbackUpdate(auctionFaqData("AZLzpLXGfY6fChssPU5fYA")),
    );

    const rendered = calls.findLast(
      (call) => call.method === "editMessageText",
    )?.payload;
    expect(JSON.stringify(rendered)).toContain("<b>Правила и FAQ</b>");
    expect(JSON.stringify(rendered)).toContain("‹ Лоты");
    expect(records.at(-1)?.fields.use_case).toBe("view_auction");
  });
});
