import { describe, expect, it } from "vitest";
import { botCommands } from "./commands.js";
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

  it("reads a source channel payload as its code without the prefix", () => {
    expect(messageText("/start s_tg_ads")).toEqual({
      kind: "start",
      telegramUserId: 42n,
      deepLink: { kind: "source", code: "tg_ads" },
    });
  });

  it("passes an empty source code as received", () => {
    expect(messageText("/start s_")).toEqual({
      kind: "start",
      telegramUserId: 42n,
      deepLink: { kind: "source", code: "" },
    });
  });

  it("does not read a meetup payload as a source", () => {
    expect(messageText("/start m_AZLzpLXGfY6fChssPU5fYA")).toMatchObject({
      deepLink: { kind: "meetup" },
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

  it("maps menu commands to their existing screens", () => {
    expect(messageText("/meetups")).toEqual({
      kind: "screen",
      screen: "hub",
      telegramUserId: 42n,
    });
    expect(messageText("/archive")).toMatchObject({ screen: "archive" });
    expect(messageText("/notifications")).toMatchObject({
      screen: "notify-global",
    });
  });

  it("accepts a menu command with a bot mention, any case and a tail", () => {
    expect(messageText("/ARCHIVE@Stub_Bot")).toMatchObject({
      kind: "screen",
      screen: "archive",
    });
    expect(messageText("/meetups whatever")).toMatchObject({
      kind: "screen",
      screen: "hub",
    });
  });

  it("ignores a menu command mentioned for another bot", () => {
    expect(messageText("/meetups@other_bot")).toEqual({ kind: "ignored" });
  });

  it("reads /menu as /start without a payload", () => {
    expect(messageText("/menu")).toEqual({
      kind: "start",
      telegramUserId: 42n,
    });
    expect(messageText("/MENU@Stub_Bot")).toEqual({
      kind: "start",
      telegramUserId: 42n,
    });
  });

  it("does not turn a tail after /menu into a deep link", () => {
    expect(messageText("/menu m_AZLzpLXGfY6fChssPU5fYA")).toEqual({
      kind: "start",
      telegramUserId: 42n,
    });
  });

  it("parses every command of the Telegram menu into a reply", () => {
    for (const { command } of botCommands) {
      expect(messageText(`/${command}`).kind).not.toBe("ignored");
    }
  });

  it("ignores /menu mentioned for another bot", () => {
    expect(messageText("/menu@other_bot")).toEqual({ kind: "ignored" });
  });

  it("ignores unknown commands, including prototype property names", () => {
    for (const text of ["/help", "/constructor", "/toString", "/__proto__"]) {
      expect(messageText(text)).toEqual({ kind: "ignored" });
    }
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
