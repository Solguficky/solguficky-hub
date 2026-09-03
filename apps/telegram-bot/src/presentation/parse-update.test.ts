import { describe, expect, it } from "vitest";
import { parseUpdate } from "./parse-update.js";

const botUsername = "stub_bot";

describe("parseUpdate", () => {
  it("reads /start without a deep link payload", () => {
    const parsed = parseUpdate(
      {
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
      },
      botUsername,
    );
    expect(parsed).toEqual({
      kind: "start",
      telegramUserId: 42n,
      telegramUsername: "alice",
    });
  });

  it("classifies a meetup deep link payload", () => {
    const parsed = parseUpdate(
      {
        update_id: 1,
        message: {
          message_id: 7,
          date: 0,
          chat: { id: 42, type: "private" },
          from: { id: 42, is_bot: false, first_name: "tester" },
          text: "/start m_AZLzpLXGfY6fChssPU5fYA",
        },
      },
      botUsername,
    );
    expect(parsed).toEqual({
      kind: "start",
      telegramUserId: 42n,
      deepLink: {
        kind: "meetup",
        payload: "m_AZLzpLXGfY6fChssPU5fYA",
      },
    });
  });

  it("keeps a valid non-meetup payload unclassified", () => {
    expect(messageText("/start invite_token_1")).toEqual({
      kind: "start",
      telegramUserId: 42n,
      deepLink: { kind: "unclassified", payload: "invite_token_1" },
    });
  });

  it("accepts /start with a bot mention and ignores case", () => {
    expect(messageText("/START@Stub_Bot").kind).toBe("start");
    expect(messageText("/start@stub_bot m_AZLzpLXGfY6fChssPU5fYA")).toEqual({
      kind: "start",
      telegramUserId: 42n,
      deepLink: {
        kind: "meetup",
        payload: "m_AZLzpLXGfY6fChssPU5fYA",
      },
    });
  });

  it("ignores /start mentioned for another bot", () => {
    expect(messageText("/start@other_bot").kind).toBe("ignored");
  });

  it("treats invalid payload as a bare start", () => {
    expect(messageText("/start payload with spaces")).toEqual({
      kind: "start",
      telegramUserId: 42n,
    });
    expect(messageText(`/start ${"a".repeat(65)}`)).toEqual({
      kind: "start",
      telegramUserId: 42n,
    });
  });

  it("ignores other text", () => {
    expect(messageText("hello").kind).toBe("ignored");
  });

  it("ignores /start outside a private chat", () => {
    expect(
      parseUpdate(
        {
          update_id: 1,
          message: {
            message_id: 7,
            date: 0,
            chat: { id: -42, type: "group" },
            from: { id: 42, is_bot: false, first_name: "tester" },
            text: "/start",
          },
        },
        botUsername,
      ).kind,
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
      expect(parseUpdate(raw, botUsername).kind).toBe("malformed");
    }
  });

  it("ignores updates without a user message", () => {
    expect(parseUpdate({ update_id: 1 }, botUsername).kind).toBe("ignored");
    expect(
      parseUpdate(
        {
          update_id: 1,
          message: {
            message_id: 7,
            date: 0,
            chat: { id: 42, type: "private" },
          },
        },
        botUsername,
      ).kind,
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
      expect(parseUpdate(raw, botUsername).kind).toBe("ignored");
    }
  });
});

function messageText(text: string): ReturnType<typeof parseUpdate> {
  return parseUpdate(
    {
      update_id: 1,
      message: {
        message_id: 7,
        date: 0,
        chat: { id: 42, type: "private" },
        from: { id: 42, is_bot: false, first_name: "tester" },
        text,
      },
    },
    botUsername,
  );
}
