import { describe, expect, it } from "vitest";
import { isTelegramBotUsername, supportBotLink } from "./entry.js";

describe("entry", () => {
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

  // Ссылка «Написать в поддержку ↗» несёт метку поверхности: по ней бот
  // поддержки помнит, откуда человек (ADR-068, п. 2).
  it("opens the support bot with the source of the surface", () => {
    expect(supportBotLink("solguficky_support_bot", "hub")).toBe(
      "https://t.me/solguficky_support_bot?start=hub",
    );
    expect(supportBotLink("solguficky_support_bot", "auction")).toBe(
      "https://t.me/solguficky_support_bot?start=auction",
    );
  });
});
