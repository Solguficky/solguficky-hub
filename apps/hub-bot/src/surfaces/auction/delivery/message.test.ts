import { GrammyError } from "grammy";
import { describe, expect, it, vi } from "vitest";
import { inspectCall } from "../../../../testkit/screen-lint.js";
import { parseAuctionCallback } from "../../../auction-ui/index.js";
import { notifyCallback, parseEntryCallback } from "../faq.js";
import { screenMark } from "../screen-catalog.js";
import {
  createNotificationSender,
  createRenderMessage,
  type NotificationReads,
  notificationMarkup,
  parseTraceCallback,
  renderNotification,
  traceFaqCallback,
  traceLotCallback,
  traceNotifyCallback,
  tracePredictionResultsCallback,
  traceRaffleCallback,
  traceRootCallback,
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

// Название лота глазами получателя: рендер берёт его из карты по лоту.
const titled = (title: string, id = lotId) => new Map([[id, { title }]]);

describe("renderNotification", () => {
  it("names the lot and the current price of an outbid", () => {
    expect(renderNotification(outbid, titled("Кружка")).text).toBe(
      `Твою ставку перебили: <b>Кружка</b>, цена 1${nbsp}500${nbsp}₽.`,
    );
  });

  // PER-473: лидер узнаёт, что его автоставка ответила чужой, с кнопкой на
  // тот же лот, что и перебитый.
  it("tells the leader the proxy answered and leads, with the lot button", () => {
    const message = renderNotification(raised, titled("Кружка"));
    expect(message.text).toBe(
      `Твоя автоставка на <b>Кружка</b> подняла цену до 1${nbsp}600${nbsp}₽: лидируешь ты.`,
    );
    expect(message.rows).toEqual([
      [{ text: "К лоту", callback_data: traceLotCallback(lotId) }],
    ]);
  });

  // Запись 37 прогона 12.10: покупка называет лот и следующий шаг.
  it("names the lot, the sale price and the next step of a purchase", () => {
    expect(renderNotification(purchased, titled("Кружка")).text).toBe(
      `Лот <b>Кружка</b> твой за 1${nbsp}500,50${nbsp}₽. Как оплатить и забрать — напишет организатор аукциона.`,
    );
  });

  // Предел сообщения Telegram отверг бы уведомление окончательно.
  it("shortens a title that would not fit the message", () => {
    const { text } = renderNotification(
      outbid,
      titled("Кружка ".repeat(1_000)),
    );
    expect(text.length).toBeLessThan(300);
    expect(text).toContain("…</b>");
  });

  it("does without the title when it is unknown", () => {
    expect(renderNotification(outbid).text).toBe(
      `Твою ставку перебили, цена 1${nbsp}500${nbsp}₽.`,
    );
    expect(renderNotification(purchased, titled("")).text).toBe(
      `Лот твой за 1${nbsp}500,50${nbsp}₽. Как оплатить и забрать — напишет организатор аукциона.`,
    );
  });

  // Критерий приёмки: факт перебития доходит с кнопкой на карточку лота.
  it("leads to the lot card with a trace button", () => {
    const button = renderNotification(outbid, titled("Кружка")).rows?.[0]?.[0];
    if (button === undefined)
      throw new Error("the outbid must lead to the lot");
    expect(button.text).toBe("К лоту");
    expect(Buffer.byteLength(button.callback_data)).toBeLessThanOrEqual(64);
    const inner = parseTraceCallback(button.callback_data);
    expect(inner).toBeDefined();
    expect(parseAuctionCallback(inner)).toEqual({
      ok: true,
      intent: { kind: "lot", lotId, page: 0 },
    });
  });

  // PER-537: весть о повышении — без кнопки. В боте аукциона участник дальше
  // экрана перехода в сообщество не пройдёт, и обещать кнопкой нечего.
  it("tells the promoted guest they are in the community, with no button", () => {
    const message = renderNotification({ kind: "circle-promoted" });
    expect(message.text).toBe("Тебя приняли в сообщество.");
    expect(message.rows).toBeUndefined();
    expect(notificationMarkup(message)).toBeUndefined();
  });
});

// PER-515, PER-598: «Частота уведомлений» стоит рядом с «К лоту» под тем, чем
// частота управляет, — перебитием и ответом автоставки — и только у бота с
// Notifications; покупку настройка не трогает.
describe("frequency button", () => {
  it("pairs the lot button with the frequency under an outbid and a proxy answer", () => {
    for (const content of [outbid, raised]) {
      expect(
        notificationMarkup(renderNotification(content, titled("Кружка"), true)),
      ).toEqual({
        inline_keyboard: [
          [
            { text: "К лоту", callback_data: traceLotCallback(lotId) },
            {
              text: "Частота уведомлений",
              callback_data: traceNotifyCallback(),
            },
          ],
        ],
      });
    }
    // Из вести экран частоты открывается без возврата в дерево настроек
    // (№73 прогона 14 октября 2026 года).
    const inner = parseTraceCallback(traceNotifyCallback());
    expect(inner).toBe(notifyCallback(undefined, true));
    expect(parseEntryCallback(inner)).toEqual({
      action: "notify",
      page: 0,
      detached: true,
    });
    expect(Buffer.byteLength(traceNotifyCallback())).toBeLessThanOrEqual(64);
  });

  it("keeps the lot button alone under a purchase and without Notifications", () => {
    const alone = [{ text: "К лоту", callback_data: traceLotCallback(lotId) }];
    expect(renderNotification(purchased, titled("Кружка"), true).rows).toEqual([
      alone,
    ]);
    expect(renderNotification(outbid, titled("Кружка")).rows).toEqual([alone]);
  });

  it("puts the frequency under an outbid rendered for delivery", async () => {
    const reads: NotificationReads = {
      holdsPlaceBids: async () => true,
      lotInfo: async () => ({ title: "Кружка" }),
    };
    const render = createRenderMessage(reads, () => {}, true);
    const rendered = await render(outbid, { recipientId });
    if (rendered.kind !== "ready") throw new Error("the outbid must render");
    expect(rendered.message.rows?.[0]?.[1]?.text).toBe("Частота уведомлений");
  });
});

// Сводка окна частоты (PER-596): одно сообщение, ряд на лот и ряд частоты
// (PER-598).
describe("activity digest", () => {
  const otherLot = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34d1";
  const digest: AuctionNotificationContent = {
    kind: "lot-activity-digest",
    lines: [
      {
        lotId,
        kind: "outbid",
        currentPrice: { minorUnits: 150_000, currency: "RUB" },
        recipientLeads: false,
      },
      {
        lotId: otherLot,
        kind: "proxy-raised",
        currentPrice: { minorUnits: 90_000, currency: "RUB" },
        recipientLeads: true,
      },
    ],
  };

  it("opens every lot from one message", async () => {
    const source = reads({
      lotInfo: vi.fn(async (_who: string, id: string) => ({
        title: id === lotId ? "Кружка" : "Плакат",
      })),
    });
    const render = createRenderMessage(source, () => {}, true);
    const rendered = await render(digest, { recipientId });
    if (rendered.kind !== "ready") throw new Error("the digest must render");
    expect(rendered.message.text).toBe(
      [
        "Сводка по твоим ставкам:",
        "",
        `• <b>Кружка</b> — перебили, цена 1${nbsp}500${nbsp}₽`,
        `• <b>Плакат</b> — автоставка подняла цену до 900${nbsp}₽, лот за тобой`,
      ].join("\n"),
    );
    expect(notificationMarkup(rendered.message)).toEqual({
      inline_keyboard: [
        [{ text: "Кружка", callback_data: traceLotCallback(lotId) }],
        [{ text: "Плакат", callback_data: traceLotCallback(otherLot) }],
        [{ text: "Частота уведомлений", callback_data: traceNotifyCallback() }],
      ],
    });
    expect(source.holdsPlaceBids).toHaveBeenCalledTimes(1);
  });

  // Отказ по одному лоту остальные строки не роняет: строка уходит без
  // названия и кнопки, а отказ виден в логе.
  it("keeps the other lines when one title is refused for good", async () => {
    const missing = vi.fn();
    const notFound = Object.assign(new Error("lot not found"), { code: 5 });
    const render = createRenderMessage(
      reads({
        lotInfo: vi.fn(async (_who: string, id: string) =>
          id === lotId ? Promise.reject(notFound) : { title: "Плакат" },
        ),
      }),
      missing,
    );
    const rendered = await render(digest, { recipientId });
    if (rendered.kind !== "ready") throw new Error("the digest must render");
    expect(rendered.message.text).toContain("• Лот — перебили");
    expect(rendered.message.text).toContain("• <b>Плакат</b> —");
    // Кнопки к лоту, который Auction не отдаёт, нет: она упёрлась бы в тот же
    // отказ.
    expect(rendered.message.rows?.[0]?.[0]?.text).toBe("Плакат");
    expect(missing).toHaveBeenCalledWith(notFound, undefined);
  });

  it("finds a recipient without the right to bid ineligible", async () => {
    const render = createRenderMessage(
      reads({ holdsPlaceBids: vi.fn(async () => false) }),
      () => {},
    );
    await expect(render(digest, { recipientId })).resolves.toEqual({
      kind: "ineligible",
    });
  });

  it("passes the screen linter", async () => {
    const sent: unknown[] = [];
    const sender = createNotificationSender({
      sendMessage: vi.fn(async (chat: number, text: string, extra) => {
        sent.push({ chat_id: chat, text, ...extra });
        return {};
      }),
    } as never);
    await sender.send({
      telegramUserId: 42n,
      message: renderNotification(digest, titled("Кружка"), true),
    });
    expect(
      sent.flatMap((call) => inspectCall("auction", "sendMessage", call)),
    ).toEqual([]);
  });
});

// Начало окна «Счастливых часов» (PER-616): одно сообщение с шагом и концом
// окна и рядом на каждый лот окна.
describe("step window", () => {
  const otherLot = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34d1";
  const start: AuctionNotificationContent = {
    kind: "step-window-started",
    auctionId: "5f0c1a2b-3c4d-5e6f-8a9b-0c1d2e3f4a5b",
    lots: [
      {
        lotId,
        until: "2026-10-21T21:00:00Z",
        step: { minorUnits: 50_000, currency: "RUB" },
      },
      {
        lotId: otherLot,
        until: "2026-10-21T22:00:00Z",
        step: { minorUnits: 90_000, currency: "RUB" },
      },
    ],
  };

  it("names the step and the end of the window and opens every lot", async () => {
    const source = reads({
      lotInfo: vi.fn(async (_who: string, id: string) => ({
        title: id === lotId ? "Кружка" : "Плакат",
      })),
    });
    const render = createRenderMessage(source, () => {}, true);
    const rendered = await render(start, { recipientId });
    if (rendered.kind !== "ready") throw new Error("the window must render");
    expect(rendered.message.text).toBe(
      [
        "Счастливые часы начались:",
        "",
        `• «Кружка» — шаг 500${nbsp}₽ до 21:00`,
        `• «Плакат» — шаг 900${nbsp}₽ до 22:00`,
      ].join("\n"),
    );
    expect(notificationMarkup(rendered.message)).toEqual({
      inline_keyboard: [
        [{ text: "Кружка", callback_data: traceLotCallback(lotId) }],
        [{ text: "Плакат", callback_data: traceLotCallback(otherLot) }],
      ],
    });
  });

  // Частоты под вестью нет: повод выключается снятием отметки (ADR-047).
  it("has no frequency button under the notice", async () => {
    const render = createRenderMessage(reads(), () => {}, true);
    const rendered = await render(start, { recipientId });
    if (rendered.kind !== "ready") throw new Error("the window must render");
    expect(
      rendered.message.rows?.flat().map((button) => button.text),
    ).not.toContain("Частота уведомлений");
    expect(rendered.message.rows).toHaveLength(2);
  });

  it("passes the screen linter", async () => {
    const sent: unknown[] = [];
    const sender = createNotificationSender({
      sendMessage: vi.fn(async (chat: number, text: string, extra) => {
        sent.push({ chat_id: chat, text, ...extra });
        return {};
      }),
    } as never);
    await sender.send({
      telegramUserId: 42n,
      message: renderNotification(start, titled("Кружка")),
    });
    expect(
      sent.flatMap((call) => inspectCall("auction", "sendMessage", call)),
    ).toEqual([]);
  });
});

describe("parseTraceCallback", () => {
  it("passes an ordinary button through as not a trace", () => {
    expect(parseTraceCallback("v1:entry:menu")).toBeUndefined();
  });

  // Вход в аукцион из сообщения о допуске — тоже след (PER-442): FAQ, а не
  // список аукционов, — у допущенного впереди правила (PER-592).
  it("carries an entry button inside a trace", () => {
    expect(parseTraceCallback(traceFaqCallback())).toBe("v1:entry:faq");
  });

  // «К розыгрышу» под итогом розыгрыша (PER-620) — тоже след.
  it("carries a prediction results button inside a trace", () => {
    const auctionId = "5f0c1a2b-3c4d-5e6f-8a9b-0c1d2e3f4a5b";
    const inner = parseTraceCallback(tracePredictionResultsCallback(auctionId));
    expect(inner).toBeDefined();
    const parsed = parseAuctionCallback(inner ?? "");
    expect(parsed.ok && parsed.intent).toEqual({
      kind: "prediction-results",
      auctionId,
    });
  });

  it("carries a raffle button inside a trace", () => {
    const auctionId = "5f0c1a2b-3c4d-5e6f-8a9b-0c1d2e3f4a5b";
    const inner = parseTraceCallback(traceRaffleCallback(auctionId));
    expect(inner).toBeDefined();
    const parsed = parseAuctionCallback(inner ?? "");
    expect(parsed.ok && parsed.intent).toEqual({ kind: "raffle", auctionId });
  });

  // «К аукциону» под извещением об отмене (PER-606) — тоже след.
  it("carries a root button inside a trace", () => {
    const auctionId = "5f0c1a2b-3c4d-5e6f-8a9b-0c1d2e3f4a5b";
    const inner = parseTraceCallback(traceRootCallback(auctionId));
    const parsed = parseAuctionCallback(inner ?? "");
    expect(parsed.ok && parsed.intent).toEqual({ kind: "root", auctionId });
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
    holdsPlaceBids: vi.fn(async () => true),
    lotInfo: vi.fn(async () => ({ title: "Кружка" })),
    ...overrides,
  };
}

// Итог розыгрыша (PER-620): весть без права и без чтений, с кнопкой следа на
// экран итога.
describe("prediction results notice", () => {
  const auctionId = "5f0c1a2b-3c4d-5e6f-8a9b-0c1d2e3f4a5b";

  it("tells the guest the results are ready", () => {
    const message = renderNotification({
      kind: "prediction-results",
      auctionId,
    });
    expect(message.text).toBe("Итоги твоих прогнозов подведены.");
    expect(message.rows).toEqual([
      [
        {
          text: "К итогам",
          callback_data: tracePredictionResultsCallback(auctionId),
        },
      ],
    ]);
  });
});

describe("raffle result", () => {
  const auctionId = "5f0c1a2b-3c4d-5e6f-8a9b-0c1d2e3f4a5b";
  const result = (
    ticket: number,
    prize?: string,
  ): AuctionNotificationContent => ({
    kind: "raffle-result",
    auctionId,
    ticket,
    winningTicket: 7,
    ticketCount: 12,
    ...(prize === undefined ? {} : { prize }),
  });

  it("tells the winner their ticket won", () => {
    expect(renderNotification(result(7)).text).toBe(
      "Твой билет №7 из 12 выиграл розыгрыш среди участников.",
    );
  });

  // Приз из факта называет себя в вести победителя (PER-649).
  it("names the prize to the winner", () => {
    expect(renderNotification(result(7, "сертификат на 5000 ₽")).text).toBe(
      "Твой билет №7 из 12 выиграл розыгрыш среди участников: приз — сертификат на 5000 ₽, а организатор напишет тебе, как его получить.",
    );
  });

  it("tells the others the winning ticket and their own", () => {
    const message = renderNotification(result(3));
    expect(message.text).toBe(
      "Розыгрыш среди участников проведён: выиграл билет №7 из 12, твой — №3.",
    );
    expect(message.rows).toEqual([
      [{ text: "К розыгрышу", callback_data: traceRaffleCallback(auctionId) }],
    ]);
  });

  it("asks Identity nothing and reads no lot", async () => {
    const source = reads();
    const render = createRenderMessage(source, () => {});
    await expect(render(result(3), { recipientId })).resolves.toMatchObject({
      kind: "ready",
    });
    expect(source.holdsPlaceBids).not.toHaveBeenCalled();
    expect(source.lotInfo).not.toHaveBeenCalled();
  });
});

describe("access granted", () => {
  it("tells the applicant they are admitted and leads into the auction", () => {
    const message = renderNotification({ kind: "access-granted" });
    expect(message.text).toBe("Тебя допустили к аукциону.");
    expect(message.rows).toEqual([
      [{ text: "Правила и FAQ", callback_data: traceFaqCallback() }],
    ]);
  });

  // Лота у допуска нет: название не читается, а роль проверяется, как у торгов.
  it("checks the right to bid and reads no lot", async () => {
    const source = reads();
    const render = createRenderMessage(source, () => {});
    await expect(
      render({ kind: "access-granted" }, { recipientId }),
    ).resolves.toMatchObject({ kind: "ready" });
    expect(source.holdsPlaceBids).toHaveBeenCalledWith(recipientId, undefined);
    expect(source.lotInfo).not.toHaveBeenCalled();
  });

  it("finds a recipient who lost the right to bid ineligible", async () => {
    const render = createRenderMessage(
      reads({ holdsPlaceBids: vi.fn(async () => false) }),
      () => {},
    );
    await expect(
      render({ kind: "access-granted" }, { recipientId }),
    ).resolves.toEqual({ kind: "ineligible" });
  });
});

describe("createRenderMessage", () => {
  // Право ставить для вести о круге не спрашивается, и лот не читается: она не
  // о торгах, и кнопки, которая упёрлась бы в отказ, у неё нет (PER-537).
  it("reads neither the right to bid nor the lot", async () => {
    const source = reads();
    const render = createRenderMessage(source, () => {});
    await expect(
      render({ kind: "circle-promoted" }, { recipientId }),
    ).resolves.toMatchObject({
      kind: "ready",
      message: { text: "Тебя приняли в сообщество." },
    });
    expect(source.holdsPlaceBids).not.toHaveBeenCalled();
    expect(source.lotInfo).not.toHaveBeenCalled();
  });

  it("reads the title as the recipient with the right to bid", async () => {
    const source = reads();
    const render = createRenderMessage(source, () => {});
    await expect(
      render(outbid, { recipientId, requestId: "req-1" }),
    ).resolves.toMatchObject({
      kind: "ready",
      message: { text: expect.stringContaining("<b>Кружка</b>") },
    });
    expect(source.holdsPlaceBids).toHaveBeenCalledWith(recipientId, "req-1");
    expect(source.lotInfo).toHaveBeenCalledWith(recipientId, lotId, "req-1");
  });

  // Без роли кнопка упёрлась бы в тот же отказ Auction: уведомление не уходит.
  it("finds a recipient without the right to bid ineligible", async () => {
    const source = reads({ holdsPlaceBids: vi.fn(async () => false) });
    const render = createRenderMessage(source, () => {});
    await expect(render(outbid, { recipientId })).resolves.toEqual({
      kind: "ineligible",
    });
    expect(source.lotInfo).not.toHaveBeenCalled();
  });

  // Отказ, который повтор не изменит, — дефект: снимается без повторов.
  it("rejects for good when Identity refuses the right check", async () => {
    const denied = Object.assign(new Error("permission denied"), { code: 7 });
    const render = createRenderMessage(
      reads({ holdsPlaceBids: vi.fn(async () => Promise.reject(denied)) }),
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
      reads({ lotInfo: vi.fn(async () => Promise.reject(notFound)) }),
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
      reads({ holdsPlaceBids: vi.fn(async () => Promise.reject(down)) }),
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
      reads({ lotInfo: vi.fn(async () => Promise.reject(down)) }),
      missing,
    );
    await expect(
      render(outbid, { recipientId, requestId: "req-1" }),
    ).resolves.toMatchObject({
      kind: "ready",
      message: { text: expect.stringContaining("Твою ставку перебили, цена") },
    });
    expect(missing).toHaveBeenCalledWith(down, "req-1");
  });
});

describe("notification sender", () => {
  it("sends the text with the lot button to the private chat", async () => {
    const sendMessage = vi.fn().mockResolvedValue({});
    const sender = createNotificationSender({ sendMessage } as never);
    const message = renderNotification(outbid, titled("Кружка"));
    await expect(
      sender.send({ telegramUserId: 42n, message }),
    ).resolves.toEqual({ kind: "sent" });
    // Весть о лоте — HTML: название жирным (№71 прогона 14 октября 2026 года).
    expect(sendMessage).toHaveBeenCalledWith(42, message.text, {
      ...screenMark("notification"),
      reply_markup: { inline_keyboard: message.rows },
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  });

  // Весть о смене круга идёт без клавиатуры (PER-537).
  it("sends the promotion without a keyboard", async () => {
    const sendMessage = vi.fn().mockResolvedValue({});
    const sender = createNotificationSender({ sendMessage } as never);
    await expect(
      sender.send({
        telegramUserId: 42n,
        message: renderNotification({ kind: "circle-promoted" }),
      }),
    ).resolves.toEqual({ kind: "sent" });
    expect(sendMessage).toHaveBeenCalledWith(42, "Тебя приняли в сообщество.", {
      ...screenMark("notification"),
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
      renderNotification(outbid, titled("Кружка")),
      renderNotification(outbid, titled("Кружка"), true),
      renderNotification(raised),
      renderNotification(purchased, titled("Кружка")),
      renderNotification({ kind: "access-granted" }),
      renderNotification({ kind: "circle-promoted" }),
    ]) {
      await sender.send({ telegramUserId: 42n, message });
    }
    expect(sent).toHaveLength(6);
    expect(
      sent.flatMap((call) => inspectCall("auction", "sendMessage", call)),
    ).toEqual([]);
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

// Извещение об отмене аукциона (PER-606): без права и без чтений, покупателю —
// строка о покупке, кнопка следа — в корень аукциона.
describe("auction cancelled", () => {
  const auctionId = "5f0c1a2b-3c4d-5e6f-8a9b-0c1d2e3f4a5b";
  const cancelled = (
    purchases: { minorUnits: number; currency: string }[] = [],
  ): AuctionNotificationContent => ({
    kind: "auction-cancelled",
    auctionId,
    purchases,
  });

  it("tells about the cancel and leads to the auction", () => {
    const message = renderNotification(cancelled());
    expect(message.text).toBe(
      "Аукцион отменили: торги по лотам остановлены, ставки больше не действуют.",
    );
    expect(message.rows).toEqual([
      [{ text: "К аукциону", callback_data: traceRootCallback(auctionId) }],
    ]);
  });

  it("adds the purchase line for a buyer and asks Identity nothing", async () => {
    const source = reads();
    const render = createRenderMessage(source, () => {});
    const rendered = await render(
      cancelled([{ minorUnits: 150_000, currency: "RUB" }]),
      { recipientId },
    );
    expect(rendered).toMatchObject({
      kind: "ready",
      message: { text: expect.stringContaining("Твоя покупка за") },
    });
    expect(source.holdsPlaceBids).not.toHaveBeenCalled();
    expect(source.lotInfo).not.toHaveBeenCalled();
  });
});
