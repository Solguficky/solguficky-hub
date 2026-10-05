import type { AuctionScreenBody } from "@solguficky/auction-bot-ui";
import { describe, expect, it } from "vitest";
import { inspectCall, type ScreenEntry } from "../testkit/screen-lint.js";
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
    [{ action: "lot.refresh", callbackData: "v1:auc:lot:lot-1:1" }],
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
              participantName: "@jay",
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

const urls = {
  items: "Грибы и соленья.",
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
  { screen: { kind: "welcome" } },
  { screen: { kind: "menu" } },
  { screen: { kind: "faq" } },
  { screen: { kind: "faq" }, faq: urls },
  { screen: { kind: "details" } },
  { screen: { kind: "question" } },
  { screen: { kind: "auctions" } },
  { screen: { kind: "auction", body: feed } },
  { screen: { kind: "auction", body: emptyFeed } },
  { screen: { kind: "auction", body: lot(false) } },
  { screen: { kind: "auction", body: lot(true) } },
  { screen: { kind: "auction", body: lot(true) }, presentation: "plain" },
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
  { screen: { kind: "outdated" } },
  { screen: { kind: "unavailable" } },
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

function brokenRules(): Map<ScreenId, Set<string>> {
  const broken = new Map<ScreenId, Set<string>>();
  for (const { screen, faq, presentation } of shown) {
    const rendered = renderEntryScreen(screen, {
      timeZone: "Europe/Moscow",
      ...(faq === undefined ? {} : { faq }),
      ...(presentation === undefined ? {} : { presentation }),
    });
    const rules = broken.get(rendered.id) ?? new Set<string>();
    for (const violation of inspectCall(...sent(rendered), bare)) {
      rules.add(violation.rule);
    }
    broken.set(rendered.id, rules);
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
