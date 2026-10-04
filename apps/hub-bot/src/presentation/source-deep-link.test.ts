import { describe, expect, it } from "vitest";
import {
  isSourceChannelCode,
  isTelegramBotUsername,
  sourceStartLink,
} from "./source-deep-link.js";

describe("source deep link", () => {
  it("builds a start link with the s_ prefix", () => {
    expect(sourceStartLink("solguficky_bot", "tg_ads")).toBe(
      "https://t.me/solguficky_bot?start=s_tg_ads",
    );
  });

  it("accepts a code that fits the payload next to the prefix", () => {
    expect(isSourceChannelCode("tg_ads")).toBe(true);
    expect(isSourceChannelCode("A-z_9")).toBe(true);
    expect(isSourceChannelCode("a".repeat(62))).toBe(true);
    // Вместе с префиксом — ровно 64 символа payload, и ссылка остаётся рабочей.
    expect(`s_${"a".repeat(62)}`.length).toBe(64);
  });

  it("rejects a code outside the alphabet, empty or too long", () => {
    for (const code of ["", "a".repeat(63), "tg ads", "тг", "a.b", "@ads"]) {
      expect(isSourceChannelCode(code)).toBe(false);
    }
  });

  it("checks a bot username by Telegram rules", () => {
    expect(isTelegramBotUsername("solguficky_auction_bot")).toBe(true);
    expect(isTelegramBotUsername("AuctionBot")).toBe(true);
    // Границы длины Telegram: от 5 до 32 символов.
    expect(isTelegramBotUsername("a1bot")).toBe(true);
    expect(isTelegramBotUsername(`a${"b".repeat(28)}bot`)).toBe(true);
    for (const name of [
      "@auction_bot",
      "auction",
      "1auction_bot",
      "a b_bot",
      "abot",
      `a${"b".repeat(29)}bot`,
    ]) {
      expect(isTelegramBotUsername(name)).toBe(false);
    }
  });
});
