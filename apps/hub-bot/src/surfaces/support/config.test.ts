import { describe, expect, it } from "vitest";
import { readSupportConfig } from "./config.js";

describe("readSupportConfig", () => {
  it("reads the operators' supergroup", () => {
    expect(
      readSupportConfig({ BOT_SUPPORT_GROUP_ID: "-1001234567890" }),
    ).toEqual({ ok: true, config: { groupId: -1001234567890 } });
  });

  it.each([undefined, ""])("refuses a missing group %j", (raw) => {
    expect(readSupportConfig({ BOT_SUPPORT_GROUP_ID: raw })).toEqual({
      ok: false,
      error: "BOT_SUPPORT_GROUP_ID is not set",
    });
  });

  // Личный чат или обычная группа тем не держат, а опечатка увела бы
  // переписку в чужой чат.
  it.each([
    "42",
    "-42",
    "-100",
    "-100abc",
    " -1001234567890",
    "-100999999999999999999",
  ])("refuses %j", (raw) => {
    expect(readSupportConfig({ BOT_SUPPORT_GROUP_ID: raw })).toEqual({
      ok: false,
      error: "BOT_SUPPORT_GROUP_ID must be a supergroup id like -100…",
    });
  });
});
