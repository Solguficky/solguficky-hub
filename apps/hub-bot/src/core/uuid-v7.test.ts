import { describe, expect, it } from "vitest";
import { createUuidV7, uuidV7Of } from "./uuid-v7.js";

const canonical =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("createUuidV7", () => {
  it("makes a canonical UUIDv7 with the time in front", () => {
    expect(createUuidV7(0x0192_9b7e_5c1d)).toMatch(
      /^01929b7e-5c1d-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

// Ключ из сообщения Telegram (PER-699): повтор того же сообщения — тот же
// `op_id`, другое сообщение — другой.
describe("uuidV7Of", () => {
  it("makes the same canonical UUIDv7 from the same key and time", () => {
    const first = uuidV7Of("hub-bot:final-ask:42:10", 0x0192_9b7e_5c1d);

    expect(first).toMatch(canonical);
    expect(first.startsWith("01929b7e-5c1d-7")).toBe(true);
    expect(uuidV7Of("hub-bot:final-ask:42:10", 0x0192_9b7e_5c1d)).toBe(first);
  });

  it("makes different identifiers from different keys at the same time", () => {
    const keys = [
      "hub-bot:final-ask:42:10",
      "hub-bot:final-ask:42:11",
      "hub-bot:final-ask:43:10",
      "hub-bot:console-week:42:10",
    ];

    const made = keys.map((key) => uuidV7Of(key, 0));

    expect(new Set(made).size).toBe(keys.length);
    for (const id of made) expect(id).toMatch(canonical);
  });
});
