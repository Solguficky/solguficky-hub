import { isDeepStrictEqual } from "node:util";
import { encodeAuctionCallback, MAX_FEED_PAGE } from "../callback-data.js";
import type { AuctionResult, AuctionUpdate } from "../gateway.js";
import type {
  AuctionBotPorts,
  LotHistoryEntryView,
  LotHistoryPage,
  LotPage,
  LotView,
  Money,
  ResolvedIdentity,
  TelegramUser,
} from "../ports.js";
import type { AuctionScreenBody } from "../screen.js";

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
};

export type AuctionContractCase = {
  intent: string;
  callbackData: string;
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

// Одна установленная личность и один снимок Auction для обеих фабрик. Роли
// пускают её на обе поверхности: `member` — в хаб, `public` — в бот аукциона.
export const CONTRACT_USER: TelegramUser = { telegramUserId: 424242 };

export const CONTRACT_IDENTITY: ResolvedIdentity = {
  identityId: "01929b7e-5c1d-7a3f-8e4b-000000000001",
  globalRoles: ["member", "public"],
  blocked: false,
};

const VIEWER = {
  identityId: CONTRACT_IDENTITY.identityId,
  globalRoles: CONTRACT_IDENTITY.globalRoles,
};

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
  status: {
    kind: "trading",
    currentPrice: rub(1200),
    leaderId: LEADER_ID,
    deadline: "2026-10-10T18:00:00Z",
  },
};

const SOLD_LOT: LotView = {
  lotId: "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b3d",
  auctionId: CONTRACT_AUCTION_ID,
  version: 9,
  card: { title: "Плакат", description: "" },
  status: { kind: "sold", winnerId: WINNER_ID, price: rub(3000) },
};

const UNSOLD_LOT: LotView = {
  lotId: "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b3e",
  auctionId: CONTRACT_AUCTION_ID,
  version: 5,
  card: { title: "Значок", description: "" },
  status: { kind: "unsold" },
};

// Без строки каталога: лента показывает его без названия.
const WITHDRAWN_LOT: LotView = {
  lotId: "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b3f",
  auctionId: CONTRACT_AUCTION_ID,
  version: 2,
  status: { kind: "withdrawn" },
};

const SCHEDULED_LOT: LotView = {
  lotId: "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b40",
  auctionId: CONTRACT_AUCTION_ID,
  version: 2,
  card: { title: "Носки", description: "" },
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

const EMPTY_AUCTION: ContractAuction = {
  lots: [],
  pages: { "": { lots: [], nextPageToken: "" } },
};

const listCalls = (auctionId: string, tokens: readonly string[]): PortCall[] =>
  tokens.map((pageToken) => ({
    port: "auction",
    method: "listAuctionLots",
    request: { viewer: VIEWER, auctionId, pageToken },
  }));

const getLotCall = (lotId: string): PortCall => ({
  port: "auction",
  method: "getLot",
  request: { viewer: VIEWER, lotId },
});

const namesCall = (...participantIds: string[]): PortCall => ({
  port: "auction",
  method: "getDisplayNames",
  request: {
    viewer: VIEWER,
    auctionId: CONTRACT_AUCTION_ID,
    participantIds,
  },
});

const historyCalls = (lotId: string, tokens: readonly string[]): PortCall[] =>
  tokens.map((pageToken) => ({
    port: "auction",
    method: "listLotHistory",
    request: { viewer: VIEWER, lotId, pageToken },
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

const lotKeyboard = (lotId: string, page: number) => [
  [{ action: "lot.refresh" as const, callbackData: lotCallback(lotId, page) }],
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
      keyboard: lotKeyboard(CONTRACT_LOT.lotId, 2),
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
      keyboard: lotKeyboard(SOLD_LOT.lotId, 0),
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
      keyboard: lotKeyboard(UNSOLD_LOT.lotId, 0),
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
      keyboard: lotKeyboard(WITHDRAWN_LOT.lotId, 0),
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
      keyboard: lotKeyboard(SOLD_LOT.lotId, 0),
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
];

export function spyPorts(
  calls: PortCall[],
  snapshot: ContractAuction,
): AuctionBotPorts {
  return {
    identity: {
      async resolveIdentity(request) {
        calls.push({ port: "identity", method: "resolveIdentity", request });
        return CONTRACT_IDENTITY;
      },
    },
    auction: {
      async getLot(request) {
        calls.push({ port: "auction", method: "getLot", request });
        const lot = snapshot.lots.find((each) => each.lotId === request.lotId);
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
    },
  };
}

function callbackDataOf(body: AuctionScreenBody): string[] {
  return body.keyboard.flat().map((button) => button.callbackData);
}

export async function checkAuctionContractCase(
  createApp: AuctionContractApp,
  contractCase: AuctionContractCase,
): Promise<ContractViolation[]> {
  const calls: PortCall[] = [];
  const handle = createApp(spyPorts(calls, contractCase.auction));
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
  try {
    result = await handle({
      from: CONTRACT_USER,
      input: { kind: "callback", data: contractCase.callbackData },
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
    { port: "identity", method: "resolveIdentity", request: CONTRACT_USER },
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
  if (!isDeepStrictEqual(auctionCalls, contractCase.auctionCalls)) {
    violations.push(
      violation("wrong-port-call", {
        expected: contractCase.auctionCalls,
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
  createApp: AuctionContractApp,
  cases: readonly AuctionContractCase[] = AUCTION_CONTRACT_CASES,
): Promise<ContractViolation[]> {
  if (cases.length === 0) {
    return [{ intent: "*", kind: "no-cases", detail: "intent table is empty" }];
  }
  const perCase = await Promise.all(
    cases.map((contractCase) =>
      checkAuctionContractCase(createApp, contractCase),
    ),
  );
  return perCase.flat();
}
