import { describe, expect, it } from "vitest";
import {
  communityDay,
  communityLocalTime,
  isBeforeDay,
  parseTimeZone,
} from "./community-time.js";

describe("community time zone", () => {
  it("accepts an IANA zone and rejects a missing or unknown one", () => {
    expect(parseTimeZone("Europe/Moscow")).toBe("Europe/Moscow");
    expect(parseTimeZone(undefined)).toBeUndefined();
    expect(parseTimeZone("")).toBeUndefined();
    expect(parseTimeZone("Europe/Moskva")).toBeUndefined();
  });

  it("shows a UTC instant in community time, across midnight", () => {
    expect(communityLocalTime("2026-10-01T21:30:00Z", "Europe/Moscow")).toEqual(
      { year: 2026, month: 10, day: 2, hours: 0, minutes: 30 },
    );
  });

  // В Москве перехода на летнее время нет с 2014 года, поэтому смещение
  // проверяется поясом, где оно меняется: пояс — параметр, а не константа.
  it("follows the zone offset on both sides of a daylight saving change", () => {
    expect(communityLocalTime("2026-03-28T18:00:00Z", "Europe/Berlin")).toEqual(
      { year: 2026, month: 3, day: 28, hours: 19, minutes: 0 },
    );
    expect(communityLocalTime("2026-03-29T18:00:00Z", "Europe/Berlin")).toEqual(
      { year: 2026, month: 3, day: 29, hours: 20, minutes: 0 },
    );
  });

  it("refuses a value that is not an instant instead of dropping it", () => {
    expect(() => communityLocalTime("tomorrow", "Europe/Moscow")).toThrow();
  });

  it("takes today's date in the community zone, not in UTC", () => {
    const lateEvening = new Date("2026-09-23T21:30:00Z");
    expect(communityDay(lateEvening, "Europe/Moscow")).toEqual({
      year: 2026,
      month: 9,
      day: 24,
    });
    expect(communityDay(lateEvening, "UTC")).toEqual({
      year: 2026,
      month: 9,
      day: 23,
    });
  });

  it("treats only an earlier calendar day as before today", () => {
    const today = { year: 2026, month: 9, day: 24 };
    expect(isBeforeDay({ year: 2026, month: 9, day: 23 }, today)).toBe(true);
    expect(isBeforeDay({ year: 2026, month: 8, day: 30 }, today)).toBe(true);
    expect(isBeforeDay({ year: 2025, month: 12, day: 31 }, today)).toBe(true);
    expect(isBeforeDay(today, today)).toBe(false);
    expect(isBeforeDay({ year: 2026, month: 10, day: 1 }, today)).toBe(false);
  });
});
