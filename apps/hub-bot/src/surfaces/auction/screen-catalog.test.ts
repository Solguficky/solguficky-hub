import { describe, expect, it } from "vitest";
import {
  inspectCall,
  inspectCatalog,
  type ScreenEntry,
} from "../../../testkit/screen-lint.js";
import type {
  AuctionScreenBody,
  RaffleStatusView,
  RaffleView,
} from "../../auction-ui/index.js";
import type { AuctionListPage } from "./auctions.js";
import { markupOf, richMessageOf } from "./bot.js";
import { notificationMarkup, renderNotification } from "./delivery/message.js";
import {
  type AuctionEntryScreen,
  type RenderedScreen,
  renderEntryScreen,
} from "./entry-screen.js";
import { type ScreenId, screenCatalog, screenMark } from "./screen-catalog.js";

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

// Корень аукциона (PER-605): входа в него этот бот не даёт, но тело дерева
// он рисует — по стадии и без аукциона.
const root: AuctionScreenBody = {
  blocks: [
    {
      kind: "root",
      auctionId: "auc-1",
      auction: {
        auctionId: "auc-1",
        stage: "prebidding",
        opensAt: "2026-10-26T09:00:00Z",
        closesAt: "2026-10-29T18:00:00Z",
        final: true,
      },
    },
  ],
  keyboard: [
    [{ action: "root.lots", callbackData: "v1:auc:feed:auc-1:0" }],
    [{ action: "root.raffle", callbackData: "v1:auc:rf:auc-1" }],
  ],
};

const goneRoot: AuctionScreenBody = {
  blocks: [{ kind: "root", auctionId: "auc-1" }],
  keyboard: [],
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

// Карточка с кнопкой избранного (PER-495): полный лист ставки, «Обновить»,
// «Ставки», избранное и навигация — семь рядов, предел карточки.
const withFollow = (following: boolean): AuctionScreenBody => {
  const body = lot(false);
  const back = body.keyboard.at(-1) ?? [];
  return {
    blocks: body.blocks.map((block) =>
      block.kind === "lot" ? { ...block, following } : block,
    ),
    keyboard: [
      ...body.keyboard.slice(0, -1),
      [
        following
          ? { action: "lot.unfollow", callbackData: "v1:auc:uf:lot-1:1" }
          : { action: "lot.follow", callbackData: "v1:auc:fo:lot-1:1" },
      ],
      back,
    ],
  };
};

// Избранное: средняя страница с листанием — лот в торгах с дедлайном и
// проданный с итогом, — и пустой список.
const favorites = (filled: boolean): AuctionScreenBody => ({
  blocks: [
    {
      kind: "favorites",
      page: filled ? 1 : 0,
      pageCount: filled ? 3 : 1,
      lots: filled
        ? [
            {
              lotId: "lot-1",
              title: "Банка <солёных> грибов",
              status: {
                kind: "trading",
                currentPrice: rub(500),
                phase: "online",
                deadline: "2026-10-12T16:00:00Z",
              },
            },
            {
              lotId: "lot-2",
              title: "Кружка",
              status: { kind: "sold", winnerId: "w-1", price: rub(3000) },
            },
          ]
        : [],
    },
  ],
  keyboard: filled
    ? [
        [
          {
            action: "favorites.open-lot",
            lotId: "lot-1",
            callbackData: "v1:auc:lot:lot-1:0",
          },
        ],
        [
          {
            action: "favorites.open-lot",
            lotId: "lot-2",
            callbackData: "v1:auc:lot:lot-2:0",
          },
        ],
        [
          { action: "favorites.prev", callbackData: "v1:auc:fav:0" },
          { action: "favorites.next", callbackData: "v1:auc:fav:2" },
        ],
      ]
    : [],
});

const followRefused: AuctionScreenBody = {
  blocks: [
    {
      kind: "follow-refused",
      lotId: "lot-1",
      auctionId: "auc-1",
      title: "Кружка <с совой>",
    },
  ],
  keyboard: [[{ action: "result.lot", callbackData: "v1:auc:lot:lot-1:1" }]],
};

// Хронология с обеими кнопками листания и пустая — первая и единственная
// страница. Возврат тела и есть ряд навигации.
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
    [
      { action: "confirm.yes", callbackData: "v1:auc:b:lot-1:op:fa:1" },
      { action: "confirm.no", callbackData: "v1:auc:lot:lot-1:1" },
    ],
  ],
});

const question = (
  kind: "bid" | "proxy" | "alias",
  titled: boolean,
): AuctionScreenBody => ({
  blocks: [
    {
      kind: "question",
      question: kind,
      lotId: "lot-1",
      auctionId: "auc-1",
      ...(kind === "alias" ? {} : { current: rub(550) }),
      ...(titled ? { title: "Кружка <с совой>" } : {}),
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
// Отказ команды и непринятый ответ (PER-472): кадры исхода с «К лоту», у
// непринятого ответа над ней — «Ввести заново».
const commandResult = (title: boolean): AuctionScreenBody => ({
  blocks: [
    {
      kind: "result",
      result: {
        command: "bid",
        kind: "refused",
        refusal: { kind: "bid-below-minimum", minRequired: rub(650) },
      },
      lotId: "lot-1",
      auctionId: "auc-1",
      ...(title ? { title: "Кружка <с совой>" } : {}),
    },
  ],
  keyboard: [[{ action: "result.lot", callbackData: "v1:auc:lot:lot-1:1" }]],
});

const answerRefused = (retry: boolean): AuctionScreenBody => ({
  blocks: [
    {
      kind: "answer-refused",
      refusal: retry ? "not-a-number" : "name-frozen",
      lotId: "lot-1",
      auctionId: "auc-1",
      title: "Кружка <с совой>",
    },
  ],
  keyboard: [
    ...(retry
      ? [
          [
            {
              action: "answer.retry" as const,
              callbackData: "v1:auc:ab:lot-1:1",
            },
          ],
        ]
      : []),
    [{ action: "result.lot", callbackData: "v1:auc:lot:lot-1:1" }],
  ],
});

// Принятая команда (PER-473): кадр исхода с «К лоту».
const accepted = (
  command: "bid" | "proxy",
  title: boolean,
): AuctionScreenBody => ({
  blocks: [
    {
      kind: "accepted",
      command,
      lotId: "lot-1",
      auctionId: "auc-1",
      ...(title ? { title: "Кружка <с совой>" } : {}),
      amount: rub(600),
    },
  ],
  keyboard: [[{ action: "accepted.lot", callbackData: "v1:auc:lot:lot-1:1" }]],
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

// Розыгрыш среди участников (ADR-066) во всех статусах: кнопка регистрации
// или отмены — только в окне регистрации.
const raffleOf = (
  status: RaffleStatusView,
  extra: Partial<RaffleView> = {},
): RaffleView => ({
  auctionId: "auc-1",
  status,
  closesAt: "2026-10-29T18:00:00Z",
  commitment: "ab".repeat(32),
  beaconRound: 12_345_678,
  registered: false,
  tickets: [],
  ...extra,
});

const pool = {
  tickets: [
    { number: 1, displayName: "@owl_fan" },
    { number: 2, displayName: "Сова <*>" },
    { number: 3 },
  ],
  myTicket: 1,
};

const raffles: readonly (RaffleView | undefined)[] = [
  undefined,
  raffleOf("open"),
  raffleOf("open", { registered: true }),
  raffleOf("closing", { registered: true }),
  raffleOf("awaiting-beacon", { registered: true, ...pool }),
  raffleOf("drawn", {
    registered: true,
    ...pool,
    reveal: {
      seed: "cd".repeat(32),
      randomness: "ef".repeat(32),
      value: "12".repeat(32),
      winningTicket: 2,
    },
  }),
  raffleOf("no-tickets", { reveal: { seed: "cd".repeat(32) } }),
  raffleOf("not-held", {}),
];

const raffleBody = (raffle: RaffleView | undefined): AuctionScreenBody => ({
  blocks: [
    { kind: "raffle", auctionId: "auc-1", ...(raffle ? { raffle } : {}) },
  ],
  keyboard: [
    ...(raffle?.status === "open"
      ? [
          [
            raffle.registered
              ? {
                  action: "raffle.cancel" as const,
                  callbackData: "v1:auc:rc:a",
                }
              : {
                  action: "raffle.register" as const,
                  callbackData: "v1:auc:rr:a",
                },
          ],
        ]
      : []),
    [{ action: "raffle.back", callbackData: "v1:auc:feed:auc-1:0" }],
  ],
});

const feedWithRaffle: AuctionScreenBody = {
  ...feed,
  keyboard: [
    [{ action: "feed.raffle", callbackData: "v1:auc:rf:a" }],
    ...feed.keyboard,
  ],
};

const raffleNameChoice: AuctionScreenBody = {
  blocks: [
    { kind: "raffle-name-choice", auctionId: "auc-1", username: "owl_fan" },
  ],
  keyboard: [
    [{ action: "name.username", callbackData: "v1:auc:ru:a" }],
    [{ action: "name.alias", callbackData: "v1:auc:ra:a" }],
    [{ action: "raffle.return", callbackData: "v1:auc:rf:a" }],
  ],
};

const raffleQuestion: AuctionScreenBody = {
  blocks: [{ kind: "raffle-question", auctionId: "auc-1" }],
  keyboard: [[{ action: "question.cancel", callbackData: "v1:auc:rq:a:42" }]],
};

const raffleAnswerRefused: AuctionScreenBody = {
  blocks: [
    {
      kind: "raffle-answer-refused",
      auctionId: "auc-1",
      refusal: "alias-taken",
    },
  ],
  keyboard: [
    [{ action: "answer.retry", callbackData: "v1:auc:ra:a" }],
    [{ action: "raffle.return", callbackData: "v1:auc:rf:a" }],
  ],
};

// Каждый вид каждого экрана, который оболочка умеет отдать.
const shown: readonly {
  screen: AuctionEntryScreen;
  faq?: typeof urls;
  presentation?: "plain";
}[] = [
  { screen: { kind: "notify", current: "every" } },
  { screen: { kind: "notify", current: "15" } },
  { screen: { kind: "notify", current: "off" } },
  { screen: { kind: "faq" } },
  { screen: { kind: "faq" }, faq: urls },
  // Корневое меню, приветствие и подсказка (PER-592).
  { screen: { kind: "menu", favorites: false, notifications: false } },
  { screen: { kind: "menu", favorites: true, notifications: true } },
  { screen: { kind: "welcome" } },
  { screen: { kind: "welcome", sourceCode: "chat" } },
  { screen: { kind: "hint", openQuestion: true } },
  { screen: { kind: "hint", openQuestion: false } },
  { screen: { kind: "details" } },
  { screen: { kind: "question" } },
  { screen: { kind: "auctions", list: emptyList } },
  { screen: { kind: "auctions", list: middlePage } },
  { screen: { kind: "past", list: emptyList } },
  { screen: { kind: "past", list: middlePage } },
  { screen: { kind: "auction", body: feed, parent: "auctions" } },
  { screen: { kind: "auction", body: feed, parent: "past" } },
  { screen: { kind: "auction", body: emptyFeed, parent: "auctions" } },
  { screen: { kind: "auction", body: root, parent: "auctions" } },
  { screen: { kind: "auction", body: goneRoot, parent: "auctions" } },
  { screen: { kind: "auction", body: lot(false) } },
  { screen: { kind: "auction", body: lot(true) } },
  { screen: { kind: "auction", body: lot(true) }, presentation: "plain" },
  { screen: { kind: "auction", body: withFollow(false) } },
  { screen: { kind: "auction", body: withFollow(true) } },
  { screen: { kind: "auction", body: favorites(true) } },
  { screen: { kind: "auction", body: favorites(false) } },
  { screen: { kind: "auction", body: followRefused } },
  { screen: { kind: "auction", body: soldLot } },
  { screen: { kind: "auction", body: soldLot }, presentation: "plain" },
  { screen: { kind: "auction", body: history(true) } },
  { screen: { kind: "auction", body: history(false) } },
  { screen: { kind: "auction", body: confirm("bid") } },
  { screen: { kind: "auction", body: confirm("proxy") } },
  { screen: { kind: "auction", body: accepted("bid", true) } },
  { screen: { kind: "auction", body: accepted("proxy", false) } },
  { screen: { kind: "auction", body: commandResult(true) } },
  { screen: { kind: "auction", body: commandResult(false) } },
  { screen: { kind: "auction", body: answerRefused(true) } },
  { screen: { kind: "auction", body: answerRefused(false) } },
  { screen: { kind: "auction", body: question("bid", false) } },
  { screen: { kind: "auction", body: question("bid", true) } },
  { screen: { kind: "auction", body: question("proxy", false) } },
  { screen: { kind: "auction", body: question("alias", true) } },
  { screen: { kind: "auction", body: nameChoice(true) } },
  { screen: { kind: "auction", body: nameChoice(false) } },
  { screen: { kind: "auction", body: feedWithRaffle, parent: "auctions" } },
  ...raffles.map((raffle) => ({
    screen: { kind: "auction" as const, body: raffleBody(raffle) },
  })),
  { screen: { kind: "auction", body: raffleNameChoice } },
  { screen: { kind: "auction", body: raffleQuestion } },
  { screen: { kind: "auction", body: raffleAnswerRefused } },
  { screen: { kind: "denied", reason: "blocked" } },
  { screen: { kind: "denied", reason: "not-admitted" } },
  { screen: { kind: "denied", reason: "declined" } },
  { screen: { kind: "denied", reason: "in-community" } },
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
  {
    screen: {
      kind: "unavailable",
      exit: { kind: "retry", data: "v1:entry:notify:15" },
      subject: "notifications",
    },
  },
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

// Момент показа: даты экранов — 2026 год, поэтому года в них нет.
const now = new Date("2026-10-07T12:00:00Z");

const rendered = shown.map(({ screen, faq, presentation }) =>
  renderEntryScreen(screen, {
    timeZone: "Europe/Moscow",
    now,
    ...(faq === undefined ? {} : { faq }),
    ...(presentation === undefined ? {} : { presentation }),
  }),
);

// Уведомления — следы с меткой каталога, которые шлёт отправитель доставки в
// той же форме (`delivery/message.ts`).
const notifications = [
  renderNotification(
    {
      kind: "lot-outbid",
      lotId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34d0",
      currentPrice: rub(500),
    },
    "Банка солёных грибов",
  ),
  // «Реже» рядом с «К лоту» у бота с Notifications (PER-515).
  renderNotification(
    {
      kind: "lot-outbid",
      lotId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34d0",
      currentPrice: rub(500),
    },
    "Банка солёных грибов",
    true,
  ),
  renderNotification({ kind: "access-granted" }),
  // Весть о смене круга — без клавиатуры (PER-537).
  renderNotification({ kind: "circle-promoted" }),
].map((message) => {
  const markup = notificationMarkup(message);
  return {
    chat_id: 42,
    text: message.text,
    ...screenMark("notification"),
    ...(markup === undefined ? {} : { reply_markup: markup }),
    link_preview_options: { is_disabled: true },
  };
});

function brokenRules(): Map<ScreenId, Set<string>> {
  const broken = new Map<ScreenId, Set<string>>();
  const calls: [ScreenId, string, unknown][] = [
    ...rendered.map((screen): [ScreenId, string, unknown] => [
      screen.id,
      ...sent(screen),
    ]),
    ...notifications.map((call): [ScreenId, string, unknown] => [
      "notification",
      "sendMessage",
      call,
    ]),
  ];
  for (const [id, method, payload] of calls) {
    const rules = broken.get(id) ?? new Set<string>();
    for (const violation of inspectCall("auction", method, payload, bare)) {
      rules.add(violation.rule);
    }
    broken.set(id, rules);
  }
  return broken;
}

describe("auction screen catalog", () => {
  const broken = brokenRules();

  // Корень один — меню, и цепочка родителей каждого экрана дерева доходит
  // до него (PER-592): «‹» за конечное число шагов приводит в корень.
  it("roots every tree screen in the menu", () => {
    expect(inspectCatalog("auction")).toEqual([]);
  });

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
  // Видимый текст: теги сняты — и моноширинный блок и ссылка на раунд drand
  // у розыгрыша. Остаток `<` — неэкранированный знак.
  const visible = (screen: RenderedScreen) =>
    screen.text.replace(/<\/?(b|h1|p|br|code)>|<a href="[^"<>]*">|<\/a>/g, "");

  it("marks every link button, and only a link button, with the sign", () => {
    expect(
      buttons
        .filter(({ button }) => "url" in button !== button.text.endsWith(" ↗"))
        .map(({ screen, button }) => `${screen}: ${button.text}`),
    ).toEqual([]);
  });

  // FAQ — раздел под меню: кнопка к нему стоит только в самом меню, боковой
  // кнопки под другими экранами нет (PER-592).
  it("gives the FAQ a button only in the menu", () => {
    expect(
      buttons
        .filter(({ button }) => button.text === "Правила и FAQ")
        .map(({ screen }) => screen)
        .filter((screen) => screen !== "menu"),
    ).toEqual([]);
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
        .filter((screen) => /<|&(?!(amp|lt|gt|quot);)/.test(visible(screen)))
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

  // Список в теле повторяет кнопки содержимого строками «• …» (дизайн-код,
  // «Списки»): экран над вопросом теряет клавиатуру, и без строк он пуст.
  it("lists every content button of a list as a line of the body", () => {
    const lists = rendered.filter((screen) =>
      ["auctions", "past", "feed"].includes(screen.id),
    );
    expect(lists.length).toBeGreaterThan(0);
    // Среди видов есть непустые списки: на одних пустых проверка молчала бы.
    expect(lists.some((screen) => screen.text.includes("\n• "))).toBe(true);
    for (const screen of lists) {
      const lines = screen.text
        .split("\n")
        .filter((line) => line.startsWith("• "));
      // Навигация, листание, действие ленты «Розыгрыш» (ADR-066) и вход в
      // «Прошедшие» под «Аукционами» (PER-592) — не содержимое списка.
      const content = screen.keyboard
        .flat()
        .filter(
          (button) =>
            "callback_data" in button &&
            !/^(‹ |←$|→$|Розыгрыш$|Прошедшие$)/.test(button.text),
        );
      expect(lines.length, screen.text).toBe(content.length);
    }
  });

  // Карточка лота: строки «ключ: значение» без точки в конце, статус первой
  // группой (дизайн-код, «Карточка лота»).
  it("keeps the lot card lines as fields without a trailing full stop", () => {
    const cards = rendered.filter((screen) => screen.id === "lot");
    expect(cards.length).toBeGreaterThan(0);
    for (const card of cards) {
      // Блоки и переносы rich-карточки — строки.
      const lines = card.text
        .replace(/<\/(h1|p)>|<br>/g, "\n")
        .replace(/<[^>]+>/g, "")
        .split("\n")
        .filter((line) => /^[А-ЯЁ][а-яё ]+: /.test(line));
      expect(lines.length).toBeGreaterThan(0);
      expect(lines[0]).toMatch(/^Статус: /);
      expect(lines.filter((line) => line.endsWith("."))).toEqual([]);
    }
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
