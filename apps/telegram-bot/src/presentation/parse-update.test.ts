import { describe, expect, it } from "vitest";
import { parseUpdate } from "./parse-update.js";

describe("parseUpdate", () => {
  it("reads /start without a deep link payload", () => {
    const parsed = parseUpdate({
      update_id: 1,
      message: {
        message_id: 7,
        date: 0,
        chat: { id: 42, type: "private" },
        from: {
          id: 42,
          is_bot: false,
          first_name: "tester",
          username: "alice",
        },
        text: "/start",
      },
    });
    expect(parsed).toEqual({
      kind: "start",
      telegramUserId: 42n,
      telegramUsername: "alice",
    });
  });

  it("parses and preserves a valid deep link payload", () => {
    const parsed = parseUpdate({
      update_id: 1,
      message: {
        message_id: 7,
        date: 0,
        chat: { id: 42, type: "private" },
        from: { id: 42, is_bot: false, first_name: "tester" },
        text: "/start m_AZLzpLXGfY6fChssPU5fYA",
      },
    });
    expect(parsed).toEqual({
      kind: "start",
      telegramUserId: 42n,
      deepLinkPayload: "m_AZLzpLXGfY6fChssPU5fYA",
    });
  });

  it("ignores other text and malformed start payloads", () => {
    expect(messageText("hello").kind).toBe("ignored");
    expect(messageText("/start payload with spaces").kind).toBe("ignored");
    expect(messageText(`/start ${"a".repeat(65)}`).kind).toBe("ignored");
  });

  it("ignores /start outside a private chat", () => {
    expect(
      parseUpdate({
        update_id: 1,
        message: {
          message_id: 7,
          date: 0,
          chat: { id: -42, type: "group" },
          from: { id: 42, is_bot: false, first_name: "tester" },
          text: "/start",
        },
      }).kind,
    ).toBe("ignored");
  });

  it("treats garbage as malformed", () => {
    const cases: unknown[] = [
      null,
      "",
      1,
      {},
      { update_id: "x" },
      { update_id: 1, message: null },
    ];
    for (const raw of cases) {
      expect(parseUpdate(raw).kind).toBe("malformed");
    }
  });

  it("ignores updates without a user message", () => {
    expect(parseUpdate({ update_id: 1 }).kind).toBe("ignored");
    expect(
      parseUpdate({
        update_id: 1,
        message: {
          message_id: 7,
          date: 0,
          chat: { id: 42, type: "private" },
        },
      }).kind,
    ).toBe("ignored");
  });

  it("ignores non-text user messages", () => {
    const from = {
      id: 42,
      is_bot: false,
      first_name: "tester",
    };
    const base = {
      message_id: 7,
      date: 0,
      chat: { id: 42, type: "private" },
      from,
    };
    const cases: unknown[] = [
      { update_id: 1, message: { ...base, photo: [{}] } },
      { update_id: 2, message: { ...base, sticker: { file_id: "sticker" } } },
      {
        update_id: 3,
        message: { ...base, new_chat_members: [{ id: 9, is_bot: false }] },
      },
      { update_id: 4, message: { ...base, text: "" } },
    ];
    for (const raw of cases) {
      expect(parseUpdate(raw).kind).toBe("ignored");
    }
  });
});

function messageText(text: string): ReturnType<typeof parseUpdate> {
  return parseUpdate({
    update_id: 1,
    message: {
      message_id: 7,
      date: 0,
      chat: { id: 42, type: "private" },
      from: { id: 42, is_bot: false, first_name: "tester" },
      text,
    },
  });
}
