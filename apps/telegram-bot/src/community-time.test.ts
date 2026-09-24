import { describe, expect, it } from "vitest";
import { communityLocalTime, parseTimeZone } from "./community-time.js";

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
});
