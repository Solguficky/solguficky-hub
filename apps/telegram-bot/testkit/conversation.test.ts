import type { Update } from "grammy/types";
import { describe, expect, it } from "vitest";
import { readScreenViews, startConversation } from "./conversation.js";
import type { ApiMethod, RecordedCall } from "./harness.js";

// L0: модель экранов test kit на записи вызовов Bot API, без бота и сервисов.
// По ней пульт провода показывает экран, а сценарий L2 жмёт кнопки: ошибка
// здесь молча искажает оба.

const chatId = 7_000_000_001;

// Полезная нагрузка — то, что бот отдал бы grammY. Тип записи выводится из
// метода и требует всех его полей, а тест держит только те, что читает модель:
// отсюда `as never`.
function call(method: ApiMethod, payload: object): RecordedCall {
  return { method, payload: { chat_id: chatId, ...payload } as never };
}

function capturingBot() {
  const updates: Update[] = [];
  return {
    updates,
    bot: {
      handleUpdate(update: Update): Promise<void> {
        updates.push(update);
        return Promise.resolve();
      },
    },
  };
}

describe("readScreenViews", () => {
  it("returns the keyboard by rows with styles and url buttons", () => {
    const views = readScreenViews(
      [
        call("sendMessage", {
          text: "Точно отменить сходку?",
          reply_markup: {
            inline_keyboard: [
              [
                { text: "Да", callback_data: "v1:yes", style: "danger" },
                { text: "Нет", callback_data: "v1:no" },
              ],
              [{ text: "Открыть источник", url: "https://t.me/c/1/2" }],
            ],
          },
        }),
      ],
      chatId,
    );

    expect(views).toEqual([
      {
        message: 101,
        text: "Точно отменить сходку?",
        buttons: ["Да", "Нет"],
        rows: [
          [
            { text: "Да", kind: "callback", target: "v1:yes", style: "danger" },
            { text: "Нет", kind: "callback", target: "v1:no" },
          ],
          [
            {
              text: "Открыть источник",
              kind: "url",
              target: "https://t.me/c/1/2",
            },
          ],
        ],
        format: "plain",
        awaitsReply: false,
      },
    ]);
  });

  it("tells a rich message, html and plain text apart", () => {
    const views = readScreenViews(
      [
        call("sendRichMessage", {
          rich_message: { html: "<h1>Сходка</h1><p>Когда: завтра</p>" },
        }),
        call("sendMessage", { text: "<b>Сходка</b>", parse_mode: "HTML" }),
        call("sendMessage", { text: "<b>не разметка</b>" }),
      ],
      chatId,
    );

    expect(views.map(({ format, text }) => [format, text])).toEqual([
      ["rich", "Сходка\nКогда: завтра"],
      ["html", "Сходка"],
      ["plain", "<b>не разметка</b>"],
    ]);
  });

  it("keeps a file message and its caption edit as one screen", () => {
    const views = readScreenViews(
      [
        call("sendDocument", {
          document: "file-1",
          caption: "Прикрепить материал?\n\nНазвание: Программа",
          reply_markup: {
            inline_keyboard: [[{ text: "Прикрепить", callback_data: "v1:ca" }]],
          },
        }),
        call("editMessageCaption", {
          message_id: 101,
          caption: "Материал прикреплён.",
          reply_markup: { inline_keyboard: [] },
        }),
        call("sendPhoto", { photo: "file-2" }),
      ],
      chatId,
    );

    expect(views).toEqual([
      {
        message: 101,
        text: "Материал прикреплён.",
        buttons: [],
        rows: [],
        format: "plain",
        media: "document",
        awaitsReply: false,
      },
      {
        message: 103,
        text: "",
        buttons: [],
        rows: [],
        format: "plain",
        media: "photo",
        awaitsReply: false,
      },
    ]);
  });
});

describe("conversation press", () => {
  it("returns the message the screen replied to", async () => {
    const { bot, updates } = capturingBot();
    const person = startConversation(
      bot,
      [
        call("sendMessage", { text: "Встречаемся у входа" }),
        call("sendMessage", {
          text: "Выше — текст для подписчиков.",
          reply_parameters: { message_id: 101 },
          reply_markup: {
            inline_keyboard: [[{ text: "Отправить", callback_data: "v1:bc" }]],
          },
        }),
      ],
      BigInt(chatId),
    );

    await person.presses("Отправить");

    expect(updates[0]?.callback_query?.message).toMatchObject({
      message_id: 102,
      text: "Выше — текст для подписчиков.",
      reply_to_message: { message_id: 101, text: "Встречаемся у входа" },
    });
  });

  it("returns the file and its caption instead of text", async () => {
    const { bot, updates } = capturingBot();
    const person = startConversation(
      bot,
      [
        call("sendDocument", {
          document: "file-1",
          caption: "Прикрепить материал?",
          reply_markup: {
            inline_keyboard: [[{ text: "Прикрепить", callback_data: "v1:ca" }]],
          },
        }),
      ],
      BigInt(chatId),
    );

    await person.presses("Прикрепить");

    const message = updates[0]?.callback_query?.message;
    expect(message).toMatchObject({
      caption: "Прикрепить материал?",
      document: { file_id: "file-1" },
    });
    expect(message).not.toHaveProperty("text");
  });
});

describe("conversation file", () => {
  it("answers the pending question with the document", async () => {
    const { bot, updates } = capturingBot();
    const person = startConversation(
      bot,
      [
        call("sendMessage", {
          text: "Перешли сообщение или отправь документ.",
          reply_markup: { force_reply: true },
        }),
      ],
      BigInt(chatId),
    );

    await person.sendsDocument("programma.pdf");

    expect(updates[0]?.message).toMatchObject({
      document: { file_name: "programma.pdf" },
      reply_to_message: { message_id: 101 },
    });
  });
});
