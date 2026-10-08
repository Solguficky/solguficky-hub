import { describe, expect, it } from "vitest";
import { readAuctionConfig } from "./config.js";

describe("readAuctionConfig", () => {
  it("treats an empty Auction address as unset", () => {
    expect(readAuctionConfig({ AUCTION_GRPC_URL: "" })).toEqual({
      ok: true,
      config: expect.objectContaining({ auctionUrl: "http://127.0.0.1:8081" }),
    });
  });

  // Аукцион ленты бот больше не берёт из конфигурации: списки читаются из
  // Auction (PER-453), и забытая переменная старого развёртывания не мешает.
  it("ignores a stale auction id", () => {
    const result = readAuctionConfig({ AUCTION_BOT_AUCTION_ID: "lot-1" });
    expect(result.ok && "auctionId" in result.config).toBe(false);
  });
});
