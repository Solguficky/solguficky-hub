import { describe, expect, it } from "vitest";
import { readAuctionConfig } from "./config.js";

describe("readAuctionConfig", () => {
  it("treats an empty Auction address as unset", () => {
    expect(readAuctionConfig({ AUCTION_GRPC_URL: "" })).toEqual({
      ok: true,
      config: expect.objectContaining({ auctionUrl: "http://127.0.0.1:8081" }),
    });
  });

  // Без адреса Notifications настройки «перебили» в боте нет (PER-515).
  it("leaves Notifications unset without its address", () => {
    const result = readAuctionConfig({ NOTIFICATIONS_GRPC_URL: "" });
    expect(result.ok && "notificationsUrl" in result.config).toBe(false);
  });

  it("reads the Notifications address", () => {
    expect(
      readAuctionConfig({ NOTIFICATIONS_GRPC_URL: "http://127.0.0.1:50053" }),
    ).toEqual({
      ok: true,
      config: expect.objectContaining({
        notificationsUrl: "http://127.0.0.1:50053",
      }),
    });
  });

  // Аукцион ленты бот больше не берёт из конфигурации: списки читаются из
  // Auction (PER-453), и забытая переменная старого развёртывания не мешает.
  it("ignores a stale auction id", () => {
    const result = readAuctionConfig({ AUCTION_BOT_AUCTION_ID: "lot-1" });
    expect(result.ok && "auctionId" in result.config).toBe(false);
  });

  // Имя бота поддержки — адрес кнопки кадра ожидания допуска (PER-625,
  // ADR-068): без него кнопки нет, а чужое имя — отказ конфигурации.
  it("reads the support bot name", () => {
    expect(
      readAuctionConfig({ BOT_SUPPORT_BOT_USERNAME: "solguficky_support_bot" }),
    ).toEqual({
      ok: true,
      config: expect.objectContaining({
        supportBotUsername: "solguficky_support_bot",
      }),
    });
  });

  it("refuses a support bot name that is not a bot username", () => {
    expect(
      readAuctionConfig({ BOT_SUPPORT_BOT_USERNAME: "@support_bot" }),
    ).toEqual({
      ok: false,
      error: "BOT_SUPPORT_BOT_USERNAME must be a Telegram bot username",
    });
  });

  it("leaves the support bot off without its name", () => {
    const result = readAuctionConfig({});
    expect(result.ok && "supportBotUsername" in result.config).toBe(false);
  });
});
