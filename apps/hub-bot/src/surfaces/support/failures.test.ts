import { describe, expect, it } from "vitest";
import { classifyRefusal } from "./failures.js";

const reply = (error_code: number, description: string) => ({
  error_code,
  description,
});

describe("classifyRefusal", () => {
  it.each([
    [reply(400, "Bad Request: TOPIC_CLOSED"), "topic-closed"],
    [reply(400, "Bad Request: message thread not found"), "topic-missing"],
    [reply(400, "Bad Request: TOPIC_DELETED"), "topic-missing"],
    [reply(400, "Bad Request: TOPIC_ID_INVALID"), "topic-missing"],
    [reply(400, "Bad Request: message can't be copied"), "not-copyable"],
    [reply(403, "Forbidden: bot was blocked by the user"), "stopped"],
    [reply(403, "Forbidden: user is deactivated"), "stopped"],
    [reply(429, "Too Many Requests: retry after 5"), "other"],
    [reply(500, "Internal Server Error"), "other"],
    [reply(400, "Bad Request: chat not found"), "other"],
    [new Error("socket hang up"), "other"],
  ] as const)("reads %j as %s", (cause, expected) => {
    expect(classifyRefusal(cause)).toBe(expected);
  });
});
