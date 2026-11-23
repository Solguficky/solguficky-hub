import { GrammyError } from "grammy";
import type { Update } from "grammy/types";
import { describe, expect, it, vi } from "vitest";
import {
  botInfo,
  createHarness,
  type RecordedCall,
} from "../../../../testkit/harness.js";
import type { AccessRight } from "../../../auction-ui/index.js";
import { noopTracing } from "../../../core/tracing.js";
import type { ExecuteRequest, ExecuteResult } from "../application/types.js";
import type { MeetupSnapshot } from "../meetups/port.js";
import type { CommunityChat } from "./community-chat.js";
import { uuidToToken } from "./meetup-deep-link.js";

// Правка текста поста (PER-926, вариант А): харнесс без Telegram. Проверяют
// кнопку у каждой ссылки, пересмотр права в момент изменения, правку поста с
// сохранённой подписью и кнопкой, а также понятный отказ на чужом сообщении.

const resolvedId = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd";
const communityChatId = -1001234567890;
const postId = 28;
const postLink = `https://t.me/c/1234567890/${postId}`;
const materialId = "0199c0de-0000-7000-8000-000000000001";
const body = "Новый текст анонса";
const signature = "Организатор";

const memberRights: readonly AccessRight[] = [
  "access-hub",
  "place-bids",
  "organize-meetups",
];

function meetupOf(overrides: Partial<MeetupSnapshot> = {}): MeetupSnapshot {
  return {
    id: "0192f3a4-b5c6-7d8e-9f0a-1b2c3d4e5f60",
    title: "Настолки",
    description: "Берём свои игры",
    venue: "Циферблат",
    lifecycle: "planned",
    visibility: "visible",
    author: "0192f0a0-0000-7000-8000-00000000a001",
    organizers: [resolvedId],
    version: 1,
    materials: [
      {
        id: materialId,
        title: "Анонс сходки",
        source: { kind: "message-link", url: postLink },
      },
    ],
    ...overrides,
  };
}

type SetupOptions = {
  rights?: readonly AccessRight[];
  withChat?: boolean;
  chatId?: number;
  initial?: MeetupSnapshot;
  respond?: (method: string, payload: unknown) => unknown;
};

function setup(options: SetupOptions = {}) {
  const rights = options.rights ?? memberRights;
  const meetup = options.initial ?? meetupOf();
  const execute = vi.fn(
    async (_request: ExecuteRequest): Promise<ExecuteResult> => ({
      kind: "meetup-card",
      meetup,
    }),
  );
  const chat: CommunityChat = {
    chatId: options.chatId ?? communityChatId,
    registerCommands: async () => {},
    gate: async (_ctx, next) => next(),
  };
  const harness = createHarness(
    {
      resolve: async () => ({
        kind: "resolved" as const,
        identityId: resolvedId,
        rights,
        blocked: false,
      }),
    },
    { execute },
    [],
    noopTracing(),
    undefined,
    undefined,
    {
      ...(options.withChat === false ? {} : { communityChat: chat }),
      ...(options.respond === undefined ? {} : { respond: options.respond }),
    },
  );
  return {
    ...harness,
    execute,
    token: uuidToToken(meetup.id),
    materialToken: uuidToToken(materialId),
  };
}

function callbackUpdate(
  data: string,
  message: Record<string, unknown> = {},
): Update {
  return {
    update_id: 2,
    callback_query: {
      id: "callback-1",
      chat_instance: "chat-1",
      from: { id: 42, is_bot: false, first_name: signature },
      data,
      message: {
        message_id: 9,
        date: 0,
        chat: { id: 42, type: "private", first_name: "tester" },
        ...message,
      },
    },
  } as Update;
}

function replyUpdate(text: string, replyMessageId: number): Update {
  return {
    update_id: 3,
    message: {
      message_id: 10,
      date: 0,
      chat: { id: 42, type: "private", first_name: "tester" },
      from: { id: 42, is_bot: false, first_name: signature },
      text,
      reply_to_message: {
        message_id: replyMessageId,
        date: 0,
        chat: { id: 42, type: "private", first_name: "tester" },
        from: { id: botInfo.id, is_bot: true, first_name: "stub" },
        text: "Вопрос",
      },
    },
  } as Update;
}

function findData(calls: readonly RecordedCall[], prefix: string): string {
  for (const call of calls) {
    const rows = (
      call.payload as {
        reply_markup?: { inline_keyboard?: { callback_data?: string }[][] };
      }
    ).reply_markup?.inline_keyboard;
    for (const button of rows?.flat() ?? []) {
      if (button.callback_data?.startsWith(prefix) === true) {
        return button.callback_data;
      }
    }
  }
  throw new Error(`button ${prefix} not found`);
}

function lastQuestionId(calls: readonly RecordedCall[]): number {
  const index = calls.findLastIndex((call) => call.method === "sendMessage");
  return 100 + index + 1;
}

function previewMessage(): Record<string, unknown> {
  return {
    text: "Подтверждение",
    reply_to_message: {
      message_id: 5,
      date: 100,
      from: { id: botInfo.id, is_bot: true, first_name: "stub" },
      text: body,
    },
  };
}

function editCalls(calls: readonly RecordedCall[]): RecordedCall[] {
  // Нажатие на кнопку снимает клавиатуру тем же editMessageText, но в личке;
  // правка поста идёт в чат сообщества.
  return calls.filter(
    (call) =>
      call.method === "editMessageText" &&
      (call.payload as { chat_id?: number }).chat_id === communityChatId,
  );
}

async function openConfirmation(h: ReturnType<typeof setup>): Promise<string> {
  await h.bot.handleUpdate(
    callbackUpdate(`v1:mm:et:${h.token}:${h.materialToken}`),
  );
  const questionId = lastQuestionId(h.calls);
  await h.bot.handleUpdate(replyUpdate(body, questionId));
  return findData(h.calls, "v1:mm:ee:");
}

describe("правка текста поста чата сообщества (PER-926)", () => {
  it("меняет текст поста, сохраняя подпись и кнопку, материал не пишется", async () => {
    const h = setup();
    const confirm = await openConfirmation(h);
    await h.bot.handleUpdate(callbackUpdate(confirm, previewMessage()));

    const edits = editCalls(h.calls);
    expect(edits).toHaveLength(1);
    expect(edits[0]?.payload).toMatchObject({
      chat_id: communityChatId,
      message_id: postId,
      text: `<b>${signature}:</b>\n\n${body}`,
      parse_mode: "HTML",
    });
    const editPayload = edits[0]?.payload;
    expect(editPayload).toBeDefined();
    const markup = (
      editPayload as {
        reply_markup?: { inline_keyboard: { text: string; url?: string }[][] };
      }
    ).reply_markup;
    expect(markup?.inline_keyboard.flat()[0]?.text).toBe("Открыть сходку ↗");
    expect(
      h.execute.mock.calls.every(
        ([request]) =>
          request.intent !== "attach-material" &&
          request.intent !== "remove-material",
      ),
    ).toBe(true);
    expect(
      h.records.some((record) => record.message === "material text edited"),
    ).toBe(true);
  });

  it("пересчитывает право на подтверждении: потерявший право organizer не меняет текст", async () => {
    const h = setup();
    const confirm = await openConfirmation(h);
    h.execute.mockImplementation(async () => ({
      kind: "meetup-card",
      meetup: meetupOf({ organizers: [] }),
    }));
    await h.bot.handleUpdate(callbackUpdate(confirm, previewMessage()));

    expect(editCalls(h.calls)).toHaveLength(0);
    expect(
      h.records.some(
        (record) => record.message === "material text edit rejected",
      ),
    ).toBe(true);
  });

  it("подделанная кнопка без права не задаёт вопрос и не права пост", async () => {
    const h = setup({ rights: ["access-hub"] });
    await h.bot.handleUpdate(
      callbackUpdate(`v1:mm:et:${h.token}:${h.materialToken}`),
    );
    expect(editCalls(h.calls)).toHaveLength(0);
    expect(
      h.records.some(
        (record) => record.message === "material text edit rejected",
      ),
    ).toBe(true);
  });

  it("правка открыта у отменённой сходки", async () => {
    const h = setup({ initial: meetupOf({ lifecycle: "cancelled" }) });
    const confirm = await openConfirmation(h);
    await h.bot.handleUpdate(callbackUpdate(confirm, previewMessage()));
    expect(editCalls(h.calls)).toHaveLength(1);
  });

  it("отказ Telegram на чужой пост объясняется человеку, материал не меняется", async () => {
    const h = setup({
      respond: (method) => {
        if (method === "editMessageText") {
          throw new GrammyError(
            "Bad Request: message can't be edited",
            {
              ok: false,
              error_code: 400,
              description: "message can't be edited",
            },
            "editMessageText",
            {},
          );
        }
        return undefined;
      },
    });
    const confirm = await openConfirmation(h);
    await h.bot.handleUpdate(callbackUpdate(confirm, previewMessage()));

    expect(
      h.records.some(
        (record) => record.message === "material text edit denied by telegram",
      ),
    ).toBe(true);
    const refusals = h.calls.filter(
      (call) =>
        call.method === "sendMessage" &&
        JSON.stringify(call.payload).includes("не принадлежит боту"),
    );
    expect(refusals.length).toBeGreaterThan(0);
    expect(
      h.execute.mock.calls.every(
        ([request]) => request.intent !== "attach-material",
      ),
    ).toBe(true);
  });

  it("устаревший предпросмотр не даёт правки", async () => {
    const h = setup();
    const confirm = await openConfirmation(h);
    await h.bot.handleUpdate(
      callbackUpdate(confirm, {
        text: "Подтверждение",
        reply_to_message: {
          message_id: 5,
          date: 100,
          from: { id: botInfo.id, is_bot: true, first_name: "stub" },
          text: "Другой текст",
        },
      }),
    );
    expect(editCalls(h.calls)).toHaveLength(0);
    expect(
      h.records.some(
        (record) => record.message === "material text edit preview stale",
      ),
    ).toBe(true);
  });

  it("ссылка на чужой чат не даёт правки", async () => {
    const h = setup({
      initial: meetupOf({
        materials: [
          {
            id: materialId,
            title: "Чужая ссылка",
            source: { kind: "message-link", url: "https://t.me/c/999/1" },
          },
        ],
      }),
    });
    await h.bot.handleUpdate(
      callbackUpdate(`v1:mm:et:${h.token}:${h.materialToken}`),
    );
    expect(editCalls(h.calls)).toHaveLength(0);
    expect(
      h.records.some(
        (record) => record.message === "material text edit foreign link",
      ),
    ).toBe(true);
  });
});
