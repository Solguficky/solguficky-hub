import { describe, expect, it } from "vitest";
import { lotIdOf, startPayloadOf } from "./start-payload.js";

const lotId = "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b3c";
const token = Buffer.from(lotId.replaceAll("-", ""), "hex").toString(
  "base64url",
);

describe("startPayloadOf", () => {
  it("reads the channel code without the prefix", () => {
    expect(startPayloadOf("s_tg_ads")).toEqual({ sourceCode: "tg_ads" });
  });

  it("passes an empty code after the prefix as received", () => {
    expect(startPayloadOf("s_")).toEqual({ sourceCode: "" });
  });

  it("reads a lot token of the auction bot link", () => {
    expect(startPayloadOf(`l_${token}`)).toEqual({ lotToken: token });
  });

  it("finds no target in a meetup link, a foreign or broken payload", () => {
    for (const payload of [
      "",
      "m_AZLzpLXGfY6fChssPU5fYA",
      "invite_token_1",
      "s_with spaces",
      `s_${"a".repeat(63)}`,
      // Токен лота — ровно 22 знака: обрезанный и удлинённый по ссылке прийти
      // не могли, и целью они не становятся.
      "l_short",
      `l_${token}a`,
    ]) {
      expect(startPayloadOf(payload)).toEqual({});
    }
  });
});

describe("lotIdOf", () => {
  it("restores the lot id the hub put in the link", () => {
    expect(lotIdOf(token)).toBe(lotId);
  });

  it("refuses a token that is not the canonical spelling of its bytes", () => {
    // Последний знак base64url несёт два значащих бита: у одного набора байт
    // четыре написания, а пишет хаб одно.
    expect(lotIdOf("a".repeat(22))).toBeUndefined();
    for (const broken of ["", "short", `${token}!`, token.slice(0, 21)]) {
      expect(lotIdOf(broken)).toBeUndefined();
    }
  });
});
