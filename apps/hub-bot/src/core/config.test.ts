import { describe, expect, it } from "vitest";
import {
  parseTelegramEnvironment,
  parseTimeZone,
  readProcessConfig,
} from "./config.js";

const base = {
  BOT_TOKEN: "123:auction",
  BOT_SERVICE_TOKEN: "service-token",
  BOT_COMMUNITY_TIME_ZONE: "Europe/Moscow",
};

const readConfig = (env: Record<string, string | undefined>) =>
  readProcessConfig(env, "auction");

describe("readProcessConfig", () => {
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
    ["empty", { BOT_TOKEN: "" }],
    ["blank", { BOT_TOKEN: "  " }],
  ])("refuses a %s bot token", (_name, env) => {
    const result = readConfig({
      BOT_SERVICE_TOKEN: "service-token",
      ...env,
    });
    expect(result).toEqual({
      ok: false,
      error: "BOT_TOKEN is not set",
    });
  });

  it("refuses a missing caller token", () => {
    const result = readConfig({ BOT_TOKEN: "123:auction" });
    expect(result).toEqual({
      ok: false,
      error: "BOT_SERVICE_TOKEN is not set",
    });
  });

  it("refuses a caller token with surrounding whitespace", () => {
    const result = readConfig({ ...base, BOT_SERVICE_TOKEN: " t " });
    expect(result).toEqual({
      ok: false,
      error: "BOT_SERVICE_TOKEN has surrounding whitespace",
    });
  });

  it("accepts the test environment and refuses an unknown one", () => {
    expect(readConfig({ ...base, BOT_ENVIRONMENT: "test" })).toEqual({
      ok: true,
      config: expect.objectContaining({ environment: "test" }),
    });
    expect(readConfig({ ...base, BOT_ENVIRONMENT: "staging" })).toEqual({
      ok: false,
      error: "BOT_ENVIRONMENT must be prod or test",
    });
  });

  it("refuses a bot token with surrounding whitespace", () => {
    const result = readConfig({ ...base, BOT_TOKEN: "123:auction\n" });
    expect(result).toEqual({
      ok: false,
      error: "BOT_TOKEN has surrounding whitespace",
    });
  });

  it("treats an empty value as unset", () => {
    const result = readConfig({
      ...base,
      IDENTITY_GRPC_URL: "",
      BOT_NATS_URL: "",
      BOT_LOG_LEVEL: "",
    });
    expect(result).toEqual({
      ok: true,
      config: expect.objectContaining({
        identityUrl: "http://127.0.0.1:50051",
        natsUrl: "nats://127.0.0.1:4222",
        logLevel: "info",
      }),
    });
  });

  it.each([
    ["hub", "hub-bot"],
    ["auction", "auction-bot"],
  ] as const)("names the %s surface service %s", (surface, service) => {
    expect(readProcessConfig(base, surface)).toEqual({
      ok: true,
      config: expect.objectContaining({ surface, service }),
    });
  });

  it("keeps token values out of every refusal", () => {
    const result = readConfig({ ...base, BOT_SERVICE_TOKEN: " t " });
    expect(JSON.stringify(result)).not.toContain("123:auction");
  });

  it("presents the lot card rich unless the operator rolls back to plain", () => {
    const presentation = (value: string | undefined) => {
      const result = readConfig({ ...base, BOT_PRESENTATION: value });
      return result.ok ? result.config.presentation : result.error;
    };
    expect(presentation(undefined)).toBe("rich");
    expect(presentation("")).toBe("rich");
    expect(presentation("plain")).toBe("plain");
    expect(presentation("text")).toBe("BOT_PRESENTATION must be rich or plain");
  });

  it.each([
    ["missing", undefined],
    ["unknown", "Mars/Olympus"],
  ])("refuses a %s community time zone", (_name, zone) => {
    expect(readConfig({ ...base, BOT_COMMUNITY_TIME_ZONE: zone })).toEqual({
      ok: false,
      error: "BOT_COMMUNITY_TIME_ZONE must be an IANA time zone name",
    });
  });
});

describe("telegram environment", () => {
  it("reads an absent or empty variable as production", () => {
    expect(parseTelegramEnvironment(undefined)).toBe("prod");
    expect(parseTelegramEnvironment("")).toBe("prod");
  });

  it("accepts exactly the two known values", () => {
    expect(parseTelegramEnvironment("prod")).toBe("prod");
    expect(parseTelegramEnvironment("test")).toBe("test");
  });

  it("refuses an unknown value instead of falling back to production", () => {
    expect(parseTelegramEnvironment("Test")).toBeUndefined();
    expect(parseTelegramEnvironment("production")).toBeUndefined();
    expect(parseTelegramEnvironment(" test")).toBeUndefined();
  });
});

describe("community time zone", () => {
  it("accepts an IANA zone and rejects a missing or unknown one", () => {
    expect(parseTimeZone("Europe/Moscow")).toBe("Europe/Moscow");
    expect(parseTimeZone(undefined)).toBeUndefined();
    expect(parseTimeZone("")).toBeUndefined();
    expect(parseTimeZone("Europe/Moskva")).toBeUndefined();
  });
});
