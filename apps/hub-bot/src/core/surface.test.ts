import { describe, expect, it } from "vitest";
import { readSurface } from "./surface.js";

describe("readSurface", () => {
  it.each(["hub", "auction"] as const)("accepts %s", (surface) => {
    expect(readSurface(surface)).toEqual({ ok: true, surface });
  });

  it.each([undefined, "", "Hub", "auction-bot"])("refuses %j", (raw) => {
    expect(readSurface(raw)).toEqual({
      ok: false,
      error: "BOT_SURFACE must be hub or auction",
    });
  });
});
