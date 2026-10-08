import { GrammyError } from "grammy";
import { describe, expect, it, vi } from "vitest";
import { inspectCall } from "../../../../testkit/auction/screen-lint.js";
import { parseAuctionCallback } from "../../../auction-ui/index.js";
import { screenMark } from "../screen-catalog.js";
import {
  createNotificationSender,
  createRenderMessage,
  type NotificationReads,
  parseTraceCallback,
  renderNotification,
  traceAuctionsCallback,
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
const raised: AuctionNotificationContent = {
  kind: "lot-proxy-raised",
  lotId,
  currentPrice: { minorUnits: 160_000, currency: "RUB" },
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
      `Твою ставку на «Кружка» перебили. Текущая цена — 1${nbsp}500${nbsp}₽.`,
    );
  });

  // PER-473: лидер узнаёт, что его автоставка ответила чужой, с кнопкой на
  // тот же лот, что и перебитый.
  it("tells the leader the proxy answered and leads, with the lot button", () => {
    const message = renderNotification(raised, "Кружка");
    expect(message.text).toBe(
      `Твоя автоставка на «Кружка» подняла цену до 1${nbsp}600${nbsp}₽: лидируешь ты.`,
    );
    expect(message.button).toEqual({
      text: "К лоту",
      callback_data: traceLotCallback(lotId),
    });
  });

  it("names the lot and the sale price of a purchase", () => {
    expect(renderNotification(purchased, "Кружка").text).toBe(
      `Лот «Кружка» твой за 1${nbsp}500,50${nbsp}₽.`,
    );
  });

  // Предел сообщения Telegram отверг бы уведомление окончательно.
  it("shortens a title that would not fit the message", () => {
    const { text } = renderNotification(outbid, "Кружка ".repeat(1_000));
    expect(text.length).toBeLessThan(300);
    expect(text).toContain("…»");
  });

  it("does without the title when it is unknown", () => {
    expect(renderNotification(outbid).text).toBe(
      `Твою ставку на лот перебили. Текущая цена — 1${nbsp}500${nbsp}₽.`,
    );
    expect(renderNotification(purchased, "").text).toBe(
      `Лот твой за 1${nbsp}500,50${nbsp}₽.`,
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

  // Вход в аукцион из сообщения о допуске — тоже след (PER-442).
  it("carries an entry button inside a trace", () => {
    expect(parseTraceCallback(traceAuctionsCallback())).toBe(
      "v1:entry:auctions",
    );
  });

  it("refuses a trace that carries neither a lot nor an entry button", () => {
    expect(parseTraceCallback("v1:t:v1:entry:nowhere")).toBeUndefined();
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

describe("access granted", () => {
  it("tells the applicant they are admitted and leads into the auction", () => {
    const message = renderNotification({ kind: "access-granted" });
    expect(message.text).toBe("Тебя допустили к аукциону.");
    expect(message.button).toEqual({
      text: "Открыть аукцион",
      callback_data: traceAuctionsCallback(),
    });
  });

  // Лота у допуска нет: название не читается, а роль проверяется, как у торгов.
  it("checks the role and reads no lot", async () => {
    const source = reads();
    const render = createRenderMessage(source, () => {});
    await expect(
      render({ kind: "access-granted" }, { recipientId }),
    ).resolves.toMatchObject({ kind: "ready" });
    expect(source.hasPublicRole).toHaveBeenCalledWith(recipientId, undefined);
    expect(source.lotTitle).not.toHaveBeenCalled();
  });

  it("finds a recipient who lost the role ineligible", async () => {
    const render = createRenderMessage(
      reads({ hasPublicRole: vi.fn(async () => false) }),
      () => {},
    );
    await expect(
      render({ kind: "access-granted" }, { recipientId }),
    ).resolves.toEqual({ kind: "ineligible" });
  });
});

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

  // Отказ, который повтор не изменит, — дефект: снимается без повторов.
  it("rejects for good when Identity refuses the role check", async () => {
    const denied = Object.assign(new Error("permission denied"), { code: 7 });
    const render = createRenderMessage(
      reads({ hasPublicRole: vi.fn(async () => Promise.reject(denied)) }),
      () => {},
    );
    await expect(render(outbid, { recipientId })).resolves.toEqual({
      kind: "rejected",
      cause: denied,
    });
  });

  it("does not send a lot Auction cannot find", async () => {
    const missing = vi.fn();
    const notFound = Object.assign(new Error("lot not found"), { code: 5 });
    const render = createRenderMessage(
      reads({ lotTitle: vi.fn(async () => Promise.reject(notFound)) }),
      missing,
    );
    await expect(render(outbid, { recipientId })).resolves.toEqual({
      kind: "rejected",
      cause: notFound,
    });
    expect(missing).not.toHaveBeenCalled();
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
      ...screenMark("notification"),
      reply_markup: { inline_keyboard: [[message.button]] },
      link_preview_options: { is_disabled: true },
    });
  });

  // Отправка идёт мимо адаптера экранов, но метку каталога несёт: след с
  // кнопкой проходит линтер дизайн-кода, как любой экран (PER-472).
  it("marks every notification for the screen linter", async () => {
    const sent: unknown[] = [];
    const sendMessage = vi.fn(async (chat: number, text: string, extra) => {
      sent.push({ chat_id: chat, text, ...extra });
      return {};
    });
    const sender = createNotificationSender({ sendMessage } as never);
    for (const message of [
      renderNotification(outbid, "Кружка"),
      renderNotification(raised),
      renderNotification(purchased, "Кружка"),
      renderNotification({ kind: "access-granted" }),
    ]) {
      await sender.send({ telegramUserId: 42n, message });
    }
    expect(sent).toHaveLength(4);
    expect(sent.flatMap((call) => inspectCall("sendMessage", call))).toEqual(
      [],
    );
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
