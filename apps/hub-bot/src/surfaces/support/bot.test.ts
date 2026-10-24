import { describe, expect, it } from "vitest";
import type { RecordedCall } from "../../../testkit/harness.js";
import {
  createMemoryKv,
  createSupportHarness,
  refusal,
  type SupportRespond,
  supportGroupId,
} from "../../../testkit/support.js";
import { createRateLimiter, messagesPerWindow } from "./rate-limit.js";
import {
  blockedText,
  notCopyableText,
  notDeliveredText,
  operatorRefusals,
  rateLimitText,
  welcomeText,
} from "./texts.js";

const anya = {
  id: 7001,
  is_bot: false,
  first_name: "Аня",
  username: "anya",
};

let updateId = 0;

function fromPerson(
  content: Record<string, unknown>,
  person: Record<string, unknown> = anya,
) {
  updateId += 1;
  return {
    update_id: updateId,
    message: {
      message_id: 500 + updateId,
      date: 0,
      chat: { id: person["id"], type: "private", first_name: "Аня" },
      from: person,
      ...content,
    },
  };
}

const operator = { id: 9001, is_bot: false, first_name: "Оператор" };

function inTopic(
  thread: number | undefined,
  content: Record<string, unknown>,
  sender: Record<string, unknown> = { from: operator },
  chatId: number = supportGroupId,
) {
  updateId += 1;
  return {
    update_id: updateId,
    message: {
      message_id: 900 + updateId,
      date: 0,
      chat: {
        id: chatId,
        type: "supergroup",
        title: "Операторы",
        is_forum: true,
      },
      ...(thread === undefined
        ? {}
        : { message_thread_id: thread, is_topic_message: true }),
      ...sender,
      ...content,
    },
  };
}

const methods = (calls: RecordedCall[]) => calls.map((call) => call.method);
const payloadOf = (calls: RecordedCall[], method: string) =>
  calls.find((call) => call.method === method)?.payload as
    | Record<string, unknown>
    | undefined;

const textOf = (call: RecordedCall | undefined) =>
  (call?.payload as { text?: string } | undefined)?.text ?? "";

// Ответ Telegram на первый вызов метода — отказ, дальше — по умолчанию.
function refuseOnce(method: string, answer: unknown): SupportRespond {
  let refused = false;
  return (called) => {
    if (called !== method || refused) return undefined;
    refused = true;
    return answer;
  };
}

describe("person relay", () => {
  it("greets /start without opening a topic", async () => {
    const { bot, calls } = createSupportHarness();
    await bot.handleUpdate(fromPerson({ text: "/start hub" }) as never);
    expect(methods(calls)).toEqual(["sendMessage"]);
    expect(calls[0]?.payload).toMatchObject({
      chat_id: anya.id,
      text: welcomeText,
      parse_mode: "HTML",
    });
  });

  it("opens a topic with a card on the first message and reuses it", async () => {
    const { bot, calls, kv } = createSupportHarness();
    await bot.handleUpdate(fromPerson({ text: "/start hub" }) as never);
    calls.length = 0;
    await bot.handleUpdate(
      fromPerson({ text: "Не приходит напоминание о сходке" }) as never,
    );
    expect(methods(calls)).toEqual([
      "createForumTopic",
      "sendMessage",
      "copyMessage",
      "setMessageReaction",
    ]);
    expect(calls[0]?.payload).toMatchObject({
      chat_id: supportGroupId,
      name: "Аня · @anya",
    });
    expect(calls[1]?.payload).toMatchObject({
      chat_id: supportGroupId,
      message_thread_id: 1,
      text: "Аня · @anya\nКруг: участник\nОткуда: бот хаба\n14 октября",
    });
    expect(calls[2]?.payload).toMatchObject({
      chat_id: supportGroupId,
      from_chat_id: anya.id,
      message_thread_id: 1,
    });
    expect(calls[3]?.payload).toMatchObject({
      chat_id: anya.id,
      reaction: [{ type: "emoji", emoji: "👌" }],
    });
    // Тема → человек пишется первой (ADR-068, п. 8).
    expect(kv.ops.slice(0, 2)).toEqual([
      `put topic.${supportGroupId}.1`,
      `put person.${supportGroupId}.${anya.id}`,
    ]);

    calls.length = 0;
    await bot.handleUpdate(fromPerson({ text: "И ещё вопрос" }) as never);
    expect(methods(calls)).toEqual(["copyMessage", "setMessageReaction"]);
    expect(calls[0]?.payload).toMatchObject({ message_thread_id: 1 });
  });

  it("writes an unknown source when /start carries no mark", async () => {
    const { bot, calls } = createSupportHarness();
    await bot.handleUpdate(fromPerson({ text: "/start" }) as never);
    await bot.handleUpdate(fromPerson({ text: "Привет" }) as never);
    expect(payloadOf(calls, "createForumTopic")).toMatchObject({
      name: "Аня · @anya",
    });
    const card = calls.filter((call) => call.method === "sendMessage")[1];
    expect(textOf(card)).toContain("Откуда: неизвестно");
  });

  it("names a topic without a username by the name alone", async () => {
    const { bot, calls } = createSupportHarness();
    const nameless = { id: 7002, is_bot: false, first_name: "Боря" };
    await bot.handleUpdate(fromPerson({ text: "Привет" }, nameless) as never);
    expect(payloadOf(calls, "createForumTopic")).toMatchObject({
      name: "Боря",
    });
  });

  it("reads the pair from KV after the bot is recreated", async () => {
    const kv = createMemoryKv();
    const first = createSupportHarness({ kv });
    await first.bot.handleUpdate(fromPerson({ text: "Привет" }) as never);
    const second = createSupportHarness({ kv, firstThread: 50 });
    await second.bot.handleUpdate(fromPerson({ text: "Снова я" }) as never);
    expect(methods(second.calls)).toEqual([
      "copyMessage",
      "setMessageReaction",
    ]);
    expect(second.calls[0]?.payload).toMatchObject({ message_thread_id: 1 });
  });

  it("ignores a pair of another group and opens a new topic", async () => {
    const kv = createMemoryKv();
    const old = createSupportHarness({ kv, groupId: -1009999999999 });
    await old.bot.handleUpdate(fromPerson({ text: "Привет" }) as never);
    const current = createSupportHarness({ kv, firstThread: 50 });
    await current.bot.handleUpdate(fromPerson({ text: "Снова я" }) as never);
    expect(methods(current.calls)[0]).toBe("createForumTopic");
    expect(payloadOf(current.calls, "copyMessage")).toMatchObject({
      chat_id: supportGroupId,
      message_thread_id: 51,
    });
  });

  it("reopens a closed topic and copies again", async () => {
    const kv = createMemoryKv();
    await createSupportHarness({ kv }).bot.handleUpdate(
      fromPerson({ text: "Привет" }) as never,
    );
    const { bot, calls } = createSupportHarness({
      kv,
      firstThread: 50,
      respond: refuseOnce(
        "copyMessage",
        refusal(400, "Bad Request: TOPIC_CLOSED"),
      ),
    });
    await bot.handleUpdate(fromPerson({ text: "Снова я" }) as never);
    expect(methods(calls)).toEqual([
      "copyMessage",
      "reopenForumTopic",
      "copyMessage",
      "setMessageReaction",
    ]);
    expect(calls[1]?.payload).toMatchObject({
      chat_id: supportGroupId,
      message_thread_id: 1,
    });
  });

  it("opens a new topic with a new card when the old one is deleted", async () => {
    const kv = createMemoryKv();
    await createSupportHarness({ kv }).bot.handleUpdate(
      fromPerson({ text: "Привет" }) as never,
    );
    const { bot, calls, pairs } = createSupportHarness({
      kv,
      firstThread: 50,
      respond: refuseOnce(
        "copyMessage",
        refusal(400, "Bad Request: message thread not found"),
      ),
    });
    await bot.handleUpdate(fromPerson({ text: "Снова я" }) as never);
    expect(methods(calls)).toEqual([
      "copyMessage",
      "createForumTopic",
      "sendMessage",
      "copyMessage",
      "setMessageReaction",
    ]);
    expect(calls[3]?.payload).toMatchObject({ message_thread_id: 51 });
    await expect(pairs.threadOf(anya.id)).resolves.toBe(51);
    await expect(pairs.personOf(1)).resolves.toBeUndefined();
    await expect(pairs.personOf(51)).resolves.toBe(anya.id);
  });

  it("answers a blocked person with the block frame and copies nothing", async () => {
    const { bot, calls } = createSupportHarness({
      standing: { resolve: async () => ({ blocked: true }) },
    });
    await bot.handleUpdate(fromPerson({ text: "Пустите" }) as never);
    expect(methods(calls)).toEqual(["sendMessage"]);
    expect(calls[0]?.payload).toMatchObject({
      chat_id: anya.id,
      text: blockedText,
      parse_mode: "HTML",
    });
  });

  it("copies with an unknown circle when Identity is down", async () => {
    const { bot, calls, records } = createSupportHarness({
      standing: {
        resolve: async () => {
          throw new Error("identity unavailable");
        },
      },
    });
    await bot.handleUpdate(fromPerson({ text: "Всё сломалось" }) as never);
    expect(methods(calls)).toEqual([
      "createForumTopic",
      "sendMessage",
      "copyMessage",
      "setMessageReaction",
    ]);
    expect(textOf(calls[1])).toContain("Круг: неизвестен");
    expect(records).toContainEqual(
      expect.objectContaining({
        level: "warn",
        fields: expect.objectContaining({
          error_category: "dependency_unavailable",
          operation: "resolve_identity",
        }),
      }),
    );
  });

  it("writes the circle of a guest and of someone not admitted", async () => {
    for (const [circle, word] of [
      ["guest", "гость"],
      ["none", "без доступа"],
    ] as const) {
      const { bot, calls } = createSupportHarness({
        standing: { resolve: async () => ({ blocked: false, circle }) },
      });
      await bot.handleUpdate(fromPerson({ text: "Привет" }) as never);
      expect(textOf(calls[1])).toContain(`Круг: ${word}`);
    }
  });

  it("answers over the rate limit once a window and copies nothing", async () => {
    let at = 0;
    const { bot, calls } = createSupportHarness({
      limiter: createRateLimiter(() => at),
    });
    for (let i = 0; i < messagesPerWindow; i += 1) {
      await bot.handleUpdate(fromPerson({ text: `№${i}` }) as never);
    }
    calls.length = 0;
    await bot.handleUpdate(fromPerson({ text: "ещё" }) as never);
    await bot.handleUpdate(fromPerson({ text: "и ещё" }) as never);
    expect(methods(calls)).toEqual(["sendMessage"]);
    expect(calls[0]?.payload).toMatchObject({
      text: rateLimitText,
      reply_parameters: expect.objectContaining({}),
    });
    at = 60_000;
    calls.length = 0;
    await bot.handleUpdate(fromPerson({ text: "через минуту" }) as never);
    expect(methods(calls)).toEqual(["copyMessage", "setMessageReaction"]);
  });

  it("replies not delivered when Telegram refuses the copy", async () => {
    const { bot, calls } = createSupportHarness({
      respond: (method) =>
        method === "copyMessage"
          ? refusal(500, "Internal Server Error")
          : undefined,
    });
    const update = fromPerson({ text: "Бот хаба не открывает карточку" });
    await bot.handleUpdate(update as never);
    const answer = calls.at(-1)?.payload;
    expect(answer).toMatchObject({
      chat_id: anya.id,
      text: notDeliveredText,
      reply_parameters: { message_id: update.message.message_id },
    });
    expect(methods(calls)).not.toContain("setMessageReaction");
  });

  it("replies not delivered and opens no topic when KV is down", async () => {
    const { bot, calls } = createSupportHarness({
      kv: createMemoryKv(() => true),
    });
    await bot.handleUpdate(fromPerson({ text: "Привет" }) as never);
    expect(methods(calls)).toEqual(["sendMessage"]);
    expect(calls[0]?.payload).toMatchObject({ text: notDeliveredText });
  });

  it("keeps the operator's answer when the second pair write fails", async () => {
    const kv = createMemoryKv(
      (op, key) => op === "put" && key.startsWith("person."),
    );
    const { bot, calls } = createSupportHarness({ kv });
    await bot.handleUpdate(fromPerson({ text: "Привет" }) as never);
    // Тема заведена, но пара не дописана: человек получит «не дошло», а
    // запись «тема → человек» уже на месте — ответ оператора дойдёт.
    expect(calls.at(-1)?.payload).toMatchObject({ text: notDeliveredText });
    expect(kv.values.get(`topic.${supportGroupId}.1`)).toBe(String(anya.id));
    calls.length = 0;
    await bot.handleUpdate(inTopic(1, { text: "Ответ" }) as never);
    expect(payloadOf(calls, "copyMessage")).toMatchObject({ chat_id: anya.id });
  });

  // Сбой записи пары не заводит человеку вторую тему: следующее сообщение
  // дописывает пару уже заведённой темы, и карточка в ней одна.
  it("opens one topic when the pair write fails on the first message", async () => {
    let failPerson = true;
    const kv = createMemoryKv(
      (op, key) => failPerson && op === "put" && key.startsWith("person."),
    );
    const { bot, calls, pairs } = createSupportHarness({ kv });
    await bot.handleUpdate(fromPerson({ text: "/start auction" }) as never);
    await bot.handleUpdate(fromPerson({ text: "Привет" }) as never);
    expect(calls.at(-1)?.payload).toMatchObject({ text: notDeliveredText });
    failPerson = false;
    calls.length = 0;
    await bot.handleUpdate(fromPerson({ text: "Ещё раз" }) as never);
    expect(methods(calls)).toEqual([
      "sendMessage",
      "copyMessage",
      "setMessageReaction",
    ]);
    // Карточка помнит метку первого сообщения: тема заведена им.
    expect(calls[0]?.payload).toMatchObject({
      chat_id: supportGroupId,
      message_thread_id: 1,
      text: "Аня · @anya\nКруг: участник\nОткуда: бот аукциона\n14 октября",
    });
    expect(calls[1]?.payload).toMatchObject({ message_thread_id: 1 });
    await expect(pairs.threadOf(anya.id)).resolves.toBe(1);
    await expect(pairs.personOf(1)).resolves.toBe(anya.id);
  });

  it("opens one topic when KV fails both writes on the first message", async () => {
    let failing = true;
    const kv = createMemoryKv((op) => failing && op === "put");
    const { bot, calls } = createSupportHarness({ kv });
    await bot.handleUpdate(fromPerson({ text: "Привет" }) as never);
    await bot.handleUpdate(fromPerson({ text: "Привет?" }) as never);
    failing = false;
    await bot.handleUpdate(fromPerson({ text: "Есть кто?" }) as never);
    expect(
      methods(calls).filter((method) => method === "createForumTopic"),
    ).toHaveLength(1);
    expect(payloadOf(calls.slice(-3), "copyMessage")).toMatchObject({
      message_thread_id: 1,
    });
  });

  it("opens a new topic when the unpaired one was deleted meanwhile", async () => {
    let failPerson = true;
    const kv = createMemoryKv(
      (op, key) => failPerson && op === "put" && key.startsWith("person."),
    );
    const { bot, calls, pairs } = createSupportHarness({
      kv,
      respond: (method, payload) =>
        method === "copyMessage" &&
        (payload as { message_thread_id?: number }).message_thread_id === 1
          ? refusal(400, "Bad Request: message thread not found")
          : undefined,
    });
    await bot.handleUpdate(fromPerson({ text: "Привет" }) as never);
    failPerson = false;
    calls.length = 0;
    await bot.handleUpdate(fromPerson({ text: "Ещё раз" }) as never);
    expect(methods(calls)).toEqual([
      "sendMessage",
      "copyMessage",
      "createForumTopic",
      "sendMessage",
      "copyMessage",
      "setMessageReaction",
    ]);
    await expect(pairs.threadOf(anya.id)).resolves.toBe(2);
    await expect(pairs.personOf(1)).resolves.toBeUndefined();
  });

  // Тема от сбоя между двумя записями, которую процесс забыл рестартом,
  // отвечает человеку, но не перетягивает его сообщения обратно к себе.
  it("keeps the person in the new topic after an answer in the half-paired one", async () => {
    let failPerson = true;
    const kv = createMemoryKv(
      (op, key) => failPerson && op === "put" && key.startsWith("person."),
    );
    await createSupportHarness({ kv }).bot.handleUpdate(
      fromPerson({ text: "Привет" }) as never,
    );
    failPerson = false;
    const { bot, calls } = createSupportHarness({ kv, firstThread: 1 });
    await bot.handleUpdate(fromPerson({ text: "Ещё раз" }) as never);
    expect(payloadOf(calls.slice(-2), "copyMessage")).toMatchObject({
      message_thread_id: 2,
    });
    await bot.handleUpdate(inTopic(1, { text: "Ответ в старой" }) as never);
    calls.length = 0;
    await bot.handleUpdate(fromPerson({ text: "А теперь?" }) as never);
    expect(payloadOf(calls, "copyMessage")).toMatchObject({
      message_thread_id: 2,
    });
  });

  it("greets /start with extra text and copies nothing", async () => {
    const { bot, calls } = createSupportHarness();
    await bot.handleUpdate(fromPerson({ text: "/start hub привет" }) as never);
    expect(methods(calls)).toEqual(["sendMessage"]);
    expect(calls[0]?.payload).toMatchObject({ text: welcomeText });
  });

  // Метка живёт до первого сообщения: у человека с темой она не дождётся
  // темы, заведённой взамен удалённой.
  it("drops the source mark on the first message even with a topic", async () => {
    const kv = createMemoryKv();
    await createSupportHarness({ kv }).bot.handleUpdate(
      fromPerson({ text: "Привет" }) as never,
    );
    let deleted = false;
    const { bot, calls } = createSupportHarness({
      kv,
      firstThread: 50,
      respond: (method) => {
        if (method !== "copyMessage" || !deleted) return undefined;
        deleted = false;
        return refusal(400, "Bad Request: message thread not found");
      },
    });
    await bot.handleUpdate(fromPerson({ text: "/start hub" }) as never);
    await bot.handleUpdate(fromPerson({ text: "Снова я" }) as never);
    deleted = true;
    calls.length = 0;
    await bot.handleUpdate(fromPerson({ text: "Тема пропала" }) as never);
    expect(methods(calls)).toContain("createForumTopic");
    expect(
      textOf(calls.find((call) => call.method === "sendMessage")),
    ).toContain("Откуда: неизвестно");
  });

  it("refuses what Telegram cannot copy", async () => {
    const { bot, calls } = createSupportHarness();
    await bot.handleUpdate(
      fromPerson({
        poll: { id: "p", question: "?", type: "quiz", options: [] },
      }) as never,
    );
    expect(methods(calls)).toEqual(["sendMessage"]);
    expect(calls[0]?.payload).toMatchObject({ text: notCopyableText });

    const refused = createSupportHarness({
      respond: (method) =>
        method === "copyMessage"
          ? refusal(400, "Bad Request: message can't be copied")
          : undefined,
    });
    await refused.bot.handleUpdate(fromPerson({ text: "x" }) as never);
    expect(refused.calls.at(-1)?.payload).toMatchObject({
      text: notCopyableText,
    });
  });
});

describe("operator relay", () => {
  async function paired() {
    const harness = createSupportHarness();
    await harness.bot.handleUpdate(fromPerson({ text: "Привет" }) as never);
    harness.calls.length = 0;
    return harness;
  }

  it("copies an answer to the person and marks it delivered", async () => {
    const { bot, calls, kv } = await paired();
    kv.ops.length = 0;
    const update = inTopic(1, { text: "Включи напоминание в настройках" });
    await bot.handleUpdate(update as never);
    expect(methods(calls)).toEqual(["copyMessage", "setMessageReaction"]);
    expect(calls[0]?.payload).toMatchObject({
      chat_id: anya.id,
      from_chat_id: supportGroupId,
      message_id: update.message.message_id,
    });
    expect(calls[1]?.payload).toMatchObject({
      chat_id: supportGroupId,
      message_id: update.message.message_id,
    });
    // Доставленный ответ переписывает обе записи пары.
    expect(kv.ops).toEqual([
      `put topic.${supportGroupId}.1`,
      `put person.${supportGroupId}.${anya.id}`,
    ]);
  });

  it("does not copy a note starting with //", async () => {
    const { bot, calls } = await paired();
    await bot.handleUpdate(
      inTopic(1, { text: "// это дефолт, не баг" }) as never,
    );
    await bot.handleUpdate(
      inTopic(1, {
        photo: [{ file_id: "f", file_unique_id: "u", width: 1, height: 1 }],
        caption: "//скрин для своих",
      }) as never,
    );
    expect(calls).toEqual([]);
  });

  it("delivers an answer of the anonymous administrator", async () => {
    const { bot, calls } = await paired();
    await bot.handleUpdate(
      inTopic(
        1,
        { text: "Ответ от группы" },
        {
          from: {
            id: 1087968824,
            is_bot: true,
            first_name: "Group",
            username: "GroupAnonymousBot",
          },
          sender_chat: {
            id: supportGroupId,
            type: "supergroup",
            title: "Операторы",
          },
        },
      ) as never,
    );
    expect(payloadOf(calls, "copyMessage")).toMatchObject({ chat_id: anya.id });
  });

  it("ignores bots, service messages, the general topic and other chats", async () => {
    const { bot, calls } = await paired();
    await bot.handleUpdate(
      inTopic(
        1,
        { text: "я бот" },
        {
          from: { id: 5, is_bot: true, first_name: "Other" },
        },
      ) as never,
    );
    await bot.handleUpdate(inTopic(1, { forum_topic_closed: {} }) as never);
    await bot.handleUpdate(inTopic(undefined, { text: "в общую" }) as never);
    await bot.handleUpdate(
      inTopic(
        1,
        { text: "чужой чат" },
        { from: operator },
        -1005555555555,
      ) as never,
    );
    await bot.handleUpdate(
      inTopic(
        1,
        { text: "от канала" },
        {
          from: { id: 136817688, is_bot: true, first_name: "Channel" },
          sender_chat: { id: -1007777777777, type: "channel", title: "Канал" },
        },
      ) as never,
    );
    expect(calls).toEqual([]);
  });

  it("answers in a topic without a pair", async () => {
    const { bot, calls } = createSupportHarness();
    const update = inTopic(77, { text: "Кому это?" });
    await bot.handleUpdate(update as never);
    expect(methods(calls)).toEqual(["sendMessage"]);
    expect(calls[0]?.payload).toMatchObject({
      chat_id: supportGroupId,
      message_thread_id: 77,
      text: "Не доставлено: тема не связана с человеком.",
      reply_parameters: { message_id: update.message.message_id },
    });
  });

  it("does not use a pair of another group", async () => {
    const kv = createMemoryKv();
    const old = createSupportHarness({ kv, groupId: -1009999999999 });
    await old.bot.handleUpdate(fromPerson({ text: "Привет" }) as never);
    const { bot, calls } = createSupportHarness({ kv });
    await bot.handleUpdate(inTopic(1, { text: "Ответ" }) as never);
    expect(calls[0]?.payload).toMatchObject({
      text: operatorRefusals.unpaired,
    });
  });

  it("names the refusal when the person stopped the bot or Telegram refused", async () => {
    for (const [answer, text] of [
      [
        refusal(403, "Forbidden: bot was blocked by the user"),
        operatorRefusals.stopped,
      ],
      [refusal(400, "Bad Request: chat not found"), operatorRefusals.rejected],
    ] as const) {
      const kv = createMemoryKv();
      await createSupportHarness({ kv }).bot.handleUpdate(
        fromPerson({ text: "Привет" }) as never,
      );
      const { bot, calls } = createSupportHarness({
        kv,
        respond: (method) => (method === "copyMessage" ? answer : undefined),
      });
      await bot.handleUpdate(inTopic(1, { text: "Починили" }) as never);
      expect(methods(calls)).toEqual(["copyMessage", "sendMessage"]);
      expect(calls[1]?.payload).toMatchObject({ message_thread_id: 1, text });
    }
  });

  it("answers in the topic when KV is down", async () => {
    const { bot, calls } = createSupportHarness({
      kv: createMemoryKv(() => true),
    });
    await bot.handleUpdate(inTopic(1, { text: "Ответ" }) as never);
    expect(calls[0]?.payload).toMatchObject({
      text: operatorRefusals.unavailable,
    });
  });
});
