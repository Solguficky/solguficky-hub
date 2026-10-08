import { describe, expect, it } from "vitest";
import { sourceCodeOf } from "./start-payload.js";

describe("sourceCodeOf", () => {
  it("reads the channel code without the prefix", () => {
    expect(sourceCodeOf("s_tg_ads")).toBe("tg_ads");
  });

  it("passes an empty code after the prefix as received", () => {
    expect(sourceCodeOf("s_")).toBe("");
  });

  it("finds no channel in a meetup link, a foreign or broken payload", () => {
    for (const payload of [
      "",
      "m_AZLzpLXGfY6fChssPU5fYA",
      "invite_token_1",
      "s_with spaces",
      `s_${"a".repeat(63)}`,
    ]) {
      expect(sourceCodeOf(payload)).toBeUndefined();
    }
  });
});
