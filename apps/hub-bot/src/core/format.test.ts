import { describe, expect, it } from "vitest";
import { shownInstant } from "./format.js";

const moscow = "Europe/Moscow";

describe("shownInstant", () => {
  it("shows exactly 00:00 as 23:59 of the previous day, across a month change", () => {
    // 31 октября 00:00 МСК → 30 октября 23:59.
    expect(shownInstant("2026-10-30T21:00:00Z", moscow)).toBe(
      "2026-10-30T20:59:00.000Z",
    );
    // 1 ноября 00:00 МСК → 31 октября 23:59: месяц меняется назад.
    expect(shownInstant("2026-10-31T21:00:00Z", moscow)).toBe(
      "2026-10-31T20:59:00.000Z",
    );
  });

  it("leaves 23:59 and 00:01 as they were", () => {
    expect(shownInstant("2026-10-30T20:59:00Z", moscow)).toBe(
      "2026-10-30T20:59:00Z",
    );
    expect(shownInstant("2026-10-30T21:01:00Z", moscow)).toBe(
      "2026-10-30T21:01:00Z",
    );
    // Анти-снайп, продливший дедлайн на 00:03.
    expect(shownInstant("2026-10-30T21:03:00Z", moscow)).toBe(
      "2026-10-30T21:03:00Z",
    );
  });

  it("keeps a moment after midnight by seconds", () => {
    expect(shownInstant("2026-10-30T21:00:30Z", moscow)).toBe(
      "2026-10-30T21:00:30Z",
    );
  });

  it("reads midnight in the community zone, not in UTC", () => {
    expect(shownInstant("2026-10-30T00:00:00Z", moscow)).toBe(
      "2026-10-30T00:00:00Z",
    );
    expect(shownInstant("2026-10-30T00:00:00Z", "UTC")).toBe(
      "2026-10-29T23:59:00.000Z",
    );
  });

  it("returns an unreadable instant unchanged", () => {
    expect(shownInstant("не момент", moscow)).toBe("не момент");
  });
});
