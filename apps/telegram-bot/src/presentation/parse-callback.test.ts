import { describe, expect, it } from "vitest";
import { parseCallback } from "./parse-callback.js";

describe("callback parser", () => {
  it("parses a meetup card action", () => {
    expect(parseCallback("v1:view:AZjypHwefTqbIU-OEqs0zg")).toEqual({
      kind: "view-meetup",
      token: "AZjypHwefTqbIU-OEqs0zg",
    });
  });
  it("distinguishes outdated and malformed callbacks", () => {
    expect(parseCallback("v2:manage:menu")).toEqual({ kind: "outdated" });
    expect(parseCallback("v1:manage:new:not-a-token")).toEqual({
      kind: "malformed",
    });
    expect(parseCallback(42)).toEqual({ kind: "malformed" });
  });

  it("parses a create action within the Telegram byte budget", () => {
    const data = "v1:manage:new:AZLzpLXGfY6fChssPU5fYA";
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
    expect(parseCallback(data)).toEqual({
      kind: "create-meetup",
      token: "AZLzpLXGfY6fChssPU5fYA",
    });
  });

  it("parses the hub navigation action", () => {
    expect(parseCallback("v1:nav:hub")).toEqual({ kind: "hub" });
  });
});
