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
import type { AnnouncementPostRecord } from "./announcement-posts-kv.js";
import type { CommunityChat } from "./community-chat.js";
import { announcementMaterialId } from "./meetup-announcement.js";
import { uuidToToken } from "./meetup-deep-link.js";
import {
  announceMeetupData,
  announcementLinkData,
  announcementResendConfirmData,
  announcementResendData,
} from "./parse-callback.js";

// Анонс сходки (PER-925): сценарии на харнесс без Telegram. Проверяют вход по
// кругу прав и состоянию сходки, пост с подписью и кнопкой, материал
// `message-link`, защиту от повтора и сведение после сбоя между шагами.

const resolvedId = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd";
const communityChatId = -1001234567890;
const memberRights: readonly AccessRight[] = [
  "access-hub",
  "place-bids",
  "organize-meetups",
];
const body = "Сходка в пятницу!";

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
    materials: [],
    ...overrides,
  };
}

type SetupOptions = {
  rights?: readonly AccessRight[];
  withChat?: boolean;
  chatId?: number;
  initial?: MeetupSnapshot;
  failAttach?: boolean | "once";
  respond?: (method: string, payload: unknown) => unknown;
  registryUnavailable?: boolean;
};

function setup(options: SetupOptions = {}) {
  const rights = options.rights ?? memberRights;
  const provenance: AnnouncementPostRecord[] = [];
  let meetup = options.initial ?? meetupOf();
  let viewFails = false;
  const attached: string[] = [];
  const attachRequests: ExecuteRequest[] = [];
  const execute = vi.fn(
    async (request: ExecuteRequest): Promise<ExecuteResult> => {
      if (request.intent === "view-meetup") {
        return viewFails
          ? { kind: "dependency-rejected", reason: "unavailable" }
          : { kind: "meetup-card", meetup };
      }
      if (request.intent === "attach-material") {
        attachRequests.push(request);
        if (
          options.failAttach === true ||
          (options.failAttach === "once" && attachRequests.length === 1)
        ) {
          return { kind: "dependency-rejected", reason: "unavailable" };
        }
        attached.push(request.material.id);
        meetup = {
          ...meetup,
          materials: [...meetup.materials, request.material],
        };
        return { kind: "material-attached", meetup };
      }
      return { kind: "meetup-not-found" };
    },
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
      announcementPostsRegistry: {
        async remember(record) {
          if (options.registryUnavailable === true) {
            return { kind: "unavailable", cause: "kv down" };
          }
          if (provenance.length > 0) return { kind: "exists" };
          provenance.push(record);
          return { kind: "stored" };
        },
        async read(chatId, messageId) {
          const record = provenance.find(
            (each) => each.chatId === chatId && each.messageId === messageId,
          );
          return record === undefined
            ? { kind: "missing" }
            : { kind: "found", record };
        },
        async close() {},
      },
      ...(options.respond === undefined ? {} : { respond: options.respond }),
    },
  );
  return {
    ...harness,
    attached,
    attachRequests,
    provenance,
    meetup: () => meetup,
    setVersion: (version: number) => {
      meetup = { ...meetup, version };
    },
    setViewFails: (fails: boolean) => {
      viewFails = fails;
    },
    token: uuidToToken(meetup.id),
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
      from: { id: 42, is_bot: false, first_name: "tester" },
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

function callbackUpdateAs(
  data: string,
  firstName: string,
  message: Record<string, unknown> = {},
): Update {
  const update = callbackUpdate(data, message) as {
    callback_query: { from: { first_name: string } };
  };
  update.callback_query.from.first_name = firstName;
  return update as Update;
}

function replyUpdate(text: string, replyMessageId: number): Update {
  return {
    update_id: 3,
    message: {
      message_id: 10,
      date: 0,
      chat: { id: 42, type: "private", first_name: "tester" },
      from: { id: 42, is_bot: false, first_name: "Организатор" },
      text,
      reply_to_message: {
        message_id: replyMessageId,
        date: 0,
        chat: { id: 42, type: "private", first_name: "tester" },
        from: { id: botInfo.id, is_bot: true, first_name: "stub" },
        text: "Текст анонса",
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

function findLastData(
  calls: readonly RecordedCall[],
  prefix: string,
): { data: string; messageId: number } | undefined {
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const call = calls[index] as RecordedCall;
    const payload = call.payload as {
      reply_markup?: { inline_keyboard?: { callback_data?: string }[][] };
    };
    const rows = payload.reply_markup?.inline_keyboard;
    for (const button of rows?.flat() ?? []) {
      if (button.callback_data?.startsWith(prefix) === true) {
        // Харнесс отвечает на sendMessage номером 100 + номер вызова.
        return { data: button.callback_data, messageId: 101 + index };
      }
    }
  }
  return undefined;
}

function findCancelWithKey(calls: readonly RecordedCall[]): string {
  for (const call of calls) {
    const rows = (
      call.payload as {
        reply_markup?: { inline_keyboard?: { callback_data?: string }[][] };
      }
    ).reply_markup?.inline_keyboard;
    for (const button of rows?.flat() ?? []) {
      const data = button.callback_data;
      if (
        data?.startsWith("v1:ma:no:") === true &&
        data.split(":").length === 5
      ) {
        return data;
      }
    }
  }
  throw new Error("cancel with key not found");
}

function lastQuestionId(calls: readonly RecordedCall[]): number {
  const index = calls.findLastIndex((call) => call.method === "sendMessage");
  return 100 + index + 1;
}

async function openConfirmation(harness: ReturnType<typeof setup>) {
  await harness.bot.handleUpdate(
    callbackUpdate(announceMeetupData(harness.token)),
  );
  const questionId = lastQuestionId(harness.calls);
  await harness.bot.handleUpdate(replyUpdate(body, questionId));
  return findData(harness.calls, "v1:ma:cf:");
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

describe("анонс сходки в чате сообщества", () => {
  it("вход на карточке есть только у того, кто правит материалы, и только у опубликованной неотменённой сходки", async () => {
    const hasEntry = (calls: readonly RecordedCall[]): boolean =>
      calls.some((call) => JSON.stringify(call.payload).includes("v1:ma:an:"));
    const allowed = setup();
    await allowed.bot.handleUpdate(callbackUpdate(`v1:view:${allowed.token}`));
    expect(hasEntry(allowed.calls)).toBe(true);

    for (const variant of [
      { rights: [] },
      { initial: meetupOf({ visibility: "hidden" }) },
      { initial: meetupOf({ lifecycle: "cancelled" }) },
      { withChat: false },
    ]) {
      const h = setup(variant);
      await h.bot.handleUpdate(callbackUpdate(`v1:view:${h.token}`));
      expect(hasEntry(h.calls)).toBe(false);
    }
  });

  it("пост уходит от бота с подписью и кнопкой в бот, материал ведёт на него", async () => {
    const h = setup();
    const confirm = await openConfirmation(h);
    await h.bot.handleUpdate(callbackUpdate(confirm, previewMessage()));

    const post = h.calls.find(
      (call) =>
        call.method === "sendMessage" &&
        (call.payload as { chat_id?: number }).chat_id === communityChatId,
    );
    expect(post).toBeDefined();
    const payload = post?.payload as {
      text?: string;
      reply_markup?: { inline_keyboard: { text: string; url?: string }[][] };
    };
    expect(payload.text).toContain("tester");
    expect(payload.text).toContain(body);
    expect(payload.reply_markup?.inline_keyboard.flat()[0]?.url).toContain(
      "?start=m_",
    );
    expect(h.attachRequests).toHaveLength(1);
    const request = h.attachRequests[0];
    if (request?.intent !== "attach-material")
      throw new Error("no attach request");
    expect(request.material.source).toEqual({
      kind: "message-link",
      url: expect.stringMatching(/^https:\/\/t\.me\/c\/1234567890\/[1-9]\d*$/),
    });
    expect(request.material.id).toBe(
      announcementMaterialId(h.meetup().id, confirm.split(":")[5] ?? ""),
    );
  });

  it("двойное нажатие, повтор после таймаута и повторная доставка update не дают второго поста и материала", async () => {
    const h = setup();
    const confirm = await openConfirmation(h);
    const update = callbackUpdate(confirm, previewMessage());
    await h.bot.handleUpdate(update);
    await h.bot.handleUpdate(update);
    await h.bot.handleUpdate({ ...update, update_id: 99 });

    const posts = h.calls.filter(
      (call) =>
        call.method === "sendMessage" &&
        (call.payload as { chat_id?: number }).chat_id === communityChatId,
    );
    expect(posts).toHaveLength(1);
    expect(h.attached).toHaveLength(1);
  });

  it("подделанная кнопка без чата сообщества ничего не публикует", async () => {
    const h = setup({ withChat: false });
    await h.bot.handleUpdate(callbackUpdate(announceMeetupData(h.token)));
    expect(h.attached).toHaveLength(0);
    expect(
      h.calls.some(
        (call) =>
          (call.payload as { chat_id?: number }).chat_id === communityChatId,
      ),
    ).toBe(false);
  });

  it("отказ Telegram по правам чата даёт отказ и не прикрепляет материал", async () => {
    const refusal = new GrammyError(
      "Bad Request: not enough rights to send text messages to the chat",
      {
        ok: false,
        error_code: 400,
        description: "not enough rights to send text messages to the chat",
      },
      "sendMessage",
      {},
    );
    const h = setup({
      respond: (method, payload) => {
        if (
          method === "sendMessage" &&
          (payload as { chat_id?: number }).chat_id === communityChatId
        ) {
          throw refusal;
        }
        return undefined;
      },
    });
    const confirm = await openConfirmation(h);
    await h.bot.handleUpdate(callbackUpdate(confirm, previewMessage()));
    expect(h.attachRequests).toHaveLength(0);
    expect(
      h.records.some(
        (record) => record.message === "meetup announcement denied by telegram",
      ),
    ).toBe(true);
  });

  it("сбой записи материала сводится нажатием на кнопку кадра повтора без второго поста", async () => {
    const h = setup({ failAttach: "once" });
    const confirm = await openConfirmation(h);
    await h.bot.handleUpdate(callbackUpdate(confirm, previewMessage()));
    expect(h.attached).toHaveLength(0);
    expect(h.attachRequests).toHaveLength(1);
    // Берём кнопку именно из выданного кадра повтора, а не исходный update.
    const retry = findLastData(h.calls, "v1:ma:cf:");
    expect(retry).toBeDefined();
    await h.bot.handleUpdate(
      callbackUpdate(retry?.data ?? "", { message_id: retry?.messageId ?? 9 }),
    );
    const posts = h.calls.filter(
      (call) =>
        call.method === "sendMessage" &&
        (call.payload as { chat_id?: number }).chat_id === communityChatId,
    );
    expect(posts).toHaveLength(1);
    expect(h.attached).toHaveLength(1);
    expect(h.attachRequests).toHaveLength(2);
  });

  it("повтор с новым сообщением без предпросмотра находит номер поста по ключу", async () => {
    const h = setup({
      failAttach: "once",
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
    const retry = findLastData(h.calls, "v1:ma:cf:");
    expect(retry).toBeDefined();
    // В сообщении кнопки нет reply_to_message: исходный предпросмотр недоступен.
    await h.bot.handleUpdate(
      callbackUpdate(retry?.data ?? "", { message_id: retry?.messageId ?? 9 }),
    );
    expect(h.attached).toHaveLength(1);
    expect(
      h.calls.filter(
        (call) =>
          call.method === "sendMessage" &&
          (call.payload as { chat_id?: number }).chat_id === communityChatId,
      ),
    ).toHaveLength(1);
  });

  it("название сходки экранируется в вопросе с разметкой HTML", async () => {
    const h = setup({
      initial: meetupOf({ title: "Настолки <b> & друзья" }),
    });
    await h.bot.handleUpdate(callbackUpdate(announceMeetupData(h.token)));
    const question = h.calls
      .filter((call) => call.method === "sendMessage")
      .map((call) => String((call.payload as { text?: string }).text ?? ""))
      .find((text) => text.includes("Напиши текст анонса"));
    expect(question).toContain("Настолки &lt;b&gt; &amp; друзья");
  });

  it("участник без права править материалы не видит входа и не публикует по подделанной кнопке", async () => {
    const h = setup({ rights: ["access-hub", "place-bids"] });
    await h.bot.handleUpdate(callbackUpdate(`v1:view:${h.token}`));
    expect(
      h.calls.some((call) =>
        JSON.stringify(call.payload).includes("v1:ma:an:"),
      ),
    ).toBe(false);
    await h.bot.handleUpdate(callbackUpdate(announceMeetupData(h.token)));
    expect(h.attachRequests).toHaveLength(0);
    expect(
      h.calls.some(
        (call) =>
          (call.payload as { chat_id?: number }).chat_id === communityChatId,
      ),
    ).toBe(false);
  });

  it("простая группа не даёт входа: ссылки на пост там нет", async () => {
    const h = setup({ chatId: -12345 });
    await h.bot.handleUpdate(callbackUpdate(`v1:view:${h.token}`));
    expect(
      h.calls.some((call) =>
        JSON.stringify(call.payload).includes("v1:ma:an:"),
      ),
    ).toBe(false);
    await h.bot.handleUpdate(callbackUpdate(announceMeetupData(h.token)));
    expect(h.attachRequests).toHaveLength(0);
  });

  it("предпросмотр с чужим отпечатком не публикует", async () => {
    const h = setup();
    const confirm = await openConfirmation(h);
    await h.bot.handleUpdate(
      callbackUpdate(confirm, {
        reply_to_message: {
          message_id: 5,
          date: 100,
          from: { id: botInfo.id, is_bot: true, first_name: "stub" },
          text: "Другой текст",
        },
      }),
    );
    expect(h.attachRequests).toHaveLength(0);
    expect(
      h.calls.some((call) =>
        String((call.payload as { text?: string }).text ?? "").includes(
          "предпросмотр устарел",
        ),
      ),
    ).toBe(true);
  });

  it("слишком длинный анонс отвергается до поста", async () => {
    const h = setup();
    await h.bot.handleUpdate(callbackUpdate(announceMeetupData(h.token)));
    const questionId = lastQuestionId(h.calls);
    await h.bot.handleUpdate(replyUpdate("x".repeat(4096), questionId));
    await h.bot.handleUpdate(callbackUpdate(announceMeetupData(h.token)));
    expect(() => findData(h.calls, "v1:ma:cf:")).toThrow();
    expect(
      h.calls.some((call) =>
        String((call.payload as { text?: string }).text ?? "").includes(
          "не помещается в сообщение Telegram",
        ),
      ),
    ).toBe(true);
  });

  it("конфликт версии после поста дозаписывает материал, а не публикует второй пост", async () => {
    const h = setup({ failAttach: "once" });
    const confirm = await openConfirmation(h);
    const update = callbackUpdate(confirm, previewMessage());
    await h.bot.handleUpdate(update);
    expect(
      h.attachRequests[0]?.intent === "attach-material" &&
        h.attachRequests[0].expectedVersion,
    ).toBe(1);
    h.setVersion(2);
    await h.bot.handleUpdate({ ...update, update_id: 100 });
    expect(
      h.attachRequests[1]?.intent === "attach-material" &&
        h.attachRequests[1].expectedVersion,
    ).toBe(2);
    expect(
      h.calls.filter(
        (call) =>
          call.method === "sendMessage" &&
          (call.payload as { chat_id?: number }).chat_id === communityChatId,
      ),
    ).toHaveLength(1);
    expect(h.attached).toHaveLength(1);
  });

  it("«Нет» после сбоя записи материала не утверждает, что пост не ушёл", async () => {
    const h = setup({ failAttach: true });
    const confirm = await openConfirmation(h);
    await h.bot.handleUpdate(callbackUpdate(confirm, previewMessage()));
    const cancel = findCancelWithKey(h.calls);
    await h.bot.handleUpdate(callbackUpdate(cancel));
    expect(
      h.calls.some((call) =>
        String((call.payload as { text?: string }).text ?? "").includes(
          "Пост уже опубликован",
        ),
      ),
    ).toBe(true);
    expect(
      h.calls.some((call) =>
        String((call.payload as { text?: string }).text ?? "").includes(
          "никуда не ушёл",
        ),
      ),
    ).toBe(false);
  });

  it("сбой привязки по ссылке возвращает кадр проверки чата, а не ложный повтор привязки", async () => {
    const h = setup({ ...networkLoss(), failAttach: true });
    const confirm = await openConfirmation(h);
    await h.bot.handleUpdate(callbackUpdate(confirm, previewMessage()));
    const linkButton = findLastData(h.calls, "v1:ma:lk:");
    await h.bot.handleUpdate(callbackUpdate(linkButton?.data ?? ""));
    await h.bot.handleUpdate(
      replyUpdate("https://t.me/c/1234567890/42", lastQuestionId(h.calls)),
    );
    expect(
      h.calls.some((call) =>
        String((call.payload as { text?: string }).text ?? "").includes(
          "Проверь чат сообщества",
        ),
      ),
    ).toBe(true);
    expect(
      h.calls.some((call) =>
        String((call.payload as { text?: string }).text ?? "").includes(
          "Повтори нажатие — материал запишется",
        ),
      ),
    ).toBe(false);
  });

  it("отказ чтения сходки при явной повторной отправке сохраняет неопределённость", async () => {
    const h = setup(networkLoss());
    const confirm = await openConfirmation(h);
    await h.bot.handleUpdate(callbackUpdate(confirm, previewMessage()));
    const resendButton = findLastData(h.calls, "v1:ma:rs:");
    await h.bot.handleUpdate(callbackUpdate(resendButton?.data ?? ""));
    const confirmResend = findLastData(h.calls, "v1:ma:rr:");
    h.setViewFails(true);
    await h.bot.handleUpdate(callbackUpdate(confirmResend?.data ?? ""));
    expect(communityPosts(h.calls)).toBe(1);
    expect(
      h.calls.some((call) =>
        String((call.payload as { text?: string }).text ?? "").includes(
          "Проверь чат сообщества",
        ),
      ),
    ).toBe(true);
  });

  function networkLoss(options: SetupOptions = {}): SetupOptions {
    return {
      ...options,
      respond: (method, payload) => {
        if (
          method === "sendMessage" &&
          (payload as { chat_id?: number }).chat_id === communityChatId
        ) {
          throw new Error("network lost after send");
        }
        return options.respond?.(method, payload);
      },
    };
  }

  function communityPosts(calls: readonly RecordedCall[]): number {
    return calls.filter(
      (call) =>
        call.method === "sendMessage" &&
        (call.payload as { chat_id?: number }).chat_id === communityChatId,
    ).length;
  }

  it("неизвестный исход отправки не публикует второй пост по той же кнопке", async () => {
    const h = setup(networkLoss());
    const confirm = await openConfirmation(h);
    await h.bot.handleUpdate(callbackUpdate(confirm, previewMessage()));
    expect(communityPosts(h.calls)).toBe(1);
    expect(h.attachRequests).toHaveLength(0);
    expect(
      h.calls.some((call) =>
        String((call.payload as { text?: string }).text ?? "").includes(
          "Проверь чат сообщества",
        ),
      ),
    ).toBe(true);
    await h.bot.handleUpdate(callbackUpdate(confirm, previewMessage()));
    await h.bot.handleUpdate({
      ...callbackUpdate(confirm, previewMessage()),
      update_id: 200,
    });
    expect(communityPosts(h.calls)).toBe(1);
  });

  it("пост прикрепляется по ссылке с проверкой источника без новой публикации", async () => {
    const h = setup(networkLoss());
    const confirm = await openConfirmation(h);
    await h.bot.handleUpdate(callbackUpdate(confirm, previewMessage()));
    const key = confirm.split(":")[5] ?? "";
    const linkButton = findLastData(h.calls, "v1:ma:lk:");
    expect(linkButton?.data).toBe(announcementLinkData(h.token, key));
    await h.bot.handleUpdate(callbackUpdate(linkButton?.data ?? ""));
    const questionId = lastQuestionId(h.calls);
    await h.bot.handleUpdate(
      replyUpdate("https://t.me/c/1234567890/42", questionId),
    );
    expect(h.attachRequests).toHaveLength(1);
    expect(
      h.attachRequests[0]?.intent === "attach-material" &&
        h.attachRequests[0].material.source,
    ).toEqual({
      kind: "message-link",
      url: "https://t.me/c/1234567890/42",
    });
    expect(communityPosts(h.calls)).toBe(1);
    expect(h.attached).toHaveLength(1);
  });

  it("ссылка из другого чата не прикрепляется", async () => {
    const h = setup(networkLoss());
    const confirm = await openConfirmation(h);
    await h.bot.handleUpdate(callbackUpdate(confirm, previewMessage()));
    const linkButton = findLastData(h.calls, "v1:ma:lk:");
    await h.bot.handleUpdate(callbackUpdate(linkButton?.data ?? ""));
    await h.bot.handleUpdate(
      replyUpdate("https://t.me/c/999/42", lastQuestionId(h.calls)),
    );
    expect(h.attachRequests).toHaveLength(0);
  });

  it("новая отправка идёт только после явного подтверждения и не повторяется двойным нажатием", async () => {
    const h = setup(networkLoss());
    const confirm = await openConfirmation(h);
    await h.bot.handleUpdate(callbackUpdate(confirm, previewMessage()));
    const key = confirm.split(":")[5] ?? "";
    const resendButton = findLastData(h.calls, "v1:ma:rs:");
    expect(resendButton?.data).toBe(announcementResendData(h.token, key));
    await h.bot.handleUpdate(callbackUpdate(resendButton?.data ?? ""));
    expect(communityPosts(h.calls)).toBe(1);
    const confirmResend = findLastData(h.calls, "v1:ma:rr:");
    expect(confirmResend?.data).toBe(
      announcementResendConfirmData(
        h.token,
        key,
        confirmResend?.data.split(":")[5] ?? "",
      ),
    );
    await h.bot.handleUpdate(callbackUpdate(confirmResend?.data ?? ""));
    expect(communityPosts(h.calls)).toBe(2);
    await h.bot.handleUpdate(callbackUpdate(confirmResend?.data ?? ""));
    expect(communityPosts(h.calls)).toBe(2);
  });

  it("отмена при неизвестном исходе не утверждает, что публикации не было", async () => {
    const h = setup(networkLoss());
    const confirm = await openConfirmation(h);
    await h.bot.handleUpdate(callbackUpdate(confirm, previewMessage()));
    const cancel = findCancelWithKey(h.calls);
    await h.bot.handleUpdate(callbackUpdate(cancel));
    expect(
      h.calls.some((call) =>
        String((call.payload as { text?: string }).text ?? "").includes(
          "пост мог быть опубликован",
        ),
      ),
    ).toBe(true);
    expect(
      h.calls.some((call) =>
        String((call.payload as { text?: string }).text ?? "").includes(
          "никуда не ушёл",
        ),
      ),
    ).toBe(false);
  });

  it("records provenance at send time, before the material is attached", async () => {
    const h = setup({ failAttach: "once" });
    const confirm = await openConfirmation(h);
    await h.bot.handleUpdate(callbackUpdate(confirm, previewMessage()));
    // После первой отправки пост уже в чате, хотя материал не записался.
    expect(h.provenance).toHaveLength(1);
    expect(h.provenance[0]).toMatchObject({
      chatId: communityChatId,
      signature: "tester",
    });
    expect(h.provenance[0]?.messageId).toBeGreaterThan(0);
    expect(h.provenance[0]?.keyboard.url).toContain("?start=m_");
  });

  it("keeps the original signature when another organizer retries the attach", async () => {
    const h = setup({ failAttach: "once" });
    const confirm = await openConfirmation(h);
    await h.bot.handleUpdate(callbackUpdate(confirm, previewMessage()));
    const original = h.provenance[0];
    expect(original).toBeDefined();

    const retry = findLastData(h.calls, "v1:ma:cf:");
    expect(retry).toBeDefined();
    await h.bot.handleUpdate(
      callbackUpdateAs(retry?.data ?? "", "Борис", {
        message_id: retry?.messageId ?? 9,
      }),
    );
    expect(h.attached).toHaveLength(1);
    expect(h.provenance).toHaveLength(1);
    expect(h.provenance[0]?.signature).toBe(original?.signature);
    expect(h.provenance[0]?.keyboard).toEqual(original?.keyboard);
  });

  it("says honestly when provenance could not be saved", async () => {
    const h = setup({ registryUnavailable: true });
    const confirm = await openConfirmation(h);
    await h.bot.handleUpdate(callbackUpdate(confirm, previewMessage()));
    expect(h.provenance).toHaveLength(0);
    expect(
      h.calls.some((call) =>
        JSON.stringify(call.payload).includes(
          "данные для правки не сохранились",
        ),
      ),
    ).toBe(true);
  });
});
