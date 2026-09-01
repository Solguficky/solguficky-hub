import { describe, expect, it } from "vitest";
import { parseUpdate } from "./parse-update.js";

describe("parseUpdate", () => {
  it("reads a private message as unknown", () => {
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
        text: "hello",
      },
    });
    expect(parsed).toEqual({
      kind: "message",
      telegramUserId: 42n,
      telegramUsername: "alice",
      text: "hello",
    });
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
});
