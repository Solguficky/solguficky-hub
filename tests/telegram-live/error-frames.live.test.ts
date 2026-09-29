import { randomBytes } from "node:crypto";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from "../../apps/telegram-bot/testkit/index.js";
import { type LiveDriver, openLiveDriver } from "./driver.js";
import { classifyFailure } from "./failure.js";
import {
  pickLiveSecrets,
  pickMeetupPayloads,
  readSecretStore,
} from "./session.js";

// Кадры ошибок из telegram-bot.md на уровне L3 (ADR-046, PER-279). Логику
// кадров уже держит L2 (tests/contour/bot-wire); здесь проверяется только то,
// чего L2 не видит, — края Telegram: payload `/start`, доставленный настоящим
// клиентом, настоящий `callback_query` и настоящая правка сообщения. E-01,
// E-09 и остальные угловые случаи остаются на L2 — причины в telegram-bot.md.

const store = readSecretStore();
let driver: LiveDriver | undefined;

beforeAll(async () => {
  try {
    driver = await openLiveDriver(pickLiveSecrets(store));
  } catch (error) {
    throw classifyFailure(error);
  }
});

afterAll(async () => {
  await driver?.close();
});

function opened(): LiveDriver {
  if (driver === undefined) {
    throw new Error("драйвер не открыт: причина — в отказе beforeAll");
  }
  return driver;
}

describe("кадры ошибок в тестовой среде Telegram", () => {
  it("E-03: скрытая сходка по ссылке неотличима от несуществующей, опубликованная открывается", async () => {
    let payloads: ReturnType<typeof pickMeetupPayloads>;
    try {
      payloads = pickMeetupPayloads(store);
    } catch (error) {
      throw classifyFailure(error);
    }
    const live = opened();
    // Кнопки карточки несут токен сходки без префикса payload `m_`.
    const publishedToken = payloads.published.slice("m_".length);

    // Положительный путь первым: карточка доказывает, что payload этой формы
    // доходит до Meetups, а не превращается в чистый `/start`.
    const card = await live.sendStart(payloads.published);
    expect(card.callbackData).toContain(`v1:view:${publishedToken}`);

    const hidden = await live.sendStart(payloads.hidden);
    const missing = await live.sendStart(
      `m_${randomBytes(16).toString("base64url")}`,
    );

    expect(hidden.text).toBe("Сходка не найдена или больше недоступна.");
    expect(hidden.callbackData).toEqual(["v1:nav:hub"]);
    expect({ text: missing.text, callbackData: missing.callbackData }).toEqual({
      text: hidden.text,
      callbackData: hidden.callbackData,
    });
  });

  it("случай 4 и E-04: кнопка старого сообщения правит это же сообщение, а не присылает новое", async () => {
    const live = opened();
    const older = await live.sendStart();
    const newer = await live.sendStart();
    expect(newer.messageId).toBeGreaterThan(older.messageId);

    const edited = await live.press(older, "v1:nav:hub");

    // Экран списка узнаётся по клавиатуре: текст зависит от того, пуст ли
    // список. Домашний экран кнопки «Назад» не несёт.
    expect(edited.messageId).toBe(older.messageId);
    expect(edited.callbackData).toContain("v1:nav:start");
    expect(edited.callbackData).not.toContain("v1:manage:menu");
  });
});
