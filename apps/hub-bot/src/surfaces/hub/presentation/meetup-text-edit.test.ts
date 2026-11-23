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
import type { AnnouncementPostRegistry } from "./announcement-posts-kv.js";
import type { CommunityChat } from "./community-chat.js";
import { uuidToToken } from "./meetup-deep-link.js";

// Правка текста поста (PER-926, решение владельца 2026-11-23): происхождение
// поста берётся только из постоянного реестра. Харнесс без Telegram проверяет
// подпись и кнопку, право в момент правки, две сходки, рестарт, старые ссылки,
// отказы KV и Bot API.

const resolvedId = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd";
const communityChatId = -1001234567890;
const postId = 28;
const postLink = `https://t.me/c/1234567890/${postId}`;
const materialId = "0199c0de-0000-7000-8000-000000000001";
const body = "Новый текст анонса";
const recordedSignature = "Анна";
const editorName = "Борис";
const recordedKeyboard = {
  text: "Открыть сходку ↗",
  url: "https://t.me/test_bot?start=m_original",
};

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

type RegistryMode = "ok" | "unavailable" | "missing";

function createRegistry(
  options: { meetupId?: string; signature?: string; mode?: RegistryMode } = {},
): AnnouncementPostRegistry {
  const mode = options.mode ?? "ok";
  const record = {
    chatId: communityChatId,
    messageId: postId,
    meetupId: options.meetupId ?? meetupOf().id,
    signature: options.signature ?? recordedSignature,
    keyboard: recordedKeyboard,
  };
  return {
    async remember() {
      return { kind: "stored" };
    },
    async read(chatId, messageId) {
      if (mode === "unavailable") {
        return { kind: "unavailable", cause: "kv down" };
      }
      if (mode === "missing") return { kind: "missing" };
      if (chatId !== communityChatId || messageId !== postId) {
        return { kind: "missing" };
      }
      return { kind: "found", record };
    },
    async close() {},
  };
}

type SetupOptions = {
  rights?: readonly AccessRight[];
  withChat?: boolean;
  initial?: MeetupSnapshot;
  respond?: (method: string, payload: unknown) => unknown;
  registry?: AnnouncementPostRegistry;
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
    chatId: communityChatId,
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
      announcementPostsRegistry: options.registry ?? createRegistry(),
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
      from: { id: 42, is_bot: false, first_name: editorName },
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
      from: { id: 42, is_bot: false, first_name: editorName },
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

function previewMessage(text = body): Record<string, unknown> {
  return {
    text: "Подтверждение",
    reply_to_message: {
      message_id: 5,
      date: 100,
      from: { id: botInfo.id, is_bot: true, first_name: "stub" },
      text,
    },
  };
}

function editCalls(calls: readonly RecordedCall[]): RecordedCall[] {
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

function telegramError(description: string): GrammyError {
  return new GrammyError(
    `Bad Request: ${description}`,
    { ok: false, error_code: 400, description },
    "editMessageText",
    {},
  );
}

describe("meetup announcement text edit (PER-926)", () => {
  it("uses the recorded signature and keyboard, not the editor's name or current meetup", async () => {
    const h = setup();
    const confirm = await openConfirmation(h);
    await h.bot.handleUpdate(callbackUpdate(confirm, previewMessage()));

    const edits = editCalls(h.calls);
    expect(edits).toHaveLength(1);
    expect(edits[0]?.payload).toMatchObject({
      chat_id: communityChatId,
      message_id: postId,
      text: `<b>${recordedSignature}:</b>\n\n${body}`,
      parse_mode: "HTML",
    });
    const editPayload = edits[0]?.payload;
    expect(editPayload).toBeDefined();
    const markup = (
      editPayload as {
        reply_markup?: {
          inline_keyboard: { text: string; url?: string }[][];
        };
      }
    ).reply_markup;
    expect(markup?.inline_keyboard.flat()[0]).toEqual(recordedKeyboard);
    expect(
      h.execute.mock.calls.every(
        ([request]) =>
          request.intent !== "attach-material" &&
          request.intent !== "remove-material",
      ),
    ).toBe(true);
  });

  it("rechecks rights on confirmation so a former organizer cannot edit", async () => {
    const h = setup();
    const confirm = await openConfirmation(h);
    h.execute.mockImplementation(async () => ({
      kind: "meetup-card",
      meetup: meetupOf({ organizers: [] }),
    }));
    await h.bot.handleUpdate(callbackUpdate(confirm, previewMessage()));
    expect(editCalls(h.calls)).toHaveLength(0);
    expect(
      h.records.some((r) => r.message === "material text edit rejected"),
    ).toBe(true);
  });

  it("forged button without rights neither asks a question nor edits the post", async () => {
    const h = setup({ rights: ["access-hub"] });
    await h.bot.handleUpdate(
      callbackUpdate(`v1:mm:et:${h.token}:${h.materialToken}`),
    );
    expect(editCalls(h.calls)).toHaveLength(0);
    expect(
      h.records.some((r) => r.message === "material text edit rejected"),
    ).toBe(true);
  });

  it("allows editing for a cancelled meetup", async () => {
    const h = setup({ initial: meetupOf({ lifecycle: "cancelled" }) });
    const confirm = await openConfirmation(h);
    await h.bot.handleUpdate(callbackUpdate(confirm, previewMessage()));
    expect(editCalls(h.calls)).toHaveLength(1);
  });

  it("explains a Telegram refusal on a foreign post and keeps the material", async () => {
    const h = setup({
      respond: (method) =>
        method === "editMessageText"
          ? telegramError("message can't be edited")
          : undefined,
    });
    const confirm = await openConfirmation(h);
    await h.bot.handleUpdate(callbackUpdate(confirm, previewMessage()));
    expect(
      h.records.some(
        (r) => r.message === "material text edit denied by telegram",
      ),
    ).toBe(true);
    expect(
      h.calls.some((call) =>
        JSON.stringify(call.payload).includes("не принадлежит боту"),
      ),
    ).toBe(true);
  });

  it("gives a neutral refusal when the post was not found", async () => {
    const h = setup({
      respond: (method) =>
        method === "editMessageText"
          ? telegramError("message to edit not found")
          : undefined,
    });
    const confirm = await openConfirmation(h);
    await h.bot.handleUpdate(callbackUpdate(confirm, previewMessage()));
    expect(
      h.records.some((r) => r.message === "material text edit post not found"),
    ).toBe(true);
    expect(
      h.calls.some((call) =>
        JSON.stringify(call.payload).includes("Не удалось найти сообщение"),
      ),
    ).toBe(true);
    expect(
      h.calls.some((call) =>
        JSON.stringify(call.payload).includes("не принадлежит боту"),
      ),
    ).toBe(false);
  });

  it("stale preview cannot edit the post", async () => {
    const h = setup();
    const confirm = await openConfirmation(h);
    await h.bot.handleUpdate(callbackUpdate(confirm, previewMessage("other")));
    expect(editCalls(h.calls)).toHaveLength(0);
    expect(
      h.records.some((r) => r.message === "material text edit preview stale"),
    ).toBe(true);
  });

  it("a link to a foreign chat cannot edit the post", async () => {
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
      h.records.some((r) => r.message === "material text edit foreign link"),
    ).toBe(true);
  });

  it("treats 'message is not modified' as success, not a retry loop", async () => {
    const h = setup({
      respond: (method) =>
        method === "editMessageText"
          ? telegramError("message is not modified")
          : undefined,
    });
    const confirm = await openConfirmation(h);
    await h.bot.handleUpdate(callbackUpdate(confirm, previewMessage()));
    expect(
      h.records.some((r) => r.message === "material text edit unchanged"),
    ).toBe(true);
  });

  it("refuses a non-text post without offering an endless retry", async () => {
    const h = setup({
      respond: (method) =>
        method === "editMessageText"
          ? telegramError("there is no text in the message to edit")
          : undefined,
    });
    const confirm = await openConfirmation(h);
    await h.bot.handleUpdate(callbackUpdate(confirm, previewMessage()));
    expect(
      h.records.some((r) => r.message === "material text edit non-text post"),
    ).toBe(true);
  });

  it("refuses an old material with no registry record", async () => {
    const h = setup({ registry: createRegistry({ mode: "missing" }) });
    await h.bot.handleUpdate(
      callbackUpdate(`v1:mm:et:${h.token}:${h.materialToken}`),
    );
    expect(editCalls(h.calls)).toHaveLength(0);
    expect(
      h.records.some(
        (r) => r.message === "material text edit unknown provenance",
      ),
    ).toBe(true);
    expect(
      h.calls.some((call) =>
        JSON.stringify(call.payload).includes("не значится анонсом"),
      ),
    ).toBe(true);
  });

  it("refuses when the registry is unavailable", async () => {
    const h = setup({ registry: createRegistry({ mode: "unavailable" }) });
    await h.bot.handleUpdate(
      callbackUpdate(`v1:mm:et:${h.token}:${h.materialToken}`),
    );
    expect(editCalls(h.calls)).toHaveLength(0);
    expect(
      h.records.some(
        (r) => r.message === "material text edit registry unavailable",
      ),
    ).toBe(true);
  });

  it("refuses a post belonging to another meetup with another organizer", async () => {
    const h = setup({
      registry: createRegistry({
        meetupId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cf",
      }),
    });
    await h.bot.handleUpdate(
      callbackUpdate(`v1:mm:et:${h.token}:${h.materialToken}`),
    );
    expect(editCalls(h.calls)).toHaveLength(0);
    expect(
      h.records.some((r) => r.message === "material text edit meetup mismatch"),
    ).toBe(true);
  });

  it("recovers after a process restart sharing only the registry and chat history", async () => {
    const registry = createRegistry();
    const first = setup({ registry });
    const confirm = await openConfirmation(first);
    const calls = [...first.calls];
    const second = createHarness(
      {
        resolve: async () => ({
          kind: "resolved" as const,
          identityId: resolvedId,
          rights: memberRights,
          blocked: false,
        }),
      },
      { execute: first.execute },
      calls,
      noopTracing(),
      undefined,
      undefined,
      {
        communityChat: {
          chatId: communityChatId,
          registerCommands: async () => {},
          gate: async (_ctx, next) => next(),
        },
        announcementPostsRegistry: registry,
      },
    );
    await second.bot.handleUpdate(callbackUpdate(confirm, previewMessage()));
    expect(
      editCalls(calls).filter(
        (call) =>
          (call.payload as { chat_id?: number }).chat_id === communityChatId,
      ).length,
    ).toBeGreaterThan(0);
  });

  it("measures the length against the recorded signature, not the editor", async () => {
    const longSignature = "А".repeat(5000);
    const h = setup({ registry: createRegistry({ signature: longSignature }) });
    await h.bot.handleUpdate(
      callbackUpdate(`v1:mm:et:${h.token}:${h.materialToken}`),
    );
    const questionId = lastQuestionId(h.calls);
    await h.bot.handleUpdate(replyUpdate("ok", questionId));
    expect(
      h.calls.some((call) =>
        JSON.stringify(call.payload).includes("Ввести заново"),
      ),
    ).toBe(true);
    expect(
      h.calls.some((call) =>
        JSON.stringify(call.payload).includes("v1:mm:ee:"),
      ),
    ).toBe(false);
  });
});
