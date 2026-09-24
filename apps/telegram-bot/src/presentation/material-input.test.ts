import { describe, expect, it } from "vitest";
import {
  materialConfirmationText,
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

  it("recovers a file material from the confirmation screen", () => {
    expect(
      parseMaterialConfirmation({
        caption: materialConfirmationText("Афиша"),
        document: { file_id: "bot-file-id" },
      }),
    ).toEqual({
      title: "Афиша",
      source: { kind: "file", fileId: "bot-file-id" },
    });
  });
});
