import type { AuctionBlock, Money } from "@solguficky/auction-bot-ui";
import { describe, expect, it } from "vitest";
import {
  CAPTION_LIMIT,
  money,
  renderEntryScreen,
  TEXT_LIMIT,
} from "./entry-screen.js";

const options = { timeZone: "Europe/Moscow" };
const rub = (rubles: number): Money => ({
  minorUnits: rubles * 100,
  currency: "RUB",
});
// Intl разделяет разряды неразрывным пробелом; тесты читают его обычным.
const plain = (text: string) => text.replace(/[  ]/g, " ");

function lotScreen(block: Partial<Extract<AuctionBlock, { kind: "lot" }>>) {
  return renderEntryScreen(
    {
      kind: "auction",
      body: {
        blocks: [
          {
            kind: "lot",
            lotId: "lot-1",
            auctionId: "auc-1",
            version: 1,
            status: { kind: "unsold" },
            ...block,
          },
        ],
        keyboard: [[{ action: "lot.back", callbackData: "v1:auc:feed:x:0" }]],
      },
    },
    options,
  );
}

describe("renderEntryScreen", () => {
  it("keeps the welcome shell free of trading buttons and hub promises", () => {
    const screen = renderEntryScreen({ kind: "welcome" }, options);
    expect(screen.keyboard).toEqual([]);
    expect(screen.text).not.toMatch(/хаб|сходк/i);
  });

  it("gives the blocked person a text different from the not-admitted one", () => {
    const blocked = renderEntryScreen(
      { kind: "denied", reason: "blocked" },
      options,
    );
    const notAdmitted = renderEntryScreen(
      { kind: "denied", reason: "not-admitted" },
      options,
    );
    expect(blocked.text).not.toBe(notAdmitted.text);
  });

  it("labels feed buttons with the title and the price that orders them", () => {
    const screen = renderEntryScreen(
      {
        kind: "auction",
        body: {
          blocks: [
            {
              kind: "feed",
              auctionId: "auc-1",
              page: 0,
              pageCount: 2,
              lots: [
                {
                  lotId: "a",
                  title: "Носки",
                  status: { kind: "scheduled", startingPrice: rub(500) },
                },
                { lotId: "b", status: { kind: "unsold" } },
              ],
            },
          ],
          keyboard: [
            [{ action: "feed.open-lot", lotId: "a", callbackData: "ca" }],
            [{ action: "feed.open-lot", lotId: "b", callbackData: "cb" }],
            [{ action: "feed.next", callbackData: "cn" }],
          ],
        },
      },
      options,
    );
    expect(screen.text).toContain("страница 1 из 2");
    expect(screen.keyboard.map((row) => row.map((b) => plain(b.text)))).toEqual(
      [
        ["Носки · старт 500 ₽"],
        ["Лот без названия · не продан"],
        ["Следующие ›"],
        // Оболочка добавляет выход в FAQ и меню под торговым телом.
        ["Правила и FAQ"],
        ["В меню"],
      ],
    );
  });

  it("names an empty feed instead of showing nothing", () => {
    const screen = renderEntryScreen(
      {
        kind: "auction",
        body: {
          blocks: [
            {
              kind: "feed",
              auctionId: "auc-1",
              page: 0,
              pageCount: 1,
              lots: [],
            },
          ],
          keyboard: [],
        },
      },
      options,
    );
    expect(screen.text).toContain("Лотов пока нет.");
  });

  it("shows price, step, leader and deadline in the community zone", () => {
    const screen = lotScreen({
      card: { title: "Кружка", description: "Роспись." },
      nextPrice: rub(1250),
      fixedStep: rub(50),
      status: {
        kind: "trading",
        currentPrice: rub(1200),
        leaderId: "p-1",
        deadline: "2026-10-10T18:00:00Z",
      },
      participantName: "@owl",
    });
    const text = plain(screen.text);
    expect(text).toContain("Кружка\n\nРоспись.");
    expect(text).toContain("Текущая цена: 1 200 ₽.");
    expect(text).toContain("Лидер: @owl.");
    expect(text).toContain("Следующая ставка — от 1 250 ₽.");
    expect(text).toContain("Шаг: 50 ₽.");
    // 18:00 UTC — 21:00 по Москве.
    expect(text).toMatch(/Торги до 10 октября.*21:00\./);
    expect(screen.photo).toBeUndefined();
  });

  it("does not show an identifier when the leader's name is missing", () => {
    const text = lotScreen({
      status: { kind: "trading", currentPrice: rub(1), leaderId: "p-1" },
    }).text;
    expect(text).toContain("Лидер есть.");
    expect(text).not.toContain("p-1");
  });

  it("shows the winner and the price of a sold lot", () => {
    const text = plain(
      lotScreen({
        status: { kind: "sold", winnerId: "p-3", price: rub(3000) },
        participantName: "Сыч*",
      }).text,
    );
    expect(text).toContain("Продан за 3 000 ₽.");
    expect(text).toContain("Победитель: Сыч*.");
  });

  it("shows an unsold lot as an outcome without a winner", () => {
    const text = lotScreen({ status: { kind: "unsold" } }).text;
    expect(text).toContain("лот не продан");
    expect(text).not.toContain("Победитель");
  });

  it("asks for the photo and keeps a long caption within the limit", () => {
    const screen = lotScreen({
      card: {
        title: "Кружка",
        description: "я".repeat(5_000),
        image: { version: "img-1" },
      },
    });
    expect(screen.photo).toEqual({ lotId: "lot-1", version: "img-1" });
    expect(screen.text.length).toBeLessThanOrEqual(CAPTION_LIMIT);
    expect(screen.text).toContain("…");
    expect(screen.text).toContain("лот не продан");
  });

  it("keeps a long text card within the message limit", () => {
    const screen = lotScreen({
      card: { title: "Кружка", description: "я".repeat(10_000) },
    });
    expect(screen.text.length).toBeLessThanOrEqual(TEXT_LIMIT);
  });

  // Длину названия Auction не ограничивает: цена и исход остаются в подписи.
  it("keeps the price of a photo card with a very long title", () => {
    const screen = lotScreen({
      card: {
        title: "К".repeat(5_000),
        description: "",
        image: { version: "v" },
      },
      status: { kind: "sold", winnerId: "p-3", price: rub(3000) },
    });
    expect(screen.text.length).toBeLessThanOrEqual(CAPTION_LIMIT);
    expect(plain(screen.text)).toContain("Продан за 3 000 ₽.");
  });

  // Срез по UTF-16 разрезал бы эмодзи пополам, и Telegram отверг бы строку.
  it("never cuts a surrogate pair in half", () => {
    const screen = lotScreen({
      card: { title: "Кружка", description: "🦉".repeat(3_000) },
    });
    expect(screen.text.length).toBeLessThanOrEqual(TEXT_LIMIT);
    expect(screen.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it("formats kopecks only when there are some", () => {
    expect(plain(money({ minorUnits: 120_050, currency: "RUB" }))).toBe(
      "1 200,50 ₽",
    );
    expect(plain(money(rub(7)))).toBe("7 ₽");
  });
});
