import { describe, expect, it } from "vitest";
import type { AuctionBlock, Money } from "../../../../auction-ui/index.js";
import { type AuctionView, auctionScreen } from "./auction.js";

// L0: оболочка хаба над телом аукциона на данных, без бота и Telegram. Тексты
// экранов аукциона у двух ботов обязаны совпадать (дизайн-код, «Карточка лота»,
// «Лист ставки»): ожидания здесь те же, что в
// `src/surfaces/auction/entry-screen.test.ts`, и расхождение оболочек ловится с обеих сторон.

const today = { year: 2026, month: 10, day: 7 };
const rub = (rubles: number): Money => ({
  minorUnits: rubles * 100,
  currency: "RUB",
});
// Intl разделяет разряды неразрывным пробелом; тесты читают его обычным.
// Лента возвращает в корень аукциона, и её кнопка несёт токен аукциона.
const auctionId = "daef05c7-cd68-5048-b03d-cb4860e8dc73";

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
    rootParent: { name: "Расширения", data: "v1:ext:x" },
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
  auctionId: auctionId,
  version: 1,
  status: { kind: "unsold" },
  ...overrides,
});

describe("lot card in the hub shell", () => {
  it("orders the groups as status, price with leader and deadline, course, description", () => {
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
    // Цена, лидер и срок — блок со знаками, ход торгов — свой (PER-594).
    expect(plain(screen.text)).toBe(
      "<h1>Кружка</h1><p>Статус: идут торги</p>" +
        "<p>💰 Цена: 1 200 ₽<br>👤 Лидер: @owl<br>⏳ Торги до: 10 октября, сб, 21:00</p>" +
        "<p>Следующая ставка: от 1 250 ₽<br>Шаг: 50 ₽</p>" +
        "<p>Роспись.</p>",
    );
  });

  // Свой лимит — строка хода торгов; над названием ничего нет (PER-472,
  // PER-594). Пустое описание — заглушка.
  it("shows the own limit in the trading course and nothing above the title", () => {
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
        "Статус: идут торги\n\n💰 Цена: 1 200 ₽\n👤 Лидер: пока нет\n\n" +
        "Твоя автоставка: до 2 000 ₽ (видишь только ты)\n\n" +
        "Описание пока не добавлено.",
    );
  });

  // Пустое описание — заглушка, та же, что у карточки сходки (PER-594).
  it("shows the placeholder for an empty description of a lot without a photo", () => {
    const { screen } = auctionScreen(
      view([lot({ card: { title: "Кружка", description: "" } })]),
    );
    expect(screen.format).toBe("rich");
    expect(plain(screen.text)).toMatch(
      /^<h1>Кружка<\/h1>.*<p>Описание пока не добавлено\.<\/p>$/,
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
        "<p>Статус: продан</p><p>💰 Цена продажи: 3 000 ₽<br>👤 Победитель: Сыч</p>" +
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
  it("keeps a full admin feed within the twelve-row keyboard limit", () => {
    const { screen } = auctionScreen({
      ...view([]),
      canManage: true,
      canAddLots: true,
      favorites: true,
      body: {
        blocks: [
          {
            kind: "feed",
            auctionId: "123e4567-e89b-42d3-a456-426614174000",
            page: 0,
            pageCount: 2,
            lots: Array.from({ length: 8 }, (_, index) => ({
              lotId: `lot-${index}`,
              title: `Лот ${index}`,
              status: { kind: "unsold" as const },
            })),
          },
        ],
        keyboard: [
          ...Array.from({ length: 8 }, (_, index) => [
            {
              action: "feed.open-lot" as const,
              lotId: `lot-${index}`,
              callbackData: `lot-${index}`,
            },
          ]),
          [{ action: "feed.next" as const, callbackData: "next" }],
        ],
      },
    });
    const rows = screen.keyboard.inline_keyboard.map((row) =>
      row.map((button) => button.text),
    );

    // Лента — просто список лотов (PER-605): пульт, избранное и правила
    // стоят в корне аукциона, а над лотами — только «Добавить лот».
    expect(rows).toHaveLength(11);
    expect(rows[0]).toEqual(["Добавить лот"]);
    expect(rows.at(-1)).toEqual(["‹ Аукцион"]);
  });

  // Текст ленты не повторяет кнопки (PER-595): своих лотов нет — сводка так
  // и говорит, а все лоты — кнопками.
  it("lists every lot as a button and says the text is not the full list", () => {
    const { screen } = auctionScreen({
      ...view([]),
      body: {
        blocks: [
          {
            kind: "feed",
            auctionId: auctionId,
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
      "<b>Лоты · 1 из 2</b>\n\nТы пока не лидируешь ни в одном лоте этого аукциона. Все лоты — кнопками ниже.",
    );
    expect(
      screen.keyboard.inline_keyboard
        .flat()
        .filter((button) => !/^(‹ |←$|→$)/.test(button.text))
        .map((button) => plain(button.text)),
    ).toEqual(["Носки · старт 500 ₽", "Лот без названия · не продан"]);
  });

  // Перенос строки в названии не плодит строк сводки: вторая выглядела бы
  // чужим лотом с чужой ценой. Свой проданный лот сводка отмечает «✅ твой
  // лот» (PER-595).
  it("keeps a lot title with line breaks on one line of the feed", () => {
    const won = {
      lotId: "a",
      title: "Ваза\n• Другой лот",
      status: { kind: "sold" as const, winnerId: "me", price: rub(3000) },
      standing: "won" as const,
    };
    const { screen } = auctionScreen({
      ...view([]),
      body: {
        blocks: [
          {
            kind: "feed",
            auctionId: auctionId,
            page: 0,
            pageCount: 1,
            lots: [won],
            mine: [won],
          },
        ],
        keyboard: [
          [{ action: "feed.open-lot", lotId: "a", callbackData: "ca" }],
        ],
      },
    });
    expect(plain(screen.text)).toBe(
      "<b>Лоты</b>\n\nЗдесь только твои лоты: где ты лидер и что ты купил. Все лоты аукциона — кнопками ниже.\n\n• Ваза • Другой лот — ✅ твой лот за 3 000 ₽",
    );
  });

  it("lists the bids as lines under the lot in quotes with the foreign year", () => {
    const { screen } = auctionScreen({
      ...view([]),
      body: {
        blocks: [
          {
            kind: "history",
            lotId: "lot-1",
            auctionId: auctionId,
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
      "<b>Ставки</b>\n\n<b>Кружка</b>\n\n• 3 октября 2025, пт, 19:04 · @jay · 500 ₽ · вручную",
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
      auctionId: auctionId,
      title: "Кружка <с совой>",
      amount: rub(1300),
      currentPrice: rub(1200),
    });
    expect(plain(screen.text)).toBe(
      "<b>Поставить 1 300 ₽?</b>\n\n<b>Кружка &lt;с совой&gt;</b>\n\nОтменить ставку нельзя.",
    );
  });

  it("names how far the bot may raise the price in the proxy confirmation", () => {
    const { screen } = sheet({
      kind: "confirm",
      command: "proxy",
      lotId: "lot-1",
      auctionId: auctionId,
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
      auctionId: auctionId,
      current: rub(1600),
    });
    expect(plain(screen.text)).toBe(
      "<b>Своя сумма</b>\n\nПришли сумму ставки в рублях.\nМинимальная ставка: 1 600 ₽\nНапример: 1 500",
    );
    expect(asks).toBe(true);
  });

  // Пояснение автоставки (PER-517) — тем же текстом, что у бота аукциона.
  it("explains the limit on this lot before asking it", () => {
    const { screen, asks } = sheet({
      kind: "question",
      question: "proxy",
      lotId: "lot-1",
      auctionId: auctionId,
      current: rub(1250),
      explainer: {
        example: {
          currentPrice: rub(1200),
          step: rub(50),
          limit: rub(1350),
          firstBid: rub(1250),
        },
      },
    });
    expect(plain(screen.text)).toBe(
      [
        "<b>Автоставка</b>",
        "",
        "💡 Подсказка: платишь цену, а не лимит. Лимит — твой потолок: бот перебивает чужие ставки по шагу, пока не дойдёт до него.",
        "Например: цена сейчас 1 200 ₽, шаг 50 ₽, твой лимит 1 350 ₽. Бот сразу поставит за тебя 1 250 ₽ и будет отвечать на чужие ставки, но не выше 1 350 ₽. Никто не перебьёт — заплатишь 1 250 ₽, а не 1 350 ₽.",
        "",
        "Пришли лимит в рублях: до этой суммы бот будет ставить за тебя по шагу. Лимит видишь только ты.",
        "Минимальная ставка: 1 250 ₽",
        "Например: 3 000",
      ].join("\n"),
    );
    expect(asks).toBe(true);
  });

  // Пояснение видено — над «Отменой» встаёт «Как это работает».
  it("offers how it works above the cancel once the explainer was seen", () => {
    const { screen } = auctionScreen({
      ...view([]),
      body: {
        blocks: [
          {
            kind: "question",
            question: "proxy",
            lotId: "lot-1",
            auctionId: auctionId,
            current: rub(1250),
          },
        ],
        keyboard: [
          [{ action: "question.explain", callbackData: "v1:auc:xe:lot-1:1" }],
          [{ action: "question.cancel", callbackData: "v1:auc:qx:lot-1:1:42" }],
        ],
      },
    });
    expect(screen.text).not.toContain("Подсказка");
    expect(
      screen.keyboard?.inline_keyboard.map((row) =>
        row.map((button) => button.text),
      ),
    ).toEqual([["Как это работает"], ["Отмена"]]);
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
            auctionId: auctionId,
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
      "<b>Ставка ниже порога</b>\n\n<b>Кружка</b>\n\nСейчас можно от 1 300 ₽.",
    );
    expect(
      screen.keyboard.inline_keyboard.map((row) => row.map((b) => b.text)),
    ).toEqual([["‹ Лот"]]);
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
            auctionId: auctionId,
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
    expect(plain(screen.text)).toBe("<b>Это не сумма</b>\n\n<b>Кружка</b>");
    expect(
      screen.keyboard.inline_keyboard.map((row) => row.map((b) => b.text)),
    ).toEqual([["Ввести заново"], ["‹ Лот"]]);
  });
});

// «Счастливые часы» (PER-505): те же строки, что у бота аукциона
// (`src/surfaces/auction/entry-screen.test.ts`).
describe("happy hours in the hub shell", () => {
  const trading = {
    kind: "trading" as const,
    currentPrice: rub(1200),
    phase: "online" as const,
  };
  const facts = (overrides: Partial<Extract<AuctionBlock, { kind: "lot" }>>) =>
    plain(
      auctionScreen(view([lot({ status: trading, ...overrides })])).screen.text,
    );

  it("shows the window step until its end next to the regular step", () => {
    expect(
      facts({
        nextPrice: rub(1210),
        fixedStep: rub(50),
        baseStep: rub(50),
        activeWindow: {
          from: "2026-10-10T15:00:00Z",
          until: "2026-10-10T18:00:00Z",
          step: rub(10),
        },
      }),
    ).toContain(
      "Следующая ставка: от 1 210 ₽<br>Счастливые часы: шаг 10 ₽ до 10 октября, сб, 21:00<br>Обычный шаг: 50 ₽",
    );
  });

  it("shows the thresholds instead of one step when the step is tiered", () => {
    expect(
      facts({
        nextPrice: rub(1210),
        tiers: [
          { lowerBound: rub(0), step: rub(50) },
          { lowerBound: rub(5000), step: rub(250) },
        ],
      }),
    ).toContain(
      "Следующая ставка: от 1 210 ₽<br>Шаг по порогам:<br>от 0 ₽ — 50 ₽<br>от 5 000 ₽ — 250 ₽",
    );
  });

  it("names the day of a future window once when it fits in a day", () => {
    expect(
      facts({
        fixedStep: rub(50),
        baseStep: rub(50),
        nextWindow: {
          from: "2026-10-11T12:00:00Z",
          until: "2026-10-11T15:00:00Z",
          step: rub(10),
        },
      }),
    ).toContain(
      "Шаг: 50 ₽<br>Счастливые часы: с 11 октября, вс, 15:00 до 18:00, шаг 10 ₽",
    );
  });

  it("names both days of a future window across midnight", () => {
    expect(
      facts({
        nextWindow: {
          from: "2026-10-11T20:00:00Z",
          until: "2026-10-11T22:00:00Z",
          step: rub(10),
        },
      }),
    ).toContain(
      "Счастливые часы: с 11 октября, вс, 23:00 до 12 октября, пн, 01:00, шаг 10 ₽",
    );
  });

  it("marks a lot of the feed whose window is in force", () => {
    const feed = view([
      {
        kind: "feed",
        auctionId: auctionId,
        page: 0,
        pageCount: 1,
        lots: [
          {
            lotId: "a",
            title: "Кружка",
            status: trading,
            activeWindow: {
              from: "2026-10-10T15:00:00Z",
              until: "2026-10-10T18:00:00Z",
              step: rub(10),
            },
          },
        ],
      },
    ]);
    const { screen } = auctionScreen({
      ...feed,
      body: { ...feed.body, keyboard: [] },
    });
    // Отметка окна — строкой сводки (PER-595): строк лотов в теле больше нет.
    expect(plain(screen.text)).toContain("Счастливые часы сейчас: Кружка.");
  });
});
