import { parseAuctionCallback } from "@solguficky/auction-bot-ui";
import { GrammyError } from "grammy";
import { describe, expect, it, vi } from "vitest";
import {
  createNotificationSender,
  createRenderMessage,
  type NotificationReads,
  parseTraceCallback,
  renderNotification,
  traceLotCallback,
} from "./message.js";
import type { AuctionNotificationContent } from "./notification.js";

const lotId = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34d0";
const recipientId = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd";
const outbid: AuctionNotificationContent = {
  kind: "lot-outbid",
  lotId,
  currentPrice: { minorUnits: 150_000, currency: "RUB" },
};
const purchased: AuctionNotificationContent = {
  kind: "lot-purchased",
  lotId,
  price: { minorUnits: 150_050, currency: "RUB" },
};

// Пробел в сумме — неразрывный, как его ставит Intl.NumberFormat ru-RU.
const nbsp = " ";

describe("renderNotification", () => {
  it("names the lot and the current price of an outbid", () => {
    expect(renderNotification(outbid, "Кружка").text).toBe(
      `Вашу ставку на «Кружка» перебили. Текущая цена — 1${nbsp}500${nbsp}₽.`,
    );
  });

  it("names the lot and the sale price of a purchase", () => {
    expect(renderNotification(purchased, "Кружка").text).toBe(
      `Лот «Кружка» ваш за 1${nbsp}500,50${nbsp}₽.`,
    );
  });

  it("does without the title when it is unknown", () => {
    expect(renderNotification(outbid).text).toBe(
      `Вашу ставку на лот перебили. Текущая цена — 1${nbsp}500${nbsp}₽.`,
    );
    expect(renderNotification(purchased, "").text).toBe(
      `Лот ваш за 1${nbsp}500,50${nbsp}₽.`,
    );
  });

  // Критерий приёмки: факт перебития доходит с кнопкой на карточку лота.
  it("leads to the lot card with a trace button", () => {
    const { button } = renderNotification(outbid, "Кружка");
    expect(button.text).toBe("К лоту");
    expect(Buffer.byteLength(button.callback_data)).toBeLessThanOrEqual(64);
    const inner = parseTraceCallback(button.callback_data);
    expect(inner).toBeDefined();
    expect(parseAuctionCallback(inner)).toEqual({
      ok: true,
      intent: { kind: "lot", lotId, page: 0 },
    });
  });
});

describe("parseTraceCallback", () => {
  it("passes an ordinary button through as not a trace", () => {
    expect(parseTraceCallback("v1:entry:menu")).toBeUndefined();
  });

  it("refuses a trace that does not carry a lot button", () => {
    expect(parseTraceCallback("v1:t:v1:entry:menu")).toBeUndefined();
    expect(parseTraceCallback(traceLotCallback(lotId).slice(0, -3))).toBe(
      undefined,
    );
  });
});

function reads(overrides: Partial<NotificationReads> = {}): NotificationReads {
  return {
    hasPublicRole: vi.fn(async () => true),
    lotTitle: vi.fn(async () => "Кружка"),
    ...overrides,
  };
}

describe("createRenderMessage", () => {
  it("reads the title as the recipient with the public role", async () => {
    const source = reads();
    const render = createRenderMessage(source, () => {});
    await expect(
      render(outbid, { recipientId, requestId: "req-1" }),
    ).resolves.toMatchObject({
      kind: "ready",
      message: { text: expect.stringContaining("«Кружка»") },
    });
    expect(source.hasPublicRole).toHaveBeenCalledWith(recipientId, "req-1");
    expect(source.lotTitle).toHaveBeenCalledWith(recipientId, lotId, "req-1");
  });

  // Без роли кнопка упёрлась бы в тот же отказ Auction: уведомление не уходит.
  it("finds a recipient without the public role ineligible", async () => {
    const source = reads({ hasPublicRole: vi.fn(async () => false) });
    const render = createRenderMessage(source, () => {});
    await expect(render(outbid, { recipientId })).resolves.toEqual({
      kind: "ineligible",
    });
    expect(source.lotTitle).not.toHaveBeenCalled();
  });

  it("asks for a retry when Identity cannot say", async () => {
    const down = new Error("unavailable");
    const render = createRenderMessage(
      reads({ hasPublicRole: vi.fn(async () => Promise.reject(down)) }),
      () => {},
    );
    await expect(render(outbid, { recipientId })).resolves.toEqual({
      kind: "unavailable",
      cause: down,
    });
  });

  // Перебитие ценно вовремя: отказ Auction стоит уведомлению названия, а не
  // доставки, и виден в логе.
  it("sends without the title when Auction does not give it", async () => {
    const missing = vi.fn();
    const down = new Error("unavailable");
    const render = createRenderMessage(
      reads({ lotTitle: vi.fn(async () => Promise.reject(down)) }),
      missing,
    );
    await expect(
      render(outbid, { recipientId, requestId: "req-1" }),
    ).resolves.toMatchObject({
      kind: "ready",
      message: { text: expect.stringContaining("на лот перебили") },
    });
    expect(missing).toHaveBeenCalledWith(down, "req-1");
  });
});

describe("notification sender", () => {
  it("sends the text with the lot button to the private chat", async () => {
    const sendMessage = vi.fn().mockResolvedValue({});
    const sender = createNotificationSender({ sendMessage } as never);
    const message = renderNotification(outbid, "Кружка");
    await expect(
      sender.send({ telegramUserId: 42n, message }),
    ).resolves.toEqual({ kind: "sent" });
    expect(sendMessage).toHaveBeenCalledWith(42, message.text, {
      reply_markup: { inline_keyboard: [[message.button]] },
      link_preview_options: { is_disabled: true },
    });
  });

  // Критерий приёмки: заблокировавший бота человек — окончательный отказ.
  it("reports a recipient who blocked the bot", async () => {
    const blocked = new GrammyError(
      "Call to 'sendMessage' failed!",
      { ok: false, error_code: 403, description: "Forbidden: bot was blocked" },
      "sendMessage",
      {},
    );
    const sender = createNotificationSender({
      sendMessage: vi.fn().mockRejectedValue(blocked),
    } as never);
    await expect(
      sender.send({
        telegramUserId: 42n,
        message: renderNotification(outbid),
      }),
    ).resolves.toMatchObject({ kind: "bot-blocked" });
  });
});
