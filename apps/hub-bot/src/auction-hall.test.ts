import { describe, expect, it } from "vitest";
import { hallButtons, readHallLinks } from "./auction-hall.js";

describe("readHallLinks", () => {
  it("reads nothing without the settings", () => {
    for (const env of [{}, { BOT_HALL_SCREEN_URL: "", BOT_STREAM_URL: "  " }]) {
      expect(readHallLinks(env)).toEqual({ ok: true, links: {} });
    }
  });

  it("reads the screen base without a trailing slash and the stream as is", () => {
    expect(
      readHallLinks({
        BOT_HALL_SCREEN_URL: "https://hall.example.org/screen/",
        BOT_STREAM_URL: "https://stream.example.org/live",
      }),
    ).toEqual({
      ok: true,
      links: {
        screenUrl: "https://hall.example.org/screen",
        streamUrl: "https://stream.example.org/live",
      },
    });
  });

  it("refuses a value that is not HTTPS, has credentials or is not a URL", () => {
    for (const [name, value] of [
      ["BOT_HALL_SCREEN_URL", "http://hall.example.org/screen"],
      ["BOT_HALL_SCREEN_URL", "https://user:pw@hall.example.org/screen"],
      ["BOT_HALL_SCREEN_URL", "https://hall.example.org/screen?x=1"],
      ["BOT_HALL_SCREEN_URL", "https://hall.example.org/screen?"],
      ["BOT_HALL_SCREEN_URL", "https://hall.example.org/screen#"],
      ["BOT_HALL_SCREEN_URL", "not a url"],
      ["BOT_STREAM_URL", "http://stream.example.org"],
      ["BOT_STREAM_URL", "https://token@stream.example.org"],
      ["BOT_HALL_SCREEN_URL", "https://localhost:5173/screen"],
      ["BOT_HALL_SCREEN_URL", "https://10.0.0.5/screen"],
      ["BOT_STREAM_URL", "https://[::1]/live"],
      ["BOT_HALL_SCREEN_URL", `https://hall.example.org/${"a".repeat(2000)}`],
    ] as const) {
      const result = readHallLinks({ [name]: value });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain(name);
        expect(result.error).not.toContain(value);
      }
    }
  });
});

describe("hallButtons", () => {
  const links = {
    screenUrl: "https://hall.example.org/screen",
    streamUrl: "https://stream.example.org/live",
  };

  it("has no buttons without settings", () => {
    expect(hallButtons(undefined, "a-1")).toEqual([]);
    expect(hallButtons({}, "a-1")).toEqual([]);
  });

  it("puts the auction id after the base", () => {
    expect(hallButtons({ screenUrl: links.screenUrl }, "a-1")).toEqual([
      { text: "Экран зала ↗", url: "https://hall.example.org/screen/a-1" },
    ]);
  });

  it("shows the stream only when its address is set", () => {
    expect(hallButtons({ streamUrl: links.streamUrl }, "a-1")).toEqual([
      { text: "Стрим ↗", url: "https://stream.example.org/live" },
    ]);
    expect(hallButtons(links, "a-1").map((button) => button.text)).toEqual([
      "Экран зала ↗",
      "Стрим ↗",
    ]);
  });
});
