import type { AuctionBlock, Money } from "@solguficky/auction-bot-ui";
import { describe, expect, it } from "vitest";
import { type AuctionView, auctionScreen } from "./auction.js";

// L0: оболочка хаба над телом аукциона на данных, без бота и Telegram. Тексты
// экранов аукциона у двух ботов обязаны совпадать (дизайн-код, «Карточка лота»,
// «Лист ставки»): ожидания здесь те же, что в `apps/auction-bot/src/
// entry-screen.test.ts`, и расхождение оболочек ловится с обеих сторон.

const today = { year: 2026, month: 10, day: 7 };
const rub = (rubles: number): Money => ({
  minorUnits: rubles * 100,
  currency: "RUB",
});
// Intl разделяет разряды неразрывным пробелом; тесты читают его обычным.
const plain = (text: string) => text.replace(/[  ]/g, " ");

function view(
  blocks: AuctionBlock[],
  presentation: "rich" | "plain" = "rich",
): AuctionView {
  return {
    body: {
      blocks,
      keyboard: [[{ action: "lot.back", callbackData: "v1:auc:feed:x:0" }]],
    },
    feedParent: { name: "Сходка", data: "v1:view:x" },
    presentation,
    timeZone: "Europe/Moscow",
    today,
  };
}

const lot = (
  overrides: Partial<Extract<AuctionBlock, { kind: "lot" }>>,
): Extract<AuctionBlock, { kind: "lot" }> => ({
  kind: "lot",
  lotId: "lot-1",
  auctionId: "auc-1",
  version: 1,
  status: { kind: "unsold" },
  ...overrides,
});

describe("lot card in the hub shell", () => {
  it("orders the groups as status, price and leader, description", () => {
    const { screen } = auctionScreen(
      view([
        lot({
          card: { title: "Кружка", description: "Роспись." },
          nextPrice: rub(1250),
          fixedStep: rub(50),
          status: {
            kind: "trading",
            currentPrice: rub(1200),
            leaderId: "p-1",
            deadline: "2026-10-10T18:00:00Z",
            phase: "online",
          },
          participantName: "@owl",
        }),
      ]),
    );
    expect(screen.format).toBe("rich");
    // 18:00 UTC — 21:00 по Москве; строки без точек, как у бота аукциона.
    expect(plain(screen.text)).toBe(
      "<h1>Кружка</h1><p>Статус: идут торги</p>" +
        "<p>Цена: 1 200 ₽<br>Лидер: @owl<br>Следующая ставка: от 1 250 ₽<br>Шаг: 50 ₽<br>Торги до: 10 октября, сб, 21:00</p>" +
        "<p>Роспись.</p>",
    );
  });

  // Свой лимит — строка фактов; над названием ничего нет (PER-472).
  it("shows the own limit among the facts and nothing above the title", () => {
    const { screen } = auctionScreen(
      view(
        [
          lot({
            card: { title: "Кружка", description: "" },
            status: {
              kind: "trading",
              currentPrice: rub(1200),
              phase: "online",
            },
            viewerProxyLimit: rub(2000),
          }),
        ],
        "plain",
      ),
    );
    expect(plain(screen.text)).toBe(
      "<b>Кружка</b>\n\n" +
        "Статус: идут торги\n\nЦена: 1 200 ₽\nЛидер: пока нет\nТвоя автоставка: до 2 000 ₽ (видишь только ты)",
    );
  });

  it("shows a sold lot with the sale price and the winner", () => {
    const { screen } = auctionScreen(
      view([
        lot({
          card: {
            title: "Кружка <XL> & блюдце",
            description: "Роспись.\nРучная.\n\nОбъём 300 мл.",
          },
          status: { kind: "sold", winnerId: "p-3", price: rub(3000) },
          participantName: "Сыч",
        }),
      ]),
    );
    expect(plain(screen.text)).toBe(
      "<h1>Кружка &lt;XL&gt; &amp; блюдце</h1>" +
        "<p>Статус: продан</p><p>Цена продажи: 3 000 ₽<br>Победитель: Сыч</p>" +
        "<p>Роспись.<br>Ручная.</p><p>Объём 300 мл.</p>",
    );
  });

  // Чужой год называется в дате (дизайн-код, «Формат»).
  it("names the year of a deadline outside the current year", () => {
    const { screen } = auctionScreen(
      view(
        [
          lot({
            status: {
              kind: "trading",
              currentPrice: rub(1),
              deadline: "2027-01-09T18:00:00Z",
              phase: "online",
            },
          }),
        ],
        "plain",
      ),
    );
    expect(plain(screen.text)).toContain("Торги до: 9 января 2027, сб, 21:00");
  });

  // Карточка лота: статус первой группой, строки-поля без точки в конце.
  it.each([
    lot({ status: { kind: "draft" } }),
    lot({ status: { kind: "scheduled", startingPrice: rub(500) } }),
    lot({
      status: { kind: "held", currentPrice: rub(700), leaderId: "p-1" },
    }),
    lot({ status: { kind: "withdrawn" } }),
  ])("keeps the card lines as fields without a trailing full stop", (block) => {
    const { screen } = auctionScreen(view([block], "plain"));
    const lines = screen.text
      .split("\n")
      .filter((line) => /^[А-ЯЁ][а-яё ]+: /.test(line));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).toMatch(/^Статус: /);
    expect(lines.filter((line) => line.endsWith("."))).toEqual([]);
  });
});

describe("feed and history in the hub shell", () => {
  it("lists every lot as a line of the body and as a button", () => {
    const { screen } = auctionScreen({
      ...view([]),
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
    });
    expect(plain(screen.text)).toBe(
      "<b>Лоты · 1 из 2</b>\n\n• Носки — старт 500 ₽\n• Лот без названия — не продан",
    );
    const lines = screen.text
      .split("\n")
      .filter((line) => line.startsWith("• "));
    const content = screen.keyboard.inline_keyboard
      .flat()
      .filter((button) => !/^(‹ |←$|→$|Меню$)/.test(button.text));
    expect(lines.length).toBe(content.length);
  });

  // Перенос строки в названии не плодит строк списка: вторая выглядела бы
  // чужим лотом с чужой ценой.
  it("keeps a lot title with line breaks on one line of the feed", () => {
    const { screen } = auctionScreen({
      ...view([]),
      body: {
        blocks: [
          {
            kind: "feed",
            auctionId: "auc-1",
            page: 0,
            pageCount: 1,
            lots: [
              {
                lotId: "a",
                title: "Ваза\n• Другой лот",
                status: { kind: "unsold" },
              },
            ],
          },
        ],
        keyboard: [
          [{ action: "feed.open-lot", lotId: "a", callbackData: "ca" }],
        ],
      },
    });
    expect(screen.text).toBe("<b>Лоты</b>\n\n• Ваза • Другой лот — не продан");
  });

  it("lists the bids as lines under the lot in quotes with the foreign year", () => {
    const { screen } = auctionScreen({
      ...view([]),
      body: {
        blocks: [
          {
            kind: "history",
            lotId: "lot-1",
            auctionId: "auc-1",
            title: "Кружка",
            page: 0,
            pageCount: 1,
            entries: [
              {
                kind: "bid",
                sequence: 1,
                occurredAt: "2025-10-03T16:04:00Z",
                amount: rub(500),
                origin: { kind: "manual", source: "bot" },
                participantName: "@jay",
              },
            ],
          },
        ],
        keyboard: [
          [{ action: "history.back", callbackData: "v1:auc:lot:lot-1:0" }],
        ],
      },
    });
    expect(plain(screen.text)).toBe(
      "<b>Ставки</b>\n\n«Кружка»\n\n• 3 октября 2025, пт, 19:04 · @jay · 500 ₽ · вручную",
    );
  });
});

describe("bid sheet in the hub shell", () => {
  const sheet = (block: AuctionBlock) =>
    auctionScreen({
      ...view([]),
      body: {
        blocks: [block],
        keyboard: [
          [{ action: "confirm.yes", callbackData: "v1:auc:b:lot-1:op:fa:1" }],
          [{ action: "confirm.no", callbackData: "v1:auc:lot:lot-1:1" }],
          [{ action: "question.cancel", callbackData: "v1:auc:qb:lot-1:1:42" }],
        ],
      },
    });

  it("asks the bid as a question with the lot in quotes", () => {
    const { screen } = sheet({
      kind: "confirm",
      command: "bid",
      lotId: "lot-1",
      auctionId: "auc-1",
      title: "Кружка <с совой>",
      amount: rub(1300),
      currentPrice: rub(1200),
    });
    expect(plain(screen.text)).toBe(
      "<b>Поставить 1 300 ₽?</b>\n\n«Кружка &lt;с совой&gt;»\n\nОтменить ставку нельзя.",
    );
  });

  it("names how far the bot may raise the price in the proxy confirmation", () => {
    const { screen } = sheet({
      kind: "confirm",
      command: "proxy",
      lotId: "lot-1",
      auctionId: "auc-1",
      amount: rub(2000),
      currentPrice: rub(1200),
    });
    expect(plain(screen.text)).toMatch(
      /^<b>Включить автоставку до 2 000 ₽\?<\/b>\n\n/,
    );
    expect(screen.text).toMatch(/поднимет её не больше чем на 800\s₽/);
    expect(screen.text).toContain("Лимит видишь только ты.");
  });

  it("asks the question with the prompt under the title", () => {
    const { screen, asks } = sheet({
      kind: "question",
      question: "bid",
      lotId: "lot-1",
      auctionId: "auc-1",
      current: rub(1600),
    });
    expect(plain(screen.text)).toBe(
      "<b>Своя сумма</b>\n\nПришли сумму ставки в рублях.\nСейчас: от 1 600 ₽\nНапример: 1 500",
    );
    expect(asks).toBe(true);
  });

  // Отказ команды — свой экран исхода (PER-472), тексты — как у бота
  // аукциона.
  it("shows a refused command as its own outcome screen", () => {
    const { screen } = auctionScreen({
      ...view([]),
      body: {
        blocks: [
          {
            kind: "result",
            result: {
              command: "bid",
              kind: "refused",
              refusal: { kind: "bid-below-minimum", minRequired: rub(1300) },
            },
            lotId: "lot-1",
            auctionId: "auc-1",
            title: "Кружка",
          },
        ],
        keyboard: [
          [{ action: "result.lot", callbackData: "v1:auc:lot:lot-1:0" }],
        ],
      },
    });
    expect(screen.id).toBe("command-result");
    expect(plain(screen.text)).toBe(
      "<b>Ставка ниже порога</b>\n\n«Кружка»\n\nСейчас можно от 1 300 ₽.",
    );
    expect(
      screen.keyboard.inline_keyboard.map((row) => row.map((b) => b.text)),
    ).toEqual([["К лоту", "Меню"]]);
  });

  // Непринятый ответ — свой экран с «Ввести заново» над «К лоту» (PER-472).
  it("shows a refused answer as its own screen with a retry", () => {
    const { screen, asks } = auctionScreen({
      ...view([]),
      body: {
        blocks: [
          {
            kind: "answer-refused",
            refusal: "not-a-number",
            lotId: "lot-1",
            auctionId: "auc-1",
            title: "Кружка",
          },
        ],
        keyboard: [
          [{ action: "answer.retry", callbackData: "v1:auc:ab:lot-1:0" }],
          [{ action: "result.lot", callbackData: "v1:auc:lot:lot-1:0" }],
        ],
      },
    });
    expect(screen.id).toBe("answer-refused");
    expect(asks).toBeUndefined();
    expect(plain(screen.text)).toBe("<b>Это не сумма</b>\n\n«Кружка»");
    expect(
      screen.keyboard.inline_keyboard.map((row) => row.map((b) => b.text)),
    ).toEqual([["Ввести заново"], ["К лоту", "Меню"]]);
  });
});
