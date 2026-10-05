import { describe, expect, it } from "vitest";
import { readConfig } from "./config.js";

const base = {
  AUCTION_BOT_TOKEN: "123:auction",
  AUCTION_BOT_SERVICE_TOKEN: "service-token",
  AUCTION_BOT_COMMUNITY_TIME_ZONE: "Europe/Moscow",
};

describe("readConfig", () => {
  it("reads the bot's own token and caller token", () => {
    const result = readConfig(base);
    expect(result).toEqual({
      ok: true,
      config: expect.objectContaining({
        token: "123:auction",
        serviceToken: "service-token",
        environment: "prod",
      }),
    });
  });

  it.each([
    ["missing", {}],
    ["empty", { AUCTION_BOT_TOKEN: "" }],
    ["blank", { AUCTION_BOT_TOKEN: "  " }],
  ])("refuses a %s bot token", (_name, env) => {
    const result = readConfig({
      AUCTION_BOT_SERVICE_TOKEN: "service-token",
      ...env,
    });
    expect(result).toEqual({
      ok: false,
      error: "AUCTION_BOT_TOKEN is not set",
    });
  });

  it("never falls back to the hub bot token", () => {
    const result = readConfig({
      AUCTION_BOT_SERVICE_TOKEN: "service-token",
      HUB_BOT_TOKEN: "456:hub",
    });
    expect(result).toEqual({
      ok: false,
      error: "AUCTION_BOT_TOKEN is not set",
    });
  });

  it("refuses a missing caller token", () => {
    const result = readConfig({ AUCTION_BOT_TOKEN: "123:auction" });
    expect(result).toEqual({
      ok: false,
      error: "AUCTION_BOT_SERVICE_TOKEN is not set",
    });
  });

  it("refuses a caller token with surrounding whitespace", () => {
    const result = readConfig({ ...base, AUCTION_BOT_SERVICE_TOKEN: " t " });
    expect(result).toEqual({
      ok: false,
      error: "AUCTION_BOT_SERVICE_TOKEN has surrounding whitespace",
    });
  });

  it("accepts the test environment and refuses an unknown one", () => {
    expect(readConfig({ ...base, AUCTION_BOT_ENVIRONMENT: "test" })).toEqual({
      ok: true,
      config: expect.objectContaining({ environment: "test" }),
    });
    expect(readConfig({ ...base, AUCTION_BOT_ENVIRONMENT: "staging" })).toEqual(
      {
        ok: false,
        error: "AUCTION_BOT_ENVIRONMENT must be prod or test",
      },
    );
  });

  it("refuses a bot token with surrounding whitespace", () => {
    const result = readConfig({ ...base, AUCTION_BOT_TOKEN: "123:auction\n" });
    expect(result).toEqual({
      ok: false,
      error: "AUCTION_BOT_TOKEN has surrounding whitespace",
    });
  });

  it("treats an empty service address as unset", () => {
    const result = readConfig({
      ...base,
      IDENTITY_GRPC_URL: "",
      AUCTION_GRPC_URL: "",
    });
    expect(result).toEqual({
      ok: true,
      config: expect.objectContaining({
        identityUrl: "http://127.0.0.1:50051",
        auctionUrl: "http://127.0.0.1:8081",
      }),
    });
  });

  it("keeps token values out of every refusal", () => {
    const result = readConfig({ ...base, AUCTION_BOT_SERVICE_TOKEN: " t " });
    expect(JSON.stringify(result)).not.toContain("123:auction");
  });

  it("reads the community time zone and an optional auction", () => {
    const auctionId = "01929b7e-5c1d-7a3f-8e4b-0000000000a1";
    const withAuction = readConfig({
      ...base,
      AUCTION_BOT_AUCTION_ID: auctionId,
    });
    expect(withAuction).toEqual({
      ok: true,
      config: expect.objectContaining({
        communityTimeZone: "Europe/Moscow",
        auctionId,
      }),
    });
    const without = readConfig(base);
    expect(without.ok && "auctionId" in without.config).toBe(false);
  });

  it("presents the lot card rich unless the operator rolls back to plain", () => {
    const presentation = (value: string | undefined) => {
      const result = readConfig({ ...base, AUCTION_BOT_PRESENTATION: value });
      return result.ok ? result.config.presentation : result.error;
    };
    expect(presentation(undefined)).toBe("rich");
    expect(presentation("")).toBe("rich");
    expect(presentation("plain")).toBe("plain");
    expect(presentation("text")).toBe(
      "AUCTION_BOT_PRESENTATION must be rich or plain",
    );
  });

  it.each([
    ["missing", undefined],
    ["unknown", "Mars/Olympus"],
  ])("refuses a %s community time zone", (_name, zone) => {
    expect(
      readConfig({ ...base, AUCTION_BOT_COMMUNITY_TIME_ZONE: zone }),
    ).toEqual({
      ok: false,
      error: "AUCTION_BOT_COMMUNITY_TIME_ZONE must be an IANA time zone name",
    });
  });

  it.each([
    "01929B7E-5C1D-7A3F-8E4B-0000000000A1",
    "01929b7e5c1d7a3f8e4b0000000000a1",
    "lot-1",
  ])("refuses a non-canonical auction id %s", (auctionId) => {
    expect(readConfig({ ...base, AUCTION_BOT_AUCTION_ID: auctionId })).toEqual({
      ok: false,
      error: "AUCTION_BOT_AUCTION_ID must be a canonical lowercase UUID",
    });
  });
});
