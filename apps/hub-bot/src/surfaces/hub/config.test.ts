import { describe, expect, it } from "vitest";
import { defaultFaq } from "../../auction-faq.js";
import { readHubConfig } from "./config.js";

describe("readHubConfig", () => {
  it("leaves the meetup auction off without an Auction address", () => {
    for (const env of [{}, { AUCTION_GRPC_URL: "" }]) {
      const result = readHubConfig(env);
      expect(result.ok && "auctionUrl" in result.config).toBe(false);
    }
  });

  it("reads the neighbours' addresses with local defaults", () => {
    expect(readHubConfig({ AUCTION_GRPC_URL: "http://auction:8081" })).toEqual({
      ok: true,
      config: {
        meetupsUrl: "http://127.0.0.1:50052",
        notificationsUrl: "http://127.0.0.1:50053",
        auctionUrl: "http://auction:8081",
        faq: defaultFaq,
      },
    });
  });

  it("reads the shared auction FAQ content", () => {
    const result = readHubConfig({ AUCTION_FAQ_ITEMS: "Лоты" });
    expect(result.ok && result.config.faq.items).toBe("Лоты");
  });

  it("refuses an auction bot name that is not a bot username", () => {
    expect(
      readHubConfig({ BOT_AUCTION_BOT_USERNAME: "@solguficky_auction_bot" }),
    ).toEqual({
      ok: false,
      error: "BOT_AUCTION_BOT_USERNAME must be a Telegram bot username",
    });
    expect(
      readHubConfig({ BOT_AUCTION_BOT_USERNAME: "solguficky_auction_bot" }),
    ).toEqual({
      ok: true,
      config: expect.objectContaining({
        auctionBotUsername: "solguficky_auction_bot",
      }),
    });
  });

  // Имя бота поддержки проверяется так же: ссылка «Помощи» и кадра ожидания
  // ведёт в него (PER-625, ADR-068).
  it("refuses a support bot name that is not a bot username", () => {
    expect(
      readHubConfig({ BOT_SUPPORT_BOT_USERNAME: "@solguficky_support_bot" }),
    ).toEqual({
      ok: false,
      error: "BOT_SUPPORT_BOT_USERNAME must be a Telegram bot username",
    });
    expect(
      readHubConfig({ BOT_SUPPORT_BOT_USERNAME: "solguficky_support_bot" }),
    ).toEqual({
      ok: true,
      config: expect.objectContaining({
        supportBotUsername: "solguficky_support_bot",
      }),
    });
  });

  it("leaves the support bot off without its name", () => {
    const result = readHubConfig({});
    expect(result.ok && "supportBotUsername" in result.config).toBe(false);
  });
});
