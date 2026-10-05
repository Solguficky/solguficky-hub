import {
  type AuctionBlock,
  encodeAuctionCallback,
  type Money,
} from "@solguficky/auction-bot-ui";
import { describe, expect, it } from "vitest";
import type { AuctionSummary } from "./auctions.js";
import {
  auctionLabel,
  money,
  type RenderOptions,
  renderEntryScreen,
  TEXT_LIMIT,
} from "./entry-screen.js";
import { entryCallback, listCallback } from "./faq.js";

const options = { timeZone: "Europe/Moscow" };
const plainCard = { ...options, presentation: "plain" as const };
const rub = (rubles: number): Money => ({
  minorUnits: rubles * 100,
  currency: "RUB",
});
// Intl разделяет разряды неразрывным пробелом; тесты читают его обычным.
const plain = (text: string) => text.replace(/[  ]/g, " ");

// Видимый текст карточки: теги сняты, сущности раскрыты.
const visible = (html: string) =>
  html
    .replace(/<\/(h1|p)>|<br>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");

function lotScreen(
  block: Partial<Extract<AuctionBlock, { kind: "lot" }>>,
  render: RenderOptions = options,
) {
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
    render,
  );
}

describe("renderEntryScreen", () => {
  it("keeps the menu free of trading buttons and hub promises", () => {
    const screen = renderEntryScreen({ kind: "menu" }, options);
    expect(screen.text).toBe(
      "<b>Меню</b>\n\nАукцион сообщества. Выбери раздел.",
    );
    expect(screen.keyboard.map((row) => row.map((b) => b.text))).toEqual([
      ["Аукционы"],
      ["Прошедшие"],
      ["Правила и FAQ"],
    ]);
    expect(screen.text).not.toMatch(/хаб|сходк/i);
  });

  // Состояния FAQ возвращают в FAQ, а не в меню (дизайн-код, «Дерево бота
  // аукциона»).
  it.each(["details", "question"] as const)(
    "returns from the FAQ state %s to FAQ",
    (kind) => {
      const screen = renderEntryScreen({ kind }, options);
      expect(screen.text).toMatch(/^<b>Правила и FAQ<\/b>\n\nОрганизатор/);
      expect(screen.keyboard).toEqual([
        [
          { text: "‹ FAQ", callback_data: entryCallback("faq") },
          { text: "Меню", callback_data: entryCallback("menu") },
        ],
      ]);
    },
  );

  // Ответ на вопрос в кнопку не помещается: повтора нет, ответ присылают
  // ещё раз.
  it("asks to send the answer again when a reply met a failure", () => {
    const screen = renderEntryScreen(
      { kind: "unavailable", exit: { kind: "answer" } },
      options,
    );
    expect(screen.text).toContain("Пришли ответ ещё раз");
    expect(screen.keyboard).toEqual([
      [{ text: "Меню", callback_data: entryCallback("menu") }],
    ]);
  });

  // Трём отказам — три разных ответа: заблокированный и получивший отказ не
  // читают «заявка на рассмотрении» (ADR-060, пункты 13 и 15).
  const refusals = (["not-admitted", "declined", "blocked"] as const).map(
    (reason) => renderEntryScreen({ kind: "denied", reason }, options),
  );

  it("gives every refusal a text of its own", () => {
    expect(new Set(refusals.map((screen) => screen.text)).size).toBe(3);
    expect(refusals[0]?.text).toContain("на рассмотрении");
  });

  it("renders a refusal as the denied frame without a keyboard", () => {
    for (const screen of refusals) {
      expect(screen.id).toBe("denied");
      expect(screen.keyboard).toEqual([]);
    }
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
    expect(screen.format).toBe("html");
    expect(screen.text).toBe("<b>Лоты · 1 из 2</b>\n\nПо возрастанию цены.");
    expect(screen.keyboard.map((row) => row.map((b) => plain(b.text)))).toEqual(
      [
        ["Носки · старт 500 ₽"],
        ["Лот без названия · не продан"],
        ["→"],
        // Оболочка ставит возврат в список аукциона и «Меню» одним рядом.
        ["‹ Аукционы", "Меню"],
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
    // Пустая лента несёт заголовок так же, как заполненная.
    expect(screen.text).toBe("<b>Лоты</b>\n\nЛотов пока нет.");
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
        phase: "online",
      },
      participantName: "@owl",
    });
    expect(screen.format).toBe("rich");
    expect(screen.text).toMatch(/^<h1>Кружка<\/h1><p>Роспись\.<\/p>/);
    const text = plain(visible(screen.text));
    expect(text).toContain("Текущая цена: 1 200 ₽.");
    expect(text).toContain("Лидер: @owl.");
    expect(text).toContain("Следующая ставка — от 1 250 ₽.");
    expect(text).toContain("Шаг: 50 ₽.");
    // 18:00 UTC — 21:00 по Москве.
    expect(text).toContain("Торги до 10 октября, сб, 21:00.");
    expect(screen.photo).toBeUndefined();
  });

  it("does not show an identifier when the leader's name is missing", () => {
    const text = lotScreen({
      status: {
        kind: "trading",
        currentPrice: rub(1),
        leaderId: "p-1",
        phase: "online",
      },
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

  // Критерий PER-463: последний ряд под лотом — возврат и «Меню».
  it("puts the return to the feed and the menu into the last row of a lot", () => {
    expect(lotScreen({}).keyboard).toEqual([
      [
        { text: "‹ Лоты", callback_data: "v1:auc:feed:x:0" },
        { text: "Меню", callback_data: entryCallback("menu") },
      ],
    ]);
  });

  it("shows an unsold lot as an outcome without a winner", () => {
    const text = lotScreen({ status: { kind: "unsold" } }).text;
    expect(text).toContain("лот не продан");
    expect(text).not.toContain("Победитель");
  });

  it("asks for the photo and keeps a long description whole", () => {
    const description = "я".repeat(5_000);
    const screen = lotScreen({
      card: { title: "Кружка", description, image: { version: "img-1" } },
    });
    expect(screen.photo).toEqual({ lotId: "lot-1", version: "img-1" });
    expect(screen.text).toContain(`<p>${description}</p>`);
    expect(screen.text).not.toContain("…");
  });

  // Перенос строки в html rich-сообщения не рисуется: абзац — свой блок,
  // строки внутри абзаца и строки статуса разделяет `<br>`.
  it("marks paragraphs as blocks, breaks lines and escapes the text", () => {
    const screen = lotScreen({
      card: {
        title: "Кружка <XL> & блюдце",
        description: "Роспись.\nРучная.\n\nОбъём 300 мл.",
      },
      status: { kind: "sold", winnerId: "p-3", price: rub(3000) },
      participantName: "Сыч",
    });
    expect(plain(screen.text)).toBe(
      "<h1>Кружка &lt;XL&gt; &amp; блюдце</h1>" +
        "<p>Роспись.<br>Ручная.</p><p>Объём 300 мл.</p>" +
        "<p>Продан за 3 000 ₽.<br>Победитель: Сыч.</p>",
    );
  });

  // Блоков у rich-сообщения не бесконечно: лишние абзацы сливаются в один,
  // и текст не теряется.
  it("merges paragraphs beyond the block limit without losing text", () => {
    const description = Array.from({ length: 120 }, (_, i) => `п${i}`).join(
      "\n\n",
    );
    const screen = lotScreen({ card: { title: "Кружка", description } });
    expect(screen.text.match(/<p>/g)?.length).toBe(51);
    expect(screen.text).toContain("п0");
    expect(screen.text).toContain("п119");
  });

  it("puts the plain card into an HTML message without a photo", () => {
    const screen = lotScreen(
      {
        card: {
          title: "Кружка <XL>",
          description: "Роспись & глазурь.",
          image: { version: "img-1" },
        },
      },
      plainCard,
    );
    expect(screen.format).toBe("html");
    expect(screen.photo).toBeUndefined();
    expect(screen.text).toBe(
      "<b>Кружка &lt;XL&gt;</b>\n\nРоспись &amp; глазурь.\n\nТорги закончились, лот не продан.",
    );
  });

  it("keeps a long plain card within the message limit", () => {
    const screen = lotScreen(
      { card: { title: "Кружка", description: "я".repeat(10_000) } },
      plainCard,
    );
    expect(visible(screen.text).length).toBeLessThanOrEqual(TEXT_LIMIT);
    expect(screen.text).toContain("…");
    expect(screen.text).toContain("лот не продан");
  });

  // Длину названия Auction не ограничивает: цена и исход остаются на карточке.
  it("keeps the price of a card with a very long title", () => {
    const screen = lotScreen({
      card: { title: "К".repeat(5_000), description: "" },
      status: { kind: "sold", winnerId: "p-3", price: rub(3000) },
    });
    expect(plain(visible(screen.text))).toContain("Продан за 3 000 ₽.");
    expect(screen.text.length).toBeLessThan(1_000);
  });

  // Срез по UTF-16 разрезал бы эмодзи пополам, и Telegram отверг бы строку.
  it("never cuts a surrogate pair in half", () => {
    const screen = lotScreen(
      { card: { title: "Кружка", description: "🦉".repeat(3_000) } },
      plainCard,
    );
    expect(visible(screen.text).length).toBeLessThanOrEqual(TEXT_LIMIT);
    expect(screen.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it("formats kopecks only when there are some", () => {
    expect(plain(money({ minorUnits: 120_050, currency: "RUB" }))).toBe(
      "1 200,50 ₽",
    );
    expect(plain(money(rub(7)))).toBe("7 ₽");
  });
});

// Подтверждение автоставки объясняет её разницей цены и лимита (PER-317).
describe("proxy limit confirmation", () => {
  const confirm = (limit: number) =>
    renderEntryScreen(
      {
        kind: "auction",
        body: {
          blocks: [
            {
              kind: "confirm",
              command: "proxy",
              lotId: "lot-1",
              auctionId: "auc-1",
              amount: rub(limit),
              currentPrice: rub(1200),
            },
          ],
          keyboard: [
            [{ action: "confirm.yes", callbackData: "v1:auc:x:lot-1:op:1:0" }],
            [{ action: "confirm.no", callbackData: "v1:auc:lot:lot-1:0" }],
          ],
        },
      },
      { timeZone: "Europe/Moscow" },
    );

  it("names how far the bot may raise the price", () => {
    const screen = confirm(2000);
    expect(screen.text).toMatch(/поднимет её не больше чем на 800\s₽/);
    expect(screen.text).toContain("Лимит видишь только ты.");
    expect(screen.keyboard[0]?.[0]).toMatchObject({
      text: "Да, включить автоставку",
      style: "danger",
    });
  });

  it("says the bot will not outbid when the limit is not above the price", () => {
    expect(confirm(1200).text).toContain("перебивать бот не будет");
  });
});

describe("auction lists", () => {
  const auction = (overrides: Partial<AuctionSummary>): AuctionSummary => ({
    auctionId: "01926f3c-8b7a-5cde-8f00-000000000001",
    stage: "prebidding",
    opensAt: "2026-10-10T16:00:00Z",
    lotCount: 5,
    ...overrides,
  });

  it.each([
    [1, "1 лот"],
    [3, "3 лота"],
    [5, "5 лотов"],
    [11, "11 лотов"],
    [21, "21 лот"],
    [0, "0 лотов"],
  ])("counts %i lots as %s", (lotCount, label) => {
    expect(auctionLabel(auction({ lotCount }), "Europe/Moscow")).toBe(
      `10 октября, сб · идут ставки · ${label}`,
    );
  });

  it("names the day in the community zone and a format without an online phase", () => {
    expect(
      auctionLabel(
        auction({ opensAt: "2026-10-10T22:30:00Z", stage: "scheduled" }),
        "Europe/Moscow",
      ),
    ).toBe("11 октября, вс · скоро старт · 5 лотов");
    const { opensAt: _opensAt, ...without } = auction({});
    expect(auctionLabel(without, "Europe/Moscow")).toBe(
      "Без онлайн-торгов · идут ставки · 5 лотов",
    );
  });

  it("names the finished stage in a past row", () => {
    expect(auctionLabel(auction({ stage: "finished" }), "Europe/Moscow")).toBe(
      "10 октября, сб · завершён · 5 лотов",
    );
  });

  it("opens the feed from the row and pages the list with arrows", () => {
    const screen = renderEntryScreen(
      {
        kind: "past",
        list: { page: 1, pageCount: 3, auctions: [auction({})] },
      },
      options,
    );
    expect(screen.text).toBe(
      "<b>Прошедшие аукционы · 2 из 3</b>\n\nВыбери аукцион.",
    );
    expect(screen.keyboard).toEqual([
      [
        {
          text: "10 октября, сб · идут ставки · 5 лотов",
          callback_data: encodeAuctionCallback({
            kind: "feed",
            auctionId: "01926f3c-8b7a-5cde-8f00-000000000001",
            page: 0,
          }),
        },
      ],
      [
        { text: "←", callback_data: entryCallback("past") },
        { text: "→", callback_data: listCallback("past", 2) },
      ],
      [{ text: "‹ Меню", callback_data: entryCallback("menu") }],
    ]);
  });

  it("says in text that there are no active auctions", () => {
    const screen = renderEntryScreen(
      { kind: "auctions", list: { page: 0, pageCount: 1, auctions: [] } },
      options,
    );
    expect(screen.text).toBe(
      "<b>Аукционы</b>\n\nАктивных аукционов сейчас нет.",
    );
    expect(screen.keyboard).toEqual([
      [{ text: "‹ Меню", callback_data: entryCallback("menu") }],
    ]);
  });
});
