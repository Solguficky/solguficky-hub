import { describe, expect, it } from "vitest";
import { readSeedEnvironment } from "./environment.js";

const complete = {
  AUCTION_SEED_CATALOG: "catalog.json",
  IDENTITY_GRPC_URL: "http://127.0.0.1:1",
  MEETUPS_GRPC_URL: "http://127.0.0.1:2",
  AUCTION_GRPC_URL: "http://127.0.0.1:3",
  HUB_BOT_SERVICE_TOKEN: "token",
  AUCTION_SEED_ADMIN_TELEGRAM_ID: "42",
  BOT_COMMUNITY_TIME_ZONE: "Europe/Moscow",
};

describe("переменные наполнения", () => {
  it("читает полный набор", () => {
    expect(readSeedEnvironment(complete)).toMatchObject({
      administratorTelegramUserId: 42n,
      communityTimeZone: "Europe/Moscow",
    });
  });

  it("без переменной отказывает и называет каждую недостающую", () => {
    const {
      AUCTION_GRPC_URL: _auction,
      HUB_BOT_SERVICE_TOKEN: _token,
      ...rest
    } = complete;
    expect(() => readSeedEnvironment(rest)).toThrow(
      "не заданы переменные: AUCTION_GRPC_URL, HUB_BOT_SERVICE_TOKEN — наполнение не начато",
    );
  });

  it("пустое значение равно отсутствующему", () => {
    expect(() =>
      readSeedEnvironment({ ...complete, IDENTITY_GRPC_URL: "" }),
    ).toThrow(/IDENTITY_GRPC_URL/);
  });

  it("отвергает нечисловой Telegram id и неизвестный пояс", () => {
    expect(() =>
      readSeedEnvironment({
        ...complete,
        AUCTION_SEED_ADMIN_TELEGRAM_ID: "@admin",
      }),
    ).toThrow(/AUCTION_SEED_ADMIN_TELEGRAM_ID/);
    expect(() =>
      readSeedEnvironment({
        ...complete,
        BOT_COMMUNITY_TIME_ZONE: "Mars/Base",
      }),
    ).toThrow(/BOT_COMMUNITY_TIME_ZONE/);
  });
});
