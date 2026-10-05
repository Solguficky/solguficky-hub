import type { AuctionScreenBody } from "@solguficky/auction-bot-ui";
import { describe, expect, it } from "vitest";
import { inspectCall, type ScreenEntry } from "../testkit/screen-lint.js";
import type { AuctionListPage } from "./auctions.js";
import { markupOf, richMessageOf } from "./bot.js";
import {
  type AuctionEntryScreen,
  type RenderedScreen,
  renderEntryScreen,
} from "./entry-screen.js";
import { type ScreenId, screenCatalog } from "./screen-catalog.js";

// Исключения каталога не переживают свою причину: каждая запись рендерится во
// всех своих видах, линтер гоняется без исключений, и набор сработавших
// правил обязан совпасть с `waive`. Исправил перевёрстку и не снял
// исключение — тест падает; сломал правило вне исключения — тоже.

const rub = (rubles: number) => ({ minorUnits: rubles * 100, currency: "RUB" });

const feed: AuctionScreenBody = {
  blocks: [
    {
      kind: "feed",
      auctionId: "auc-1",
      page: 1,
      pageCount: 3,
      lots: [
        {
          lotId: "lot-1",
          title: "Банка солёных грибов",
          status: { kind: "trading", currentPrice: rub(500), phase: "online" },
        },
      ],
    },
  ],
  keyboard: [
    [
      {
        action: "feed.open-lot",
        lotId: "lot-1",
        callbackData: "v1:auc:lot:lot-1:1",
      },
    ],
    [
      { action: "feed.prev", callbackData: "v1:auc:feed:auc-1:0" },
      { action: "feed.next", callbackData: "v1:auc:feed:auc-1:2" },
    ],
  ],
};

const emptyFeed: AuctionScreenBody = {
  blocks: [
    { kind: "feed", auctionId: "auc-1", page: 0, pageCount: 1, lots: [] },
  ],
  keyboard: [],
};

// Лот с итогом: «Обновить» и рядов ставки тело под ним не несёт.
const soldLot: AuctionScreenBody = {
  blocks: [
    {
      kind: "lot",
      lotId: "lot-1",
      auctionId: "auc-1",
      version: 9,
      card: { title: "Банка <солёных> грибов & рыжиков", description: "" },
      status: { kind: "sold", winnerId: "p-1", price: rub(900) },
      participantName: "@jay",
    },
  ],
  keyboard: [
    [{ action: "lot.history", callbackData: "v1:auc:hist:lot-1:1:999" }],
    [{ action: "lot.back", callbackData: "v1:auc:feed:auc-1:1" }],
  ],
};

const lot = (image: boolean): AuctionScreenBody => ({
  blocks: [
    {
      kind: "lot",
      lotId: "lot-1",
      auctionId: "auc-1",
      version: 3,
      card: {
        title: "Банка солёных грибов",
        description: "Грузди, урожай этого года.",
        ...(image ? { image: { version: "img-1" } } : {}),
      },
      status: { kind: "trading", currentPrice: rub(500), phase: "online" },
    },
  ],
  keyboard: [
    // Ряды листа ставки (PER-317): лот в онлайн-торгах с автоставкой.
    [
      {
        action: "lot.bid-step",
        amount: rub(550),
        callbackData: "v1:auc:cb:lot-1:fa:1",
      },
    ],
    [{ action: "lot.bid-custom", callbackData: "v1:auc:ab:lot-1:1" }],
    [{ action: "lot.proxy", callbackData: "v1:auc:ax:lot-1:1" }],
    [{ action: "lot.refresh", callbackData: "v1:auc:lot:lot-1:1" }],
    [{ action: "lot.history", callbackData: "v1:auc:hist:lot-1:1:999" }],
    [{ action: "lot.back", callbackData: "v1:auc:feed:auc-1:1" }],
  ],
});

// Хронология с обеими кнопками листания и пустая — первая и единственная
// страница. Возврат тела оболочка ставит в один ряд с «Меню».
const history = (entries: boolean): AuctionScreenBody => ({
  blocks: [
    {
      kind: "history",
      lotId: "lot-1",
      auctionId: "auc-1",
      title: "Банка солёных грибов",
      page: entries ? 1 : 0,
      pageCount: entries ? 3 : 1,
      entries: entries
        ? [
            {
              kind: "bid",
              sequence: 4,
              occurredAt: "2026-10-03T16:04:00Z",
              amount: rub(500),
              origin: { kind: "manual", source: "bot" },
              // Псевдоним со знаками разметки: строка хронологии его экранирует.
              participantName: "Сыч <&>*",
            },
            {
              kind: "bid",
              sequence: 6,
              occurredAt: "2026-10-03T16:04:00Z",
              amount: rub(550),
              origin: { kind: "proxy" },
            },
          ]
        : [],
    },
  ],
  keyboard: [
    ...(entries
      ? [
          [
            {
              action: "history.prev" as const,
              callbackData: "v1:auc:hist:lot-1:1:0",
            },
            {
              action: "history.next" as const,
              callbackData: "v1:auc:hist:lot-1:1:2",
            },
          ],
        ]
      : []),
    [{ action: "history.back" as const, callbackData: "v1:auc:lot:lot-1:1" }],
  ],
});

// Лист ставки (PER-317): подтверждения, вопросы и выбор имени.
const confirm = (command: "bid" | "proxy"): AuctionScreenBody => ({
  blocks: [
    {
      kind: "confirm",
      command,
      lotId: "lot-1",
      auctionId: "auc-1",
      title: "Банка солёных грибов",
      amount: rub(550),
      currentPrice: rub(500),
    },
  ],
  keyboard: [
    [{ action: "confirm.yes", callbackData: "v1:auc:b:lot-1:op:fa:1" }],
    [{ action: "confirm.no", callbackData: "v1:auc:lot:lot-1:1" }],
  ],
});

const question = (
  kind: "bid" | "proxy" | "alias",
  refused: boolean,
): AuctionScreenBody => ({
  blocks: [
    {
      kind: "question",
      question: kind,
      lotId: "lot-1",
      auctionId: "auc-1",
      ...(kind === "alias" ? {} : { current: rub(550) }),
      ...(refused ? { refusal: "not-a-number" as const } : {}),
    },
  ],
  keyboard: [
    [{ action: "question.cancel", callbackData: "v1:auc:qb:lot-1:1:42" }],
  ],
});

const nameChoice = (username: boolean): AuctionScreenBody => ({
  blocks: [
    {
      kind: "name-choice",
      lotId: "lot-1",
      auctionId: "auc-1",
      ...(username ? { username: "owl_fan" } : {}),
    },
  ],
  keyboard: [
    ...(username
      ? [
          [
            {
              action: "name.username" as const,
              callbackData: "v1:auc:nu:lot-1:1:bfa",
            },
          ],
        ]
      : []),
    [{ action: "name.alias", callbackData: "v1:auc:aa:lot-1:1:bfa" }],
    [{ action: "name.back", callbackData: "v1:auc:lot:lot-1:1" }],
  ],
});
const emptyList: AuctionListPage = { page: 0, pageCount: 1, auctions: [] };

// Страница посередине: строки аукционов, обе стрелки листания и возврат.
const middlePage: AuctionListPage = {
  page: 1,
  pageCount: 3,
  auctions: [
    {
      auctionId: "01926f3c-8b7a-5cde-8f00-000000000001",
      stage: "prebidding",
      opensAt: "2026-10-10T16:00:00Z",
      lotCount: 12,
    },
    {
      auctionId: "01926f3c-8b7a-5cde-8f00-000000000002",
      stage: "scheduled",
      lotCount: 1,
    },
  ],
};

// Тексты организатора со знаками разметки: в сообщение они уходят дословно.
const urls = {
  items: "Грибы & соленья <домашние>.",
  purpose: "На сходки.",
  simultaneousBids: "Побеждает первая.",
  connectionFailure: "Ставка либо принята, либо нет.",
  delivery: "Лично на сходке.",
  detailsUrl: "https://example.org/rules",
  questionUrl: "https://t.me/organizer",
};

// Каждый вид каждого экрана, который оболочка умеет отдать.
const shown: readonly {
  screen: AuctionEntryScreen;
  faq?: typeof urls;
  presentation?: "plain";
}[] = [
  { screen: { kind: "menu" } },
  { screen: { kind: "faq" } },
  { screen: { kind: "faq" }, faq: urls },
  { screen: { kind: "details" } },
  { screen: { kind: "question" } },
  { screen: { kind: "auctions", list: emptyList } },
  { screen: { kind: "auctions", list: middlePage } },
  { screen: { kind: "past", list: emptyList } },
  { screen: { kind: "past", list: middlePage } },
  { screen: { kind: "auction", body: feed, parent: "auctions" } },
  { screen: { kind: "auction", body: feed, parent: "past" } },
  { screen: { kind: "auction", body: emptyFeed, parent: "auctions" } },
  { screen: { kind: "auction", body: lot(false) } },
  { screen: { kind: "auction", body: lot(true) } },
  { screen: { kind: "auction", body: lot(true) }, presentation: "plain" },
  { screen: { kind: "auction", body: soldLot } },
  { screen: { kind: "auction", body: soldLot }, presentation: "plain" },
  { screen: { kind: "auction", body: history(true) } },
  { screen: { kind: "auction", body: history(false) } },
  { screen: { kind: "auction", body: confirm("bid") } },
  { screen: { kind: "auction", body: confirm("proxy") } },
  { screen: { kind: "auction", body: question("bid", false) } },
  { screen: { kind: "auction", body: question("bid", true) } },
  { screen: { kind: "auction", body: question("proxy", false) } },
  { screen: { kind: "auction", body: question("alias", true) } },
  { screen: { kind: "auction", body: nameChoice(true) } },
  { screen: { kind: "auction", body: nameChoice(false) } },
  { screen: { kind: "denied", reason: "blocked" } },
  { screen: { kind: "denied", reason: "not-admitted" } },
  { screen: { kind: "denied", reason: "declined" } },
  { screen: { kind: "outdated" } },
  // Повтор несёт данные исходного нажатия — здесь у самого предела кнопки.
  {
    screen: {
      kind: "unavailable",
      exit: { kind: "retry", data: `v1:auc:${"x".repeat(57)}` },
    },
  },
  {
    screen: {
      kind: "unavailable",
      exit: { kind: "enter", data: "v1:entry:start" },
    },
  },
  { screen: { kind: "unavailable", exit: { kind: "answer" } } },
];

// Вызов в той форме, в какой его собирает адаптер (`bot.ts`): rich-карточка —
// rich-сообщение, остальное — текст. Параметры разметки и метку даёт сам
// адаптер.
function sent(screen: RenderedScreen): [method: string, payload: unknown] {
  const markup = markupOf(screen);
  return screen.format === "rich"
    ? [
        "sendRichMessage",
        {
          chat_id: 42,
          rich_message: richMessageOf(screen, undefined),
          ...markup,
        },
      ]
    : ["sendMessage", { chat_id: 42, text: screen.text, ...markup }];
}

const entries = Object.entries(screenCatalog) as [ScreenId, ScreenEntry][];

const bare = Object.fromEntries(
  entries.map(([id, { waive: _waive, ...entry }]) => [id, entry]),
);

const rendered = shown.map(({ screen, faq, presentation }) =>
  renderEntryScreen(screen, {
    timeZone: "Europe/Moscow",
    ...(faq === undefined ? {} : { faq }),
    ...(presentation === undefined ? {} : { presentation }),
  }),
);

function brokenRules(): Map<ScreenId, Set<string>> {
  const broken = new Map<ScreenId, Set<string>>();
  for (const screen of rendered) {
    const rules = broken.get(screen.id) ?? new Set<string>();
    for (const violation of inspectCall(...sent(screen), bare)) {
      rules.add(violation.rule);
    }
    broken.set(screen.id, rules);
  }
  return broken;
}

describe("auction screen catalog", () => {
  const broken = brokenRules();

  it("shows every entry at least once", () => {
    expect(entries.map(([id]) => id).filter((id) => !broken.has(id))).toEqual(
      [],
    );
  });

  it.each(entries)("waives exactly what %s breaks", (id, entry) => {
    expect([...(broken.get(id) ?? [])].sort()).toEqual(
      Object.keys(entry.waive ?? {}).sort(),
    );
  });
});

// Правила дизайн-кода, которых линтер не видит: он проверяет клавиатуру по
// записи каталога, а эти — свойства всех экранов бота сразу.
describe("auction screens beyond the linter", () => {
  const buttons = rendered.flatMap((screen) =>
    screen.keyboard.flat().map((button) => ({ screen: screen.id, button })),
  );
  // Видимый текст: теги сняты. Остаток `<` — неэкранированный знак.
  const visible = (screen: RenderedScreen) =>
    screen.text.replace(/<\/?(b|h1|p|br)>/g, "");

  it("marks every link button, and only a link button, with the sign", () => {
    expect(
      buttons
        .filter(({ button }) => "url" in button !== button.text.endsWith(" ↗"))
        .map(({ screen, button }) => `${screen}: ${button.text}`),
    ).toEqual([]);
  });

  it("keeps the FAQ button in the menu only", () => {
    expect(
      buttons
        .filter(({ button }) => button.text === "Правила и FAQ")
        .map(({ screen }) => screen),
    ).toEqual(["menu"]);
  });

  it("uses the dictionary for the menu and paging", () => {
    const labels = buttons.map(({ button }) => button.text);
    for (const retired of ["В меню", "К лотам"]) {
      expect(labels).not.toContain(retired);
    }
    expect(
      labels.filter((label) => /Предыдущие|Следующие/.test(label)),
    ).toEqual([]);
  });

  it("addresses the person informally in every text", () => {
    // Местоимения и повелительные формы, которые стояли в текстах до
    // перевёрстки; общий признак окончания дал бы ложные «лимите» и «ответе».
    const formal =
      /(^|[^а-яё])(вы|вас|вам|ваш[а-яё]*|выберите|отправьте|попробуйте|пришлите|откройте|проверьте)(?![а-яё])/i;
    expect(
      rendered
        .filter((screen) => formal.test(visible(screen)))
        .map((screen) => `${screen.id}: ${visible(screen)}`),
    ).toEqual([]);
  });

  it("leaves no raw markup character of a lot title or organizer text", () => {
    expect(
      rendered
        .filter((screen) => /<|&(?!(amp|lt|gt);)/.test(visible(screen)))
        .map((screen) => `${screen.id}: ${visible(screen)}`),
    ).toEqual([]);
  });

  // Линтер принимает жирную строку в любом месте текста: перед заголовком
  // вправе стоять заметка. У экранов этого списка заметок нет, и заголовок
  // обязан быть первым; вопрос с причиной отказа — класс «вопрос», не экран.
  it("starts every screen with its bold title", () => {
    expect(
      rendered
        .filter((screen) => screen.asks !== true)
        .filter((screen) => !/^<(b|h1)>/.test(screen.text))
        .map((screen) => `${screen.id}: ${screen.text.slice(0, 40)}`),
    ).toEqual([]);
  });

  it("sends every screen with markup", () => {
    for (const screen of rendered) {
      const [, payload] = sent(screen);
      // `sent` отдаёт параметры вызова без типа: он зависит от метода.
      const call = payload as { parse_mode?: unknown; rich_message?: unknown };
      expect(
        call.parse_mode === "HTML" || call.rich_message !== undefined,
      ).toBe(true);
    }
  });
});
