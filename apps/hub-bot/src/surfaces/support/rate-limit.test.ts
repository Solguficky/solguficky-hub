import { describe, expect, it } from "vitest";
import {
  createRateLimiter,
  messagesPerWindow,
  windowMs,
} from "./rate-limit.js";

describe("support rate limiter", () => {
  it("passes the window, notifies once and drops the rest", () => {
    const limiter = createRateLimiter(() => 0);
    const admissions = Array.from({ length: messagesPerWindow + 3 }, () =>
      limiter.admit(1),
    );
    expect(admissions.slice(0, messagesPerWindow)).toEqual(
      Array(messagesPerWindow).fill("pass"),
    );
    expect(admissions.slice(messagesPerWindow)).toEqual([
      "notify",
      "drop",
      "drop",
    ]);
  });

  it("starts a new window a minute after the first message", () => {
    let at = 0;
    const limiter = createRateLimiter(() => at);
    for (let i = 0; i <= messagesPerWindow; i += 1) limiter.admit(1);
    at = windowMs - 1;
    expect(limiter.admit(1)).toBe("drop");
    at = windowMs;
    expect(limiter.admit(1)).toBe("pass");
  });

  it("counts every person apart", () => {
    const limiter = createRateLimiter(() => 0);
    for (let i = 0; i < messagesPerWindow; i += 1) limiter.admit(1);
    expect(limiter.admit(2)).toBe("pass");
    expect(limiter.admit(1)).toBe("notify");
  });
});
