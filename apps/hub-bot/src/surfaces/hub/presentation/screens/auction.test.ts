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
        "Статус: идут торги\n\n💰 Стартовая цена: 1 200 ₽\n👤 Лидер: пока нет\n\n" +
        "Твоя автоставка: до 2 000 ₽ (видишь только ты)\n\n" +
        "Описание пока не добавлено.",
    );
  });

  // Лимит ниже порога у не-лидера больше ничего не сделает (PER-631, №81).
  it("names an exhausted own limit of a participant who does not lead", () => {
    const { screen } = auctionScreen(
      view(
        [
          lot({
            card: { title: "Кружка", description: "" },
            nextPrice: rub(950),
            status: {
              kind: "trading",
              currentPrice: rub(900),
              leaderId: "p-2",
              phase: "online",
            },
            participantName: "@owl",
            viewerProxyLimit: rub(900),
          }),
        ],
        "plain",
      ),
    );
    expect(plain(screen.text)).toContain(
      "💰 Цена: 900 ₽\n👤 Лидер: @owl\n\n" +
        "Следующая ставка: от 950 ₽\n" +
        "Автоставка до 900 ₽ исчерпана — подними лимит",
    );
  });

  // В живом финале кнопки «Автоставка» нет (PER-713): исчерпанный лимит не
  // советует его поднять, а лимит лидера ниже текущей цены не показан
  // действующим.
  it("names an exhausted own limit in the live final without advising to raise it", () => {
    const course = (standing?: "leader") =>
      plain(
        auctionScreen(
          view(
            [
              lot({
                card: { title: "Кружка", description: "" },
                nextPrice: rub(1550),
                status: {
                  kind: "trading",
                  currentPrice: rub(1500),
                  leaderId: standing === "leader" ? "viewer" : "p-2",
                  phase: "live",
                },
                participantName: "@owl",
                viewerProxyLimit: rub(1450),
                ...(standing === undefined ? {} : { standing }),
              }),
            ],
            "plain",
          ),
        ).screen.text,
      );
    for (const text of [course(), course("leader")]) {
      expect(text).toContain("Автоставка до 1 450 ₽ исчерпана");
      expect(text).not.toContain("подними лимит");
      expect(text).not.toContain("Твоя автоставка");
    }
  });

  // Без ставок первая ставка — по стартовой цене, а не «по шагу» (PER-631,
  // №82); с лидером — по шагу.
  it("offers the first bid instead of the step on a lot without bids", () => {
    const labelOf = (leaderId?: string) => {
      const block = lot({
        nextPrice: rub(1000),
        status: {
          kind: "trading",
          currentPrice: rub(1000),
          ...(leaderId === undefined ? {} : { leaderId }),
          phase: "online",
        },
      });
      const { screen } = auctionScreen({
        ...view([block]),
        body: {
          blocks: [block],
          keyboard: [
            [
              {
                action: "lot.bid-step",
                callbackData: "v1:auc:cb:x:0",
                amount: rub(1000),
              },
            ],
            [{ action: "lot.back", callbackData: "v1:auc:feed:x:0" }],
          ],
        },
      });
      return plain(String(screen.keyboard.inline_keyboard[0]?.[0]?.text ?? ""));
    };
    expect(labelOf()).toBe("Первая ставка (1 000 ₽)");
    expect(labelOf("p-2")).toBe("По шагу (1 000 ₽)");
  });

  // Принятая ставка называет продление анти-снайпом по часам сообщества
  // (PER-631, №107): номер продления — или что продлений больше не будет.
  it("names the anti-sniping extension on an accepted bid", () => {
    const accepted = (
      extension: Extract<AuctionBlock, { kind: "accepted" }>["extension"],
    ) =>
      plain(
        auctionScreen({
          ...view([]),
          body: {
            blocks: [
              {
                kind: "accepted",
                command: "bid",
                lotId: "lot-1",
                auctionId,
                title: "Кружка",
                amount: rub(1300),
                ...(extension === undefined ? {} : { extension }),
              },
            ],
            keyboard: [
              [{ action: "accepted.lot", callbackData: "v1:auc:lot:x:0" }],
              [{ action: "accepted.feed", callbackData: "v1:auc:feed:x:0" }],
            ],
          },
        }).screen.text,
      );
    // 08:03 UTC — 11:03 по Москве.
    expect(
      accepted({
        kind: "extended",
        deadline: "2026-10-10T08:03:00Z",
        used: 3,
        max: 3,
        windowSeconds: 120,
      }),
    ).toContain("Торги продлены до 11:03 (продление 3 из 3).");
    expect(
      accepted({
        kind: "extended",
        deadline: "2026-10-10T08:03:00Z",
        used: 1,
        max: 3,
        windowSeconds: 60,
      }),
    ).toContain("Торги продлены до 11:03");
    expect(
      accepted({ kind: "exhausted", deadline: "2026-10-10T08:03:00Z" }),
    ).toContain("Продлений больше не будет: торги закроются в 11:03.");
    expect(accepted(undefined)).not.toContain("продл");
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

  // Организатор видит настоящий аккаунт победителя рядом с псевдонимом
  // (PER-648), а участнику поле не задаётся, и остаётся псевдоним.
  it("adds the real account of the sold winner next to the pseudonym", () => {
    const { screen } = auctionScreen({
      ...view([
        lot({
          card: { title: "Кружка", description: "Роспись." },
          status: { kind: "sold", winnerId: "p-3", price: rub(3000) },
          participantName: "Сыч*",
        }),
      ]),
      winnerUsername: "owl",
    });
    expect(plain(screen.text)).toContain("👤 Победитель: Сыч* (@owl)");
  });

  it("does not repeat the account when the winner is shown by it", () => {
    const { screen } = auctionScreen({
      ...view([
        lot({
          card: { title: "Кружка", description: "Роспись." },
          status: { kind: "sold", winnerId: "p-3", price: rub(3000) },
          participantName: "@owl",
        }),
      ]),
      winnerUsername: "owl",
    });
    expect(plain(screen.text)).toContain("👤 Победитель: @owl");
    expect(plain(screen.text)).not.toContain("@owl (@owl)");
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
          [{ action: "feed.back" as const, callbackData: "v1:auc:rt:x" }],
        ],
      },
    });
    const rows = screen.keyboard.inline_keyboard.map((row) =>
      row.map((button) => button.text),
    );

    // Лента — просто список лотов (PER-605): пульт, избранное и правила
    // стоят в корне аукциона, а над лотами — только «Добавить лот».
    expect(rows).toHaveLength(11);
    expect(rows[0]).toEqual(["🛠 Добавить лот"]);
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
          [{ action: "feed.back" as const, callbackData: "v1:auc:rt:x" }],
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
          [{ action: "feed.back" as const, callbackData: "v1:auc:rt:x" }],
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
            status: { kind: "unsold" },
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
      "<b>Ставки</b>\n<i>Кружка</i>\n\n• 3 октября 2025, пт, 19:04 · @jay · 500 ₽ · вручную",
    );
  });
});

describe("history with removals in the hub shell", () => {
  it("strikes the bids of a removed participant and shows the removal as its own line", () => {
    const { screen } = auctionScreen({
      ...view([]),
      body: {
        blocks: [
          {
            kind: "history",
            lotId: "lot-1",
            auctionId: auctionId,
            title: "Кружка",
            status: { kind: "unsold" },
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
                removed: true,
              },
              {
                kind: "bid",
                sequence: 2,
                occurredAt: "2025-10-03T16:05:00Z",
                amount: rub(450),
                origin: { kind: "proxy" },
                participantName: "@owl",
              },
              {
                kind: "removal",
                sequence: 3,
                occurredAt: "2025-10-03T16:06:00Z",
                price: rub(400),
                leaderName: "@owl",
              },
              {
                kind: "removal",
                sequence: 4,
                occurredAt: "2025-10-03T16:07:00Z",
                price: rub(300),
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
      [
        "<b>Ставки</b>",
        "<i>Кружка</i>",
        "",
        "• <s>3 октября 2025, пт, 19:04 · @jay · 500 ₽ · вручную</s>",
        "• 3 октября 2025, пт, 19:05 · @owl · 450 ₽ · авто",
        "• 3 октября 2025, пт, 19:06 · участник снят · цена 400 ₽ · ведёт @owl",
        "• 3 октября 2025, пт, 19:07 · участник снят · цена 300 ₽",
      ].join("\n"),
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

  // Лимит, равный стартовой цене лота без ставок, — первая ставка (П-01).
  it("names the first bid when the limit equals the start price", () => {
    const { screen } = sheet({
      kind: "confirm",
      command: "proxy",
      lotId: "lot-1",
      auctionId: auctionId,
      amount: rub(1200),
      currentPrice: rub(1200),
      firstBid: rub(1200),
    });
    expect(screen.text).toMatch(
      /Ставок ещё нет: бот сразу поставит за тебя 1\s200\s₽ и будет перебивать чужие ставки по шагу, но не выше 1\s200\s₽\./,
    );
    expect(screen.text).not.toContain("лимит не выше неё");
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

  it("names five times the next price when a bid is above the ceiling", () => {
    const { screen } = auctionScreen({
      ...view([]),
      body: {
        blocks: [
          {
            kind: "result",
            result: {
              command: "bid",
              kind: "refused",
              refusal: { kind: "bid-above-maximum", next: rub(5100) },
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
    expect(plain(screen.text)).toBe(
      "<b>Ставка выше потолка</b>\n\n<b>Кружка</b>\n\nМаксимум сейчас — 5 × 5 100 ₽.",
    );
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
      "Следующая ставка: от 1 210 ₽<br>Счастливые часы до 10 октября, сб, 21:00: шаг 10 ₽<br>Обычный шаг: 50 ₽",
    );
  });

  // Период со стартовой ценой (PER-787): у лота без ставок стартовая окна
  // парой с обычной, без «Обычного шага», когда шаг окно не меняет.
  it("shows the window start next to the regular start of a lot without bids", () => {
    expect(
      facts({
        nextPrice: rub(800),
        fixedStep: rub(50),
        baseStep: rub(50),
        activeWindow: {
          from: "2026-10-10T15:00:00Z",
          until: "2026-10-10T18:00:00Z",
          start: rub(800),
        },
      }),
    ).toContain(
      "Следующая ставка: от 800 ₽<br>Счастливые часы до 10 октября, сб, 21:00: от 800 ₽ вместо 1 200 ₽",
    );
  });

  it("promises the start of a future window only to a lot without bids", () => {
    const window = {
      from: "2026-10-11T12:00:00Z",
      until: "2026-10-11T15:00:00Z",
      start: rub(800),
    };
    expect(
      facts({ fixedStep: rub(50), baseStep: rub(50), nextWindow: window }),
    ).toContain(
      "Счастливые часы: с 11 октября, вс, 15:00 до 18:00, от 800 ₽ вместо 1 200 ₽",
    );
    expect(
      plain(
        auctionScreen(
          view([
            lot({
              status: { ...trading, leaderId: "someone" },
              fixedStep: rub(50),
              baseStep: rub(50),
              nextWindow: window,
            }),
          ]),
        ).screen.text,
      ),
    ).not.toContain("Счастливые часы");
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
      body: {
        ...feed.body,
        keyboard: [
          [{ action: "feed.back" as const, callbackData: "v1:auc:rt:x" }],
        ],
      },
    });
    // Отметка окна — строкой сводки (PER-595): строк лотов в теле больше нет.
    expect(plain(screen.text)).toContain("Счастливые часы сейчас: Кружка.");
  });
});

// Шаг до торгов (PER-618): тем же форматом, что в торгах, своей группой под
// стартовой ценой. Те же строки ждёт оболочка бота аукциона.
describe("lot card before trading", () => {
  const scheduled = (block: Partial<Extract<AuctionBlock, { kind: "lot" }>>) =>
    plain(
      auctionScreen(
        view([
          lot({
            status: { kind: "scheduled", startingPrice: rub(500) },
            ...block,
          }),
        ]),
      ).screen.text,
    );

  it("shows the single step under the starting price", () => {
    expect(scheduled({ fixedStep: rub(50) })).toContain(
      "<p>Статус: торги ещё не начались</p><p>💰 Стартовая цена: 500 ₽</p><p>Шаг: 50 ₽</p>",
    );
  });

  it("shows the thresholds under the starting price", () => {
    expect(
      scheduled({
        tiers: [
          { lowerBound: rub(0), step: rub(50) },
          { lowerBound: rub(5000), step: rub(250) },
        ],
      }),
    ).toContain(
      "<p>💰 Стартовая цена: 500 ₽</p><p>Шаг по порогам:<br>от 0 ₽ — 50 ₽<br>от 5 000 ₽ — 250 ₽</p>",
    );
  });
});

// Лента до торгов (PER-618): лидерства ещё нет ни у кого, и сводка говорит,
// что торги не начались. В торгах — прежняя сводка о своих лотах.
describe("feed before trading", () => {
  const feedText = (beforeTrading: boolean) =>
    plain(
      auctionScreen({
        ...view([]),
        body: {
          blocks: [
            {
              kind: "feed",
              auctionId,
              page: 0,
              pageCount: 1,
              lots: [
                {
                  lotId: "a",
                  title: "Носки",
                  status: { kind: "scheduled", startingPrice: rub(500) },
                },
              ],
              ...(beforeTrading ? { beforeTrading: true as const } : {}),
            },
          ],
          keyboard: [
            [{ action: "feed.open-lot", lotId: "a", callbackData: "ca" }],
            [{ action: "feed.back" as const, callbackData: "v1:auc:rt:x" }],
          ],
        },
      }).screen.text,
    );

  it("says the trading has not started instead of the leadership line", () => {
    expect(feedText(true)).toBe(
      "<b>Лоты</b>\n\nТорги ещё не начались. Лоты — кнопками ниже.",
    );
  });

  it("keeps the leadership line once the trading is open", () => {
    expect(feedText(false)).toBe(
      "<b>Лоты</b>\n\nТы пока не лидируешь ни в одном лоте этого аукциона. Все лоты — кнопками ниже.",
    );
  });
});

// Живой финал (PER-639): лента говорит, что идёт финал и какой лот на
// торгах, а карточка — одну строку цены без шага.
describe("live final in the hub shell", () => {
  const shirt = {
    lotId: "lot-shirt",
    title: "Футболка",
    status: {
      kind: "trading" as const,
      currentPrice: rub(1200),
      phase: "live" as const,
      ask: rub(1500),
    },
  };
  const vase = {
    lotId: "lot-vase",
    title: "Ваза",
    status: { kind: "held" as const, currentPrice: rub(400) },
  };
  const mug = {
    lotId: "lot-mug",
    title: "Кружка",
    status: { kind: "sold" as const, winnerId: "w", price: rub(900) },
  };
  const feedOf = (final?: { active?: typeof shirt }) =>
    auctionScreen({
      ...view([]),
      body: {
        blocks: [
          {
            kind: "feed",
            auctionId,
            page: 0,
            pageCount: 1,
            lots: [shirt, vase, mug],
            ...(final === undefined ? {} : { final }),
          },
        ],
        keyboard: [
          ...[shirt, vase, mug].map((item) => [
            {
              action: "feed.open-lot" as const,
              lotId: item.lotId,
              callbackData: item.lotId,
            },
          ]),
          [{ action: "feed.back" as const, callbackData: "v1:auc:rt:x" }],
        ],
      },
    }).screen;
  const labels = (screen: ReturnType<typeof feedOf>) =>
    screen.keyboard.inline_keyboard.map((row) =>
      plain(row.map((button) => button.text).join("|")),
    );

  it("names the lot on sale and marks the lineup apart from the sold lots", () => {
    const screen = feedOf({ active: shirt });
    expect(plain(screen.text)).toContain(
      "Идёт финал: сейчас «Футболка», цена 1 200 ₽, ведущий объявил 1 500 ₽.",
    );
    expect(plain(screen.text)).not.toContain("не лидируешь");
    expect(labels(screen).slice(0, 3)).toEqual([
      "▶ Футболка · на торгах",
      "Ваза · в составе · 400 ₽",
      "Кружка · продан за 900 ₽",
    ]);
  });

  it("says the auctioneer prepares the next lot between lots", () => {
    expect(plain(feedOf({}).text)).toContain(
      "Идёт финал: ведущий готовит следующий лот.",
    );
  });

  it("keeps the feed as before outside the final", () => {
    const screen = feedOf();
    expect(plain(screen.text)).toContain("Ты пока не лидируешь");
    expect(labels(screen).slice(0, 2)).toEqual([
      "Футболка · 1 200 ₽",
      "Ваза · 400 ₽",
    ]);
  });

  const card = (ask?: Money) =>
    plain(
      auctionScreen(
        view([
          lot({
            card: { title: "Футболка", description: "" },
            nextPrice: ask ?? rub(1400),
            fixedStep: rub(200),
            status: {
              kind: "trading",
              currentPrice: rub(1200),
              phase: "live",
              ...(ask === undefined ? {} : { ask }),
            },
          }),
        ]),
      ).screen.text,
    );

  it("shows one price line and no step on the card of the live final", () => {
    const announced = card(rub(1500));
    expect(announced).toContain("Ведущий объявил: 1 500 ₽");
    expect(announced).not.toContain("Следующая ставка");
    expect(announced).not.toContain("Шаг");
    const plainNext = card();
    expect(plainNext).toContain("Следующая ставка: 1 400 ₽");
    expect(plainNext).not.toContain("Шаг");
  });

  // Отказ «не по цене» поднимает кнопку выше отстающего снимка: карточка
  // называет ту же сумму, что на кнопке, а не прежнюю объявленную.
  it("names the raised next price instead of a stale ask", () => {
    const text = plain(
      auctionScreen(
        view([
          lot({
            card: { title: "Футболка", description: "" },
            nextPrice: rub(1700),
            status: {
              kind: "trading",
              currentPrice: rub(1200),
              phase: "live",
              ask: rub(1500),
            },
          }),
        ]),
      ).screen.text,
    );
    expect(text).toContain("Следующая ставка: 1 700 ₽");
    expect(text).not.toContain("Ведущий объявил");
  });
});

// Сет лотов (ADR-073, п. 7): карточка лота сета называет сет и ведёт к его
// экрану, после итога — строка собравшего; экран сета перечисляет лоты сета.
describe("lot set in the hub shell", () => {
  const setLot = (overrides: Partial<Extract<AuctionBlock, { kind: "lot" }>>) =>
    lot({
      card: { title: "Кружка", description: "" },
      status: { kind: "unsold" },
      ...overrides,
    });

  it("names the set on the card and opens its screen", () => {
    const { screen } = auctionScreen({
      ...view([]),
      body: {
        blocks: [
          setLot({
            set: { name: "Лесные дары", lotIds: ["lot-1", "lot-2"] },
          }),
        ],
        keyboard: [
          [{ action: "lot.set", callbackData: "v1:auc:st:lot-1:0" }],
          [{ action: "lot.back", callbackData: "v1:auc:feed:x:0" }],
        ],
      },
    });
    expect(plain(screen.text)).toContain("Сет: «Лесные дары»");
    // До итога сета собравшего нет (ADR-073, п. 4).
    expect(plain(screen.text)).not.toContain("собрал");
    const rows = screen.keyboard.inline_keyboard.map((row) =>
      row.map((button) => button.text),
    );
    expect(rows[0]).toEqual(["Лоты сета"]);
  });

  it("names the collector of the set after the outcome", () => {
    const { screen } = auctionScreen({
      ...view([]),
      body: {
        blocks: [
          setLot({
            set: {
              name: "Лесные дары",
              lotIds: ["lot-1", "lot-2"],
              collectorName: "@jay",
            },
          }),
        ],
        keyboard: [[{ action: "lot.back", callbackData: "v1:auc:feed:x:0" }]],
      },
    });
    expect(plain(screen.text)).toContain("Сет «Лесные дары» собрал @jay");
  });

  it("lists the lots of the set and returns to the lot", () => {
    const { screen } = auctionScreen({
      ...view([]),
      body: {
        blocks: [
          {
            kind: "set",
            auctionId: auctionId,
            name: "Лесные дары",
            lots: [
              {
                lotId: "lot-1",
                title: "Кружка",
                status: { kind: "unsold" },
              },
              {
                lotId: "lot-2",
                title: "Плакат",
                status: { kind: "sold", winnerId: "p-1", price: rub(700) },
              },
            ],
            collectorName: "@jay",
          },
        ],
        keyboard: [
          [
            {
              action: "set.open-lot",
              lotId: "lot-1",
              callbackData: "v1:auc:lot:lot-1:0",
            },
          ],
          [
            {
              action: "set.open-lot",
              lotId: "lot-2",
              callbackData: "v1:auc:lot:lot-2:0",
            },
          ],
          [{ action: "set.back", callbackData: "v1:auc:lot:lot-1:0" }],
        ],
      },
    });
    expect(plain(screen.text)).toContain("<i>Лесные дары</i>");
    expect(plain(screen.text)).toContain("• Кружка — не продан");
    expect(plain(screen.text)).toContain("• Плакат — продан за 700 ₽");
    const rows = screen.keyboard.inline_keyboard.map((row) =>
      row.map((button) => plain(button.text)),
    );
    expect(rows[0]).toEqual(["Кружка · не продан"]);
    expect(rows[1]).toEqual(["Плакат · продан за 700 ₽"]);
    expect(rows.at(-1)).toEqual(["‹ Лот"]);
  });

  // Экран показывает до восьми лотов, а остальные — строкой «И ещё N.»
  // (дизайн-код, «Лоты сета»).
  it("names the lots of the set the screen did not show", () => {
    const { screen } = auctionScreen({
      ...view([]),
      body: {
        blocks: [
          {
            kind: "set",
            auctionId: auctionId,
            name: "Лесные дары",
            lots: [
              { lotId: "lot-1", title: "Кружка", status: { kind: "unsold" } },
            ],
            more: 2,
          },
        ],
        keyboard: [
          [
            {
              action: "set.open-lot",
              lotId: "lot-1",
              callbackData: "v1:auc:lot:lot-1:0",
            },
          ],
          [{ action: "set.back", callbackData: "v1:auc:lot:lot-1:0" }],
        ],
      },
    });
    expect(plain(screen.text)).toContain("И ещё 2.");
  });

  // Решение владельца 24.10.2026: сет называет карточка, а не подпись ленты.
  it("leaves the set out of the feed label", () => {
    const { screen } = auctionScreen({
      ...view([]),
      body: {
        blocks: [
          {
            kind: "feed",
            auctionId: auctionId,
            page: 0,
            pageCount: 1,
            lots: [
              {
                lotId: "a",
                title: "Носки",
                status: { kind: "scheduled", startingPrice: rub(500) },
                setName: "Лесные дары",
              },
            ],
          },
        ],
        keyboard: [
          [{ action: "feed.open-lot", lotId: "a", callbackData: "ca" }],
          [{ action: "feed.back" as const, callbackData: "v1:auc:rt:x" }],
        ],
      },
    });
    const rows = screen.keyboard.inline_keyboard.map((row) =>
      row.map((button) => plain(button.text)),
    );
    expect(rows[0]).toEqual(["Носки · старт 500 ₽"]);
  });
});
