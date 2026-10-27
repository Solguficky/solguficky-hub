import { describe, expect, it } from "vitest";
import {
  materialConfirmationText,
  materialRefusal,
  parseMaterialConfirmation,
  parseMaterialInput,
} from "./material-input.js";

describe("material input", () => {
  it("builds a private Telegram message link from a forwarded channel post", () => {
    expect(
      parseMaterialInput({
        forward_origin: {
          type: "channel",
          chat: { id: -1001234567890 },
          message_id: 77,
        },
      }),
    ).toEqual({
      kind: "message-link",
      url: "https://t.me/c/1234567890/77",
    });
  });

  it("refuses a forward whose original message cannot be linked", () => {
    expect(
      parseMaterialInput({
        forward_origin: { type: "hidden_user", sender_user_name: "Скрыт" },
      }),
    ).toBeUndefined();
  });

  it("takes the largest photo file id", () => {
    expect(
      parseMaterialInput({
        photo: [{ file_id: "small" }, { file_id: "large" }],
      }),
    ).toEqual({ kind: "file", fileId: "large", fileKind: "photo" });
  });

  it("keeps a forwarded media post as a link to its source message", () => {
    expect(
      parseMaterialInput({
        photo: [{ file_id: "small" }, { file_id: "large" }],
        forward_origin: {
          type: "channel",
          chat: { id: -1001234567890, username: "community" },
          message_id: 77,
        },
      }),
    ).toEqual({
      kind: "message-link",
      url: "https://t.me/community/77",
    });
  });

  it.each([
    ["https://t.me/solguficky/77", "https://t.me/solguficky/77"],
    ["https://t.me/solguficky/12/77", "https://t.me/solguficky/12/77"],
    ["https://t.me/c/1234567890/77", "https://t.me/c/1234567890/77"],
    [
      " https://t.me/c/1234567890/12/77?thread=12 ",
      "https://t.me/c/1234567890/12/77",
    ],
    [
      "https://t.me/solguficky/77?single&comment=5",
      "https://t.me/solguficky/77?comment=5",
    ],
    ["https://t.me/solguficky/77?comment=x", "https://t.me/solguficky/77"],
    // Набранная руками (PER-793): без схемы и с `http://` — та же ссылка.
    ["t.me/solguficky/77", "https://t.me/solguficky/77"],
    ["http://t.me/c/1234567890/77", "https://t.me/c/1234567890/77"],
  ])("takes a typed message link %s", (text, url) => {
    expect(parseMaterialInput({ text })).toEqual({ kind: "message-link", url });
  });

  it.each([
    "https://example.com/solguficky/77",
    "ftp://t.me/solguficky/77",
    "xt.me/solguficky/77",
    "https://t.me/solguficky",
    "https://t.me/c/1234567890",
    "https://t.me/+invite",
    "вот https://t.me/solguficky/77",
  ])("refuses a typed text %s that is not a message link", (text) => {
    expect(parseMaterialInput({ text })).toBeUndefined();
  });

  it("does not read a link out of a forwarded text", () => {
    expect(
      parseMaterialInput({
        text: "https://t.me/solguficky/77",
        forward_origin: { type: "user" },
      }),
    ).toBeUndefined();
  });

  it.each([
    [
      { forward_origin: { type: "chat" }, text: "пост" },
      "forward:chat",
      "Копировать ссылку",
    ],
    [
      { forward_origin: { type: "user" }, text: "пост" },
      "forward:user",
      "Копировать ссылку",
    ],
    [
      { forward_origin: { type: "hidden_user" }, text: "пост" },
      "forward:hidden_user",
      "Источник скрыт",
    ],
    [{ forward_origin: { type: "новый" } }, "forward:other", "Источник скрыт"],
    [{ voice: { file_id: "v" } }, "voice", "Голосовое не принимается"],
    [
      { venue: { title: "т" }, location: { latitude: 0, longitude: 0 } },
      "venue",
      "Место не принимается",
    ],
    [
      { forward_origin: { type: "chat" }, video: { file_id: "v" } },
      "forward:chat,video",
      "Видео не принимается",
    ],
    [{ text: "ссылка где-то" }, "text", "Текст сам по себе не материал"],
    // Скрытый источник называет вид пересланного медиа (PER-793).
    [
      { forward_origin: { type: "hidden_user" }, video: { file_id: "v" } },
      "forward:hidden_user,video",
      "Видео не принимается материалом. На это сообщение нельзя дать ссылку",
    ],
    // Ссылка внутри фразы: отказ просит прислать её одну (PER-793).
    [
      { text: "вот t.me/solguficky/77, глянь" },
      "text",
      "Ссылку на сообщение пришли отдельно, без другого текста",
    ],
  ])("names the refusal of %j", (message, kind, text) => {
    const refusal = materialRefusal(message);
    expect(refusal.kind).toBe(kind);
    expect(refusal.text).toContain(text);
  });

  // Отказ тексту не зовёт переслать из чата: такую пересылку бот не принимает
  // и ответил бы «пришли ссылку» — круга нет (PER-793).
  it("sends a typed text to the link form instead of a chat forward", () => {
    const typed = materialRefusal({ text: "вот афиша" }).text;
    expect(typed).toContain("https://t.me/…");
    expect(typed).not.toContain("чата");
    expect(materialRefusal({ text: "https://t.me/solguficky" }).text).toBe(
      typed,
    );
  });

  it("recovers a message material from the confirmation screen", () => {
    expect(
      parseMaterialConfirmation({
        text: materialConfirmationText("Опрос: кто идёт"),
        reply_markup: {
          inline_keyboard: [
            [{ text: "Открыть источник", url: "https://t.me/c/42/7" }],
            [{ text: "Прикрепить", callback_data: "v1:mm:confirm-add:x:y" }],
          ],
        },
      }),
    ).toEqual({
      title: "Опрос: кто идёт",
      source: { kind: "message-link", url: "https://t.me/c/42/7" },
    });
  });

  it("keeps the photo kind when the confirmation screen carries a photo", () => {
    expect(
      parseMaterialConfirmation({
        caption: materialConfirmationText("Афиша"),
        photo: [{ file_id: "small" }, { file_id: "large" }],
      }),
    ).toEqual({
      title: "Афиша",
      source: { kind: "file", fileId: "large", fileKind: "photo" },
    });
  });

  it("recovers a file material from the confirmation screen", () => {
    expect(
      parseMaterialConfirmation({
        caption: materialConfirmationText("Афиша"),
        document: { file_id: "bot-file-id" },
      }),
    ).toEqual({
      title: "Афиша",
      source: { kind: "file", fileId: "bot-file-id", fileKind: "document" },
    });
  });
});
