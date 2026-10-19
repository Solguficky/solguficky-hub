import { describe, expect, it } from "vitest";
import {
  type AuctionBlock,
  encodeAuctionCallback,
  type Money,
} from "../../auction-ui/index.js";
import type { AuctionSummary } from "./auctions.js";
import {
  auctionLabel,
  money,
  type RenderOptions,
  renderEntryScreen,
  TEXT_LIMIT,
} from "./entry-screen.js";
import { entryCallback, listCallback } from "./faq.js";

// Момент показа в 2026 году: года в датах экранов нет, пока он текущий.
const now = new Date("2026-10-07T12:00:00Z");
const options = { timeZone: "Europe/Moscow", now };
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
  // FAQ — раздел под меню (PER-592): кнопка «Аукционы» под ним ставит
  // отметку ознакомления и открывает список, последний ряд — «‹ Меню».
  it("ends the FAQ with the button that opens the auctions and the way back", () => {
    const screen = renderEntryScreen({ kind: "faq" }, options);
    expect(screen.keyboard.slice(-2)).toEqual([
      [{ text: "Аукционы", callback_data: entryCallback("read") }],
      [{ text: "‹ Меню", callback_data: entryCallback("menu") }],
    ]);
  });

  // Корневое меню — общий родитель разделов (PER-592): «Аукционы»,
  // «Настройки» (PER-595), затем FAQ; возврата нет. «Избранного» в меню нет:
  // оно открывается из корня аукциона (PER-644).
  it("lists the sections in the menu without favorites", () => {
    const menu = renderEntryScreen({ kind: "menu" }, options);
    expect(menu.keyboard.flat().map((button) => button.text)).toEqual([
      "Аукционы",
      "Настройки",
      "Правила и FAQ",
    ]);
    expect(menu.id).toBe("menu");
    expect(menu.text).toMatch(/^<b>Меню<\/b>\n\n/);
  });

  // Приветствие без права (дополнение ADR-060): что за бот, что за аукцион,
  // кто даёт допуск — и одна кнопка, которая ставит заявку; код канала едет
  // в её данных.
  it("welcomes with one button that applies and carries the channel code", () => {
    const screen = renderEntryScreen(
      { kind: "welcome", sourceCode: "chat" },
      options,
    );
    expect(screen.id).toBe("welcome");
    expect(screen.text).toContain("бот аукциона сообщества солегуфиков");
    expect(screen.text).toContain(
      "Доступ выдаёт администратор или мейнтейнер.",
    );
    expect(screen.keyboard).toEqual([
      [{ text: "Подать заявку", callback_data: "v1:entry:apply:chat" }],
    ]);
    expect(renderEntryScreen({ kind: "welcome" }, options).keyboard).toEqual([
      [{ text: "Подать заявку", callback_data: "v1:entry:apply" }],
    ]);
  });

  it("names who admits on the waiting frame", () => {
    const screen = renderEntryScreen(
      { kind: "denied", reason: "not-admitted" },
      options,
    );
    expect(screen.text).toBe(
      "<b>Заявка на рассмотрении.</b> Участие в аукционе пока не открыто. Доступ выдаёт администратор или мейнтейнер.",
    );
  });

  // Ожидание допуска несёт вход в бот поддержки, когда её адрес задан
  // (PER-625, ADR-068): «?start=auction» говорит боту поддержки, откуда
  // человек. Отказ, блокировка и переход в бот хаба кнопки не несут.
  it("offers the support bot on the waiting frame when its address is set", () => {
    const render: RenderOptions = {
      ...options,
      supportBotUsername: "solguficky_support_bot",
    };
    const waiting = renderEntryScreen(
      { kind: "denied", reason: "not-admitted" },
      render,
    );
    expect(waiting.id).toBe("denied-support");
    expect(waiting.keyboard).toEqual([
      [
        {
          text: "Написать в поддержку ↗",
          url: "https://t.me/solguficky_support_bot?start=auction",
        },
      ],
    ]);
    for (const reason of ["declined", "blocked", "in-community"] as const) {
      const screen = renderEntryScreen({ kind: "denied", reason }, render);
      expect(screen.keyboard).toEqual([]);
      expect(screen.id).toBe(reason === "in-community" ? reason : "denied");
    }
  });

  it("hints how to answer an open question and where to go otherwise", () => {
    const open = renderEntryScreen(
      { kind: "hint", openQuestion: true },
      options,
    );
    const none = renderEntryScreen(
      { kind: "hint", openQuestion: false },
      options,
    );
    expect(open.text).toMatch(/^<b>Ответ не дошёл до вопроса\.<\/b> /);
    expect(none.text).toMatch(/^<b>Я отвечаю на кнопки и команды\.<\/b> /);
    expect(none.keyboard).toEqual([
      [{ text: "‹ Меню", callback_data: entryCallback("menu") }],
    ]);
  });

  // Состояния FAQ возвращают в FAQ (дизайн-код, «Дерево бота аукциона»).
  it.each(["details", "question"] as const)(
    "returns from the FAQ state %s to FAQ",
    (kind) => {
      const screen = renderEntryScreen({ kind }, options);
      expect(screen.text).toMatch(/^<b>Правила и FAQ<\/b>\n\nОрганизатор/);
      expect(screen.keyboard).toEqual([
        [{ text: "‹ FAQ", callback_data: entryCallback("faq") }],
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
      [{ text: "‹ Аукционы", callback_data: entryCallback("auctions") }],
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
            [{ action: "feed.back", callbackData: "v1:auc:rt:x" }],
          ],
        },
      },
      options,
    );
    expect(screen.format).toBe("html");
    // Текст не повторяет кнопки (PER-595): своих лотов нет — сводка так и
    // говорит, а все лоты — кнопками.
    expect(plain(screen.text)).toBe(
      "<b>Лоты · 1 из 2</b>\n\nТы пока не лидируешь ни в одном лоте этого аукциона. Все лоты — кнопками ниже.",
    );
    expect(screen.keyboard.map((row) => row.map((b) => plain(b.text)))).toEqual(
      [
        ["Носки · старт 500 ₽"],
        ["Лот без названия · не продан"],
        ["→"],
        // Лента — под корнем аукциона, и возврат в него ставит тело дерева
        // (PER-644).
        ["‹ Аукцион"],
      ],
    );
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
              lots: [won],
              mine: [won],
            },
          ],
          keyboard: [
            [{ action: "feed.open-lot", lotId: "a", callbackData: "ca" }],
          ],
        },
      },
      options,
    );
    expect(plain(screen.text)).toBe(
      "<b>Лоты</b>\n\nЗдесь только твои лоты: где ты лидер и что ты купил. Все лоты аукциона — кнопками ниже.\n\n• Ваза • Другой лот — ✅ твой лот за 3 000 ₽",
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
    // Порядок групп: статус, цена, лидер и срок со знаками, ход торгов,
    // описание; строки без точек (дизайн-код, «Карточка»; PER-594).
    // 18:00 UTC — 21:00 по Москве.
    expect(plain(screen.text)).toBe(
      "<h1>Кружка</h1><p>Статус: идут торги</p>" +
        "<p>💰 Цена: 1 200 ₽<br>👤 Лидер: @owl<br>⏳ Торги до: 10 октября, сб, 21:00</p>" +
        "<p>Следующая ставка: от 1 250 ₽<br>Шаг: 50 ₽</p>" +
        "<p>Роспись.</p>",
    );
    expect(screen.photo).toBeUndefined();
  });

  // Пустое описание — заглушка, та же, что у карточки сходки хаба (PER-594).
  it("shows the placeholder for an empty description of a lot without a photo", () => {
    const screen = lotScreen({ card: { title: "Кружка", description: "" } });
    expect(screen.photo).toBeUndefined();
    expect(plain(screen.text)).toMatch(
      /<\/p><p>Описание пока не добавлено\.<\/p>$/,
    );
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
    expect(text).toContain("Лидер: есть");
    expect(text).not.toContain("p-1");
  });

  it("shows the winner and the price of a sold lot", () => {
    const text = plain(
      lotScreen({
        status: { kind: "sold", winnerId: "p-3", price: rub(3000) },
        participantName: "Сыч*",
      }).text,
    );
    expect(text).toContain("Статус: продан");
    expect(text).toContain("Цена продажи: 3 000 ₽");
    expect(text).toContain("Победитель: Сыч*");
  });

  // Последний ряд под лотом — возврат одной кнопкой: «Меню» нет (решение
  // владельца 10 октября 2026 года).
  it("puts the return to the feed alone into the last row of a lot", () => {
    expect(lotScreen({}).keyboard).toEqual([
      [{ text: "‹ Лоты", callback_data: "v1:auc:feed:x:0" }],
    ]);
  });

  it("shows an unsold lot as an outcome without a winner", () => {
    const text = lotScreen({ status: { kind: "unsold" } }).text;
    expect(text).toContain("Статус: не продан");
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
        "<p>Статус: продан</p><p>💰 Цена продажи: 3 000 ₽<br>👤 Победитель: Сыч</p>" +
        "<p>Роспись.<br>Ручная.</p><p>Объём 300 мл.</p>",
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
      "<b>Кружка &lt;XL&gt;</b>\n\nСтатус: не продан\n\nРоспись &amp; глазурь.",
    );
  });

  it("keeps a long plain card within the message limit", () => {
    const screen = lotScreen(
      { card: { title: "Кружка", description: "я".repeat(10_000) } },
      plainCard,
    );
    expect(visible(screen.text).length).toBeLessThanOrEqual(TEXT_LIMIT);
    expect(screen.text).toContain("…");
    expect(screen.text).toContain("Статус: не продан");
  });

  // Длину названия Auction не ограничивает: цена и исход остаются на карточке.
  it("keeps the price of a card with a very long title", () => {
    const screen = lotScreen({
      card: { title: "К".repeat(5_000), description: "" },
      status: { kind: "sold", winnerId: "p-3", price: rub(3000) },
    });
    expect(plain(visible(screen.text))).toContain("Цена продажи: 3 000 ₽");
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

  // Свой лимит — строка хода торгов; над названием ничего нет (PER-472,
  // PER-594). Пустое описание — заглушка.
  it("shows the own limit in the trading course and nothing above the title", () => {
    const screen = lotScreen(
      {
        card: { title: "Кружка", description: "" },
        status: { kind: "trading", currentPrice: rub(1200), phase: "online" },
        viewerProxyLimit: rub(2000),
      },
      plainCard,
    );
    expect(plain(screen.text)).toBe(
      "<b>Кружка</b>\n\n" +
        "Статус: идут торги\n\n💰 Цена: 1 200 ₽\n👤 Лидер: пока нет\n\n" +
        "Твоя автоставка: до 2 000 ₽ (видишь только ты)\n\n" +
        "Описание пока не добавлено.",
    );
  });

  // Отказ команды — свой экран исхода (PER-472): исход в заголовке, лот
  // жирным абзацем (PER-594), цена из отказа абзацем, выход — «К лоту».
  it("shows a refused command as its own outcome screen", () => {
    const screen = renderEntryScreen(
      {
        kind: "auction",
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
      },
      plainCard,
    );
    expect(screen.id).toBe("command-result");
    expect(plain(screen.text)).toBe(
      "<b>Ставка ниже порога</b>\n\n<b>Кружка</b>\n\nСейчас можно от 1 300 ₽.",
    );
    expect(screen.keyboard.map((row) => row.map((b) => b.text))).toEqual([
      ["‹ Лот"],
    ]);
  });

  // Чужой год называется в дате (дизайн-код, «Формат»).
  it("names the year of a deadline outside the current year", () => {
    const text = plain(
      visible(
        lotScreen({
          status: {
            kind: "trading",
            currentPrice: rub(1),
            deadline: "2027-01-09T18:00:00Z",
            phase: "online",
          },
        }).text,
      ),
    );
    expect(text).toContain("Торги до: 9 января 2027, сб, 21:00");
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
      options,
    );

  it("names how far the bot may raise the price", () => {
    const screen = confirm(2000);
    expect(plain(screen.text)).toMatch(
      /^<b>Включить автоставку до 2 000 ₽\?<\/b>\n\n/,
    );
    expect(screen.text).toMatch(/поднимет её не больше чем на 800\s₽/);
    expect(screen.text).toContain("Лимит видишь только ты.");
    expect(screen.keyboard[0]?.[0]).toMatchObject({
      text: "✔️ Да, включить автоставку",
      style: "danger",
    });
  });

  it("says the bot will not outbid when the limit is not above the price", () => {
    expect(confirm(1200).text).toContain("перебивать бот не будет");
  });
});

// Лист ставки (PER-472): заголовок-вопрос с суммой и название жирным у
// подтверждения, пустая строка после заголовка, причина отказа над ним.
describe("bid sheet screens", () => {
  const body = (block: AuctionBlock) =>
    renderEntryScreen(
      {
        kind: "auction",
        body: {
          blocks: [block],
          keyboard: [
            [
              {
                action: "question.cancel",
                callbackData: "v1:auc:qb:lot-1:1:42",
              },
            ],
          ],
        },
      },
      options,
    );

  it("asks the bid as a question with the lot in bold", () => {
    const screen = body({
      kind: "confirm",
      command: "bid",
      lotId: "lot-1",
      auctionId: "auc-1",
      title: "Кружка <с совой>",
      amount: rub(1300),
      currentPrice: rub(1200),
    });
    expect(plain(screen.text)).toBe(
      "<b>Поставить 1 300 ₽?</b>\n\n<b>Кружка &lt;с совой&gt;</b>\n\nОтменить ставку нельзя.",
    );
  });

  // Лимит, равный стартовой цене лота без ставок, — первая ставка (П-01).
  it("names the first bid when the limit equals the start price", () => {
    const screen = body({
      kind: "confirm",
      command: "proxy",
      lotId: "lot-1",
      auctionId: "auc-1",
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
    const screen = body({
      kind: "question",
      question: "bid",
      lotId: "lot-1",
      auctionId: "auc-1",
      current: rub(1600),
    });
    expect(plain(screen.text)).toBe(
      "<b>Своя сумма</b>\n\nПришли сумму ставки в рублях.\nМинимальная ставка: 1 600 ₽\nНапример: 1 500",
    );
    expect(screen.asks).toBe(true);
  });

  // Пояснение автоставки (PER-517) — абзацем над тем, что прислать: пример
  // считается из цены и шага лота, а не написан в тексте.
  it("explains the limit on this lot before asking it", () => {
    const screen = body({
      kind: "question",
      question: "proxy",
      lotId: "lot-1",
      auctionId: "auc-1",
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
    expect(screen.asks).toBe(true);
  });

  // Лидеру автоставка сразу ничего не ставит: пример называет его цену.
  it("explains the limit to the leader without a first bid", () => {
    const screen = body({
      kind: "question",
      question: "proxy",
      lotId: "lot-1",
      auctionId: "auc-1",
      explainer: {
        example: {
          currentPrice: rub(1200),
          step: rub(50),
          limit: rub(1350),
        },
      },
    });
    expect(plain(screen.text)).toContain(
      "Например: цена сейчас 1 200 ₽ — твоя, шаг 50 ₽, твой лимит 1 350 ₽. Бот будет отвечать на чужие ставки, но не выше 1 350 ₽. Никто не перебьёт — заплатишь 1 200 ₽, а не 1 350 ₽.",
    );
  });

  it("explains the limit without an example when the lot has no step", () => {
    const screen = body({
      kind: "question",
      question: "proxy",
      lotId: "lot-1",
      auctionId: "auc-1",
      explainer: {},
    });
    expect(plain(screen.text)).toContain(
      "\n\n💡 Подсказка: платишь цену, а не лимит.",
    );
    expect(screen.text).not.toContain("Например: цена сейчас");
  });

  // Непринятый ответ — свой экран (PER-472): причина в заголовке, над
  // «К лоту» — «Ввести заново».
  it("shows a refused answer as its own screen with a retry", () => {
    const screen = renderEntryScreen(
      {
        kind: "auction",
        body: {
          blocks: [
            {
              kind: "answer-refused",
              refusal: "too-large",
              lotId: "lot-1",
              auctionId: "auc-1",
              title: "Кружка",
            },
          ],
          keyboard: [
            [{ action: "answer.retry", callbackData: "v1:auc:ask:b:lot-1:0" }],
            [{ action: "result.lot", callbackData: "v1:auc:lot:lot-1:0" }],
          ],
        },
      },
      options,
    );
    expect(screen.id).toBe("answer-refused");
    expect(screen.asks).toBeUndefined();
    expect(plain(screen.text)).toBe(
      "<b>Сумма слишком большая</b>\n\n<b>Кружка</b>\n\nБот принимает суммы до 604 661,75 ₽.",
    );
    expect(screen.keyboard.map((row) => row.map((b) => b.text))).toEqual([
      ["Ввести заново"],
      ["‹ Лот"],
    ]);
  });

  it("lists the bids as lines under the lot in bold with the foreign year", () => {
    const screen = body({
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
    });
    expect(plain(screen.text)).toBe(
      "<b>Ставки</b>\n<i>Кружка</i>\n\n• 3 октября 2025, пт, 19:04 · @jay · 500 ₽ · вручную",
    );
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
    expect(auctionLabel(auction({ lotCount }), "Europe/Moscow", now)).toBe(
      `10 октября, сб · идут ставки · ${label}`,
    );
  });

  it("names the day in the community zone and a format without an online phase", () => {
    expect(
      auctionLabel(
        auction({ opensAt: "2026-10-10T22:30:00Z", stage: "scheduled" }),
        "Europe/Moscow",
        now,
      ),
    ).toBe("11 октября, вс · скоро старт · 5 лотов");
    const { opensAt: _opensAt, ...without } = auction({});
    expect(auctionLabel(without, "Europe/Moscow", now)).toBe(
      "Без онлайн-торгов · идут ставки · 5 лотов",
    );
    // Чужой год называется (дизайн-код, «Формат»).
    expect(
      auctionLabel(
        auction({ opensAt: "2027-01-09T16:00:00Z" }),
        "Europe/Moscow",
        now,
      ),
    ).toBe("9 января 2027, сб · идут ставки · 5 лотов");
  });

  it("names the finished stage in a past row", () => {
    expect(
      auctionLabel(auction({ stage: "finished" }), "Europe/Moscow", now),
    ).toBe("10 октября, сб · завершён · 5 лотов");
  });

  // Строка списка открывает корень аукциона, как в хабе (PER-644).
  it("opens the auction root from the row and pages the list with arrows", () => {
    const screen = renderEntryScreen(
      {
        kind: "past",
        list: { page: 1, pageCount: 3, auctions: [auction({})] },
      },
      options,
    );
    // Строка аукциона в теле: день подписан — это начало торгов, — отделён
    // «—», этап выделен, число лотов через запятую (PER-595).
    expect(screen.text).toBe(
      "<b>Прошедшие аукционы · 2 из 3</b>\n\n• Торги с 10 октября, сб — <b>идут ставки</b>, 5 лотов",
    );
    expect(screen.keyboard).toEqual([
      [
        {
          text: "10 октября, сб · идут ставки · 5 лотов",
          callback_data: encodeAuctionCallback({
            kind: "root",
            auctionId: "01926f3c-8b7a-5cde-8f00-000000000001",
          }),
        },
      ],
      [
        { text: "←", callback_data: entryCallback("past") },
        { text: "→", callback_data: listCallback("past", 2) },
      ],
      // «Прошедшие» — внутри «Аукционов» и возвращают в них (PER-592).
      [{ text: "‹ Аукционы", callback_data: entryCallback("auctions") }],
    ]);
  });

  // Отсчёт до финала (PER-518): день финала — день общего дедлайна в поясе
  // сообщества; `now` — 7 октября, 15:00 по Москве.
  it.each([
    ["2026-10-09T21:00:00Z", ", до финала 3 дня"],
    ["2026-10-07T21:00:00Z", ", до финала 1 день"],
    ["2026-10-12T00:00:00Z", ", до финала 5 дней"],
    ["2026-10-18T00:00:00Z", ", до финала 11 дней"],
    ["2026-10-28T00:00:00Z", ", до финала 21 день"],
    // 20:59 UTC — ещё 7 октября по Москве: финал сегодня.
    ["2026-10-07T20:59:00Z", ", финал сегодня"],
    ["2026-10-06T21:00:00Z", ", финал сегодня"],
    // Вчерашний по Москве дедлайн строку убирает.
    ["2026-10-06T20:59:00Z", ""],
  ])("counts down to a finale at %s", (closesAt, tail) => {
    // Отсчёт выделен, как этап (PER-595).
    const marked = tail === "" ? "" : `, <b>${tail.slice(2)}</b>`;
    const screen = renderEntryScreen(
      {
        kind: "auctions",
        list: { page: 0, pageCount: 1, auctions: [auction({ closesAt })] },
      },
      options,
    );
    expect(screen.text).toBe(
      `<b>Аукционы</b>\n\n• Торги с 10 октября, сб — <b>идут ставки</b>, 5 лотов${marked}`,
    );
    // Кнопка остаётся короткой, как у «счастливых часов».
    expect(screen.keyboard[0]?.[0]?.text).toBe(
      "10 октября, сб · идут ставки · 5 лотов",
    );
  });

  it("has no countdown without a deadline or for a finished auction", () => {
    const line = (summary: AuctionSummary) =>
      renderEntryScreen(
        {
          kind: "auctions",
          list: { page: 0, pageCount: 1, auctions: [summary] },
        },
        options,
      ).text;
    expect(line(auction({}))).not.toContain("финал");
    expect(
      line(auction({ stage: "finished", closesAt: "2026-10-09T21:00:00Z" })),
    ).not.toContain("финал");
  });

  it("says in text that there are no active auctions", () => {
    const screen = renderEntryScreen(
      { kind: "auctions", list: { page: 0, pageCount: 1, auctions: [] } },
      options,
    );
    expect(screen.text).toBe(
      "<b>Аукционы</b>\n\nАктивных аукционов сейчас нет.",
    );
    // Пустой список — не тупик (PER-592): «Прошедшие» внутри раздела и
    // возврат в меню.
    expect(screen.keyboard).toEqual([
      [{ text: "Прошедшие", callback_data: entryCallback("past") }],
      [{ text: "‹ Меню", callback_data: entryCallback("menu") }],
    ]);
  });
});

// «Счастливые часы» (PER-505): окно сниженного шага в ленте и карточке. Те же
// строки ждёт оболочка хаба в `screens/auction.test.ts`.
describe("happy hours", () => {
  const trading = {
    kind: "trading" as const,
    currentPrice: rub(1200),
    phase: "online" as const,
  };
  const facts = (block: Partial<Extract<AuctionBlock, { kind: "lot" }>>) =>
    plain(visible(lotScreen({ status: trading, ...block }).text));

  it("shows the window step until its end next to the regular step", () => {
    const text = facts({
      nextPrice: rub(1210),
      fixedStep: rub(50),
      baseStep: rub(50),
      activeWindow: {
        from: "2026-10-10T15:00:00Z",
        until: "2026-10-10T18:00:00Z",
        step: rub(10),
      },
    });
    // «Шаг: 50 ₽» не повторяется: обычный шаг назван своей строкой.
    expect(text).toContain(
      "Следующая ставка: от 1 210 ₽\nСчастливые часы: шаг 10 ₽ до 10 октября, сб, 21:00\nОбычный шаг: 50 ₽\n",
    );
    expect(text).not.toContain("\nШаг:");
  });

  it("shows the regular step once the snapshot has no window", () => {
    const text = facts({
      nextPrice: rub(1250),
      fixedStep: rub(50),
      baseStep: rub(50),
    });
    expect(text).toContain("Следующая ставка: от 1 250 ₽\nШаг: 50 ₽\n");
    expect(text).not.toContain("Счастливые часы");
  });

  it("names the day of a future window once when it fits in a day", () => {
    const text = facts({
      fixedStep: rub(50),
      baseStep: rub(50),
      nextWindow: {
        from: "2026-10-11T12:00:00Z",
        until: "2026-10-11T15:00:00Z",
        step: rub(10),
      },
    });
    expect(text).toContain(
      "Шаг: 50 ₽\nСчастливые часы: с 11 октября, вс, 15:00 до 18:00, шаг 10 ₽",
    );
  });

  it("names both days of a future window across midnight", () => {
    const text = facts({
      nextWindow: {
        from: "2026-10-11T20:00:00Z",
        until: "2026-10-11T22:00:00Z",
        step: rub(10),
      },
    });
    expect(text).toContain(
      "Счастливые часы: с 11 октября, вс, 23:00 до 12 октября, пн, 01:00, шаг 10 ₽",
    );
  });

  it("marks a lot of the feed whose window is in force", () => {
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
                { lotId: "b", title: "Ваза", status: trading },
              ],
            },
          ],
          keyboard: [
            [{ action: "feed.open-lot", lotId: "a", callbackData: "ca" }],
            [{ action: "feed.open-lot", lotId: "b", callbackData: "cb" }],
            [{ action: "feed.back", callbackData: "v1:auc:rt:x" }],
          ],
        },
      },
      options,
    );
    // Кнопка остаётся короткой: отметка — строкой сводки (PER-595).
    expect(plain(screen.text)).toBe(
      "<b>Лоты</b>\n\nТы пока не лидируешь ни в одном лоте этого аукциона. Все лоты — кнопками ниже.\n\nСчастливые часы сейчас: Кружка.",
    );
    expect(screen.keyboard.map((row) => row.map((b) => plain(b.text)))).toEqual(
      [["Кружка · 1 200 ₽"], ["Ваза · 1 200 ₽"], ["‹ Аукцион"]],
    );
  });
});

// Шаг до торгов (PER-618): тем же форматом, что в торгах, своей группой под
// стартовой ценой. Те же строки ждёт оболочка хаба в `screens/auction.test.ts`.
describe("lot card before trading", () => {
  const scheduled = (block: Partial<Extract<AuctionBlock, { kind: "lot" }>>) =>
    plain(
      visible(
        lotScreen({
          status: { kind: "scheduled", startingPrice: rub(500) },
          ...block,
        }).text,
      ),
    );

  it("shows the single step under the starting price", () => {
    expect(scheduled({ fixedStep: rub(50) })).toContain(
      "Статус: торги ещё не начались\n💰 Стартовая цена: 500 ₽\nШаг: 50 ₽\n",
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
      "💰 Стартовая цена: 500 ₽\nШаг по порогам:\nот 0 ₽ — 50 ₽\nот 5 000 ₽ — 250 ₽\n",
    );
  });
});

// Лента до торгов (PER-618): те же строки ждёт оболочка хаба.
describe("feed before trading", () => {
  const feedText = (beforeTrading: boolean) =>
    plain(
      renderEntryScreen(
        {
          kind: "auction",
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
                    title: "Носки",
                    status: { kind: "scheduled", startingPrice: rub(500) },
                  },
                ],
                ...(beforeTrading ? { beforeTrading: true as const } : {}),
              },
            ],
            keyboard: [
              [{ action: "feed.open-lot", lotId: "a", callbackData: "ca" }],
            ],
          },
        },
        options,
      ).text,
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

// Живой финал (PER-639): те же слова, что у хаба (`screens/auction.test.ts`):
// лента называет лот на торгах, карточка — одну строку цены без шага.
describe("live final in the auction shell", () => {
  const shirt = {
    lotId: "a",
    title: "Футболка",
    status: {
      kind: "trading" as const,
      currentPrice: rub(1200),
      phase: "live" as const,
      ask: rub(1500),
    },
  };
  const vase = {
    lotId: "b",
    title: "Ваза",
    status: { kind: "held" as const, currentPrice: rub(400) },
  };
  const mug = {
    lotId: "c",
    title: "Кружка",
    status: { kind: "sold" as const, winnerId: "w", price: rub(900) },
  };

  it("names the lot on sale and marks the lineup apart from the sold lots", () => {
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
              lots: [shirt, vase, mug],
              final: { active: shirt },
            },
          ],
          keyboard: [
            [{ action: "feed.open-lot", lotId: "a", callbackData: "ca" }],
            [{ action: "feed.open-lot", lotId: "b", callbackData: "cb" }],
            [{ action: "feed.open-lot", lotId: "c", callbackData: "cc" }],
            [{ action: "feed.back", callbackData: "v1:auc:rt:x" }],
          ],
        },
      },
      options,
    );
    expect(plain(screen.text)).toContain(
      "Идёт финал: сейчас «Футболка», цена 1 200 ₽, ведущий объявил 1 500 ₽.",
    );
    expect(
      screen.keyboard.slice(0, 3).map((row) => plain(row[0]?.text ?? "")),
    ).toEqual([
      "▶ Футболка · на торгах",
      "Ваза · в составе · 400 ₽",
      "Кружка · продан за 900 ₽",
    ]);
  });

  it("shows one price line and no step on the card of the live final", () => {
    const text = plain(
      lotScreen({
        card: { title: "Футболка", description: "" },
        nextPrice: rub(1500),
        fixedStep: rub(200),
        status: {
          kind: "trading",
          currentPrice: rub(1200),
          phase: "live",
          ask: rub(1500),
        },
      }).text,
    );
    expect(text).toContain("Ведущий объявил: 1 500 ₽");
    expect(text).not.toContain("Следующая ставка");
    expect(text).not.toContain("Шаг");
  });
});
