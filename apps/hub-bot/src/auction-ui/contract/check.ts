import { isDeepStrictEqual } from "node:util";
import {
  type AuctionIntent,
  encodeAuctionCallback,
  MAX_FEED_PAGE,
} from "../callback-data.js";
import type {
  AuctionResult,
  AuctionSurface,
  AuctionUpdate,
} from "../gateway.js";
import type {
  AccessRight,
  AuctionBotPorts,
  BidRefusal,
  CommandOutcome,
  DisplayNameOutcome,
  LotHistoryEntryView,
  LotHistoryPage,
  LotPage,
  LotView,
  Money,
  ProxyLimitRefusal,
  ResolvedIdentity,
  TelegramUser,
  Viewer,
} from "../ports.js";
import type { AuctionScreenBody, CommandResult } from "../screen.js";

// Ядро contract suite из ADR-044, «Проверка общего поведения». Оно чистое и от
// раннера не зависит: возвращает нарушения значением, поэтому самопроверка
// suite над заведомо неверной заглушкой — обычный тест, а не падение vitest
// внутри vitest.

// Нажатие, каким его видит приложение до разрешения личности: кто нажал и
// какую кнопку. Типов Telegram здесь нет — их разбирает приложение.
export type AuctionContractInput = {
  from: TelegramUser;
  input: AuctionUpdate["input"];
};

// Вход приложения, доведённый до `handleAuctionUpdate`: приложение получает
// порты-шпионы, связывает ими свою поверхность, само разрешает личность через
// порт Identity и отдаёт результат шлюза до того, как обернуть тело в свою
// оболочку.
export type AuctionContractApp = (
  ports: AuctionBotPorts,
) => (pressed: AuctionContractInput) => Promise<AuctionResult>;

type AuctionMethods = AuctionBotPorts["auction"];

export type PortCall =
  | { port: "identity"; method: "resolveIdentity"; request: TelegramUser }
  | {
      port: "auction";
      method: "getLot";
      request: Parameters<AuctionMethods["getLot"]>[0];
    }
  | {
      port: "auction";
      method: "listAuctionLots";
      request: Parameters<AuctionMethods["listAuctionLots"]>[0];
    }
  | {
      port: "auction";
      method: "listLotHistory";
      request: Parameters<AuctionMethods["listLotHistory"]>[0];
    }
  | {
      port: "auction";
      method: "getDisplayNames";
      request: Parameters<AuctionMethods["getDisplayNames"]>[0];
    }
  | {
      port: "auction";
      method: "placeBid";
      request: Parameters<AuctionMethods["placeBid"]>[0];
    }
  | {
      port: "auction";
      method: "setProxyLimit";
      request: Parameters<AuctionMethods["setProxyLimit"]>[0];
    }
  | {
      port: "auction";
      method: "chooseDisplayName";
      request: Parameters<AuctionMethods["chooseDisplayName"]>[0];
    };

// Снимок Auction, над которым идёт намерение: шпион отвечает только им.
// Запрос того, чего в снимке нет, падает — так suite ловит приложение, которое
// спрашивает не то, а не подсовывает ему правдоподобный ответ.
export type ContractAuction = {
  lots: readonly LotView[];
  // Страницы `ListAuctionLots` по токену; первая — под пустым.
  pages: Readonly<Record<string, LotPage>>;
  // Страницы `ListLotHistory` по лоту и токену; первая — под пустым. Лота
  // здесь нет — хронологию у него не спрашивают.
  history?: Readonly<Record<string, Readonly<Record<string, LotHistoryPage>>>>;
  // Нет — `GetDisplayNames` отказывает, как Auction отвечает до PER-434.
  names?: Readonly<Record<string, string>>;
  // Ответы команд участника по порядку вызовов. Нет ответа — команду в этом
  // намерении звать не должны, и шпион падает.
  bids?: readonly CommandOutcome<BidRefusal>[];
  limits?: readonly CommandOutcome<ProxyLimitRefusal>[];
  displayNames?: readonly DisplayNameOutcome[];
  // Лоты после принятой команды: следующее чтение лота отдаёт их.
  after?: readonly LotView[];
};

export type AuctionContractCase = {
  intent: string;
  callbackData: string;
  // Ответ на вопрос: шаг — `callbackData`, текст — этот. Нет — нажатие.
  // `text: undefined` — ответили не текстом.
  reply?: { text?: string };
  // Кто нажал, если не `CONTRACT_USER`: ник нужен выбору имени.
  from?: TelegramUser;
  auction: ContractAuction;
  // Вызовы Auction по порядку. Identity сравнивается отдельно — числом
  // разрешений личности, одинаковым для всех намерений.
  auctionCalls: readonly PortCall[];
  body: AuctionScreenBody;
};

export type ContractViolation = {
  intent: string;
  kind:
    | "no-cases"
    | "app-threw"
    | "not-a-screen"
    | "wrong-port-call"
    | "wrong-body"
    | "wrong-callback-data"
    | "identity-not-resolved-once";
  detail: string;
};

// Один человек и один снимок Auction для обеих фабрик. Права у него свои на
// каждой поверхности — те, с которыми она пускает (`contractIdentity` ниже).
export const CONTRACT_USER: TelegramUser = { telegramUserId: 424242 };

// Тот же человек с ником: экран выбора имени предлагает его.
const USER_WITH_USERNAME: TelegramUser = {
  telegramUserId: CONTRACT_USER.telegramUserId,
  telegramUsername: "owl_fan",
};

// `op_id`, которые отдаёт шпион по порядку: подтверждение берёт следующий.
export const CONTRACT_OP_IDS = [
  "01929b7e-5c1d-7a3f-8e4b-00000000c001",
  "01929b7e-5c1d-7a3f-8e4b-00000000c002",
] as const;

// Права зрителя у каждой поверхности: хаб пускает по праву хаба, бот
// аукциона — по праву аукциона без права хаба.
const CONTRACT_RIGHTS: Record<AuctionSurface["kind"], readonly AccessRight[]> =
  {
    hub: ["hub", "auction"],
    auction: ["auction"],
  };

export function contractViewer(surface: AuctionSurface["kind"]): Viewer {
  return {
    identityId: "01929b7e-5c1d-7a3f-8e4b-000000000001",
    rights: CONTRACT_RIGHTS[surface],
  };
}

// Зритель таблицы. Вызовы Auction у неё общие на обе поверхности, а права у
// зрителя свои: сверка подставляет в каждый ожидаемый вызов смотрящего той
// поверхности, которую проверяет, — в Auction уходит ровно тот смотрящий, с
// правами, которого разрешил Identity (ADR-064, пункт 6).
export const CONTRACT_VIEWER: Viewer = contractViewer("hub");

export function contractIdentity(
  surface: AuctionSurface["kind"],
): ResolvedIdentity {
  return {
    viewer: contractViewer(surface),
    blocked: false,
  };
}

// Ожидаемый вызов только сравнивается и печатается, поэтому тип вызова порта
// за подстановкой не сохраняется.
function withViewer(call: PortCall, viewer: Viewer): unknown {
  if (call.port !== "auction" || !("viewer" in call.request)) return call;
  return { ...call, request: { ...call.request, viewer } };
}

export const CONTRACT_AUCTION_ID = "01929b7e-5c1d-7a3f-8e4b-0000000000a1";
const EMPTY_AUCTION_ID = "01929b7e-5c1d-7a3f-8e4b-0000000000a2";
const LEADER_ID = "01929b7e-5c1d-7a3f-8e4b-000000000002";
const WINNER_ID = "01929b7e-5c1d-7a3f-8e4b-000000000003";
const RIVAL_ID = "01929b7e-5c1d-7a3f-8e4b-000000000004";

const rub = (rubles: number): Money => ({
  minorUnits: rubles * 100,
  currency: "RUB",
});

// Лот в торгах с лидером, изображением и единым шагом.
export const CONTRACT_LOT: LotView = {
  lotId: "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b3c",
  auctionId: CONTRACT_AUCTION_ID,
  version: 3,
  card: {
    title: "Кружка с совой",
    description: "Ручная роспись.",
    image: { version: "img-1" },
  },
  nextPrice: rub(1250),
  fixedStep: rub(50),
  proxyEnabled: true,
  status: {
    kind: "trading",
    currentPrice: rub(1200),
    leaderId: LEADER_ID,
    deadline: "2026-10-10T18:00:00Z",
    phase: "online",
  },
};

const SOLD_LOT: LotView = {
  lotId: "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b3d",
  auctionId: CONTRACT_AUCTION_ID,
  version: 9,
  card: { title: "Плакат", description: "" },
  proxyEnabled: false,
  status: { kind: "sold", winnerId: WINNER_ID, price: rub(3000) },
};

const UNSOLD_LOT: LotView = {
  lotId: "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b3e",
  auctionId: CONTRACT_AUCTION_ID,
  version: 5,
  card: { title: "Значок", description: "" },
  proxyEnabled: false,
  status: { kind: "unsold" },
};

// Без строки каталога: лента показывает его без названия.
const WITHDRAWN_LOT: LotView = {
  lotId: "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b3f",
  auctionId: CONTRACT_AUCTION_ID,
  version: 2,
  proxyEnabled: false,
  status: { kind: "withdrawn" },
};

const SCHEDULED_LOT: LotView = {
  lotId: "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b40",
  auctionId: CONTRACT_AUCTION_ID,
  version: 2,
  card: { title: "Носки", description: "" },
  proxyEnabled: false,
  status: { kind: "scheduled", startingPrice: rub(500) },
};

// Десять ставок лота в торгах двумя серверными страницами: две страницы
// экрана по восемь строк. Время у пар ставок одно — порядок задаёт журнал, а
// прокси-ставка лидера стоит после ручной соперника той же команды.
const HISTORY_ENTRIES: readonly LotHistoryEntryView[] = Array.from(
  { length: 10 },
  (_, index): LotHistoryEntryView => {
    const byLeader = index % 2 === 1;
    return {
      kind: "bid",
      sequence: 4 + index * 2,
      occurredAt: `2026-10-04T12:0${Math.floor(index / 2)}:00Z`,
      bidId: `01929b7e-5c1d-7a3f-8e4b-0000000001${String(index).padStart(2, "0")}`,
      participantId: byLeader ? LEADER_ID : RIVAL_ID,
      amount: rub(750 + index * 50),
      origin: byLeader
        ? { kind: "proxy" }
        : { kind: "manual", source: index === 4 ? "floor" : "bot" },
    };
  },
);

const NAMES: Readonly<Record<string, string>> = {
  [LEADER_ID]: "@owl",
  [WINNER_ID]: "Сыч*",
  [RIVAL_ID]: "@jay",
};

// Лента приходит двумя серверными страницами и не по цене: порядок, которого
// ждут тела ниже, может дать только край.
export const AUCTION: ContractAuction = {
  lots: [CONTRACT_LOT, SOLD_LOT, UNSOLD_LOT, WITHDRAWN_LOT, SCHEDULED_LOT],
  pages: {
    "": {
      lots: [SOLD_LOT, CONTRACT_LOT, WITHDRAWN_LOT],
      nextPageToken: "p2",
    },
    p2: { lots: [UNSOLD_LOT, SCHEDULED_LOT], nextPageToken: "" },
  },
  history: {
    [CONTRACT_LOT.lotId]: {
      "": { entries: HISTORY_ENTRIES.slice(0, 6), nextPageToken: "h2" },
      h2: { entries: HISTORY_ENTRIES.slice(6), nextPageToken: "" },
    },
    [UNSOLD_LOT.lotId]: { "": { entries: [], nextPageToken: "" } },
  },
  names: NAMES,
};

const HELD_LOT: LotView = {
  lotId: "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b41",
  auctionId: CONTRACT_AUCTION_ID,
  version: 4,
  card: { title: "Шарф", description: "" },
  proxyEnabled: false,
  status: { kind: "held", currentPrice: rub(900) },
};

const DRAFT_LOT: LotView = {
  lotId: "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b42",
  auctionId: CONTRACT_AUCTION_ID,
  version: 1,
  card: { title: "Брелок", description: "" },
  proxyEnabled: false,
  status: { kind: "draft" },
};

// Лоты, которых нет в страницах ленты: тела ленты выше от них не зависят.
const OFF_FEED_AUCTION: ContractAuction = {
  ...AUCTION,
  lots: [...AUCTION.lots, HELD_LOT, DRAFT_LOT],
};

const EMPTY_AUCTION: ContractAuction = {
  lots: [],
  pages: { "": { lots: [], nextPageToken: "" } },
};

const listCalls = (auctionId: string, tokens: readonly string[]): PortCall[] =>
  tokens.map((pageToken) => ({
    port: "auction",
    method: "listAuctionLots",
    request: { viewer: CONTRACT_VIEWER, auctionId, pageToken },
  }));

const getLotCall = (lotId: string): PortCall => ({
  port: "auction",
  method: "getLot",
  request: { viewer: CONTRACT_VIEWER, lotId },
});

const namesCall = (...participantIds: string[]): PortCall => ({
  port: "auction",
  method: "getDisplayNames",
  request: {
    viewer: CONTRACT_VIEWER,
    auctionId: CONTRACT_AUCTION_ID,
    participantIds,
  },
});

const historyCalls = (lotId: string, tokens: readonly string[]): PortCall[] =>
  tokens.map((pageToken) => ({
    port: "auction",
    method: "listLotHistory",
    request: { viewer: CONTRACT_VIEWER, lotId, pageToken },
  }));

const feedCallback = (auctionId: string, page: number) =>
  encodeAuctionCallback({ kind: "feed", auctionId, page });

const lotCallback = (lotId: string, page: number) =>
  encodeAuctionCallback({ kind: "lot", lotId, page });

const historyCallback = (lotId: string, page: number, historyPage: number) =>
  encodeAuctionCallback({ kind: "history", lotId, page, historyPage });

// По цене: стартовая 500, текущая 1200, продажа 3000; без цены — в конце по
// `lotId`.
const FEED_ORDER = [
  SCHEDULED_LOT,
  CONTRACT_LOT,
  SOLD_LOT,
  UNSOLD_LOT,
  WITHDRAWN_LOT,
];

const FEED_BODY: AuctionScreenBody = {
  blocks: [
    {
      kind: "feed",
      auctionId: CONTRACT_AUCTION_ID,
      page: 0,
      pageCount: 1,
      lots: FEED_ORDER.map((lot) => ({
        lotId: lot.lotId,
        ...(lot.card === undefined ? {} : { title: lot.card.title }),
        status: lot.status,
      })),
    },
  ],
  keyboard: FEED_ORDER.map((lot) => [
    {
      action: "feed.open-lot",
      lotId: lot.lotId,
      callbackData: lotCallback(lot.lotId, 0),
    },
  ]),
};

const refreshRow = (lotId: string, page: number) => [
  { action: "lot.refresh" as const, callbackData: lotCallback(lotId, page) },
];

const backRow = (page: number) => [
  {
    action: "lot.back" as const,
    callbackData: feedCallback(CONTRACT_AUCTION_ID, page),
  },
];

const callback = (intent: AuctionIntent) => encodeAuctionCallback(intent);

// Ряды ставки под лотом в онлайн-торгах: по шагу, своя сумма и лимит.
const bidRows = (lot: LotView, page: number) => [
  [
    {
      action: "lot.bid-step" as const,
      amount: rub(1250),
      callbackData: callback({
        kind: "confirm",
        command: "bid",
        lotId: lot.lotId,
        amount: 125000,
        page,
      }),
    },
  ],
  [
    {
      action: "lot.bid-custom" as const,
      callbackData: callback({
        kind: "ask",
        question: "bid",
        lotId: lot.lotId,
        page,
      }),
    },
  ],
  [
    {
      action: "lot.proxy" as const,
      callbackData: callback({
        kind: "ask",
        question: "proxy",
        lotId: lot.lotId,
        page,
      }),
    },
  ],
];

const lotKeyboard = (lotId: string, page: number) => [
  refreshRow(lotId, page),
  ...settledKeyboard(lotId, page),
];

// Лот с итогом: «Обновить» под ним нет — без человека он уже не меняется.
const settledKeyboard = (lotId: string, page: number) => [
  [
    {
      action: "lot.history" as const,
      callbackData: historyCallback(lotId, page, MAX_FEED_PAGE),
    },
  ],
  [
    {
      action: "lot.back" as const,
      callbackData: feedCallback(CONTRACT_AUCTION_ID, page),
    },
  ],
];

// Строки хронологии, как их показывает экран: имя — из `names`, если отдано.
const historyItems = (
  entries: readonly LotHistoryEntryView[],
  names?: Readonly<Record<string, string>>,
) =>
  entries.map((entry) => {
    const participantName = names?.[entry.participantId];
    return {
      kind: "bid" as const,
      sequence: entry.sequence,
      occurredAt: entry.occurredAt,
      amount: entry.amount,
      origin: entry.origin,
      ...(participantName === undefined ? {} : { participantName }),
    };
  });

const historyBody = (input: {
  historyPage: number;
  entries: readonly LotHistoryEntryView[];
  names?: Readonly<Record<string, string>>;
  paging: "history.prev" | "history.next";
}): AuctionScreenBody => ({
  blocks: [
    {
      kind: "history",
      lotId: CONTRACT_LOT.lotId,
      auctionId: CONTRACT_AUCTION_ID,
      title: "Кружка с совой",
      page: input.historyPage,
      pageCount: 2,
      entries: historyItems(input.entries, input.names),
    },
  ],
  keyboard: [
    [
      {
        action: input.paging,
        callbackData: historyCallback(
          CONTRACT_LOT.lotId,
          2,
          input.paging === "history.prev"
            ? input.historyPage - 1
            : input.historyPage + 1,
        ),
      },
    ],
    [
      {
        action: "history.back",
        callbackData: lotCallback(CONTRACT_LOT.lotId, 2),
      },
    ],
  ],
});

const HISTORY_CALLS: readonly PortCall[] = [
  getLotCall(CONTRACT_LOT.lotId),
  ...historyCalls(CONTRACT_LOT.lotId, ["", "h2"]),
  namesCall(RIVAL_ID, LEADER_ID),
];

// Лот после принятой ставки смотрящего: цена его, лидер — он.
const LOT_AFTER_BID: LotView = {
  ...CONTRACT_LOT,
  version: 4,
  nextPrice: rub(1350),
  status: {
    kind: "trading",
    currentPrice: rub(1300),
    leaderId: CONTRACT_VIEWER.identityId,
    deadline: "2026-10-10T18:00:00Z",
    phase: "online",
  },
};

const OP = CONTRACT_OP_IDS[0];

const commitCallback = (
  command: "bid" | "proxy",
  amount: number,
  page = 2,
  opId: string = OP,
) =>
  callback({
    kind: "commit",
    command,
    lotId: CONTRACT_LOT.lotId,
    opId,
    amount,
    page,
  });

const questionCallback = (
  question: "bid" | "proxy" | "alias",
  pending?: { command: "bid" | "proxy"; amount: number },
) =>
  callback({
    kind: "question",
    question,
    lotId: CONTRACT_LOT.lotId,
    page: 2,
    addressee: CONTRACT_USER.telegramUserId,
    ...(pending === undefined ? {} : { pending }),
  });

const confirmBody = (
  command: "bid" | "proxy",
  amount: number,
  opId: string = OP,
): AuctionScreenBody => ({
  blocks: [
    {
      kind: "confirm",
      command,
      lotId: CONTRACT_LOT.lotId,
      auctionId: CONTRACT_AUCTION_ID,
      title: "Кружка с совой",
      amount: { minorUnits: amount, currency: "RUB" },
      currentPrice: rub(1200),
    },
  ],
  keyboard: [
    [
      {
        action: "confirm.yes",
        callbackData: commitCallback(command, amount, 2, opId),
      },
    ],
    [
      {
        action: "confirm.no",
        callbackData: lotCallback(CONTRACT_LOT.lotId, 2),
      },
    ],
  ],
});

const questionBody = (
  question: "bid" | "proxy" | "alias",
  extra: {
    current?: Money;
    pending?: { command: "bid" | "proxy"; amount: number };
  } = {},
): AuctionScreenBody => ({
  blocks: [
    {
      kind: "question",
      question,
      lotId: CONTRACT_LOT.lotId,
      auctionId: CONTRACT_AUCTION_ID,
      title: "Кружка с совой",
      ...(extra.current === undefined ? {} : { current: extra.current }),
    },
  ],
  keyboard: [
    [
      {
        action: "question.cancel",
        callbackData: questionCallback(question, extra.pending),
      },
    ],
  ],
});

type AnswerRefusalOf = Extract<
  AuctionScreenBody["blocks"][number],
  { kind: "answer-refused" }
>["refusal"];

// Отказ команды и неизвестный исход — свой экран с «К лоту» (PER-472): лот
// после ответа Auction не читается, его перечитывает кнопка.
const resultBody = (result: CommandResult): AuctionScreenBody => ({
  blocks: [
    {
      kind: "result",
      result,
      lotId: CONTRACT_LOT.lotId,
      auctionId: CONTRACT_AUCTION_ID,
      title: "Кружка с совой",
    },
  ],
  keyboard: [
    [
      {
        action: "result.lot",
        callbackData: lotCallback(CONTRACT_LOT.lotId, 2),
      },
    ],
  ],
});

// Непринятый ответ — свой экран (PER-472): «Ввести заново» задаёт тот же
// вопрос, «К лоту» открывает карточку.
const answerRefusedBody = (
  question: "bid" | "proxy" | "alias",
  refusal: AnswerRefusalOf,
  pendingCommand?: { command: "bid" | "proxy"; amount: number },
): AuctionScreenBody => ({
  blocks: [
    {
      kind: "answer-refused",
      refusal,
      lotId: CONTRACT_LOT.lotId,
      auctionId: CONTRACT_AUCTION_ID,
      title: "Кружка с совой",
    },
  ],
  keyboard: [
    [
      {
        action: "answer.retry",
        callbackData: callback({
          kind: "ask",
          question,
          lotId: CONTRACT_LOT.lotId,
          page: 2,
          ...(pendingCommand === undefined ? {} : { pending: pendingCommand }),
        }),
      },
    ],
    [
      {
        action: "result.lot",
        callbackData: lotCallback(CONTRACT_LOT.lotId, 2),
      },
    ],
  ],
});

// Принятая команда — свой экран с «К лоту» (PER-473); карточку перечитывает
// кнопка, поэтому после ответа Auction лот не читается.
const acceptedBody = (
  command: "bid" | "proxy",
  amount: number,
): AuctionScreenBody => ({
  blocks: [
    {
      kind: "accepted",
      command,
      lotId: CONTRACT_LOT.lotId,
      auctionId: CONTRACT_AUCTION_ID,
      title: "Кружка с совой",
      amount: { minorUnits: amount, currency: "RUB" },
    },
  ],
  keyboard: [
    [
      {
        action: "accepted.lot",
        callbackData: lotCallback(CONTRACT_LOT.lotId, 2),
      },
    ],
  ],
});

// Тот же лот, где лидирует смотрящий: ставить против себя ему нечего.
const LOT_LED_BY_VIEWER: LotView = {
  ...CONTRACT_LOT,
  status: {
    kind: "trading",
    currentPrice: rub(1200),
    leaderId: CONTRACT_VIEWER.identityId,
    deadline: "2026-10-10T18:00:00Z",
    phase: "online",
  },
};

const LED_BY_VIEWER: ContractAuction = {
  ...AUCTION,
  lots: [LOT_LED_BY_VIEWER],
  names: { ...NAMES, [CONTRACT_VIEWER.identityId]: "@me" },
};

const pending = (command: "bid" | "proxy", amount: number) => ({
  command,
  amount,
});

const nameChoiceBody = (
  amount: number,
  extra: { username?: string } = {},
): AuctionScreenBody => ({
  blocks: [
    {
      kind: "name-choice",
      lotId: CONTRACT_LOT.lotId,
      auctionId: CONTRACT_AUCTION_ID,
      title: "Кружка с совой",
      ...(extra.username === undefined ? {} : { username: extra.username }),
    },
  ],
  keyboard: [
    ...(extra.username === undefined
      ? []
      : [
          [
            {
              action: "name.username" as const,
              callbackData: callback({
                kind: "username",
                lotId: CONTRACT_LOT.lotId,
                page: 2,
                pending: pending("bid", amount),
              }),
            },
          ],
        ]),
    [
      {
        action: "name.alias",
        callbackData: callback({
          kind: "ask",
          question: "alias",
          lotId: CONTRACT_LOT.lotId,
          page: 2,
          pending: pending("bid", amount),
        }),
      },
    ],
    [
      {
        action: "name.back",
        callbackData: lotCallback(CONTRACT_LOT.lotId, 2),
      },
    ],
  ],
});

const bidCall = (amount: number, opId: string = OP): PortCall => ({
  port: "auction",
  method: "placeBid",
  request: {
    viewer: CONTRACT_VIEWER,
    lotId: CONTRACT_LOT.lotId,
    amount: { minorUnits: amount, currency: "RUB" },
    opId,
  },
});

const limitCall = (amount: number): PortCall => ({
  port: "auction",
  method: "setProxyLimit",
  request: {
    viewer: CONTRACT_VIEWER,
    lotId: CONTRACT_LOT.lotId,
    max: { minorUnits: amount, currency: "RUB" },
    opId: OP,
  },
});

const chooseCall = (
  choice:
    | { kind: "username"; username: string }
    | { kind: "alias"; alias: string },
): PortCall => ({
  port: "auction",
  method: "chooseDisplayName",
  request: { viewer: CONTRACT_VIEWER, auctionId: CONTRACT_AUCTION_ID, choice },
});

const LOT_CALL = getLotCall(CONTRACT_LOT.lotId);

// Намерения листа ставки (PER-317): ставка и лимит от кнопки до карточки.
const COMMAND_CASES: readonly AuctionContractCase[] = [
  // «По шагу» — подтверждение с порогом из кнопки и новым `op_id`.
  {
    intent: "bid: confirm the step",
    callbackData: callback({
      kind: "confirm",
      command: "bid",
      lotId: CONTRACT_LOT.lotId,
      amount: 125000,
      page: 2,
    }),
    auction: AUCTION,
    auctionCalls: [LOT_CALL],
    body: confirmBody("bid", 125000),
  },
  // «Да»: принятая ставка — экран «принята» с «К лоту», а не карточка.
  {
    intent: "bid: accepted",
    callbackData: commitCallback("bid", 130000),
    auction: { ...AUCTION, bids: [{ kind: "accepted" }] },
    auctionCalls: [LOT_CALL, bidCall(130000)],
    body: acceptedBody("bid", 130000),
  },
  // Отказ, который виден по снимку, приходит до «Да» (PER-473): лидер и
  // сумма ниже порога не получают подтверждения, и Auction не зовут.
  {
    intent: "bid: step refused to the leader before the confirmation",
    callbackData: callback({
      kind: "confirm",
      command: "bid",
      lotId: CONTRACT_LOT.lotId,
      amount: 125000,
      page: 2,
    }),
    auction: LED_BY_VIEWER,
    auctionCalls: [LOT_CALL],
    body: resultBody({
      command: "bid",
      kind: "refused",
      refusal: { kind: "bidder-is-leader", currentPrice: rub(1200) },
    }),
  },
  // Именованный отказ окончателен: один вызов, цена из отказа на экране
  // исхода.
  {
    intent: "bid: refused below the minimum",
    callbackData: commitCallback("bid", 125000),
    auction: {
      ...AUCTION,
      bids: [
        {
          kind: "refused",
          refusal: { kind: "bid-below-minimum", minRequired: rub(1300) },
        },
      ],
    },
    auctionCalls: [LOT_CALL, bidCall(125000)],
    body: resultBody({
      command: "bid",
      kind: "refused",
      refusal: { kind: "bid-below-minimum", minRequired: rub(1300) },
    }),
  },
  {
    intent: "bid: refused to the leader",
    callbackData: commitCallback("bid", 130000),
    auction: {
      ...AUCTION,
      bids: [
        {
          kind: "refused",
          refusal: { kind: "bidder-is-leader", currentPrice: rub(1200) },
        },
      ],
    },
    auctionCalls: [LOT_CALL, bidCall(130000)],
    body: resultBody({
      command: "bid",
      kind: "refused",
      refusal: { kind: "bidder-is-leader", currentPrice: rub(1200) },
    }),
  },
  // Ответа не было — повтор тем же `op_id`, и только один.
  {
    intent: "bid: unanswered, then accepted",
    callbackData: commitCallback("bid", 130000),
    auction: {
      ...AUCTION,
      bids: [{ kind: "unanswered" }, { kind: "accepted" }],
      after: [LOT_AFTER_BID],
    },
    auctionCalls: [LOT_CALL, bidCall(130000), bidCall(130000)],
    body: acceptedBody("bid", 130000),
  },
  {
    intent: "bid: unanswered twice",
    callbackData: commitCallback("bid", 130000),
    auction: {
      ...AUCTION,
      bids: [{ kind: "unanswered" }, { kind: "unanswered" }],
    },
    auctionCalls: [LOT_CALL, bidCall(130000), bidCall(130000)],
    body: resultBody({ command: "bid", kind: "unknown" }),
  },
  // Первая ставка без выбранного имени: предупреждение и выбор.
  {
    intent: "bid: name not chosen",
    callbackData: commitCallback("bid", 130000),
    from: USER_WITH_USERNAME,
    auction: {
      ...AUCTION,
      bids: [{ kind: "refused", refusal: { kind: "display-name-not-chosen" } }],
    },
    auctionCalls: [LOT_CALL, bidCall(130000)],
    body: nameChoiceBody(130000, { username: "owl_fan" }),
  },
  {
    intent: "name: use the username",
    callbackData: callback({
      kind: "username",
      lotId: CONTRACT_LOT.lotId,
      page: 2,
      pending: pending("bid", 130000),
    }),
    from: USER_WITH_USERNAME,
    auction: {
      ...AUCTION,
      displayNames: [{ kind: "accepted", name: "@owl_fan" }],
    },
    auctionCalls: [
      LOT_CALL,
      chooseCall({ kind: "username", username: "owl_fan" }),
    ],
    body: confirmBody("bid", 130000),
  },
  {
    intent: "name: alias taken",
    callbackData: questionCallback("alias", pending("bid", 130000)),
    reply: { text: "Сыч" },
    auction: {
      ...AUCTION,
      displayNames: [{ kind: "refused", refusal: "alias-taken" }],
    },
    auctionCalls: [LOT_CALL, chooseCall({ kind: "alias", alias: "Сыч" })],
    body: answerRefusedBody("alias", "alias-taken", pending("bid", 130000)),
  },
  {
    intent: "bid: ask the amount",
    callbackData: callback({
      kind: "ask",
      question: "bid",
      lotId: CONTRACT_LOT.lotId,
      page: 2,
    }),
    auction: AUCTION,
    auctionCalls: [LOT_CALL],
    body: questionBody("bid", { current: rub(1250) }),
  },
  {
    intent: "bid: answer the amount",
    callbackData: questionCallback("bid"),
    reply: { text: "1 300 ₽" },
    auction: AUCTION,
    auctionCalls: [LOT_CALL],
    body: confirmBody("bid", 130000),
  },
  // Сумма ниже порога и ответ лидера — экран отказа, без «Да».
  {
    intent: "bid: answer below the minimum",
    callbackData: questionCallback("bid"),
    reply: { text: "10" },
    auction: AUCTION,
    auctionCalls: [LOT_CALL],
    body: resultBody({
      command: "bid",
      kind: "refused",
      refusal: { kind: "bid-below-minimum", minRequired: rub(1250) },
    }),
  },
  {
    intent: "bid: answer from the leader",
    callbackData: questionCallback("bid"),
    reply: { text: "1 400" },
    auction: LED_BY_VIEWER,
    auctionCalls: [LOT_CALL],
    body: resultBody({
      command: "bid",
      kind: "refused",
      refusal: { kind: "bidder-is-leader", currentPrice: rub(1200) },
    }),
  },
  // Не число и чужая валюта — экран отказа с «Ввести заново», Auction не
  // зовут.
  {
    intent: "bid: answer not a number",
    callbackData: questionCallback("bid"),
    reply: { text: "много" },
    auction: AUCTION,
    auctionCalls: [LOT_CALL],
    body: answerRefusedBody("bid", "not-a-number"),
  },
  {
    intent: "bid: answer in another currency",
    callbackData: questionCallback("bid"),
    reply: { text: "$20" },
    auction: AUCTION,
    auctionCalls: [LOT_CALL],
    body: answerRefusedBody("bid", "other-currency"),
  },
  {
    intent: "bid: answer not in text",
    callbackData: questionCallback("bid"),
    reply: {},
    auction: AUCTION,
    auctionCalls: [LOT_CALL],
    body: answerRefusedBody("bid", "not-text"),
  },
  {
    intent: "bid: cancel the question",
    callbackData: questionCallback("bid"),
    auction: AUCTION,
    auctionCalls: [LOT_CALL, namesCall(LEADER_ID)],
    body: {
      blocks: [
        {
          kind: "lot",
          lotId: CONTRACT_LOT.lotId,
          auctionId: CONTRACT_AUCTION_ID,
          version: 3,
          card: {
            title: "Кружка с совой",
            description: "Ручная роспись.",
            image: { version: "img-1" },
          },
          nextPrice: rub(1250),
          fixedStep: rub(50),
          status: CONTRACT_LOT.status,
          participantName: "@owl",
        },
      ],
      keyboard: [
        ...bidRows(CONTRACT_LOT, 2),
        ...lotKeyboard(CONTRACT_LOT.lotId, 2),
      ],
    },
  },
  {
    intent: "proxy: ask the limit",
    callbackData: callback({
      kind: "ask",
      question: "proxy",
      lotId: CONTRACT_LOT.lotId,
      page: 2,
    }),
    auction: AUCTION,
    auctionCalls: [LOT_CALL],
    body: questionBody("proxy", { current: rub(1250) }),
  },
  {
    intent: "proxy: answer the limit",
    callbackData: questionCallback("proxy"),
    reply: { text: "2000" },
    auction: AUCTION,
    auctionCalls: [LOT_CALL],
    body: confirmBody("proxy", 200000),
  },
  {
    intent: "proxy: accepted",
    callbackData: commitCallback("proxy", 200000),
    auction: { ...AUCTION, limits: [{ kind: "accepted" }] },
    auctionCalls: [LOT_CALL, limitCall(200000)],
    body: acceptedBody("proxy", 200000),
  },
  {
    intent: "proxy: refused below the current price",
    callbackData: commitCallback("proxy", 110000),
    auction: {
      ...AUCTION,
      limits: [
        {
          kind: "refused",
          refusal: { kind: "proxy-below-current-price", minLimit: rub(1200) },
        },
      ],
    },
    auctionCalls: [LOT_CALL, limitCall(110000)],
    body: resultBody({
      command: "proxy",
      kind: "refused",
      refusal: { kind: "proxy-below-current-price", minLimit: rub(1200) },
    }),
  },
];

// Таблица аукционных намерений. Строку добавляет лист, который вводит
// намерение, — вместе с юзкейсом.
export const AUCTION_CONTRACT_CASES: readonly AuctionContractCase[] = [
  {
    intent: "feed",
    callbackData: feedCallback(CONTRACT_AUCTION_ID, 0),
    auction: AUCTION,
    auctionCalls: listCalls(CONTRACT_AUCTION_ID, ["", "p2"]),
    body: FEED_BODY,
  },
  // Кнопка страницы, которой больше нет: лоты сняли, пока сообщение висело.
  {
    intent: "feed: stale page",
    callbackData: feedCallback(CONTRACT_AUCTION_ID, 7),
    auction: AUCTION,
    auctionCalls: listCalls(CONTRACT_AUCTION_ID, ["", "p2"]),
    body: FEED_BODY,
  },
  {
    intent: "feed: empty",
    callbackData: feedCallback(EMPTY_AUCTION_ID, 0),
    auction: EMPTY_AUCTION,
    auctionCalls: listCalls(EMPTY_AUCTION_ID, [""]),
    body: {
      blocks: [
        {
          kind: "feed",
          auctionId: EMPTY_AUCTION_ID,
          page: 0,
          pageCount: 1,
          lots: [],
        },
      ],
      keyboard: [],
    },
  },
  {
    intent: "lot: trading",
    callbackData: lotCallback(CONTRACT_LOT.lotId, 2),
    auction: AUCTION,
    auctionCalls: [getLotCall(CONTRACT_LOT.lotId), namesCall(LEADER_ID)],
    body: {
      blocks: [
        {
          kind: "lot",
          lotId: CONTRACT_LOT.lotId,
          auctionId: CONTRACT_AUCTION_ID,
          version: 3,
          card: {
            title: "Кружка с совой",
            description: "Ручная роспись.",
            image: { version: "img-1" },
          },
          nextPrice: rub(1250),
          fixedStep: rub(50),
          status: CONTRACT_LOT.status,
          participantName: "@owl",
        },
      ],
      keyboard: [
        ...bidRows(CONTRACT_LOT, 2),
        ...lotKeyboard(CONTRACT_LOT.lotId, 2),
      ],
    },
  },
  {
    intent: "lot: sold",
    callbackData: lotCallback(SOLD_LOT.lotId, 0),
    auction: AUCTION,
    auctionCalls: [getLotCall(SOLD_LOT.lotId), namesCall(WINNER_ID)],
    body: {
      blocks: [
        {
          kind: "lot",
          lotId: SOLD_LOT.lotId,
          auctionId: CONTRACT_AUCTION_ID,
          version: 9,
          card: { title: "Плакат", description: "" },
          status: { kind: "sold", winnerId: WINNER_ID, price: rub(3000) },
          participantName: "Сыч*",
        },
      ],
      keyboard: settledKeyboard(SOLD_LOT.lotId, 0),
    },
  },
  // Непроданный лот — исход без победителя, и за именем Auction не зовут.
  {
    intent: "lot: unsold",
    callbackData: lotCallback(UNSOLD_LOT.lotId, 0),
    auction: AUCTION,
    auctionCalls: [getLotCall(UNSOLD_LOT.lotId)],
    body: {
      blocks: [
        {
          kind: "lot",
          lotId: UNSOLD_LOT.lotId,
          auctionId: CONTRACT_AUCTION_ID,
          version: 5,
          card: { title: "Значок", description: "" },
          status: { kind: "unsold" },
        },
      ],
      keyboard: settledKeyboard(UNSOLD_LOT.lotId, 0),
    },
  },
  {
    intent: "lot: withdrawn",
    callbackData: lotCallback(WITHDRAWN_LOT.lotId, 0),
    auction: AUCTION,
    auctionCalls: [getLotCall(WITHDRAWN_LOT.lotId)],
    body: {
      blocks: [
        {
          kind: "lot",
          lotId: WITHDRAWN_LOT.lotId,
          auctionId: CONTRACT_AUCTION_ID,
          version: 2,
          status: { kind: "withdrawn" },
        },
      ],
      keyboard: settledKeyboard(WITHDRAWN_LOT.lotId, 0),
    },
  },
  // Имя не отдали — карточка с ценой и исходом остаётся, без имени.
  {
    intent: "lot: names unavailable",
    callbackData: lotCallback(SOLD_LOT.lotId, 0),
    auction: { lots: AUCTION.lots, pages: AUCTION.pages },
    auctionCalls: [getLotCall(SOLD_LOT.lotId), namesCall(WINNER_ID)],
    body: {
      blocks: [
        {
          kind: "lot",
          lotId: SOLD_LOT.lotId,
          auctionId: CONTRACT_AUCTION_ID,
          version: 9,
          card: { title: "Плакат", description: "" },
          status: { kind: "sold", winnerId: WINNER_ID, price: rub(3000) },
        },
      ],
      keyboard: settledKeyboard(SOLD_LOT.lotId, 0),
    },
  },
  // Запланированный лот ставок не знает: кнопки хронологии под ним нет.
  {
    intent: "lot: scheduled",
    callbackData: lotCallback(SCHEDULED_LOT.lotId, 0),
    auction: AUCTION,
    auctionCalls: [getLotCall(SCHEDULED_LOT.lotId)],
    body: {
      blocks: [
        {
          kind: "lot",
          lotId: SCHEDULED_LOT.lotId,
          auctionId: CONTRACT_AUCTION_ID,
          version: 2,
          card: { title: "Носки", description: "" },
          status: { kind: "scheduled", startingPrice: rub(500) },
        },
      ],
      keyboard: [refreshRow(SCHEDULED_LOT.lotId, 0), backRow(0)],
    },
  },
  // Отложенный в финал лот итога ещё не имеет: «Обновить» под ним стоит.
  {
    intent: "lot: held",
    callbackData: lotCallback(HELD_LOT.lotId, 0),
    auction: OFF_FEED_AUCTION,
    auctionCalls: [getLotCall(HELD_LOT.lotId)],
    body: {
      blocks: [
        {
          kind: "lot",
          lotId: HELD_LOT.lotId,
          auctionId: CONTRACT_AUCTION_ID,
          version: 4,
          card: { title: "Шарф", description: "" },
          status: { kind: "held", currentPrice: rub(900) },
        },
      ],
      keyboard: lotKeyboard(HELD_LOT.lotId, 0),
    },
  },
  // Лот без условий торгов сам не меняется: ни «Обновить», ни хронологии.
  {
    intent: "lot: draft",
    callbackData: lotCallback(DRAFT_LOT.lotId, 0),
    auction: OFF_FEED_AUCTION,
    auctionCalls: [getLotCall(DRAFT_LOT.lotId)],
    body: {
      blocks: [
        {
          kind: "lot",
          lotId: DRAFT_LOT.lotId,
          auctionId: CONTRACT_AUCTION_ID,
          version: 1,
          card: { title: "Брелок", description: "" },
          status: { kind: "draft" },
        },
      ],
      keyboard: [backRow(0)],
    },
  },
  // Кнопка с карточки просит последнюю страницу: восемь свежих ставок в
  // порядке журнала, а неполная — самая ранняя страница. Имена — одним вызовом на участников страницы.
  {
    intent: "history: newest page",
    callbackData: historyCallback(CONTRACT_LOT.lotId, 2, MAX_FEED_PAGE),
    auction: AUCTION,
    auctionCalls: HISTORY_CALLS,
    body: historyBody({
      historyPage: 1,
      entries: HISTORY_ENTRIES.slice(2),
      names: NAMES,
      paging: "history.prev",
    }),
  },
  {
    intent: "history: earlier page",
    callbackData: historyCallback(CONTRACT_LOT.lotId, 2, 0),
    auction: AUCTION,
    auctionCalls: HISTORY_CALLS,
    body: historyBody({
      historyPage: 0,
      entries: HISTORY_ENTRIES.slice(0, 2),
      names: NAMES,
      paging: "history.next",
    }),
  },
  // Имена не отдали — строки с ценой и способом ставки остаются, без имён.
  {
    intent: "history: names unavailable",
    callbackData: historyCallback(CONTRACT_LOT.lotId, 2, MAX_FEED_PAGE),
    auction: {
      lots: AUCTION.lots,
      pages: AUCTION.pages,
      ...(AUCTION.history === undefined ? {} : { history: AUCTION.history }),
    },
    auctionCalls: HISTORY_CALLS,
    body: historyBody({
      historyPage: 1,
      entries: HISTORY_ENTRIES.slice(2),
      paging: "history.prev",
    }),
  },
  // Без ставок — одна пустая страница, и за именами Auction не зовут.
  {
    intent: "history: empty",
    callbackData: historyCallback(UNSOLD_LOT.lotId, 0, MAX_FEED_PAGE),
    auction: AUCTION,
    auctionCalls: [
      getLotCall(UNSOLD_LOT.lotId),
      ...historyCalls(UNSOLD_LOT.lotId, [""]),
    ],
    body: {
      blocks: [
        {
          kind: "history",
          lotId: UNSOLD_LOT.lotId,
          auctionId: CONTRACT_AUCTION_ID,
          title: "Значок",
          page: 0,
          pageCount: 1,
          entries: [],
        },
      ],
      keyboard: [
        [
          {
            action: "history.back",
            callbackData: lotCallback(UNSOLD_LOT.lotId, 0),
          },
        ],
      ],
    },
  },
  ...COMMAND_CASES,
];

export function spyPorts(
  calls: PortCall[],
  snapshot: ContractAuction,
  identity: ResolvedIdentity = contractIdentity("hub"),
): AuctionBotPorts {
  // Очереди ответов команд и `op_id`: каждый вызов берёт следующий.
  const bids = [...(snapshot.bids ?? [])];
  const limits = [...(snapshot.limits ?? [])];
  const displayNames = [...(snapshot.displayNames ?? [])];
  const opIds: string[] = [...CONTRACT_OP_IDS];
  let changed = false;
  const settled = <T extends { kind: string }>(outcome: T | undefined): T => {
    if (outcome === undefined) throw new Error("command is not expected");
    if (outcome.kind === "accepted") changed = true;
    return outcome;
  };
  return {
    identity: {
      async resolveIdentity(request) {
        calls.push({ port: "identity", method: "resolveIdentity", request });
        return identity;
      },
    },
    auction: {
      async getLot(request) {
        calls.push({ port: "auction", method: "getLot", request });
        const lots =
          changed && snapshot.after !== undefined
            ? [...snapshot.after, ...snapshot.lots]
            : snapshot.lots;
        const lot = lots.find((each) => each.lotId === request.lotId);
        if (lot === undefined) throw new Error("lot is not in the snapshot");
        return lot;
      },
      async listAuctionLots(request) {
        calls.push({ port: "auction", method: "listAuctionLots", request });
        const page = snapshot.pages[request.pageToken];
        if (page === undefined) throw new Error("page is not in the snapshot");
        return page;
      },
      async listLotHistory(request) {
        calls.push({ port: "auction", method: "listLotHistory", request });
        const page = snapshot.history?.[request.lotId]?.[request.pageToken];
        if (page === undefined) {
          throw new Error("history is not in the snapshot");
        }
        return page;
      },
      async getDisplayNames(request) {
        calls.push({ port: "auction", method: "getDisplayNames", request });
        const { names } = snapshot;
        if (names === undefined) throw new Error("display names unavailable");
        return Object.fromEntries(
          request.participantIds.flatMap((id) => {
            const name = names[id];
            return name === undefined ? [] : [[id, name]];
          }),
        );
      },
      async placeBid(request) {
        calls.push({ port: "auction", method: "placeBid", request });
        return settled(bids.shift());
      },
      async setProxyLimit(request) {
        calls.push({ port: "auction", method: "setProxyLimit", request });
        return settled(limits.shift());
      },
      async chooseDisplayName(request) {
        calls.push({ port: "auction", method: "chooseDisplayName", request });
        return settled(displayNames.shift());
      },
    },
    operations: {
      newOperationId() {
        const opId = opIds.shift();
        if (opId === undefined) throw new Error("no operation id left");
        return opId;
      },
    },
  };
}

function callbackDataOf(body: AuctionScreenBody): string[] {
  return body.keyboard.flat().map((button) => button.callbackData);
}

export async function checkAuctionContractCase(
  surface: AuctionSurface["kind"],
  createApp: AuctionContractApp,
  contractCase: AuctionContractCase,
): Promise<ContractViolation[]> {
  const calls: PortCall[] = [];
  const handle = createApp(
    spyPorts(calls, contractCase.auction, contractIdentity(surface)),
  );
  const violation = (
    kind: ContractViolation["kind"],
    detail: unknown,
  ): ContractViolation => ({
    intent: contractCase.intent,
    kind,
    detail: JSON.stringify(detail),
  });
  // Приложение, которое спросило шпиона не о том, падает на его ответе. Это
  // нарушение того же намерения, а не сбой самого прогона.
  let result: AuctionResult | undefined;
  let thrown: unknown;
  const from = contractCase.from ?? CONTRACT_USER;
  const { reply } = contractCase;
  try {
    result = await handle({
      from,
      input:
        reply === undefined
          ? { kind: "callback", data: contractCase.callbackData }
          : {
              kind: "reply",
              data: contractCase.callbackData,
              ...(reply.text === undefined ? {} : { text: reply.text }),
            },
    });
  } catch (cause) {
    thrown = cause;
  }

  const violations: ContractViolation[] = [];
  // Личность разрешается ровно один раз на update и ровно того, кто нажал:
  // приложение — для своей оболочки, а шлюз берёт тот же ответ из update и
  // Identity не зовёт. Шпион отвечает одной личностью на любой запрос,
  // поэтому чужой пользователь виден только по самому запросу.
  const identityCalls = calls.filter((call) => call.port === "identity");
  const expectedIdentityCalls: PortCall[] = [
    { port: "identity", method: "resolveIdentity", request: from },
  ];
  if (!isDeepStrictEqual(identityCalls, expectedIdentityCalls)) {
    violations.push(
      violation("identity-not-resolved-once", {
        expected: expectedIdentityCalls,
        actual: identityCalls,
      }),
    );
  }
  const auctionCalls = calls.filter((call) => call.port === "auction");
  const viewer = contractViewer(surface);
  const expectedAuctionCalls = contractCase.auctionCalls.map((call) =>
    withViewer(call, viewer),
  );
  if (!isDeepStrictEqual(auctionCalls, expectedAuctionCalls)) {
    violations.push(
      violation("wrong-port-call", {
        expected: expectedAuctionCalls,
        actual: auctionCalls,
      }),
    );
  }
  if (result === undefined) {
    violations.push(violation("app-threw", String(thrown)));
    return violations;
  }
  if (result.kind !== "screen") {
    violations.push(violation("not-a-screen", result));
    return violations;
  }
  const expectedButtons = callbackDataOf(contractCase.body);
  const actualButtons = callbackDataOf(result.body);
  if (!isDeepStrictEqual(actualButtons, expectedButtons)) {
    violations.push(
      violation("wrong-callback-data", {
        expected: expectedButtons,
        actual: actualButtons,
      }),
    );
  }
  if (!isDeepStrictEqual(result.body, contractCase.body)) {
    violations.push(
      violation("wrong-body", {
        expected: contractCase.body,
        actual: result.body,
      }),
    );
  }
  return violations;
}

// Пустая таблица — нарушение, а не зелёный прогон: suite без намерений не
// проверяет подключение ничем.
export async function checkAuctionContract(
  surface: AuctionSurface["kind"],
  createApp: AuctionContractApp,
  cases: readonly AuctionContractCase[] = AUCTION_CONTRACT_CASES,
): Promise<ContractViolation[]> {
  if (cases.length === 0) {
    return [{ intent: "*", kind: "no-cases", detail: "intent table is empty" }];
  }
  const perCase = await Promise.all(
    cases.map((contractCase) =>
      checkAuctionContractCase(surface, createApp, contractCase),
    ),
  );
  return perCase.flat();
}
