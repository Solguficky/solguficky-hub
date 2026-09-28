import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from "../../apps/telegram-bot/testkit/index.js";
import { type LiveDriver, openLiveDriver } from "./driver.js";
import { classifyFailure } from "./failure.js";
import { pickLiveSecrets, readSecretStore } from "./session.js";

// Уровень L3 (ADR-046): `/start` проходит через настоящий Telegram тестовой
// среды — приём сообщения, long polling и отрисовку ответа, которых не видит
// ни один другой уровень. Запускается `just telegram-live-test` против бота,
// поднятого владельцем; в verify, test-all и CI не входит.

let driver: LiveDriver | undefined;

beforeAll(async () => {
  try {
    driver = await openLiveDriver(pickLiveSecrets(readSecretStore()));
  } catch (error) {
    throw classifyFailure(error);
  }
});

afterAll(async () => {
  await driver?.close();
});

describe("/start в тестовой среде Telegram", () => {
  it("доходит до бота, и ответ с домашней клавиатурой прочитан", async () => {
    if (driver === undefined) {
      throw new Error("драйвер не открыт: причина — в отказе beforeAll");
    }
    const reply = await driver.sendStart();

    expect(reply.text).not.toBe("");
    expect(reply.callbackData).toContain("v1:nav:hub");
  });
});
