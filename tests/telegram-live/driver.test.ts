import {
  defaultProductionDc,
  defaultTestDc,
  writeStringSession,
} from "@mtcute/core/utils.js";
import { describe, expect, it } from "../../apps/hub-bot/testkit/index.js";
import { assertTestSession } from "./driver.js";
import { TelegramLiveFailure } from "./failure.js";

// Среда сессии проверяется до соединения: mtcute берёт адреса DC из самой
// строки сессии, и продакшн-строка увела бы драйвер в продакшн вопреки
// `testMode: true` клиента.

function sessionFor(primaryDcs: typeof defaultTestDc): string {
  return writeStringSession({
    version: 3,
    primaryDcs,
    authKey: new Uint8Array(256),
  });
}

function failureOf(run: () => void): TelegramLiveFailure | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof TelegramLiveFailure) {
      return error;
    }
    throw error;
  }
  return undefined;
}

describe("assertTestSession", () => {
  it("пропускает сессию тестовой среды", () => {
    expect(() => assertTestSession(sessionFor(defaultTestDc))).not.toThrow();
  });

  it("отвергает продакшн-сессию до соединения", () => {
    expect(
      failureOf(() => assertTestSession(sessionFor(defaultProductionDc)))?.kind,
    ).toBe("not-test-environment");
  });

  it("называет неразборчивую строку недействительной сессией", () => {
    expect(failureOf(() => assertTestSession("not-a-session"))?.kind).toBe(
      "session-invalid",
    );
  });
});
