import { describe, expect, it } from "vitest";
import { classifyTelegramFailure } from "./telegram.js";

// Ответ Bot API в той форме, в какой его несёт GrammyError: сам класс пакет не
// видит, поэтому тест строит объект с теми же полями.
function reply(errorCode: number, retryAfter?: number) {
  return Object.assign(new Error(`Call to 'sendMessage' failed!`), {
    error_code: errorCode,
    parameters: retryAfter === undefined ? {} : { retry_after: retryAfter },
  });
}

describe("classifyTelegramFailure", () => {
  it("treats 403 as a recipient who blocked the bot", () => {
    expect(classifyTelegramFailure(reply(403))).toMatchObject({
      kind: "bot-blocked",
    });
  });

  it("takes the pause Telegram asks for on 429", () => {
    expect(classifyTelegramFailure(reply(429, 7))).toMatchObject({
      kind: "rate-limited",
      retryAfterMs: 7_000,
    });
  });

  it("waits a second when 429 names no pause", () => {
    expect(classifyTelegramFailure(reply(429))).toMatchObject({
      kind: "rate-limited",
      retryAfterMs: 1_000,
    });
  });

  it("treats 5xx as a temporary failure", () => {
    expect(classifyTelegramFailure(reply(502))).toMatchObject({
      kind: "unavailable",
    });
  });

  it("treats other 4xx as a rejected request", () => {
    expect(classifyTelegramFailure(reply(400))).toMatchObject({
      kind: "rejected",
    });
  });

  it("treats a failure before any reply as temporary", () => {
    expect(classifyTelegramFailure(new Error("socket hang up"))).toMatchObject({
      kind: "unavailable",
    });
  });
});
