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
  AuctionSummaryView,
  BidRefusal,
  CommandOutcome,
  DayChronicleView,
  DisplayNameOutcome,
  FollowOutcome,
  FulfillmentOutcome,
  LotHistoryEntryView,
  LotHistoryPage,
  LotPage,
  LotView,
  Money,
  MyInvoicesView,
  OwnDisplayName,
  PredictionAnswer,
  PredictionOutcome,
  PredictionResultsView,
  PredictionRoundStatus,
  PredictionRoundView,
  ProxyLimitRefusal,
  RaffleCancellationRefusal,
  RaffleOutcome,
  RaffleRegistrationRefusal,
  RaffleView,
  ResolvedIdentity,
  TelegramUser,
  Viewer,
} from "../ports.js";
import {
  type PredictionNomination,
  type PredictionRound,
  predictionNominationsFor,
} from "../prediction-spec.js";
import type {
  AnswerRefusal,
  AuctionScreenBody,
  CommandResult,
  FinalBidOutcome,
  HistoryItem,
  ProxyExample,
} from "../screen.js";

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
      method: "findLot";
      request: Parameters<AuctionMethods["findLot"]>[0];
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
      method: "getOwnDisplayName";
      request: Parameters<AuctionMethods["getOwnDisplayName"]>[0];
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
    }
  | {
      port: "auction";
      method: "getAuction";
      request: Parameters<AuctionMethods["getAuction"]>[0];
    }
  | {
      port: "auction";
      method: "getRaffle";
      request: Parameters<AuctionMethods["getRaffle"]>[0];
    }
  | {
      port: "auction";
      method: "registerForRaffle" | "cancelRaffleRegistration";
      request: Parameters<AuctionMethods["registerForRaffle"]>[0];
    }
  | {
      port: "auction";
      method: "getMyPredictions";
      request: Parameters<AuctionMethods["getMyPredictions"]>[0];
    }
  | {
      port: "auction";
      method: "getPredictionResults";
      request: Parameters<AuctionMethods["getPredictionResults"]>[0];
    }
  | {
      port: "auction";
      method: "getDayChronicle";
      request: Parameters<AuctionMethods["getDayChronicle"]>[0];
    }
  | {
      port: "auction";
      method: "submitPrediction";
      request: Parameters<AuctionMethods["submitPrediction"]>[0];
    }
  | {
      port: "auction";
      method: "listMyInvoices";
      request: Parameters<AuctionMethods["listMyInvoices"]>[0];
    }
  | {
      port: "auction";
      method: "chooseFulfillment";
      request: Parameters<AuctionMethods["chooseFulfillment"]>[0];
    }
  // Избранное (PER-495): отметки живут в Notifications, а не в Auction.
  | { port: "favorites"; method: "listFollowedLots"; request: Viewer }
  | {
      port: "favorites";
      method: "followLot" | "unfollowLot";
      request: { viewer: Viewer; lotId: string };
    }
  // Пояснение автоставки (PER-517): отметка живёт в Notifications.
  | { port: "proxyExplainer"; method: "seen" | "markSeen"; request: Viewer };

// Снимок Auction, над которым идёт намерение: шпион отвечает только им.
// Запрос того, чего в снимке нет, падает — так suite ловит приложение, которое
// спрашивает не то, а не подсовывает ему правдоподобный ответ.
export type ContractAuction = {
  // Сам аукцион для его корня (PER-605). Нет — Auction его не отдаёт;
  // `unavailable` — `GetAuction` отказывает.
  summary?: AuctionSummaryView | "unavailable";
  lots: readonly LotView[];
  // Страницы `ListAuctionLots` по токену; первая — под пустым.
  pages: Readonly<Record<string, LotPage>>;
  // Страницы `ListLotHistory` по лоту и токену; первая — под пустым. Лота
  // здесь нет — хронологию у него не спрашивают.
  history?: Readonly<Record<string, Readonly<Record<string, LotHistoryPage>>>>;
  // Нет — `GetDisplayNames` отказывает, как Auction отвечает до PER-434.
  names?: Readonly<Record<string, string>>;
  // Своё имя смотрящего (PER-595). Нет — имя выбрано и не закреплено;
  // `none` — не выбрано; `unavailable` — чтение отказывает.
  ownName?: OwnDisplayName | "none" | "unavailable";
  // Ответы команд участника по порядку вызовов. Нет ответа — команду в этом
  // намерении звать не должны, и шпион падает.
  bids?: readonly CommandOutcome<BidRefusal>[];
  limits?: readonly CommandOutcome<ProxyLimitRefusal>[];
  displayNames?: readonly DisplayNameOutcome[];
  // Лоты после принятой команды: следующее чтение лота отдаёт их.
  after?: readonly LotView[];
  // Read model отстаёт от команды (PER-470): `after` видит только чтение с
  // порогом версии — его адаптер дочитывает, — а простое отдаёт `lots`.
  lagging?: boolean;
  // Свои отметки избранного по порядку отметки (PER-495). Нет — порта
  // избранного у приложения нет, как у процесса без адреса Notifications;
  // `unavailable` — Notifications отказывает.
  followed?: readonly string[] | "unavailable";
  // Ответы отметки и снятия по порядку вызовов.
  follows?: readonly FollowOutcome[];
  // Видел ли человек пояснение автоставки (PER-517). Нет — порта у
  // приложения нет, как у процесса без адреса Notifications; `unavailable` —
  // Notifications отказывает и чтению, и отметке.
  explainer?: { seen: boolean } | "unavailable";
  // Розыгрыш аукциона (ADR-066). Нет — у аукциона розыгрыша нет;
  // `unavailable` — `GetRaffle` отказывает.
  raffle?: RaffleView | "unavailable";
  // Ответы регистрации и её отмены по порядку вызовов.
  registrations?: readonly RaffleOutcome<RaffleRegistrationRefusal>[];
  cancellations?: readonly RaffleOutcome<RaffleCancellationRefusal>[];
  // Свои прогнозы по раундам; нет — этот намерение не должен их читать.
  // `forbidden` — `GetMyPredictions` отказывает `PERMISSION_DENIED`, как
  // смотрящему без права `place_bids` (PER-703); `unavailable` — иной отказ.
  predictions?: readonly PredictionRoundView[] | "forbidden" | "unavailable";
  // Ответы отправки прогноза по порядку вызовов.
  predictionSubmissions?: readonly PredictionOutcome[];
  // Счета смотрящего и текст организатора (PER-322). Нет — `ListMyInvoices`
  // отказывает, как `unavailable`: корень тогда без «Моих счетов».
  invoices?: MyInvoicesView | "unavailable";
  // Ответы выбора способа получения по порядку вызовов; принятый выбор
  // следующее чтение счетов уже видит.
  fulfillments?: readonly FulfillmentOutcome[];
  predictionResults?: PredictionResultsView;
  // Хроники дня (PER-725). Нет — чтение не ожидается.
  dayChronicle?: DayChronicleView;
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
    hub: ["access-hub", "place-bids"],
    auction: ["place-bids"],
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
  if (call.port === "proxyExplainer") return { ...call, request: viewer };
  if (call.port === "favorites") {
    return call.method === "listFollowedLots"
      ? { ...call, request: viewer }
      : { ...call, request: { ...call.request, viewer } };
  }
  if (call.port !== "auction" || !("viewer" in call.request)) return call;
  return { ...call, request: { ...call.request, viewer } };
}

export const CONTRACT_AUCTION_ID = "01929b7e-5c1d-7a3f-8e4b-0000000000a1";
const EMPTY_AUCTION_ID = "01929b7e-5c1d-7a3f-8e4b-0000000000a2";
const PRE_TRADING_AUCTION_ID = "01929b7e-5c1d-7a3f-8e4b-0000000000a3";
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
  // Условия Auction отдаёт с первого планирования: шаг виден до торгов.
  fixedStep: rub(50),
  proxyEnabled: false,
  status: { kind: "scheduled", startingPrice: rub(500) },
};

// Лоты сета (ADR-073, п. 7): сет назван, в нём два лота, и после итога
// известен собравший. Сет приходит в снимке каждого своего лота.
const SET_LOT_ID = "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b44";
const SET_OTHER_LOT_ID = "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b45";
const SET_NAME = "Лесные дары";

const SET_LOT: LotView = {
  lotId: SET_LOT_ID,
  auctionId: CONTRACT_AUCTION_ID,
  version: 3,
  card: { title: "Кружка", description: "" },
  proxyEnabled: false,
  status: { kind: "scheduled", startingPrice: rub(500) },
  lotSet: {
    name: SET_NAME,
    lotIds: [SET_LOT_ID, SET_OTHER_LOT_ID],
    collectorName: "@owl",
  },
};

const SET_OTHER_LOT: LotView = {
  lotId: SET_OTHER_LOT_ID,
  auctionId: CONTRACT_AUCTION_ID,
  version: 2,
  card: { title: "Плакат", description: "" },
  proxyEnabled: false,
  status: { kind: "unsold" },
  lotSet: {
    name: SET_NAME,
    lotIds: [SET_LOT_ID, SET_OTHER_LOT_ID],
    collectorName: "@owl",
  },
};

// Десять записей хронологии лота в торгах двумя серверными страницами: две
// страницы экрана по восемь строк. Время у пар записей одно — порядок задаёт
// журнал, а прокси-ставка лидера стоит после ручной соперника той же команды.
// Последняя запись — снятие соперника администратором (ADR-072): его ставки
// остаются с пометкой, а лот идёт дальше с лидером.
const HISTORY_ENTRIES: readonly LotHistoryEntryView[] = Array.from(
  { length: 10 },
  (_, index): LotHistoryEntryView => {
    const sequence = 4 + index * 2;
    const occurredAt = `2026-10-04T12:0${Math.floor(index / 2)}:00Z`;
    if (index === 9) {
      return {
        kind: "removal",
        sequence,
        occurredAt,
        price: rub(950),
        leaderId: LEADER_ID,
      };
    }
    const byLeader = index % 2 === 1;
    return {
      kind: "bid",
      sequence,
      occurredAt,
      bidId: `01929b7e-5c1d-7a3f-8e4b-0000000001${String(index).padStart(2, "0")}`,
      participantId: byLeader ? LEADER_ID : RIVAL_ID,
      amount: rub(750 + index * 50),
      origin: byLeader
        ? { kind: "proxy" }
        : { kind: "manual", source: index === 4 ? "floor" : "bot" },
      ...(byLeader ? {} : { removed: true as const }),
    };
  },
);

const NAMES: Readonly<Record<string, string>> = {
  [LEADER_ID]: "@owl",
  [WINNER_ID]: "Сыч*",
  [RIVAL_ID]: "@jay",
};

const OPEN_PREDICTION_ROUNDS: readonly PredictionRoundView[] = [
  { round: "catalog", status: "open", answers: [] },
  { round: "final", status: "not-open", answers: [] },
];

// Лента приходит двумя серверными страницами и не по цене: порядок, которого
// ждут тела ниже, может дать только край.
export const AUCTION: ContractAuction = {
  lots: [
    CONTRACT_LOT,
    SOLD_LOT,
    UNSOLD_LOT,
    WITHDRAWN_LOT,
    SCHEDULED_LOT,
    SET_LOT,
    SET_OTHER_LOT,
  ],
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
  predictions: OPEN_PREDICTION_ROUNDS,
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
  predictions: OPEN_PREDICTION_ROUNDS,
};

// Аукцион до торгов (PER-618): лот с шагом по порогам, черновик и снятый —
// ни один не торговался.
const TIERED_SCHEDULED_LOT: LotView = {
  lotId: "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b43",
  auctionId: PRE_TRADING_AUCTION_ID,
  version: 2,
  card: { title: "Свеча", description: "" },
  tiers: [
    { lowerBound: rub(0), step: rub(50) },
    { lowerBound: rub(5000), step: rub(250) },
  ],
  proxyEnabled: false,
  status: { kind: "scheduled", startingPrice: rub(700) },
};

const PRE_TRADING_DRAFT: LotView = {
  ...DRAFT_LOT,
  lotId: "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b45",
  auctionId: PRE_TRADING_AUCTION_ID,
};

const PRE_TRADING_WITHDRAWN: LotView = {
  ...WITHDRAWN_LOT,
  lotId: "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b44",
  auctionId: PRE_TRADING_AUCTION_ID,
};

const PRE_TRADING_AUCTION: ContractAuction = {
  lots: [TIERED_SCHEDULED_LOT, PRE_TRADING_DRAFT, PRE_TRADING_WITHDRAWN],
  pages: {
    "": {
      lots: [PRE_TRADING_DRAFT, PRE_TRADING_WITHDRAWN, TIERED_SCHEDULED_LOT],
      nextPageToken: "",
    },
  },
  predictions: OPEN_PREDICTION_ROUNDS,
};

// В порядке создания — порядке `lotId` (PER-719).
const PRE_TRADING_ORDER = [
  TIERED_SCHEDULED_LOT,
  PRE_TRADING_WITHDRAWN,
  PRE_TRADING_DRAFT,
];

const listCalls = (auctionId: string, tokens: readonly string[]): PortCall[] =>
  tokens.map((pageToken) => ({
    port: "auction",
    method: "listAuctionLots",
    request: { viewer: CONTRACT_VIEWER, auctionId, pageToken },
  }));

const raffleCall = (auctionId: string): PortCall => ({
  port: "auction",
  method: "getRaffle",
  request: { viewer: CONTRACT_VIEWER, auctionId },
});

const summaryCall = (auctionId: string): PortCall => ({
  port: "auction",
  method: "getAuction",
  request: { viewer: CONTRACT_VIEWER, auctionId },
});

// Лента — стадия аукциона и страницы лотов: розыгрыш стоит в корне аукциона
// (PER-644), а стадия говорит, идёт ли финал (PER-639). Стадия стартует
// первой, страницы — следом.
const feedCalls = (
  auctionId: string,
  tokens: readonly string[],
): PortCall[] => [summaryCall(auctionId), ...listCalls(auctionId, tokens)];

// Карточка лота читает ленту своего аукциона ради соседей (PER-644): после
// имени и отметки, тем же чтением, что лента.
const CARD_CALLS = feedCalls(CONTRACT_AUCTION_ID, ["", "p2"]);

const getLotCall = (lotId: string, atLeastVersion?: number): PortCall => ({
  port: "auction",
  method: "getLot",
  request: {
    viewer: CONTRACT_VIEWER,
    lotId,
    ...(atLeastVersion === undefined ? {} : { atLeastVersion }),
  },
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

const lotCallback = (lotId: string, page: number, atLeastVersion?: number) =>
  encodeAuctionCallback({
    kind: "lot",
    lotId,
    page,
    ...(atLeastVersion === undefined ? {} : { atLeastVersion }),
  });

const historyCallback = (lotId: string, page: number, historyPage: number) =>
  encodeAuctionCallback({ kind: "history", lotId, page, historyPage });

// Возврат ленты — в корень аукциона (PER-644).
const feedBackRow = (auctionId: string) => [
  {
    action: "feed.back" as const,
    callbackData: encodeAuctionCallback({ kind: "root", auctionId }),
  },
];

// Администратор лоты не упорядочивал: порядок создания — порядок `lotId`
// (PER-719), а цена лот не двигает.
const FEED_ORDER = [
  CONTRACT_LOT,
  SOLD_LOT,
  UNSOLD_LOT,
  WITHDRAWN_LOT,
  SCHEDULED_LOT,
];

// Порядок и разделы администратора (PER-719): раздел из двух лотов, снятый лот
// первым в общем списке, остальные — за ним в порядке создания.
const SECTIONED_AUCTION: ContractAuction = {
  ...AUCTION,
  summary: {
    auctionId: CONTRACT_AUCTION_ID,
    stage: "prebidding",
    final: true,
    layout: {
      lotIds: [WITHDRAWN_LOT.lotId],
      sections: [
        {
          sectionId: 2,
          name: "Книги",
          lotIds: [SCHEDULED_LOT.lotId, CONTRACT_LOT.lotId],
        },
      ],
    },
  },
};

const sectionCallback = (auctionId: string, sectionId: number) =>
  encodeAuctionCallback({ kind: "section", auctionId, sectionId, page: 0 });

const feedItemOfLot = (lot: LotView) => ({
  lotId: lot.lotId,
  ...(lot.card === undefined ? {} : { title: lot.card.title }),
  status: lot.status,
});

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
  keyboard: [
    ...FEED_ORDER.map((lot) => [
      {
        action: "feed.open-lot" as const,
        lotId: lot.lotId,
        callbackData: lotCallback(lot.lotId, 0),
      },
    ]),
    feedBackRow(CONTRACT_AUCTION_ID),
  ],
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

// `[◀️][🔄 Обновить][▶️]` карточки (PER-644, PER-669): соседи лота в порядке
// ленты, у каждого своя страница, «Обновить» посередине. На краях своей
// кнопки нет; лота нет в ленте — в ряду только «Обновить», если она есть.
const pagerRows = (
  order: readonly LotView[],
  lotId: string,
  refresh: readonly ReturnType<typeof refreshRow>[number][] = [],
) => {
  const index = order.findIndex((lot) => lot.lotId === lotId);
  if (index < 0) return refresh.length === 0 ? [] : [[...refresh]];
  const button = (action: "lot.prev" | "lot.next", position: number) => {
    const lot = order[position];
    return lot === undefined
      ? []
      : [
          {
            action,
            callbackData: lotCallback(lot.lotId, Math.floor(position / 8)),
          },
        ];
  };
  const row = [
    ...button("lot.prev", index - 1),
    ...refresh,
    ...button("lot.next", index + 1),
  ];
  return row.length === 0 ? [] : [row];
};

const predictionReadCall = (auctionId: string): PortCall => ({
  port: "auction",
  method: "getMyPredictions",
  request: { viewer: CONTRACT_VIEWER, auctionId },
});

const predictionSubmitCall = (
  round: PredictionRound,
  answers: readonly PredictionAnswer[],
  opId: string = CONTRACT_OP_IDS[0],
): PortCall => ({
  port: "auction",
  method: "submitPrediction",
  request: {
    viewer: CONTRACT_VIEWER,
    auctionId: CONTRACT_AUCTION_ID,
    round,
    answers,
    opId,
  },
});

const predictionSummaryCall: PortCall = {
  port: "auction",
  method: "getAuction",
  request: { viewer: CONTRACT_VIEWER, auctionId: CONTRACT_AUCTION_ID },
};

const predictionFindLotCall = (lotId: string): PortCall => ({
  port: "auction",
  method: "findLot",
  request: { viewer: CONTRACT_VIEWER, lotId },
});

const CATALOG_LOT_ANSWER: PredictionAnswer = {
  nomination: "catalog-most-expensive-lot",
  answer: { kind: "lot", lotId: CONTRACT_LOT.lotId },
};

const CATALOG_MONEY_ANSWER: PredictionAnswer = {
  nomination: "catalog-total-sales",
  answer: { kind: "number", value: 1_250_000 },
};

const CATALOG_STALE_LOT_ANSWER: PredictionAnswer = {
  nomination: "catalog-most-expensive-lot",
  answer: { kind: "lot", lotId: WITHDRAWN_LOT.lotId },
};

const FINAL_COUNT_ANSWER: PredictionAnswer = {
  nomination: "final-total-bids",
  answer: { kind: "number", value: 42 },
};

const FINAL_MONEY_ANSWER: PredictionAnswer = {
  nomination: "final-total-sales",
  answer: { kind: "number", value: 2_500_000 },
};

const predictionViews = (
  round: PredictionRound,
  status: PredictionRoundStatus,
  answers: readonly PredictionAnswer[] = [],
): readonly PredictionRoundView[] =>
  (["catalog", "final"] as const).map((each) => ({
    round: each,
    status: each === round ? status : "not-open",
    answers: each === round ? answers : [],
  }));

const PREDICTION_CLOSES_AT = "2026-11-01T18:00:00Z";

const PREDICTION_SUMMARY: AuctionSummaryView = {
  auctionId: CONTRACT_AUCTION_ID,
  stage: "prebidding",
  closesAt: PREDICTION_CLOSES_AT,
  final: true,
};

const PREDICTION_LOTS = [
  DRAFT_LOT,
  CONTRACT_LOT,
  HELD_LOT,
  WITHDRAWN_LOT,
] as const;

const EXTRA_PREDICTION_LOTS: readonly LotView[] = Array.from(
  { length: 5 },
  (_, index): LotView => ({
    lotId: `01929b7e-5c1d-7a3f-8e4b-${String(index + 10).padStart(12, "0")}`,
    auctionId: CONTRACT_AUCTION_ID,
    version: 1,
    card: {
      title: `Сувенир ${String(index + 1).padStart(2, "0")}`,
      description: "",
    },
    proxyEnabled: false,
    status: { kind: "draft" },
  }),
);

const PAGED_PREDICTION_LOTS = [
  ...PREDICTION_LOTS,
  ...EXTRA_PREDICTION_LOTS,
] as const;

const PAGED_PREDICTION_CATALOG_FIRST_PAGE = [
  DRAFT_LOT,
  CONTRACT_LOT,
  ...EXTRA_PREDICTION_LOTS,
] as const;

const PREDICTION_LOT_AUCTION: ContractAuction = {
  ...AUCTION,
  lots: PREDICTION_LOTS,
  pages: {
    "": { lots: PREDICTION_LOTS, nextPageToken: "" },
  },
};

const PAGED_PREDICTION_LOT_AUCTION: ContractAuction = {
  ...PREDICTION_LOT_AUCTION,
  lots: PAGED_PREDICTION_LOTS,
  pages: {
    "": { lots: PAGED_PREDICTION_LOTS, nextPageToken: "" },
  },
};

const predictionQuestionCallback = (input: {
  round: PredictionRound;
  nomination: PredictionAnswer["nomination"];
}) =>
  callback({
    kind: "prediction-number-question",
    auctionId: CONTRACT_AUCTION_ID,
    ...input,
    addressee: CONTRACT_USER.telegramUserId,
  });

function predictionBody(
  round: PredictionRound,
  status: PredictionRoundStatus,
  answers: readonly PredictionAnswer[],
  options: {
    closesAt?: string;
    lotNames?: Readonly<Record<string, string>>;
    notice?:
      | "lot-not-in-round"
      | "round-closed"
      | "stale-answer-removed"
      | "unanswered";
    staleNominations?: readonly PredictionNomination[];
  } = {},
): AuctionScreenBody {
  return {
    blocks: [
      {
        kind: "prediction",
        auctionId: CONTRACT_AUCTION_ID,
        round,
        status,
        answers,
        lotNames: options.lotNames ?? {},
        ...(options.staleNominations === undefined
          ? {}
          : { staleNominations: options.staleNominations }),
        ...(options.closesAt === undefined
          ? {}
          : { closesAt: options.closesAt }),
        ...(options.notice === undefined ? {} : { notice: options.notice }),
      },
    ],
    keyboard: [
      ...(status === "open"
        ? predictionNominationsFor(round).map((nomination) => [
            {
              action: "prediction.edit" as const,
              callbackData: callback({
                kind: "prediction-edit",
                auctionId: CONTRACT_AUCTION_ID,
                round,
                nomination: nomination.id,
              }),
            },
          ])
        : []),
      [
        {
          action: "prediction.switch-round" as const,
          callbackData: callback({
            kind: "prediction",
            auctionId: CONTRACT_AUCTION_ID,
            round: round === "catalog" ? "final" : "catalog",
          }),
        },
      ],
      [
        {
          action: "prediction.back" as const,
          callbackData: rootCallback(CONTRACT_AUCTION_ID),
        },
      ],
    ],
  };
}

function predictionNumberQuestionBody(input: {
  round: PredictionRound;
  nomination: PredictionAnswer["nomination"];
  currentValue?: number;
}): AuctionScreenBody {
  return {
    blocks: [
      {
        kind: "prediction-number-question",
        auctionId: CONTRACT_AUCTION_ID,
        ...input,
      },
    ],
    keyboard: [
      ...(input.currentValue === undefined
        ? []
        : [
            [
              {
                action: "prediction.clear" as const,
                callbackData: callback({
                  kind: "prediction-clear",
                  auctionId: CONTRACT_AUCTION_ID,
                  ...input,
                }),
              },
            ],
          ]),
      [
        {
          action: "question.cancel",
          callbackData: callback({
            kind: "prediction-number-question",
            auctionId: CONTRACT_AUCTION_ID,
            ...input,
            addressee: CONTRACT_USER.telegramUserId,
          }),
        },
      ],
    ],
  };
}

function predictionNameChoiceBody(input: {
  round: PredictionRound;
  nomination: PredictionAnswer["nomination"];
  username?: string;
}): AuctionScreenBody {
  const { round, nomination, username } = input;
  const context = {
    auctionId: CONTRACT_AUCTION_ID,
    round,
    nomination,
  };
  return {
    blocks: [
      {
        kind: "prediction-name-choice",
        auctionId: CONTRACT_AUCTION_ID,
        round,
        ...(username === undefined ? {} : { username }),
      },
    ],
    keyboard: [
      ...(username === undefined
        ? []
        : [
            [
              {
                action: "name.username" as const,
                callbackData: callback({
                  kind: "prediction-username",
                  ...context,
                }),
              },
            ],
          ]),
      [
        {
          action: "name.alias",
          callbackData: callback({ kind: "prediction-ask-alias", ...context }),
        },
      ],
      [
        {
          action: "prediction.back",
          callbackData: callback({
            kind: "prediction",
            auctionId: CONTRACT_AUCTION_ID,
            round,
          }),
        },
      ],
    ],
  };
}

function predictionLotSelectionBody(input: {
  round: PredictionRound;
  nomination: PredictionAnswer["nomination"];
  lots: readonly LotView[];
  page?: number;
  pageCount?: number;
  currentLotId?: string;
  currentTitle?: string | undefined;
}): AuctionScreenBody {
  const {
    round,
    nomination,
    lots,
    currentLotId,
    page = 0,
    pageCount = 1,
  } = input;
  const current = lots.find((lot) => lot.lotId === currentLotId);
  const currentTitle = input.currentTitle ?? current?.card?.title;
  return {
    blocks: [
      {
        kind: "prediction-lots",
        auctionId: CONTRACT_AUCTION_ID,
        round,
        nomination,
        page,
        pageCount,
        lots: lots.map((lot) => ({
          lotId: lot.lotId,
          ...(lot.card === undefined ? {} : { title: lot.card.title }),
          status: lot.status,
        })),
        ...(currentLotId === undefined ? {} : { currentLotId }),
        ...(currentTitle === undefined ? {} : { currentTitle }),
      },
    ],
    keyboard: [
      ...lots.map((lot) => [
        {
          action: "prediction.select-lot" as const,
          lotId: lot.lotId,
          callbackData: callback({
            kind: "prediction-lot",
            auctionId: CONTRACT_AUCTION_ID,
            round,
            nomination,
            lotId: lot.lotId,
          }),
        },
      ]),
      ...(currentLotId === undefined
        ? []
        : [
            [
              {
                action: "prediction.clear" as const,
                callbackData: callback({
                  kind: "prediction-clear",
                  auctionId: CONTRACT_AUCTION_ID,
                  round,
                  nomination,
                }),
              },
            ],
          ]),
      ...(pageCount > 1
        ? [
            [
              ...(page > 0
                ? [
                    {
                      action: "feed.prev" as const,
                      callbackData: callback({
                        kind: "prediction-lots",
                        auctionId: CONTRACT_AUCTION_ID,
                        round,
                        nomination,
                        page: page - 1,
                      }),
                    },
                  ]
                : []),
              ...(page < pageCount - 1
                ? [
                    {
                      action: "feed.next" as const,
                      callbackData: callback({
                        kind: "prediction-lots",
                        auctionId: CONTRACT_AUCTION_ID,
                        round,
                        nomination,
                        page: page + 1,
                      }),
                    },
                  ]
                : []),
            ],
          ]
        : []),
      [
        {
          action: "prediction.back",
          callbackData: callback({
            kind: "prediction",
            auctionId: CONTRACT_AUCTION_ID,
            round,
          }),
        },
      ],
    ],
  };
}

function predictionAnswerRefusedBody(input: {
  round: PredictionRound;
  nomination: PredictionAnswer["nomination"];
  refusal: Extract<
    AnswerRefusal,
    "not-a-number" | "other-currency" | "too-precise" | "too-large" | "not-text"
  >;
}): AuctionScreenBody {
  const { round, nomination, refusal } = input;
  return {
    blocks: [
      {
        kind: "prediction-answer-refused",
        auctionId: CONTRACT_AUCTION_ID,
        round,
        nomination,
        refusal,
      },
    ],
    keyboard: [
      [
        {
          action: "answer.retry",
          callbackData: callback({
            kind: "prediction-edit",
            auctionId: CONTRACT_AUCTION_ID,
            round,
            nomination,
          }),
        },
      ],
      [
        {
          action: "prediction.back",
          callbackData: callback({
            kind: "prediction",
            auctionId: CONTRACT_AUCTION_ID,
            round,
          }),
        },
      ],
    ],
  };
}

// Ряды ставки под лотом в онлайн-торгах: по шагу, затем своя сумма и лимит
// одним рядом (PER-594).
// `step` — порог «По шагу» в копейках: следующая цена лота.
const bidRows = (lot: LotView, page: number, step = 125000) => [
  [
    {
      action: "lot.bid-step" as const,
      amount: rub(step / 100),
      callbackData: callback({
        kind: "confirm",
        command: "bid",
        lotId: lot.lotId,
        amount: step,
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

// Лот без итога: «Ставки» (рядом встаёт отметка избранного), листание с
// «Обновить» посередине и возврат (PER-669).
const lotKeyboard = (lotId: string, page: number) => [
  [historyButton(lotId, page)],
  ...pagerRows(FEED_ORDER, lotId, refreshRow(lotId, page)),
  backRow(page),
];

const historyButton = (lotId: string, page: number) => ({
  action: "lot.history" as const,
  callbackData: historyCallback(lotId, page, MAX_FEED_PAGE),
});

// Лот с итогом: «Обновить» под ним нет — без человека он уже не меняется.
const settledKeyboard = (lotId: string, page: number) => [
  [historyButton(lotId, page)],
  ...pagerRows(FEED_ORDER, lotId),
  backRow(page),
];

// Строки хронологии, как их показывает экран: имя — из `names`, если отдано.
const historyItems = (
  entries: readonly LotHistoryEntryView[],
  names?: Readonly<Record<string, string>>,
): HistoryItem[] =>
  entries.map((entry): HistoryItem => {
    switch (entry.kind) {
      case "bid": {
        const participantName = names?.[entry.participantId];
        return {
          kind: "bid",
          sequence: entry.sequence,
          occurredAt: entry.occurredAt,
          amount: entry.amount,
          origin: entry.origin,
          ...(participantName === undefined ? {} : { participantName }),
          ...(entry.removed === true ? { removed: true as const } : {}),
        };
      }
      case "removal": {
        const leaderName =
          entry.leaderId === undefined ? undefined : names?.[entry.leaderId];
        return {
          kind: "removal",
          sequence: entry.sequence,
          occurredAt: entry.occurredAt,
          price: entry.price,
          ...(leaderName === undefined ? {} : { leaderName }),
        };
      }
      default: {
        const _exhaustive: never = entry;
        return _exhaustive;
      }
    }
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
      status: CONTRACT_LOT.status,
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

// Тот же лот на версии принятой ставки соперника лидера: цена выросла, лидер
// прежний — чтение, которое отстаёт, показало бы цену 1200 ₽.
const LOT_CAUGHT_UP: LotView = {
  ...CONTRACT_LOT,
  version: 4,
  nextPrice: rub(1350),
  status: {
    kind: "trading",
    currentPrice: rub(1300),
    leaderId: LEADER_ID,
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
      {
        action: "confirm.no",
        callbackData: lotCallback(CONTRACT_LOT.lotId, 2),
      },
    ],
  ],
});

// Вопрос лимита с пояснением автоставки (PER-517) или с кнопкой «Как это
// работает», если пояснение человек уже видел.
const questionBody = (
  question: "bid" | "proxy" | "alias",
  extra: {
    current?: Money;
    pending?: { command: "bid" | "proxy"; amount: number };
    explainer?: { example?: ProxyExample };
    explainButton?: boolean;
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
      ...(extra.explainer === undefined ? {} : { explainer: extra.explainer }),
    },
  ],
  keyboard: [
    ...(extra.explainButton === true
      ? [
          [
            {
              action: "question.explain" as const,
              callbackData: callback({
                kind: "explain",
                lotId: CONTRACT_LOT.lotId,
                page: 2,
              }),
            },
          ],
        ]
      : []),
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

// Принятая команда — свой экран с «‹ Лот» и «‹ Лоты» (PER-473, PER-595);
// карточку перечитывает кнопка, поэтому после ответа Auction лот не читается.
// «‹ Лот» несёт версию из ответа команды: карточка дочитает лот до неё.
const acceptedFeedRow = [
  {
    action: "accepted.feed" as const,
    callbackData: feedCallback(CONTRACT_AUCTION_ID, 2),
  },
];

const acceptedBody = (
  command: "bid" | "proxy",
  amount: number,
  lotVersion: number,
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
        callbackData: lotCallback(CONTRACT_LOT.lotId, 2, lotVersion),
      },
    ],
    acceptedFeedRow,
  ],
});

// Экран принятой ставки 1 300 ₽ с подсказкой избранного или строкой
// анти-снайпа (PER-631).
const acceptedWith = (
  notes: Pick<
    Extract<AuctionScreenBody["blocks"][number], { kind: "accepted" }>,
    "favorites" | "extension"
  >,
): AuctionScreenBody => {
  const body = acceptedBody("bid", 130000, 4);
  const [accepted] = body.blocks;
  if (accepted?.kind !== "accepted") throw new Error("no accepted block");
  return { ...body, blocks: [{ ...accepted, ...notes }] };
};

// Отметки избранного читаются до команды (PER-631, №108).
const FOLLOWED_CALL: PortCall = {
  port: "favorites",
  method: "listFollowedLots",
  request: CONTRACT_VIEWER,
};

// Лот с анти-снайпом (PER-631, №107): окно две минуты, три продления, два
// уже использованы.
const SNIPED_TRADING = {
  kind: "trading" as const,
  currentPrice: rub(1200),
  leaderId: LEADER_ID,
  deadline: "2026-10-10T18:00:00Z",
  extensionsUsed: 2,
  phase: "online" as const,
};

const SNIPED_LOT: LotView = {
  ...CONTRACT_LOT,
  antiSnipe: { windowSeconds: 120, maxExtensions: 3 },
  status: SNIPED_TRADING,
};

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

// `final` — выбор имени после «Поставить» карточки финала (PER-713):
// отложенная ставка несёт метку и после имени уходит сразу.
const nameChoiceBody = (
  amount: number,
  extra: { username?: string; final?: true } = {},
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
                pending: {
                  ...pending("bid", amount),
                  ...(extra.final === undefined ? {} : { final: extra.final }),
                },
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
          pending: {
            ...pending("bid", amount),
            ...(extra.final === undefined ? {} : { final: extra.final }),
          },
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

// Имя спрашивается до подтверждения (PER-595): свое имя смотрящего в
// аукционе лота.
const OWN_NAME_CALL: PortCall = {
  port: "auction",
  method: "getOwnDisplayName",
  request: { viewer: CONTRACT_VIEWER, auctionId: CONTRACT_AUCTION_ID },
};

// Пояснение автоставки (PER-517): чтение и отметка — у Notifications.
const explainerCall = (method: "seen" | "markSeen"): PortCall => ({
  port: "proxyExplainer",
  method,
  request: CONTRACT_VIEWER,
});

const askLimitCallback = callback({
  kind: "ask",
  question: "proxy",
  lotId: CONTRACT_LOT.lotId,
  page: 2,
});

// Пример на лоте контракта: цена 1 200 ₽, единый шаг 50 ₽ и лимит на три
// шага выше. Лидирует другой участник, поэтому автоставка сразу поставит
// порог 1 250 ₽.
const CONTRACT_EXAMPLE: ProxyExample = {
  currentPrice: rub(1200),
  step: rub(50),
  limit: rub(1350),
  firstBid: rub(1250),
};

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
    auctionCalls: [LOT_CALL, OWN_NAME_CALL],
    body: confirmBody("bid", 125000),
  },
  // Первая ставка без имени: экран имени до подтверждения, и подтверждение
  // после выбора будет одно (PER-595).
  {
    intent: "bid: name asked before the confirmation",
    callbackData: callback({
      kind: "confirm",
      command: "bid",
      lotId: CONTRACT_LOT.lotId,
      amount: 125000,
      page: 2,
    }),
    from: USER_WITH_USERNAME,
    auction: { ...AUCTION, ownName: "none" },
    auctionCalls: [LOT_CALL, OWN_NAME_CALL],
    body: nameChoiceBody(125000, { username: "owl_fan" }),
  },
  // Чтение имени отказало: ставка не прячется, подтверждение показывается, а
  // без имени Auction отклонит её, и выбор имени придёт после «Да».
  {
    intent: "bid: name read refused, confirmation shown",
    callbackData: callback({
      kind: "confirm",
      command: "bid",
      lotId: CONTRACT_LOT.lotId,
      amount: 125000,
      page: 2,
    }),
    auction: { ...AUCTION, ownName: "unavailable" },
    auctionCalls: [LOT_CALL, OWN_NAME_CALL],
    body: confirmBody("bid", 125000),
  },
  // «Да»: принятая ставка — экран «принята» с «К лоту», а не карточка.
  {
    intent: "bid: accepted",
    callbackData: commitCallback("bid", 130000),
    auction: { ...AUCTION, bids: [{ kind: "accepted", lotVersion: 4 }] },
    auctionCalls: [LOT_CALL, bidCall(130000)],
    body: acceptedBody("bid", 130000, 4),
  },
  // Auction до PER-470 версии не называет: «К лоту» прежняя, без порога.
  {
    intent: "bid: accepted without a version",
    callbackData: commitCallback("bid", 130000),
    auction: { ...AUCTION, bids: [{ kind: "accepted", lotVersion: 0 }] },
    auctionCalls: [LOT_CALL, bidCall(130000)],
    body: {
      ...acceptedBody("bid", 130000, 4),
      keyboard: [
        [
          {
            action: "accepted.lot",
            callbackData: lotCallback(CONTRACT_LOT.lotId, 2),
          },
        ],
        acceptedFeedRow,
      ],
    },
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
  // Снятый с лота (ADR-072) — тоже именованный отказ: один вызов, без повтора.
  {
    intent: "bid: refused to a participant removed from the lot",
    callbackData: commitCallback("bid", 125000),
    auction: {
      ...AUCTION,
      bids: [{ kind: "refused", refusal: { kind: "removed-from-lot" } }],
    },
    auctionCalls: [LOT_CALL, bidCall(125000)],
    body: resultBody({
      command: "bid",
      kind: "refused",
      refusal: { kind: "removed-from-lot" },
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
      bids: [{ kind: "unanswered" }, { kind: "accepted", lotVersion: 4 }],
      after: [LOT_AFTER_BID],
    },
    auctionCalls: [LOT_CALL, bidCall(130000), bidCall(130000)],
    body: acceptedBody("bid", 130000, 4),
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
  // Имя закрепила ставка из другого окна, пока висел экран выбора: оно уже
  // есть, и человек идёт к подтверждению, а не к отказу.
  {
    intent: "name: frozen meanwhile, confirmation shown",
    callbackData: callback({
      kind: "username",
      lotId: CONTRACT_LOT.lotId,
      page: 2,
      pending: pending("bid", 130000),
    }),
    from: USER_WITH_USERNAME,
    auction: {
      ...AUCTION,
      displayNames: [{ kind: "refused", refusal: "name-frozen" }],
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
    auctionCalls: [LOT_CALL, OWN_NAME_CALL],
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
    auctionCalls: [LOT_CALL, namesCall(LEADER_ID), ...CARD_CALLS],
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
  // Без Notifications бот не знает, видел ли человек пояснение, и
  // показывает его: пример — на цене и шаге этого лота.
  {
    intent: "proxy: ask the limit",
    callbackData: askLimitCallback,
    auction: AUCTION,
    auctionCalls: [LOT_CALL],
    body: questionBody("proxy", {
      current: rub(1250),
      explainer: { example: CONTRACT_EXAMPLE },
    }),
  },
  {
    intent: "proxy: ask the limit before the first one",
    callbackData: askLimitCallback,
    auction: { ...AUCTION, explainer: { seen: false } },
    auctionCalls: [LOT_CALL, explainerCall("seen")],
    body: questionBody("proxy", {
      current: rub(1250),
      explainer: { example: CONTRACT_EXAMPLE },
    }),
  },
  {
    intent: "proxy: ask the limit again",
    callbackData: askLimitCallback,
    auction: { ...AUCTION, explainer: { seen: true } },
    auctionCalls: [LOT_CALL, explainerCall("seen")],
    body: questionBody("proxy", { current: rub(1250), explainButton: true }),
  },
  {
    intent: "proxy: ask the limit, mark unavailable",
    callbackData: askLimitCallback,
    auction: { ...AUCTION, explainer: "unavailable" },
    auctionCalls: [LOT_CALL, explainerCall("seen")],
    body: questionBody("proxy", {
      current: rub(1250),
      explainer: { example: CONTRACT_EXAMPLE },
    }),
  },
  // «Как это работает» объясняет без оглядки на отметку и её не читает.
  {
    intent: "proxy: how it works",
    callbackData: callback({
      kind: "explain",
      lotId: CONTRACT_LOT.lotId,
      page: 2,
    }),
    auction: { ...AUCTION, explainer: { seen: true } },
    auctionCalls: [LOT_CALL],
    body: questionBody("proxy", {
      current: rub(1250),
      explainer: { example: CONTRACT_EXAMPLE },
    }),
  },
  {
    intent: "proxy: answer the limit",
    callbackData: questionCallback("proxy"),
    reply: { text: "2000" },
    auction: AUCTION,
    auctionCalls: [LOT_CALL, OWN_NAME_CALL],
    body: confirmBody("proxy", 200000),
  },
  {
    intent: "proxy: accepted",
    callbackData: commitCallback("proxy", 200000),
    auction: { ...AUCTION, limits: [{ kind: "accepted", lotVersion: 5 }] },
    auctionCalls: [LOT_CALL, limitCall(200000)],
    body: acceptedBody("proxy", 200000, 5),
  },
  // Первая принятая автоставка снимает пояснение; отказ отметки экран не
  // роняет.
  {
    intent: "proxy: accepted, explainer marked",
    callbackData: commitCallback("proxy", 200000),
    auction: {
      ...AUCTION,
      limits: [{ kind: "accepted", lotVersion: 5 }],
      explainer: { seen: false },
    },
    auctionCalls: [LOT_CALL, limitCall(200000), explainerCall("markSeen")],
    body: acceptedBody("proxy", 200000, 5),
  },
  {
    intent: "proxy: accepted, mark unavailable",
    callbackData: commitCallback("proxy", 200000),
    auction: {
      ...AUCTION,
      limits: [{ kind: "accepted", lotVersion: 5 }],
      explainer: "unavailable",
    },
    auctionCalls: [LOT_CALL, limitCall(200000), explainerCall("markSeen")],
    body: acceptedBody("proxy", 200000, 5),
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
// Избранное (PER-495). Карточка спрашивает свои отметки после имён и ставит
// кнопку над возвратом; у закрытого лота без отметки «В избранное» нет.
// Команда сначала читает лот — отметку ставит тот, кому лот виден, — и
// отвечает состоянием после неё: карточка его показывает, не перечитывая
// список.
const listFollowedCall: PortCall = {
  port: "favorites",
  method: "listFollowedLots",
  request: CONTRACT_VIEWER,
};

const followCall = (
  method: "followLot" | "unfollowLot",
  lotId: string,
): PortCall => ({
  port: "favorites",
  method,
  request: { viewer: CONTRACT_VIEWER, lotId },
});

const findLotCall = (lotId: string): PortCall => ({
  port: "auction",
  method: "findLot",
  request: { viewer: CONTRACT_VIEWER, lotId },
});

const followRow = (lotId: string, page: number, following: boolean) => [
  following
    ? {
        action: "lot.unfollow" as const,
        callbackData: callback({ kind: "unfollow", lotId, page }),
      }
    : {
        action: "lot.follow" as const,
        callbackData: callback({ kind: "follow", lotId, page }),
      },
];

const SOLD_BLOCK = {
  kind: "lot" as const,
  lotId: SOLD_LOT.lotId,
  auctionId: CONTRACT_AUCTION_ID,
  version: 9,
  card: { title: "Плакат", description: "" },
  status: { kind: "sold" as const, winnerId: WINNER_ID, price: rub(3000) },
  participantName: "Сыч*",
};

const SCHEDULED_BLOCK = {
  kind: "lot" as const,
  lotId: SCHEDULED_LOT.lotId,
  auctionId: CONTRACT_AUCTION_ID,
  version: 2,
  card: { title: "Носки", description: "" },
  fixedStep: rub(50),
  status: { kind: "scheduled" as const, startingPrice: rub(500) },
};

// Запланированный лот с кнопкой избранного: «Ставок» у него нет, отметка
// стоит своим рядом, под ней листание с «Обновить» и возврат (PER-669).
const scheduledWithFollow = (following: boolean): AuctionScreenBody => ({
  blocks: [{ ...SCHEDULED_BLOCK, following }],
  keyboard: [
    followRow(SCHEDULED_LOT.lotId, 0, following),
    ...pagerRows(
      FEED_ORDER,
      SCHEDULED_LOT.lotId,
      refreshRow(SCHEDULED_LOT.lotId, 0),
    ),
    backRow(0),
  ],
});

// Проданный лот: «Ставки» и возврат; кнопки избранного у него нет, даже
// отмеченного (PER-595).
const soldWithFollow = (following: boolean): AuctionScreenBody => ({
  blocks: [{ ...SOLD_BLOCK, following }],
  keyboard: settledKeyboard(SOLD_LOT.lotId, 0),
});

const favoritesCallback = (page: number, auctionId?: string) =>
  callback({
    kind: "favorites",
    page,
    ...(auctionId === undefined ? {} : { auctionId }),
  });

const openFavoriteRow = (lot: LotView) => [
  {
    action: "favorites.open-lot" as const,
    lotId: lot.lotId,
    callbackData: lotCallback(lot.lotId, 0),
  },
];

const FAVORITE_ITEMS = [
  { lotId: UNSOLD_LOT.lotId, title: "Значок", status: UNSOLD_LOT.status },
  { lotId: SOLD_LOT.lotId, title: "Плакат", status: SOLD_LOT.status },
];

// Сводка аукциона корня (PER-605); её же читает избранное из корня ради
// стадии (прогон 14.10, №106).
const CONTRACT_SUMMARY: AuctionSummaryView = {
  auctionId: CONTRACT_AUCTION_ID,
  stage: "prebidding",
  opensAt: "2026-10-26T09:00:00Z",
  closesAt: "2026-10-29T18:00:00Z",
  final: true,
};

const FAVORITE_CASES: readonly AuctionContractCase[] = [
  {
    intent: "lot: in favorites",
    callbackData: lotCallback(SCHEDULED_LOT.lotId, 0),
    auction: { ...AUCTION, followed: [SCHEDULED_LOT.lotId] },
    auctionCalls: [
      getLotCall(SCHEDULED_LOT.lotId),
      listFollowedCall,
      ...CARD_CALLS,
    ],
    body: scheduledWithFollow(true),
  },
  // Проданный лот из избранного: итог известен, кнопки нет (PER-595).
  {
    intent: "lot: sold, in favorites",
    callbackData: lotCallback(SOLD_LOT.lotId, 0),
    auction: { ...AUCTION, followed: [SOLD_LOT.lotId] },
    auctionCalls: [
      getLotCall(SOLD_LOT.lotId),
      namesCall(WINNER_ID),
      listFollowedCall,
      ...CARD_CALLS,
    ],
    body: soldWithFollow(true),
  },
  {
    intent: "lot: not in favorites",
    callbackData: lotCallback(SCHEDULED_LOT.lotId, 0),
    auction: { ...AUCTION, followed: [UNSOLD_LOT.lotId] },
    auctionCalls: [
      getLotCall(SCHEDULED_LOT.lotId),
      listFollowedCall,
      ...CARD_CALLS,
    ],
    body: scheduledWithFollow(false),
  },
  // За закрытым лотом следить уже не за чем: «В избранное» под ним нет.
  {
    intent: "lot: closed, not in favorites",
    callbackData: lotCallback(SOLD_LOT.lotId, 0),
    auction: { ...AUCTION, followed: [] },
    auctionCalls: [
      getLotCall(SOLD_LOT.lotId),
      namesCall(WINNER_ID),
      listFollowedCall,
      ...CARD_CALLS,
    ],
    body: soldWithFollow(false),
  },
  // Notifications не ответил: карточка остаётся, без кнопки избранного.
  {
    intent: "lot: favorites unavailable",
    callbackData: lotCallback(SOLD_LOT.lotId, 0),
    auction: { ...AUCTION, followed: "unavailable" },
    auctionCalls: [
      getLotCall(SOLD_LOT.lotId),
      namesCall(WINNER_ID),
      listFollowedCall,
      ...CARD_CALLS,
    ],
    body: {
      blocks: [SOLD_BLOCK],
      keyboard: settledKeyboard(SOLD_LOT.lotId, 0),
    },
  },
  {
    intent: "follow: marked",
    callbackData: callback({
      kind: "follow",
      lotId: SCHEDULED_LOT.lotId,
      page: 0,
    }),
    auction: {
      ...AUCTION,
      followed: [],
      follows: [{ kind: "done", following: true }],
    },
    auctionCalls: [
      getLotCall(SCHEDULED_LOT.lotId),
      followCall("followLot", SCHEDULED_LOT.lotId),
      ...CARD_CALLS,
    ],
    body: scheduledWithFollow(true),
  },
  // Notifications ещё не знает лот: кадр исхода с «К лоту».
  {
    intent: "follow: lot not known yet",
    callbackData: callback({
      kind: "follow",
      lotId: SCHEDULED_LOT.lotId,
      page: 0,
    }),
    auction: { ...AUCTION, followed: [], follows: [{ kind: "not-ready" }] },
    auctionCalls: [
      getLotCall(SCHEDULED_LOT.lotId),
      followCall("followLot", SCHEDULED_LOT.lotId),
    ],
    body: {
      blocks: [
        {
          kind: "follow-refused",
          lotId: SCHEDULED_LOT.lotId,
          auctionId: CONTRACT_AUCTION_ID,
          title: "Носки",
        },
      ],
      keyboard: [
        [
          {
            action: "result.lot",
            callbackData: lotCallback(SCHEDULED_LOT.lotId, 0),
          },
        ],
      ],
    },
  },
  // Снятая отметка: карточка с кнопкой «Добавить в избранное».
  {
    intent: "unfollow",
    callbackData: callback({
      kind: "unfollow",
      lotId: SCHEDULED_LOT.lotId,
      page: 0,
    }),
    auction: {
      ...AUCTION,
      followed: [SCHEDULED_LOT.lotId],
      follows: [{ kind: "done", following: false }],
    },
    auctionCalls: [
      getLotCall(SCHEDULED_LOT.lotId),
      followCall("unfollowLot", SCHEDULED_LOT.lotId),
      ...CARD_CALLS,
    ],
    body: scheduledWithFollow(false),
  },
  // Список без аукциона — кнопка прежнего меню бота аукциона: возврата у
  // тела нет; поверхность до дерева её не пускает (PER-644). Лот, которого
  // Auction не знает, выпадает до нарезки страниц.
  {
    intent: "favorites: from the menu",
    callbackData: favoritesCallback(0),
    auction: {
      ...AUCTION,
      followed: [UNSOLD_LOT.lotId, EMPTY_AUCTION_ID, SOLD_LOT.lotId],
    },
    auctionCalls: [
      listFollowedCall,
      findLotCall(UNSOLD_LOT.lotId),
      findLotCall(EMPTY_AUCTION_ID),
      findLotCall(SOLD_LOT.lotId),
    ],
    body: {
      blocks: [
        {
          kind: "favorites",
          page: 0,
          pageCount: 1,
          lots: FAVORITE_ITEMS,
          total: 2,
        },
      ],
      keyboard: [openFavoriteRow(UNSOLD_LOT), openFavoriteRow(SOLD_LOT)],
    },
  },
  // Список из корня аукциона: возврат — в него (PER-644). Стадию аукциона
  // список читает ради текста сводки (прогон 14.10, №106).
  {
    intent: "favorites: from the root",
    callbackData: favoritesCallback(0, CONTRACT_AUCTION_ID),
    auction: { ...AUCTION, followed: [UNSOLD_LOT.lotId, SOLD_LOT.lotId] },
    auctionCalls: [
      summaryCall(CONTRACT_AUCTION_ID),
      listFollowedCall,
      findLotCall(UNSOLD_LOT.lotId),
      findLotCall(SOLD_LOT.lotId),
    ],
    body: {
      blocks: [
        {
          kind: "favorites",
          page: 0,
          pageCount: 1,
          lots: FAVORITE_ITEMS,
          total: 2,
        },
      ],
      keyboard: [
        openFavoriteRow(UNSOLD_LOT),
        openFavoriteRow(SOLD_LOT),
        [
          {
            action: "favorites.back",
            callbackData: callback({
              kind: "root",
              auctionId: CONTRACT_AUCTION_ID,
            }),
          },
        ],
      ],
    },
  },
  // Закончившийся аукцион: сводка говорит об итогах (прогон 14.10, №106).
  {
    intent: "favorites: from the root of a finished auction",
    callbackData: favoritesCallback(0, CONTRACT_AUCTION_ID),
    auction: {
      ...AUCTION,
      summary: { ...CONTRACT_SUMMARY, stage: "finished" },
      followed: [UNSOLD_LOT.lotId, SOLD_LOT.lotId],
    },
    auctionCalls: [
      summaryCall(CONTRACT_AUCTION_ID),
      listFollowedCall,
      findLotCall(UNSOLD_LOT.lotId),
      findLotCall(SOLD_LOT.lotId),
    ],
    body: {
      blocks: [
        {
          kind: "favorites",
          page: 0,
          pageCount: 1,
          lots: FAVORITE_ITEMS,
          total: 2,
          ended: true,
        },
      ],
      keyboard: [
        openFavoriteRow(UNSOLD_LOT),
        openFavoriteRow(SOLD_LOT),
        [
          {
            action: "favorites.back",
            callbackData: callback({
              kind: "root",
              auctionId: CONTRACT_AUCTION_ID,
            }),
          },
        ],
      ],
    },
  },
  // Список общий на все аукционы: лоты другого аукциона в нём — и
  // закончившийся аукцион возврата не называет их итогами (прогон 14.10,
  // №106, ревью).
  {
    intent: "favorites: finished auction, lots of another",
    callbackData: favoritesCallback(0, EMPTY_AUCTION_ID),
    auction: {
      ...AUCTION,
      summary: {
        ...CONTRACT_SUMMARY,
        auctionId: EMPTY_AUCTION_ID,
        stage: "finished",
      },
      followed: [UNSOLD_LOT.lotId, SOLD_LOT.lotId],
    },
    auctionCalls: [
      {
        port: "auction",
        method: "getAuction",
        request: { viewer: CONTRACT_VIEWER, auctionId: EMPTY_AUCTION_ID },
      },
      listFollowedCall,
      findLotCall(UNSOLD_LOT.lotId),
      findLotCall(SOLD_LOT.lotId),
    ],
    body: {
      blocks: [
        {
          kind: "favorites",
          page: 0,
          pageCount: 1,
          lots: FAVORITE_ITEMS,
          total: 2,
        },
      ],
      keyboard: [
        openFavoriteRow(UNSOLD_LOT),
        openFavoriteRow(SOLD_LOT),
        [
          {
            action: "favorites.back",
            callbackData: callback({
              kind: "root",
              auctionId: EMPTY_AUCTION_ID,
            }),
          },
        ],
      ],
    },
  },
  {
    intent: "favorites: empty",
    callbackData: favoritesCallback(3),
    auction: { ...AUCTION, followed: [] },
    auctionCalls: [listFollowedCall],
    body: {
      blocks: [
        { kind: "favorites", page: 0, pageCount: 1, lots: [], total: 0 },
      ],
      keyboard: [],
    },
  },
];

// Карточка лота в торгах, открытая со страницы 2 ленты.
const TRADING_LOT_BODY: AuctionScreenBody = {
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
};

// Ставка финала (PER-336, ADR-049): у карточки лота в живом финале одна
// кнопка — следующая цена, и ставка уходит одним нажатием, без «Да». Исход —
// строка на той же карточке, а отказ «не по цене» несёт кнопку на новую цену.
const LIVE_LOT: LotView = {
  ...CONTRACT_LOT,
  status: {
    kind: "trading",
    currentPrice: rub(1200),
    leaderId: LEADER_ID,
    phase: "live",
  },
};

// Принятая ставка смотрящего: цена его, лидер — он, кнопки у него нет.
const LIVE_LOT_AFTER_BID: LotView = {
  ...LIVE_LOT,
  version: 4,
  nextPrice: rub(1300),
  status: {
    kind: "trading",
    currentPrice: rub(1250),
    leaderId: CONTRACT_VIEWER.identityId,
    phase: "live",
  },
};

const LIVE_AUCTION: ContractAuction = {
  ...AUCTION,
  lots: [LIVE_LOT],
  names: { ...NAMES, [CONTRACT_VIEWER.identityId]: "@me" },
};

const finalBidCallback = (amount: number) =>
  callback({ kind: "final-bid", lotId: CONTRACT_LOT.lotId, amount, page: 2 });

const liveBody = (input: {
  lot: LotView;
  participantName: string;
  // Сумма кнопки в копейках; нет — смотрящий лидирует.
  button?: number;
  finalBid?: FinalBidOutcome;
}): AuctionScreenBody => ({
  blocks: [
    {
      kind: "lot",
      lotId: CONTRACT_LOT.lotId,
      auctionId: CONTRACT_AUCTION_ID,
      version: input.lot.version,
      card: {
        title: "Кружка с совой",
        description: "Ручная роспись.",
        image: { version: "img-1" },
      },
      nextPrice:
        input.button === undefined
          ? (input.lot.nextPrice ?? rub(0))
          : rub(input.button / 100),
      fixedStep: rub(50),
      status: input.lot.status,
      participantName: input.participantName,
      ...(input.button === undefined ? { standing: "leader" as const } : {}),
      live: { page: 2 },
      ...(input.finalBid === undefined ? {} : { finalBid: input.finalBid }),
    },
  ],
  keyboard: [
    ...(input.button === undefined
      ? []
      : [
          [
            {
              action: "lot.bid-final" as const,
              amount: rub(input.button / 100),
              callbackData: finalBidCallback(input.button),
            },
          ],
        ]),
    // В живом финале листания нет (PER-644): карточку правит поток, и в
    // ряду листания остаётся одна «Обновить».
    [historyButton(CONTRACT_LOT.lotId, 2)],
    refreshRow(CONTRACT_LOT.lotId, 2),
    backRow(2),
  ],
});

const FINAL_CASES: readonly AuctionContractCase[] = [
  {
    intent: "final: card",
    callbackData: lotCallback(CONTRACT_LOT.lotId, 2),
    auction: LIVE_AUCTION,
    auctionCalls: [LOT_CALL, namesCall(LEADER_ID)],
    body: liveBody({ lot: LIVE_LOT, participantName: "@owl", button: 125000 }),
  },
  // Одно нажатие: команда с суммой кнопки и `op_id` нажатия, затем карточка,
  // дочитанная до версии ответа, со строкой «принята».
  {
    intent: "final: bid accepted",
    callbackData: finalBidCallback(125000),
    auction: {
      ...LIVE_AUCTION,
      bids: [{ kind: "accepted", lotVersion: 4 }],
      after: [LIVE_LOT_AFTER_BID],
      lagging: true,
    },
    auctionCalls: [
      LOT_CALL,
      bidCall(125000),
      getLotCall(CONTRACT_LOT.lotId, 4),
      namesCall(CONTRACT_VIEWER.identityId),
    ],
    body: liveBody({
      lot: LIVE_LOT_AFTER_BID,
      participantName: "@me",
      finalBid: { kind: "accepted", amount: rub(1250) },
    }),
  },
  // Гонка двух нажатий на одну цену (ADR-049): второе получает отказ с новой
  // ценой. Чтение ещё не догнало ставку соперника, а кнопка уже несёт цену из
  // отказа — нажатие на прежнюю снова получило бы отказ.
  {
    intent: "final: bid at a price that moved",
    callbackData: finalBidCallback(125000),
    auction: {
      ...LIVE_AUCTION,
      bids: [
        {
          kind: "refused",
          refusal: { kind: "bid-not-at-next-price", expected: rub(1300) },
        },
      ],
    },
    auctionCalls: [LOT_CALL, bidCall(125000), LOT_CALL, namesCall(LEADER_ID)],
    body: liveBody({
      lot: LIVE_LOT,
      participantName: "@owl",
      button: 130000,
      finalBid: {
        kind: "refused",
        refusal: { kind: "bid-not-at-next-price", expected: rub(1300) },
      },
    }),
  },
  {
    intent: "final: bid unanswered twice",
    callbackData: finalBidCallback(125000),
    auction: {
      ...LIVE_AUCTION,
      bids: [{ kind: "unanswered" }, { kind: "unanswered" }],
    },
    auctionCalls: [
      LOT_CALL,
      bidCall(125000),
      bidCall(125000),
      LOT_CALL,
      namesCall(LEADER_ID),
    ],
    body: liveBody({
      lot: LIVE_LOT,
      participantName: "@owl",
      button: 125000,
      finalBid: { kind: "unknown" },
    }),
  },
  // Первая ставка в аукционе: тот же выбор имени, что в онлайн-неделе.
  {
    intent: "final: bid without a chosen name",
    callbackData: finalBidCallback(125000),
    from: USER_WITH_USERNAME,
    auction: {
      ...LIVE_AUCTION,
      bids: [{ kind: "refused", refusal: { kind: "display-name-not-chosen" } }],
    },
    auctionCalls: [LOT_CALL, bidCall(125000)],
    body: nameChoiceBody(125000, { username: "owl_fan", final: true }),
  },
  // Имя выбрано (PER-713): «Поставить» уже нажато, и ставка уходит сразу, если
  // цена кнопки всё ещё следующая, — второго нажатия нет, подтверждения тоже.
  {
    intent: "final: name chosen places the pending bid",
    callbackData: callback({
      kind: "username",
      lotId: CONTRACT_LOT.lotId,
      page: 2,
      pending: { ...pending("bid", 125000), final: true },
    }),
    from: USER_WITH_USERNAME,
    auction: {
      ...LIVE_AUCTION,
      displayNames: [{ kind: "accepted", name: "@owl_fan" }],
      bids: [{ kind: "accepted", lotVersion: 4 }],
      after: [LIVE_LOT_AFTER_BID],
      lagging: true,
    },
    auctionCalls: [
      LOT_CALL,
      chooseCall({ kind: "username", username: "owl_fan" }),
      bidCall(125000),
      getLotCall(CONTRACT_LOT.lotId, 4),
      namesCall(CONTRACT_VIEWER.identityId),
    ],
    body: liveBody({
      lot: LIVE_LOT_AFTER_BID,
      participantName: "@me",
      finalBid: { kind: "accepted", amount: rub(1250) },
    }),
  },
  // Цена ушла, пока выбирали имя: ставкой она не становится — карточка с
  // новой ценой на кнопке и строкой «цена изменилась», команда не уходит.
  {
    intent: "final: name chosen after the price moved",
    callbackData: callback({
      kind: "username",
      lotId: CONTRACT_LOT.lotId,
      page: 2,
      pending: { ...pending("bid", 120000), final: true },
    }),
    from: USER_WITH_USERNAME,
    auction: {
      ...LIVE_AUCTION,
      displayNames: [{ kind: "accepted", name: "@owl_fan" }],
    },
    auctionCalls: [
      LOT_CALL,
      chooseCall({ kind: "username", username: "owl_fan" }),
      namesCall(LEADER_ID),
    ],
    body: liveBody({
      lot: LIVE_LOT,
      participantName: "@owl",
      button: 125000,
      finalBid: { kind: "price-changed", next: rub(1250) },
    }),
  },
  // Ставка онлайн-недели, чьё имя выбрали уже в финале: её «Да» ещё не было,
  // и выход лота в финал её не подтверждает — карточка финала без ставки.
  {
    intent: "final: name chosen for a week bid returns to the card",
    callbackData: callback({
      kind: "username",
      lotId: CONTRACT_LOT.lotId,
      page: 2,
      pending: pending("bid", 125000),
    }),
    from: USER_WITH_USERNAME,
    auction: {
      ...LIVE_AUCTION,
      displayNames: [{ kind: "accepted", name: "@owl_fan" }],
    },
    auctionCalls: [
      LOT_CALL,
      chooseCall({ kind: "username", username: "owl_fan" }),
      namesCall(LEADER_ID),
    ],
    body: liveBody({ lot: LIVE_LOT, participantName: "@owl", button: 125000 }),
  },
  // Кнопка финала у лота, который уже не в финале: команда не уходит, а
  // карточка показывает, где лот.
  {
    intent: "final: stale button outside the final",
    callbackData: finalBidCallback(125000),
    auction: AUCTION,
    auctionCalls: [LOT_CALL, namesCall(LEADER_ID), ...CARD_CALLS],
    body: TRADING_LOT_BODY,
  },
];

// Розыгрыш среди участников (ADR-066). Кнопка регистрации или отмены есть
// только в окне регистрации; принятая команда отвечает розыгрышем после неё,
// отказ и неизвестный исход перечитывают его. Без имени — выбор имени с
// возвратом в розыгрыш, а принятое имя сразу ведёт к регистрации.
const OPEN_RAFFLE: RaffleView = {
  auctionId: CONTRACT_AUCTION_ID,
  status: "open",
  closesAt: "2026-10-29T18:00:00Z",
  commitment: "ab".repeat(32),
  beaconRound: 12_345_678,
  registered: false,
  tickets: [],
};

const REGISTERED_RAFFLE: RaffleView = { ...OPEN_RAFFLE, registered: true };

const CLOSING_RAFFLE: RaffleView = { ...REGISTERED_RAFFLE, status: "closing" };

const DRAWN_RAFFLE: RaffleView = {
  ...REGISTERED_RAFFLE,
  status: "drawn",
  drawnAt: "2026-10-29T22:30:00Z",
  tickets: [
    { number: 1, displayName: "@owl_fan" },
    { number: 2, displayName: "Сова*" },
  ],
  myTicket: 1,
  reveal: {
    seed: "cd".repeat(32),
    randomness: "ef".repeat(32),
    value: "12".repeat(32),
    winningTicket: 2,
  },
};

// Аукцион отменили до жеребьёвки (PER-698): отпечаток остался, seed не
// раскроется, регистрации нет.
const CANCELLED_RAFFLE: RaffleView = {
  ...REGISTERED_RAFFLE,
  status: "cancelled",
};

const raffleCallback = (auctionId = CONTRACT_AUCTION_ID) =>
  callback({ kind: "raffle", auctionId });

const raffleCommandCall = (
  method: "registerForRaffle" | "cancelRaffleRegistration",
  opId: string,
): PortCall => ({
  port: "auction",
  method,
  request: { viewer: CONTRACT_VIEWER, auctionId: CONTRACT_AUCTION_ID, opId },
});

const raffleNameCall = (
  choice: Parameters<AuctionMethods["chooseDisplayName"]>[0]["choice"],
): PortCall => ({
  port: "auction",
  method: "chooseDisplayName",
  request: { viewer: CONTRACT_VIEWER, auctionId: CONTRACT_AUCTION_ID, choice },
});

const toRootRow = [
  {
    action: "raffle.back" as const,
    callbackData: callback({ kind: "root", auctionId: CONTRACT_AUCTION_ID }),
  },
];

const toRaffleRow = [
  { action: "raffle.return" as const, callbackData: raffleCallback() },
];

const raffleScreen = (raffle: RaffleView | undefined): AuctionScreenBody => {
  const action =
    raffle?.status !== "open"
      ? []
      : raffle.registered
        ? [
            [
              {
                action: "raffle.cancel" as const,
                callbackData: callback({
                  kind: "raffle-cancel",
                  auctionId: CONTRACT_AUCTION_ID,
                }),
              },
            ],
          ]
        : [
            [
              {
                action: "raffle.register" as const,
                callbackData: callback({
                  kind: "raffle-register",
                  auctionId: CONTRACT_AUCTION_ID,
                }),
              },
            ],
          ];
  // «Как проверить честность» (PER-618) — пока у розыгрыша есть отпечаток;
  // у отменённого seed не раскроется, и проверять нечего (PER-698).
  const proof =
    raffle === undefined ||
    raffle.status === "not-held" ||
    raffle.status === "cancelled"
      ? []
      : [
          [
            {
              action: "raffle.proof" as const,
              callbackData: raffleProofCallback,
            },
          ],
        ];
  return {
    blocks: [
      {
        kind: "raffle",
        auctionId: CONTRACT_AUCTION_ID,
        ...(raffle === undefined ? {} : { raffle }),
      },
    ],
    keyboard: [...action, ...proof, toRootRow],
  };
};

// Принятая регистрация — свой экран исхода (прогон 14.10, №69): отмена,
// затем «‹ Розыгрыш» и «‹ Аукцион».
const registeredScreen = (raffle: RaffleView): AuctionScreenBody => ({
  blocks: [
    { kind: "raffle-registered", auctionId: CONTRACT_AUCTION_ID, raffle },
  ],
  keyboard: [
    [
      {
        action: "raffle.cancel",
        callbackData: callback({
          kind: "raffle-cancel",
          auctionId: CONTRACT_AUCTION_ID,
        }),
      },
    ],
    toRaffleRow,
    toRootRow,
  ],
});

const raffleProofCallback = callback({
  kind: "raffle-proof",
  auctionId: CONTRACT_AUCTION_ID,
});

// Экран проверки честности: тот же розыгрыш и возврат в него.
const raffleProofScreen = (
  raffle: RaffleView | undefined,
): AuctionScreenBody => ({
  blocks: [
    {
      kind: "raffle-proof",
      auctionId: CONTRACT_AUCTION_ID,
      ...(raffle === undefined ? {} : { raffle }),
    },
  ],
  keyboard: [toRaffleRow],
});

const askAliasButton = (action: "name.alias" | "answer.retry") => ({
  action,
  callbackData: callback({
    kind: "raffle-ask-alias",
    auctionId: CONTRACT_AUCTION_ID,
  }),
});

const RAFFLE_NAME_CHOICE: AuctionScreenBody = {
  blocks: [
    {
      kind: "raffle-name-choice",
      auctionId: CONTRACT_AUCTION_ID,
      username: "owl_fan",
    },
  ],
  keyboard: [
    [
      {
        action: "name.username",
        callbackData: callback({
          kind: "raffle-username",
          auctionId: CONTRACT_AUCTION_ID,
        }),
      },
    ],
    [askAliasButton("name.alias")],
    toRaffleRow,
  ],
};

const raffleQuestionCallback = callback({
  kind: "raffle-question",
  auctionId: CONTRACT_AUCTION_ID,
  addressee: CONTRACT_USER.telegramUserId,
});

const accepted = (raffle: RaffleView) => ({
  kind: "accepted" as const,
  raffle,
});

const RAFFLE_CASES: readonly AuctionContractCase[] = [
  // Лента — просто список лотов (PER-644): розыгрыш стоит в корне аукциона,
  // и лента его не читает, даже когда он есть.
  {
    intent: "feed: the raffle stays in the root",
    callbackData: feedCallback(EMPTY_AUCTION_ID, 0),
    auction: { ...EMPTY_AUCTION, raffle: OPEN_RAFFLE },
    auctionCalls: feedCalls(EMPTY_AUCTION_ID, [""]),
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
      keyboard: [feedBackRow(EMPTY_AUCTION_ID)],
    },
  },
  {
    intent: "raffle: open",
    callbackData: raffleCallback(),
    auction: { ...AUCTION, raffle: OPEN_RAFFLE },
    auctionCalls: [raffleCall(CONTRACT_AUCTION_ID)],
    body: raffleScreen(OPEN_RAFFLE),
  },
  {
    intent: "raffle: registered",
    callbackData: raffleCallback(),
    auction: { ...AUCTION, raffle: REGISTERED_RAFFLE },
    auctionCalls: [raffleCall(CONTRACT_AUCTION_ID)],
    body: raffleScreen(REGISTERED_RAFFLE),
  },
  // Вне окна регистрации кнопки нет: что с розыгрышем, говорит текст.
  {
    intent: "raffle: drawn",
    callbackData: raffleCallback(),
    auction: { ...AUCTION, raffle: DRAWN_RAFFLE },
    auctionCalls: [raffleCall(CONTRACT_AUCTION_ID)],
    body: raffleScreen(DRAWN_RAFFLE),
  },
  {
    intent: "raffle: absent",
    callbackData: raffleCallback(),
    auction: AUCTION,
    auctionCalls: [raffleCall(CONTRACT_AUCTION_ID)],
    body: raffleScreen(undefined),
  },
  // Отменённый вместе с аукционом розыгрыш (PER-698) — экран отмены с
  // возвратом в корень, без регистрации и без проверки, а не кадр сбоя.
  {
    intent: "raffle: cancelled",
    callbackData: raffleCallback(),
    auction: { ...AUCTION, raffle: CANCELLED_RAFFLE },
    auctionCalls: [raffleCall(CONTRACT_AUCTION_ID)],
    body: raffleScreen(CANCELLED_RAFFLE),
  },
  // Кнопка регистрации висела до отмены: отказ перечитывает розыгрыш, и
  // экран говорит об отмене.
  {
    intent: "raffle: register after the cancellation",
    callbackData: callback({
      kind: "raffle-register",
      auctionId: CONTRACT_AUCTION_ID,
    }),
    auction: {
      ...AUCTION,
      raffle: CANCELLED_RAFFLE,
      registrations: [{ kind: "refused", refusal: "registration-closed" }],
    },
    auctionCalls: [
      raffleCommandCall("registerForRaffle", CONTRACT_OP_IDS[0]),
      raffleCall(CONTRACT_AUCTION_ID),
    ],
    body: raffleScreen(CANCELLED_RAFFLE),
  },
  // Техника розыгрыша — отдельным экраном (PER-618): до жеребьёвки отпечаток
  // и раунд, после — раскрытие и пересчёт; что показать, решает оболочка.
  {
    intent: "raffle: proof before the draw",
    callbackData: raffleProofCallback,
    auction: { ...AUCTION, raffle: OPEN_RAFFLE },
    auctionCalls: [raffleCall(CONTRACT_AUCTION_ID)],
    body: raffleProofScreen(OPEN_RAFFLE),
  },
  {
    intent: "raffle: proof after the draw",
    callbackData: raffleProofCallback,
    auction: { ...AUCTION, raffle: DRAWN_RAFFLE },
    auctionCalls: [raffleCall(CONTRACT_AUCTION_ID)],
    body: raffleProofScreen(DRAWN_RAFFLE),
  },
  // Кнопка проверки висела до отмены: экран проверки говорит об отмене.
  {
    intent: "raffle: proof of a cancelled raffle",
    callbackData: raffleProofCallback,
    auction: { ...AUCTION, raffle: CANCELLED_RAFFLE },
    auctionCalls: [raffleCall(CONTRACT_AUCTION_ID)],
    body: raffleProofScreen(CANCELLED_RAFFLE),
  },
  // Кнопка устарела: розыгрыша нет — экран говорит это, а не падает.
  {
    intent: "raffle: proof without a raffle",
    callbackData: raffleProofCallback,
    auction: AUCTION,
    auctionCalls: [raffleCall(CONTRACT_AUCTION_ID)],
    body: raffleProofScreen(undefined),
  },
  {
    intent: "raffle: register",
    callbackData: callback({
      kind: "raffle-register",
      auctionId: CONTRACT_AUCTION_ID,
    }),
    auction: { ...AUCTION, registrations: [accepted(REGISTERED_RAFFLE)] },
    auctionCalls: [raffleCommandCall("registerForRaffle", CONTRACT_OP_IDS[0])],
    body: registeredScreen(REGISTERED_RAFFLE),
  },
  // Ответа не было: один повтор тем же `op_id`, затем розыгрыш перечитан.
  {
    intent: "raffle: register unanswered",
    callbackData: callback({
      kind: "raffle-register",
      auctionId: CONTRACT_AUCTION_ID,
    }),
    auction: {
      ...AUCTION,
      raffle: REGISTERED_RAFFLE,
      registrations: [{ kind: "unanswered" }, { kind: "unanswered" }],
    },
    auctionCalls: [
      raffleCommandCall("registerForRaffle", CONTRACT_OP_IDS[0]),
      raffleCommandCall("registerForRaffle", CONTRACT_OP_IDS[0]),
      raffleCall(CONTRACT_AUCTION_ID),
    ],
    body: raffleScreen(REGISTERED_RAFFLE),
  },
  {
    intent: "raffle: register after closing",
    callbackData: callback({
      kind: "raffle-register",
      auctionId: CONTRACT_AUCTION_ID,
    }),
    auction: {
      ...AUCTION,
      raffle: CLOSING_RAFFLE,
      registrations: [{ kind: "refused", refusal: "registration-closed" }],
    },
    auctionCalls: [
      raffleCommandCall("registerForRaffle", CONTRACT_OP_IDS[0]),
      raffleCall(CONTRACT_AUCTION_ID),
    ],
    body: raffleScreen(CLOSING_RAFFLE),
  },
  {
    intent: "raffle: register without a name",
    callbackData: callback({
      kind: "raffle-register",
      auctionId: CONTRACT_AUCTION_ID,
    }),
    from: USER_WITH_USERNAME,
    auction: {
      ...AUCTION,
      registrations: [{ kind: "refused", refusal: "display-name-not-chosen" }],
    },
    auctionCalls: [raffleCommandCall("registerForRaffle", CONTRACT_OP_IDS[0])],
    body: RAFFLE_NAME_CHOICE,
  },
  {
    intent: "raffle: cancel",
    callbackData: callback({
      kind: "raffle-cancel",
      auctionId: CONTRACT_AUCTION_ID,
    }),
    auction: { ...AUCTION, cancellations: [accepted(OPEN_RAFFLE)] },
    auctionCalls: [
      raffleCommandCall("cancelRaffleRegistration", CONTRACT_OP_IDS[0]),
    ],
    body: raffleScreen(OPEN_RAFFLE),
  },
  {
    intent: "raffle: username",
    callbackData: callback({
      kind: "raffle-username",
      auctionId: CONTRACT_AUCTION_ID,
    }),
    from: USER_WITH_USERNAME,
    auction: {
      ...AUCTION,
      displayNames: [{ kind: "accepted", name: "@owl_fan" }],
      registrations: [accepted(REGISTERED_RAFFLE)],
    },
    auctionCalls: [
      raffleNameCall({ kind: "username", username: "owl_fan" }),
      raffleCommandCall("registerForRaffle", CONTRACT_OP_IDS[0]),
    ],
    body: registeredScreen(REGISTERED_RAFFLE),
  },
  {
    intent: "raffle: ask alias",
    callbackData: callback({
      kind: "raffle-ask-alias",
      auctionId: CONTRACT_AUCTION_ID,
    }),
    auction: AUCTION,
    auctionCalls: [],
    body: {
      blocks: [{ kind: "raffle-question", auctionId: CONTRACT_AUCTION_ID }],
      keyboard: [
        [{ action: "question.cancel", callbackData: raffleQuestionCallback }],
      ],
    },
  },
  {
    intent: "raffle: alias question cancelled",
    callbackData: raffleQuestionCallback,
    from: USER_WITH_USERNAME,
    auction: AUCTION,
    auctionCalls: [],
    body: RAFFLE_NAME_CHOICE,
  },
  {
    intent: "raffle: alias answered",
    callbackData: raffleQuestionCallback,
    reply: { text: "Сова" },
    auction: {
      ...AUCTION,
      displayNames: [{ kind: "accepted", name: "Сова*" }],
      registrations: [accepted(REGISTERED_RAFFLE)],
    },
    auctionCalls: [
      raffleNameCall({ kind: "alias", alias: "Сова" }),
      raffleCommandCall("registerForRaffle", CONTRACT_OP_IDS[0]),
    ],
    body: registeredScreen(REGISTERED_RAFFLE),
  },
  {
    intent: "raffle: alias taken",
    callbackData: raffleQuestionCallback,
    reply: { text: "Сова" },
    auction: {
      ...AUCTION,
      displayNames: [{ kind: "refused", refusal: "alias-taken" }],
    },
    auctionCalls: [raffleNameCall({ kind: "alias", alias: "Сова" })],
    body: {
      blocks: [
        {
          kind: "raffle-answer-refused",
          auctionId: CONTRACT_AUCTION_ID,
          refusal: "alias-taken",
        },
      ],
      keyboard: [[askAliasButton("answer.retry")], toRaffleRow],
    },
  },
  {
    intent: "raffle: alias not text",
    callbackData: raffleQuestionCallback,
    reply: {},
    auction: AUCTION,
    auctionCalls: [],
    body: {
      blocks: [
        {
          kind: "raffle-answer-refused",
          auctionId: CONTRACT_AUCTION_ID,
          refusal: "not-text",
        },
      ],
      keyboard: [[askAliasButton("answer.retry")], toRaffleRow],
    },
  },
];

// Корень аукциона (PER-605): стадия и сроки, «Лоты» и, пока розыгрыш есть,
// «Розыгрыш». Розыгрыш читается параллельно аукциону и стартует первым; его
// отказ убирает кнопку, а аукцион, которого Auction не отдал, оставляет корень
// без кнопок — кнопка устарела.
const rootCallback = (auctionId: string) =>
  encodeAuctionCallback({ kind: "root", auctionId });

const rootCalls = (auctionId: string): PortCall[] => [
  raffleCall(auctionId),
  predictionReadCall(auctionId),
  invoicesCall(auctionId),
  {
    port: "auction",
    method: "getAuction",
    request: { viewer: CONTRACT_VIEWER, auctionId },
  },
];

const rootPredictionsRow = (
  auctionId: string,
  round: PredictionRound = "catalog",
) => [
  {
    action: "root.predictions" as const,
    callbackData: encodeAuctionCallback({
      kind: "prediction",
      auctionId,
      round,
    }),
  },
];

// Хроники дня (PER-725): корень онлайн-недели несёт вход в них.
const chronicleCallback = () =>
  encodeAuctionCallback({
    kind: "day-chronicle",
    auctionId: CONTRACT_AUCTION_ID,
  });

const rootChronicleRow = [
  { action: "root.day-chronicle" as const, callbackData: chronicleCallback() },
];

const rootLotsRow = [
  {
    action: "root.lots" as const,
    callbackData: feedCallback(CONTRACT_AUCTION_ID, 0),
  },
];

const ROOT_CASES: readonly AuctionContractCase[] = [
  {
    intent: "root: with a raffle",
    callbackData: rootCallback(CONTRACT_AUCTION_ID),
    auction: { ...AUCTION, summary: CONTRACT_SUMMARY, raffle: OPEN_RAFFLE },
    auctionCalls: rootCalls(CONTRACT_AUCTION_ID),
    body: {
      blocks: [
        {
          kind: "root",
          auctionId: CONTRACT_AUCTION_ID,
          auction: CONTRACT_SUMMARY,
        },
      ],
      // «Лоты» и «Розыгрыш» — одним рядом (прогон 14.10, №66).
      keyboard: [
        [
          ...rootLotsRow,
          {
            action: "root.raffle",
            callbackData: encodeAuctionCallback({
              kind: "raffle",
              auctionId: CONTRACT_AUCTION_ID,
            }),
          },
        ],
        rootPredictionsRow(CONTRACT_AUCTION_ID),
        rootChronicleRow,
      ],
    },
  },
  // Корень отменённого аукциона (PER-698): «Розыгрыш» остаётся и ведёт в
  // экран отмены, а не в сбой.
  {
    intent: "root: cancelled auction keeps the raffle",
    callbackData: rootCallback(CONTRACT_AUCTION_ID),
    auction: {
      ...AUCTION,
      summary: { ...CONTRACT_SUMMARY, stage: "cancelled" },
      raffle: CANCELLED_RAFFLE,
    },
    auctionCalls: rootCalls(CONTRACT_AUCTION_ID),
    body: {
      blocks: [
        {
          kind: "root",
          auctionId: CONTRACT_AUCTION_ID,
          auction: { ...CONTRACT_SUMMARY, stage: "cancelled" },
        },
      ],
      keyboard: [
        [
          ...rootLotsRow,
          {
            action: "root.raffle",
            callbackData: encodeAuctionCallback({
              kind: "raffle",
              auctionId: CONTRACT_AUCTION_ID,
            }),
          },
        ],
        rootPredictionsRow(CONTRACT_AUCTION_ID),
      ],
    },
  },
  {
    intent: "root: raffle read refused",
    callbackData: rootCallback(CONTRACT_AUCTION_ID),
    auction: { ...AUCTION, summary: CONTRACT_SUMMARY, raffle: "unavailable" },
    auctionCalls: rootCalls(CONTRACT_AUCTION_ID),
    body: {
      blocks: [
        {
          kind: "root",
          auctionId: CONTRACT_AUCTION_ID,
          auction: CONTRACT_SUMMARY,
        },
      ],
      keyboard: [
        rootLotsRow,
        rootPredictionsRow(CONTRACT_AUCTION_ID),
        rootChronicleRow,
      ],
    },
  },
  // Корень открывается и смотрящему, которому Auction прогнозы не отдаёт
  // (PER-703): хаб пускает в корень держателя `run_auctions` без `place_bids`,
  // и `GetMyPredictions` отвечает ему `PERMISSION_DENIED`. Отказ чтения
  // прогнозов, как у розыгрыша, убирает только кнопку «Прогнозы».
  ...(["forbidden", "unavailable"] as const).map(
    (refusal): AuctionContractCase => ({
      intent: `root: predictions read ${refusal}`,
      callbackData: rootCallback(CONTRACT_AUCTION_ID),
      auction: { ...AUCTION, summary: CONTRACT_SUMMARY, predictions: refusal },
      auctionCalls: rootCalls(CONTRACT_AUCTION_ID),
      body: {
        blocks: [
          {
            kind: "root",
            auctionId: CONTRACT_AUCTION_ID,
            auction: CONTRACT_SUMMARY,
          },
        ],
        keyboard: [rootLotsRow, rootChronicleRow],
      },
    }),
  ),
  // У процесса с Notifications в корне — «Избранное» (PER-644): вход в
  // список только отсюда, аукцион в кнопке — возврат.
  {
    intent: "root: with favorites",
    callbackData: rootCallback(CONTRACT_AUCTION_ID),
    auction: { ...AUCTION, summary: CONTRACT_SUMMARY, followed: [] },
    auctionCalls: rootCalls(CONTRACT_AUCTION_ID),
    body: {
      blocks: [
        {
          kind: "root",
          auctionId: CONTRACT_AUCTION_ID,
          auction: CONTRACT_SUMMARY,
        },
      ],
      keyboard: [
        rootLotsRow,
        rootPredictionsRow(CONTRACT_AUCTION_ID),
        rootChronicleRow,
        [
          {
            action: "root.favorites",
            callbackData: favoritesCallback(0, CONTRACT_AUCTION_ID),
          },
        ],
      ],
    },
  },
  {
    intent: "root: auction not given",
    callbackData: rootCallback(CONTRACT_AUCTION_ID),
    auction: AUCTION,
    auctionCalls: rootCalls(CONTRACT_AUCTION_ID),
    body: {
      blocks: [{ kind: "root", auctionId: CONTRACT_AUCTION_ID }],
      keyboard: [],
    },
  },
];

// Имя в аукционе из «Настроек» и положение смотрящего на лоте (PER-595).
const nameCallback = (
  kind: "name" | "name-username" | "name-ask-alias",
): string => callback({ kind, auctionId: CONTRACT_AUCTION_ID });

const nameQuestionCallback = callback({
  kind: "name-question",
  auctionId: CONTRACT_AUCTION_ID,
  addressee: CONTRACT_USER.telegramUserId,
});

const nameSettingsBody = (
  name: { text: string; frozen: boolean } | undefined,
  username?: string,
): AuctionScreenBody => ({
  blocks: [
    {
      kind: "name-settings",
      auctionId: CONTRACT_AUCTION_ID,
      ...(name === undefined ? {} : { name }),
      ...(username === undefined ? {} : { username }),
    },
  ],
  keyboard:
    name?.frozen === true
      ? []
      : [
          ...(username === undefined
            ? []
            : [
                [
                  {
                    action: "name.username" as const,
                    callbackData: nameCallback("name-username"),
                  },
                ],
              ]),
          [
            {
              action: "name.alias",
              callbackData: nameCallback("name-ask-alias"),
            },
          ],
        ],
});

// Смотрящий ведёт лот контракта: лента отмечает его своим.
const FEED_LED_BY_VIEWER: ContractAuction = {
  ...LED_BY_VIEWER,
  pages: { "": { lots: [LOT_LED_BY_VIEWER], nextPageToken: "" } },
};

const LED_ITEM = {
  lotId: LOT_LED_BY_VIEWER.lotId,
  title: "Кружка с совой",
  status: LOT_LED_BY_VIEWER.status,
  standing: "leader" as const,
};

// Плакат куплен смотрящим.
const LOT_WON_BY_VIEWER: LotView = {
  ...SOLD_LOT,
  status: {
    kind: "sold",
    winnerId: CONTRACT_VIEWER.identityId,
    price: rub(3000),
  },
};

const PER595_CASES: readonly AuctionContractCase[] = [
  {
    intent: "name settings: not chosen",
    callbackData: nameCallback("name"),
    from: USER_WITH_USERNAME,
    auction: { ...AUCTION, ownName: "none" },
    auctionCalls: [OWN_NAME_CALL],
    body: nameSettingsBody(undefined, "owl_fan"),
  },
  {
    intent: "name settings: chosen, not frozen",
    callbackData: nameCallback("name"),
    auction: { ...AUCTION, ownName: { text: "Сова*", frozen: false } },
    auctionCalls: [OWN_NAME_CALL],
    body: nameSettingsBody({ text: "Сова*", frozen: false }),
  },
  // После первой ставки экран только называет имя: выбора нет.
  {
    intent: "name settings: frozen",
    callbackData: nameCallback("name"),
    from: USER_WITH_USERNAME,
    auction: { ...AUCTION, ownName: { text: "Сова*", frozen: true } },
    auctionCalls: [OWN_NAME_CALL],
    body: nameSettingsBody({ text: "Сова*", frozen: true }),
  },
  {
    intent: "name settings: username",
    callbackData: nameCallback("name-username"),
    from: USER_WITH_USERNAME,
    auction: {
      ...AUCTION,
      displayNames: [{ kind: "accepted", name: "@owl_fan" }],
    },
    auctionCalls: [chooseCall({ kind: "username", username: "owl_fan" })],
    body: nameSettingsBody({ text: "@owl_fan", frozen: false }, "owl_fan"),
  },
  // Повтор того же ника после первой ставки Auction принимает: экран
  // показывает имя закреплённым, без выбора.
  {
    intent: "name settings: same name after the freeze",
    callbackData: nameCallback("name-username"),
    from: USER_WITH_USERNAME,
    auction: {
      ...AUCTION,
      displayNames: [{ kind: "accepted", name: "@owl_fan", frozen: true }],
    },
    auctionCalls: [chooseCall({ kind: "username", username: "owl_fan" })],
    body: nameSettingsBody({ text: "@owl_fan", frozen: true }),
  },
  // Имя закрепила ставка из другого окна: экран перечитывает и называет его.
  {
    intent: "name settings: frozen meanwhile",
    callbackData: nameCallback("name-username"),
    from: USER_WITH_USERNAME,
    auction: {
      ...AUCTION,
      displayNames: [{ kind: "refused", refusal: "name-frozen" }],
      ownName: { text: "Сова*", frozen: true },
    },
    auctionCalls: [
      chooseCall({ kind: "username", username: "owl_fan" }),
      OWN_NAME_CALL,
    ],
    body: nameSettingsBody({ text: "Сова*", frozen: true }),
  },
  {
    intent: "name settings: ask alias",
    callbackData: nameCallback("name-ask-alias"),
    auction: AUCTION,
    auctionCalls: [],
    body: {
      blocks: [{ kind: "name-question", auctionId: CONTRACT_AUCTION_ID }],
      keyboard: [
        [{ action: "question.cancel", callbackData: nameQuestionCallback }],
      ],
    },
  },
  {
    intent: "name settings: alias taken",
    callbackData: nameQuestionCallback,
    reply: { text: "Сыч" },
    auction: {
      ...AUCTION,
      displayNames: [{ kind: "refused", refusal: "alias-taken" }],
    },
    auctionCalls: [chooseCall({ kind: "alias", alias: "Сыч" })],
    body: {
      blocks: [
        {
          kind: "name-answer-refused",
          auctionId: CONTRACT_AUCTION_ID,
          refusal: "alias-taken",
        },
      ],
      keyboard: [
        [
          {
            action: "answer.retry",
            callbackData: nameCallback("name-ask-alias"),
          },
        ],
        [{ action: "name.return", callbackData: nameCallback("name") }],
      ],
    },
  },
  // Лента отмечает свои лоты сводкой (PER-595).
  {
    intent: "feed: the viewer leads",
    callbackData: feedCallback(CONTRACT_AUCTION_ID, 0),
    auction: FEED_LED_BY_VIEWER,
    auctionCalls: feedCalls(CONTRACT_AUCTION_ID, [""]),
    body: {
      blocks: [
        {
          kind: "feed",
          auctionId: CONTRACT_AUCTION_ID,
          page: 0,
          pageCount: 1,
          lots: [LED_ITEM],
          mine: [LED_ITEM],
        },
      ],
      keyboard: [
        [
          {
            action: "feed.open-lot",
            lotId: LOT_LED_BY_VIEWER.lotId,
            callbackData: lotCallback(LOT_LED_BY_VIEWER.lotId, 0),
          },
        ],
        feedBackRow(CONTRACT_AUCTION_ID),
      ],
    },
  },
  // Покупатель видит «твой лот» на карточке, а кнопки избранного у
  // проданного лота нет.
  {
    intent: "lot: sold to the viewer",
    callbackData: lotCallback(LOT_WON_BY_VIEWER.lotId, 0),
    auction: {
      ...AUCTION,
      lots: [LOT_WON_BY_VIEWER],
      names: { ...NAMES, [CONTRACT_VIEWER.identityId]: "@me" },
      followed: [LOT_WON_BY_VIEWER.lotId],
    },
    auctionCalls: [
      getLotCall(LOT_WON_BY_VIEWER.lotId),
      namesCall(CONTRACT_VIEWER.identityId),
      listFollowedCall,
      ...CARD_CALLS,
    ],
    body: {
      blocks: [
        {
          ...SOLD_BLOCK,
          status: LOT_WON_BY_VIEWER.status,
          participantName: "@me",
          standing: "won",
          following: true,
        },
      ],
      keyboard: settledKeyboard(LOT_WON_BY_VIEWER.lotId, 0),
    },
  },
  // У бота с избранным экран принятой ставки говорит, что лот уже там, —
  // если до ставки его там не было (PER-631, №108): отметки читаются до
  // команды, после неё Notifications кладёт лот туда сам.
  {
    intent: "bid: accepted with favorites",
    callbackData: commitCallback("bid", 130000),
    auction: {
      ...AUCTION,
      followed: [],
      bids: [{ kind: "accepted", lotVersion: 4 }],
    },
    auctionCalls: [LOT_CALL, FOLLOWED_CALL, bidCall(130000)],
    body: acceptedWith({ favorites: true }),
  },
  // Повторная ставка на лот из избранного подсказку не показывает.
  {
    intent: "bid: accepted on a lot already in favorites",
    callbackData: commitCallback("bid", 130000),
    auction: {
      ...AUCTION,
      followed: [CONTRACT_LOT.lotId],
      bids: [{ kind: "accepted", lotVersion: 4 }],
    },
    auctionCalls: [LOT_CALL, FOLLOWED_CALL, bidCall(130000)],
    body: acceptedBody("bid", 130000, 4),
  },
  // Отметки не прочитались: подсказка остаётся — ставка всё равно положит
  // лот в избранное, и строка об этом дешевле молчания.
  {
    intent: "bid: accepted, favorites unavailable",
    callbackData: commitCallback("bid", 130000),
    auction: {
      ...AUCTION,
      followed: "unavailable",
      bids: [{ kind: "accepted", lotVersion: 4 }],
    },
    auctionCalls: [LOT_CALL, FOLLOWED_CALL, bidCall(130000)],
    body: acceptedWith({ favorites: true }),
  },
  // Ставка в окне анти-снайпа продлила торги (PER-631, №107): лот
  // перечитывается до версии из ответа, и экран называет новый дедлайн и
  // номер продления.
  {
    intent: "bid: accepted, extended by anti-sniping",
    callbackData: commitCallback("bid", 130000),
    auction: {
      ...AUCTION,
      lots: [SNIPED_LOT],
      bids: [{ kind: "accepted", lotVersion: 4 }],
      after: [
        {
          ...SNIPED_LOT,
          status: {
            ...SNIPED_TRADING,
            deadline: "2026-10-10T18:02:00Z",
            extensionsUsed: 3,
          },
        },
      ],
    },
    auctionCalls: [
      LOT_CALL,
      bidCall(130000),
      getLotCall(CONTRACT_LOT.lotId, 4),
    ],
    body: acceptedWith({
      extension: {
        kind: "extended",
        deadline: "2026-10-10T18:02:00Z",
        used: 3,
        max: 3,
        windowSeconds: 120,
      },
    }),
  },
  // Ставка вдали от дедлайна его не сдвинула: строки нет.
  {
    intent: "bid: accepted, not extended",
    callbackData: commitCallback("bid", 130000),
    auction: {
      ...AUCTION,
      lots: [SNIPED_LOT],
      bids: [{ kind: "accepted", lotVersion: 4 }],
      after: [SNIPED_LOT],
    },
    auctionCalls: [
      LOT_CALL,
      bidCall(130000),
      getLotCall(CONTRACT_LOT.lotId, 4),
    ],
    body: acceptedBody("bid", 130000, 4),
  },
  // Продления кончились до ставки: дедлайн уже не сдвинется, и лот не
  // перечитывается.
  {
    intent: "bid: accepted, no extensions left",
    callbackData: commitCallback("bid", 130000),
    auction: {
      ...AUCTION,
      lots: [
        {
          ...SNIPED_LOT,
          status: { ...SNIPED_TRADING, extensionsUsed: 3 },
        },
      ],
      bids: [{ kind: "accepted", lotVersion: 4 }],
    },
    auctionCalls: [LOT_CALL, bidCall(130000)],
    body: acceptedWith({
      extension: { kind: "exhausted", deadline: "2026-10-10T18:00:00Z" },
    }),
  },
];

// Листание карточки на краях ленты (PER-644). Девять запланированных лотов —
// две страницы ленты: восьмой стоит последним на первой, девятый — на второй.
// Цена растёт с номером, поэтому порядок ленты — порядок номеров.
const MANY_AUCTION_ID = "01929b7e-5c1d-7a3f-8e4b-0000000000a4";

const manyLot = (n: number): LotView => ({
  lotId: `01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1c${String(n).padStart(2, "0")}`,
  auctionId: MANY_AUCTION_ID,
  version: 1,
  card: { title: `Лот ${n}`, description: "" },
  proxyEnabled: false,
  status: { kind: "scheduled", startingPrice: rub(100 * (n + 1)) },
});

const MANY_LOTS = Array.from({ length: 9 }, (_, n) => manyLot(n));

const MANY_AUCTION: ContractAuction = {
  lots: MANY_LOTS,
  pages: {
    "": { lots: MANY_LOTS.slice(0, 5), nextPageToken: "m2" },
    m2: { lots: MANY_LOTS.slice(5), nextPageToken: "" },
  },
};

const manyBlock = (lot: LotView) => ({
  kind: "lot" as const,
  lotId: lot.lotId,
  auctionId: MANY_AUCTION_ID,
  version: 1,
  ...(lot.card === undefined ? {} : { card: lot.card }),
  status: lot.status,
});

const manyBack = (page: number) => [
  {
    action: "lot.back" as const,
    callbackData: feedCallback(MANY_AUCTION_ID, page),
  },
];

const NEIGHBOR_CASES: readonly AuctionContractCase[] = [
  // Последний лот первой страницы: сосед справа — первый на второй, и его
  // кнопка несёт вторую страницу.
  {
    intent: "lot: neighbors across a feed page",
    callbackData: lotCallback(manyLot(7).lotId, 0),
    auction: MANY_AUCTION,
    auctionCalls: [
      getLotCall(manyLot(7).lotId),
      ...feedCalls(MANY_AUCTION_ID, ["", "m2"]),
    ],
    body: {
      blocks: [manyBlock(manyLot(7))],
      keyboard: [
        [
          {
            action: "lot.prev",
            callbackData: lotCallback(manyLot(6).lotId, 0),
          },
          ...refreshRow(manyLot(7).lotId, 0),
          {
            action: "lot.next",
            callbackData: lotCallback(manyLot(8).lotId, 1),
          },
        ],
        manyBack(0),
      ],
    },
  },
  // Последний лот ленты: ▶️ нет, листание не идёт по кругу.
  {
    intent: "lot: last in the feed",
    callbackData: lotCallback(manyLot(8).lotId, 1),
    auction: MANY_AUCTION,
    auctionCalls: [
      getLotCall(manyLot(8).lotId),
      ...feedCalls(MANY_AUCTION_ID, ["", "m2"]),
    ],
    body: {
      blocks: [manyBlock(manyLot(8))],
      keyboard: [
        [
          {
            action: "lot.prev",
            callbackData: lotCallback(manyLot(7).lotId, 0),
          },
          ...refreshRow(manyLot(8).lotId, 1),
        ],
        manyBack(1),
      ],
    },
  },
  // Первый лот ленты: ◀️ нет.
  {
    intent: "lot: first in the feed",
    callbackData: lotCallback(manyLot(0).lotId, 0),
    auction: MANY_AUCTION,
    auctionCalls: [
      getLotCall(manyLot(0).lotId),
      ...feedCalls(MANY_AUCTION_ID, ["", "m2"]),
    ],
    body: {
      blocks: [manyBlock(manyLot(0))],
      keyboard: [
        [
          ...refreshRow(manyLot(0).lotId, 0),
          {
            action: "lot.next",
            callbackData: lotCallback(manyLot(1).lotId, 0),
          },
        ],
        manyBack(0),
      ],
    },
  },
  // Единственный лот: листать некуда, ряда нет.
  {
    intent: "lot: alone in the feed",
    callbackData: lotCallback(manyLot(0).lotId, 0),
    auction: {
      lots: [manyLot(0)],
      pages: { "": { lots: [manyLot(0)], nextPageToken: "" } },
    },
    auctionCalls: [
      getLotCall(manyLot(0).lotId),
      ...feedCalls(MANY_AUCTION_ID, [""]),
    ],
    body: {
      blocks: [manyBlock(manyLot(0))],
      keyboard: [refreshRow(manyLot(0).lotId, 0), manyBack(0)],
    },
  },
  // Лента не прочиталась: карточка остаётся, без листания.
  {
    intent: "lot: feed unavailable",
    callbackData: lotCallback(manyLot(3).lotId, 0),
    auction: { lots: MANY_LOTS, pages: {} },
    auctionCalls: [
      getLotCall(manyLot(3).lotId),
      ...feedCalls(MANY_AUCTION_ID, [""]),
    ],
    body: {
      blocks: [manyBlock(manyLot(3))],
      keyboard: [refreshRow(manyLot(3).lotId, 0), manyBack(0)],
    },
  },
];

const PREDICTION_CASES: readonly AuctionContractCase[] = [
  {
    intent: "predictions: root opens the active final round",
    callbackData: rootCallback(CONTRACT_AUCTION_ID),
    auction: {
      ...AUCTION,
      summary: CONTRACT_SUMMARY,
      predictions: [
        { round: "catalog", status: "closed", answers: [] },
        { round: "final", status: "open", answers: [] },
      ],
    },
    auctionCalls: rootCalls(CONTRACT_AUCTION_ID),
    body: {
      blocks: [
        {
          kind: "root",
          auctionId: CONTRACT_AUCTION_ID,
          auction: CONTRACT_SUMMARY,
        },
      ],
      keyboard: [
        rootLotsRow,
        rootPredictionsRow(CONTRACT_AUCTION_ID, "final"),
        rootChronicleRow,
      ],
    },
  },
  {
    // Раунд каталога открыт всю онлайн-неделю (ADR-067, дополнение 2026-10-24).
    intent: "predictions: root offers the catalog round during online trading",
    callbackData: rootCallback(CONTRACT_AUCTION_ID),
    auction: {
      ...AUCTION,
      summary: PREDICTION_SUMMARY,
      predictions: predictionViews("catalog", "open"),
    },
    auctionCalls: rootCalls(CONTRACT_AUCTION_ID),
    body: {
      blocks: [
        {
          kind: "root",
          auctionId: CONTRACT_AUCTION_ID,
          auction: PREDICTION_SUMMARY,
        },
      ],
      keyboard: [
        rootLotsRow,
        rootPredictionsRow(CONTRACT_AUCTION_ID),
        rootChronicleRow,
      ],
    },
  },
  {
    intent: "predictions: open catalog round with only own answers",
    callbackData: callback({
      kind: "prediction",
      auctionId: CONTRACT_AUCTION_ID,
      round: "catalog",
    }),
    auction: {
      ...AUCTION,
      summary: PREDICTION_SUMMARY,
      predictions: predictionViews("catalog", "open", [
        CATALOG_LOT_ANSWER,
        CATALOG_MONEY_ANSWER,
      ]),
    },
    auctionCalls: [
      predictionReadCall(CONTRACT_AUCTION_ID),
      predictionSummaryCall,
      predictionFindLotCall(CONTRACT_LOT.lotId),
    ],
    body: predictionBody(
      "catalog",
      "open",
      [CATALOG_LOT_ANSWER, CATALOG_MONEY_ANSWER],
      {
        closesAt: PREDICTION_CLOSES_AT,
        lotNames: { [CONTRACT_LOT.lotId]: "Кружка с совой" },
      },
    ),
  },
  {
    intent: "predictions: mark a removed catalog lot in the open forecast",
    callbackData: callback({
      kind: "prediction",
      auctionId: CONTRACT_AUCTION_ID,
      round: "catalog",
    }),
    auction: {
      ...PREDICTION_LOT_AUCTION,
      summary: PREDICTION_SUMMARY,
      predictions: predictionViews("catalog", "open", [
        CATALOG_STALE_LOT_ANSWER,
      ]),
    },
    auctionCalls: [
      predictionReadCall(CONTRACT_AUCTION_ID),
      predictionSummaryCall,
      predictionFindLotCall(WITHDRAWN_LOT.lotId),
    ],
    body: predictionBody("catalog", "open", [CATALOG_STALE_LOT_ANSWER], {
      closesAt: PREDICTION_CLOSES_AT,
      staleNominations: ["catalog-most-expensive-lot"],
    }),
  },
  {
    intent: "predictions: switch to unopened final round",
    callbackData: callback({
      kind: "prediction",
      auctionId: CONTRACT_AUCTION_ID,
      round: "final",
    }),
    auction: {
      ...AUCTION,
      predictions: predictionViews("final", "not-open"),
    },
    auctionCalls: [predictionReadCall(CONTRACT_AUCTION_ID)],
    body: predictionBody("final", "not-open", []),
  },
  {
    intent: "predictions: closed round is read-only",
    callbackData: callback({
      kind: "prediction",
      auctionId: CONTRACT_AUCTION_ID,
      round: "catalog",
    }),
    auction: {
      ...AUCTION,
      summary: PREDICTION_SUMMARY,
      predictions: predictionViews("catalog", "closed", [CATALOG_MONEY_ANSWER]),
    },
    auctionCalls: [
      predictionReadCall(CONTRACT_AUCTION_ID),
      predictionSummaryCall,
    ],
    body: predictionBody("catalog", "closed", [CATALOG_MONEY_ANSWER], {
      closesAt: PREDICTION_CLOSES_AT,
    }),
  },
  {
    intent: "predictions: reject a stale answer after round closure",
    callbackData: predictionQuestionCallback({
      round: "final",
      nomination: "final-total-bids",
    }),
    reply: { text: "56" },
    auction: {
      ...AUCTION,
      predictions: predictionViews("final", "closed", [FINAL_COUNT_ANSWER]),
    },
    auctionCalls: [
      predictionReadCall(CONTRACT_AUCTION_ID),
      predictionReadCall(CONTRACT_AUCTION_ID),
    ],
    body: predictionBody("final", "closed", [FINAL_COUNT_ANSWER], {
      notice: "round-closed",
    }),
  },
  {
    intent: "predictions: honor round-closed refusal despite a stale open read",
    callbackData: predictionQuestionCallback({
      round: "final",
      nomination: "final-total-bids",
    }),
    reply: { text: "56" },
    auction: {
      ...AUCTION,
      predictions: predictionViews("final", "open", [FINAL_COUNT_ANSWER]),
      predictionSubmissions: [
        {
          kind: "refused",
          refusal: { kind: "round-closed" },
        },
      ],
    },
    auctionCalls: [
      predictionReadCall(CONTRACT_AUCTION_ID),
      predictionSubmitCall("final", [
        {
          nomination: "final-total-bids",
          answer: { kind: "number", value: 56 },
        },
      ]),
      predictionReadCall(CONTRACT_AUCTION_ID),
    ],
    body: predictionBody("final", "closed", [FINAL_COUNT_ANSWER], {
      notice: "round-closed",
    }),
  },
  {
    intent: "predictions: edit catalog lot from all catalog lots",
    callbackData: callback({
      kind: "prediction-edit",
      auctionId: CONTRACT_AUCTION_ID,
      round: "catalog",
      nomination: "catalog-most-expensive-lot",
    }),
    auction: {
      ...PAGED_PREDICTION_LOT_AUCTION,
      predictions: predictionViews("catalog", "open", [CATALOG_LOT_ANSWER]),
    },
    auctionCalls: [
      predictionReadCall(CONTRACT_AUCTION_ID),
      predictionReadCall(CONTRACT_AUCTION_ID),
      ...listCalls(CONTRACT_AUCTION_ID, [""]),
    ],
    body: predictionLotSelectionBody({
      round: "catalog",
      nomination: "catalog-most-expensive-lot",
      lots: PAGED_PREDICTION_CATALOG_FIRST_PAGE,
      pageCount: 2,
      currentLotId: CONTRACT_LOT.lotId,
    }),
  },
  {
    intent: "predictions: edit final lot from held lineup only",
    callbackData: callback({
      kind: "prediction-edit",
      auctionId: CONTRACT_AUCTION_ID,
      round: "final",
      nomination: "final-most-expensive-lot",
    }),
    auction: {
      ...PREDICTION_LOT_AUCTION,
      predictions: predictionViews("final", "open", [
        {
          nomination: "final-most-expensive-lot",
          answer: { kind: "lot", lotId: HELD_LOT.lotId },
        },
      ]),
    },
    auctionCalls: [
      predictionReadCall(CONTRACT_AUCTION_ID),
      predictionReadCall(CONTRACT_AUCTION_ID),
      ...listCalls(CONTRACT_AUCTION_ID, [""]),
    ],
    body: predictionLotSelectionBody({
      round: "final",
      nomination: "final-most-expensive-lot",
      lots: [HELD_LOT],
      currentLotId: HELD_LOT.lotId,
    }),
  },
  {
    intent: "predictions: reopen catalog lot choices from pagination callback",
    callbackData: callback({
      kind: "prediction-lots",
      auctionId: CONTRACT_AUCTION_ID,
      round: "catalog",
      nomination: "catalog-most-expensive-lot",
      page: 1,
    }),
    auction: {
      ...PAGED_PREDICTION_LOT_AUCTION,
      predictions: predictionViews("catalog", "open", [CATALOG_LOT_ANSWER]),
    },
    auctionCalls: [
      predictionReadCall(CONTRACT_AUCTION_ID),
      predictionReadCall(CONTRACT_AUCTION_ID),
      ...listCalls(CONTRACT_AUCTION_ID, [""]),
    ],
    body: predictionLotSelectionBody({
      round: "catalog",
      nomination: "catalog-most-expensive-lot",
      lots: [HELD_LOT],
      page: 1,
      pageCount: 2,
      currentLotId: CONTRACT_LOT.lotId,
      currentTitle: CONTRACT_LOT.card?.title,
    }),
  },
  {
    intent: "predictions: select final lot",
    callbackData: callback({
      kind: "prediction-lot",
      auctionId: CONTRACT_AUCTION_ID,
      round: "final",
      nomination: "final-most-expensive-lot",
      lotId: HELD_LOT.lotId,
    }),
    auction: {
      ...PREDICTION_LOT_AUCTION,
      predictions: predictionViews("final", "open"),
      predictionSubmissions: [
        {
          kind: "accepted",
          prediction: {
            round: "final",
            answers: [
              {
                nomination: "final-most-expensive-lot",
                answer: { kind: "lot", lotId: HELD_LOT.lotId },
              },
            ],
          },
        },
      ],
    },
    auctionCalls: [
      predictionReadCall(CONTRACT_AUCTION_ID),
      predictionSubmitCall("final", [
        {
          nomination: "final-most-expensive-lot",
          answer: { kind: "lot", lotId: HELD_LOT.lotId },
        },
      ]),
      predictionReadCall(CONTRACT_AUCTION_ID),
      predictionFindLotCall(HELD_LOT.lotId),
    ],
    body: predictionBody(
      "final",
      "open",
      [
        {
          nomination: "final-most-expensive-lot",
          answer: { kind: "lot", lotId: HELD_LOT.lotId },
        },
      ],
      {
        lotNames: { [HELD_LOT.lotId]: "Шарф" },
      },
    ),
  },
  {
    intent: "predictions: parse rubles and preserve other nominations",
    callbackData: predictionQuestionCallback({
      round: "catalog",
      nomination: "catalog-total-sales",
    }),
    reply: { text: "12 345,67 ₽" },
    auction: {
      ...AUCTION,
      summary: PREDICTION_SUMMARY,
      predictions: predictionViews("catalog", "open", [CATALOG_LOT_ANSWER]),
      predictionSubmissions: [
        {
          kind: "accepted",
          prediction: {
            round: "catalog",
            answers: [
              CATALOG_LOT_ANSWER,
              {
                nomination: "catalog-total-sales",
                answer: { kind: "number", value: 1_234_567 },
              },
            ],
          },
        },
      ],
    },
    auctionCalls: [
      predictionReadCall(CONTRACT_AUCTION_ID),
      predictionSubmitCall("catalog", [
        CATALOG_LOT_ANSWER,
        {
          nomination: "catalog-total-sales",
          answer: { kind: "number", value: 1_234_567 },
        },
      ]),
      predictionReadCall(CONTRACT_AUCTION_ID),
      predictionSummaryCall,
      predictionFindLotCall(CONTRACT_LOT.lotId),
    ],
    body: predictionBody(
      "catalog",
      "open",
      [
        CATALOG_LOT_ANSWER,
        {
          nomination: "catalog-total-sales",
          answer: { kind: "number", value: 1_234_567 },
        },
      ],
      {
        closesAt: PREDICTION_CLOSES_AT,
        lotNames: { [CONTRACT_LOT.lotId]: "Кружка с совой" },
      },
    ),
  },
  {
    intent:
      "predictions: remove a withdrawn answer before saving another nomination",
    callbackData: predictionQuestionCallback({
      round: "catalog",
      nomination: "catalog-total-sales",
    }),
    reply: { text: "12 500" },
    auction: {
      ...PREDICTION_LOT_AUCTION,
      summary: PREDICTION_SUMMARY,
      predictions: predictionViews("catalog", "open", [
        CATALOG_STALE_LOT_ANSWER,
      ]),
      predictionSubmissions: [
        {
          kind: "refused",
          refusal: {
            kind: "lot-not-in-round",
            nomination: "catalog-most-expensive-lot",
            lotId: WITHDRAWN_LOT.lotId,
          },
        },
        {
          kind: "accepted",
          prediction: { round: "catalog", answers: [CATALOG_MONEY_ANSWER] },
        },
      ],
    },
    auctionCalls: [
      predictionReadCall(CONTRACT_AUCTION_ID),
      predictionSubmitCall(
        "catalog",
        [CATALOG_STALE_LOT_ANSWER, CATALOG_MONEY_ANSWER],
        CONTRACT_OP_IDS[0],
      ),
      predictionSubmitCall(
        "catalog",
        [CATALOG_MONEY_ANSWER],
        CONTRACT_OP_IDS[1],
      ),
      predictionReadCall(CONTRACT_AUCTION_ID),
      predictionSummaryCall,
    ],
    body: predictionBody("catalog", "open", [CATALOG_MONEY_ANSWER], {
      closesAt: PREDICTION_CLOSES_AT,
      notice: "stale-answer-removed",
    }),
  },
  {
    intent: "predictions: parse grouped integer in final round",
    callbackData: predictionQuestionCallback({
      round: "final",
      nomination: "final-total-bids",
    }),
    reply: { text: "1 234" },
    auction: {
      ...AUCTION,
      predictions: predictionViews("final", "open"),
      predictionSubmissions: [
        {
          kind: "accepted",
          prediction: {
            round: "final",
            answers: [
              {
                nomination: "final-total-bids",
                answer: { kind: "number", value: 1234 },
              },
            ],
          },
        },
      ],
    },
    auctionCalls: [
      predictionReadCall(CONTRACT_AUCTION_ID),
      predictionSubmitCall("final", [
        {
          nomination: "final-total-bids",
          answer: { kind: "number", value: 1234 },
        },
      ]),
      predictionReadCall(CONTRACT_AUCTION_ID),
    ],
    body: predictionBody("final", "open", [
      {
        nomination: "final-total-bids",
        answer: { kind: "number", value: 1234 },
      },
    ]),
  },
  {
    intent: "predictions: reject foreign currency code",
    callbackData: predictionQuestionCallback({
      round: "final",
      nomination: "final-total-sales",
    }),
    reply: { text: "12 USD" },
    auction: {
      ...AUCTION,
      predictions: predictionViews("final", "open"),
    },
    auctionCalls: [],
    body: predictionAnswerRefusedBody({
      round: "final",
      nomination: "final-total-sales",
      refusal: "other-currency",
    }),
  },
  {
    intent: "predictions: clear one nomination and keep the rest",
    callbackData: callback({
      kind: "prediction-clear",
      auctionId: CONTRACT_AUCTION_ID,
      round: "final",
      nomination: "final-total-bids",
    }),
    auction: {
      ...AUCTION,
      predictions: predictionViews("final", "open", [
        FINAL_COUNT_ANSWER,
        FINAL_MONEY_ANSWER,
      ]),
      predictionSubmissions: [
        {
          kind: "accepted",
          prediction: { round: "final", answers: [FINAL_MONEY_ANSWER] },
        },
      ],
    },
    auctionCalls: [
      predictionReadCall(CONTRACT_AUCTION_ID),
      predictionSubmitCall("final", [FINAL_MONEY_ANSWER]),
      predictionReadCall(CONTRACT_AUCTION_ID),
    ],
    body: predictionBody("final", "open", [FINAL_MONEY_ANSWER], {}),
  },
  {
    intent: "predictions: unanswered submission retries same operation",
    callbackData: predictionQuestionCallback({
      round: "final",
      nomination: "final-total-bids",
    }),
    reply: { text: "56" },
    auction: {
      ...AUCTION,
      predictions: predictionViews("final", "open"),
      predictionSubmissions: [
        { kind: "unanswered" },
        {
          kind: "accepted",
          prediction: {
            round: "final",
            answers: [
              {
                nomination: "final-total-bids",
                answer: { kind: "number", value: 56 },
              },
            ],
          },
        },
      ],
    },
    auctionCalls: [
      predictionReadCall(CONTRACT_AUCTION_ID),
      predictionSubmitCall("final", [
        {
          nomination: "final-total-bids",
          answer: { kind: "number", value: 56 },
        },
      ]),
      predictionSubmitCall("final", [
        {
          nomination: "final-total-bids",
          answer: { kind: "number", value: 56 },
        },
      ]),
      predictionReadCall(CONTRACT_AUCTION_ID),
    ],
    body: predictionBody("final", "open", [
      {
        nomination: "final-total-bids",
        answer: { kind: "number", value: 56 },
      },
    ]),
  },
  {
    intent: "predictions: unanswered twice shows an uncertain save outcome",
    callbackData: predictionQuestionCallback({
      round: "final",
      nomination: "final-total-bids",
    }),
    reply: { text: "56" },
    auction: {
      ...AUCTION,
      predictions: predictionViews("final", "open", [FINAL_COUNT_ANSWER]),
      predictionSubmissions: [{ kind: "unanswered" }, { kind: "unanswered" }],
    },
    auctionCalls: [
      predictionReadCall(CONTRACT_AUCTION_ID),
      predictionSubmitCall("final", [
        {
          nomination: "final-total-bids",
          answer: { kind: "number", value: 56 },
        },
      ]),
      predictionSubmitCall("final", [
        {
          nomination: "final-total-bids",
          answer: { kind: "number", value: 56 },
        },
      ]),
      predictionReadCall(CONTRACT_AUCTION_ID),
    ],
    body: predictionBody("final", "open", [FINAL_COUNT_ANSWER], {
      notice: "unanswered",
    }),
  },
  // Имя спрашивается до ответа (PER-703), как перед ставкой (PER-595): после
  // выбора имени отказ `display-name-not-chosen` терял введённый ответ — кнопки
  // выбора имени несут номинацию, а не значение. Свои ответы раунда значат, что
  // имя уже выбрано, и Auction за ним не зовут; отказ чтения имени вопрос не
  // прячет — страховкой остаётся отказ отправки.
  {
    intent: "predictions: ask for the name before the answer",
    callbackData: callback({
      kind: "prediction-edit",
      auctionId: CONTRACT_AUCTION_ID,
      round: "final",
      nomination: "final-total-bids",
    }),
    from: USER_WITH_USERNAME,
    auction: {
      ...AUCTION,
      predictions: predictionViews("final", "open"),
      ownName: "none",
    },
    auctionCalls: [predictionReadCall(CONTRACT_AUCTION_ID), OWN_NAME_CALL],
    body: predictionNameChoiceBody({
      round: "final",
      nomination: "final-total-bids",
      username: "owl_fan",
    }),
  },
  {
    intent: "predictions: own name read refused still asks the answer",
    callbackData: callback({
      kind: "prediction-edit",
      auctionId: CONTRACT_AUCTION_ID,
      round: "final",
      nomination: "final-total-bids",
    }),
    auction: {
      ...AUCTION,
      predictions: predictionViews("final", "open"),
      ownName: "unavailable",
    },
    auctionCalls: [predictionReadCall(CONTRACT_AUCTION_ID), OWN_NAME_CALL],
    body: predictionNumberQuestionBody({
      round: "final",
      nomination: "final-total-bids",
    }),
  },
  {
    intent: "predictions: ask for a name without losing the nomination",
    callbackData: predictionQuestionCallback({
      round: "final",
      nomination: "final-total-bids",
    }),
    from: USER_WITH_USERNAME,
    reply: { text: "56" },
    auction: {
      ...AUCTION,
      predictions: predictionViews("final", "open"),
      predictionSubmissions: [
        {
          kind: "refused",
          refusal: { kind: "display-name-not-chosen" },
        },
      ],
    },
    auctionCalls: [
      predictionReadCall(CONTRACT_AUCTION_ID),
      predictionSubmitCall("final", [
        {
          nomination: "final-total-bids",
          answer: { kind: "number", value: 56 },
        },
      ]),
    ],
    body: predictionNameChoiceBody({
      round: "final",
      nomination: "final-total-bids",
      username: "owl_fan",
    }),
  },
  {
    intent: "predictions: choose username returns to same nomination",
    callbackData: callback({
      kind: "prediction-username",
      auctionId: CONTRACT_AUCTION_ID,
      round: "final",
      nomination: "final-total-bids",
    }),
    from: USER_WITH_USERNAME,
    auction: {
      ...AUCTION,
      predictions: predictionViews("final", "open", [FINAL_COUNT_ANSWER]),
      displayNames: [{ kind: "accepted", name: "@owl_fan" }],
    },
    auctionCalls: [
      chooseCall({ kind: "username", username: "owl_fan" }),
      predictionReadCall(CONTRACT_AUCTION_ID),
    ],
    body: predictionNumberQuestionBody({
      round: "final",
      nomination: "final-total-bids",
      currentValue: 42,
    }),
  },
  {
    intent: "predictions: ask for an alias",
    callbackData: callback({
      kind: "prediction-ask-alias",
      auctionId: CONTRACT_AUCTION_ID,
      round: "catalog",
      nomination: "catalog-total-sales",
    }),
    auction: AUCTION,
    auctionCalls: [],
    body: {
      blocks: [
        {
          kind: "prediction-alias-question",
          auctionId: CONTRACT_AUCTION_ID,
          round: "catalog",
          nomination: "catalog-total-sales",
        },
      ],
      keyboard: [
        [
          {
            action: "question.cancel",
            callbackData: callback({
              kind: "prediction-alias-question",
              auctionId: CONTRACT_AUCTION_ID,
              round: "catalog",
              nomination: "catalog-total-sales",
              addressee: CONTRACT_USER.telegramUserId,
            }),
          },
        ],
      ],
    },
  },
  {
    intent: "predictions: alias question cancelled",
    callbackData: callback({
      kind: "prediction-alias-question",
      auctionId: CONTRACT_AUCTION_ID,
      round: "catalog",
      nomination: "catalog-total-sales",
      addressee: CONTRACT_USER.telegramUserId,
    }),
    auction: AUCTION,
    auctionCalls: [],
    body: predictionNameChoiceBody({
      round: "catalog",
      nomination: "catalog-total-sales",
    }),
  },
  {
    intent: "predictions: alias reply without text can be retried",
    callbackData: callback({
      kind: "prediction-alias-question",
      auctionId: CONTRACT_AUCTION_ID,
      round: "catalog",
      nomination: "catalog-total-sales",
      addressee: CONTRACT_USER.telegramUserId,
    }),
    reply: {},
    auction: AUCTION,
    auctionCalls: [],
    body: {
      blocks: [
        {
          kind: "prediction-answer-refused",
          auctionId: CONTRACT_AUCTION_ID,
          round: "catalog",
          nomination: "catalog-total-sales",
          refusal: "not-text",
        },
      ],
      keyboard: [
        [
          {
            action: "answer.retry",
            callbackData: callback({
              kind: "prediction-ask-alias",
              auctionId: CONTRACT_AUCTION_ID,
              round: "catalog",
              nomination: "catalog-total-sales",
            }),
          },
        ],
        [
          {
            action: "prediction.back",
            callbackData: callback({
              kind: "prediction",
              auctionId: CONTRACT_AUCTION_ID,
              round: "catalog",
            }),
          },
        ],
      ],
    },
  },
  {
    intent: "predictions: ask and answer alias with same context",
    callbackData: callback({
      kind: "prediction-alias-question",
      auctionId: CONTRACT_AUCTION_ID,
      round: "catalog",
      nomination: "catalog-total-sales",
      addressee: CONTRACT_USER.telegramUserId,
    }),
    reply: { text: "Сова" },
    auction: {
      ...AUCTION,
      summary: PREDICTION_SUMMARY,
      predictions: predictionViews("catalog", "open"),
      displayNames: [{ kind: "accepted", name: "Сова*" }],
    },
    auctionCalls: [
      chooseCall({ kind: "alias", alias: "Сова" }),
      predictionReadCall(CONTRACT_AUCTION_ID),
      OWN_NAME_CALL,
    ],
    body: predictionNumberQuestionBody({
      round: "catalog",
      nomination: "catalog-total-sales",
    }),
  },
];

// Сет лотов (ADR-073, п. 7): карточка лота сета называет сет и ведёт к его
// экрану, экран перечисляет лоты сета и, после итога, собравшего.
const SET_CASES: readonly AuctionContractCase[] = [
  {
    intent: "lot: the card of a lot of a set",
    callbackData: lotCallback(SET_LOT_ID, 0),
    auction: AUCTION,
    auctionCalls: [getLotCall(SET_LOT_ID), ...CARD_CALLS],
    body: {
      blocks: [
        {
          kind: "lot",
          lotId: SET_LOT_ID,
          auctionId: CONTRACT_AUCTION_ID,
          version: 3,
          card: { title: "Кружка", description: "" },
          status: { kind: "scheduled", startingPrice: rub(500) },
          set: {
            name: SET_NAME,
            lotIds: [SET_LOT_ID, SET_OTHER_LOT_ID],
            collectorName: "@owl",
          },
        },
      ],
      keyboard: [
        [
          {
            action: "lot.set",
            callbackData: encodeAuctionCallback({
              kind: "set",
              lotId: SET_LOT_ID,
              page: 0,
            }),
          },
        ],
        ...pagerRows(FEED_ORDER, SET_LOT_ID, refreshRow(SET_LOT_ID, 0)),
        backRow(0),
      ],
    },
  },
  {
    intent: "set: the screen of the set",
    callbackData: encodeAuctionCallback({
      kind: "set",
      lotId: SET_LOT_ID,
      page: 0,
    }),
    auction: AUCTION,
    auctionCalls: [getLotCall(SET_LOT_ID), findLotCall(SET_OTHER_LOT_ID)],
    body: {
      blocks: [
        {
          kind: "set",
          auctionId: CONTRACT_AUCTION_ID,
          name: SET_NAME,
          lots: [
            {
              lotId: SET_LOT_ID,
              title: "Кружка",
              status: { kind: "scheduled", startingPrice: rub(500) },
              setName: SET_NAME,
            },
            {
              lotId: SET_OTHER_LOT_ID,
              title: "Плакат",
              status: { kind: "unsold" },
              setName: SET_NAME,
            },
          ],
          collectorName: "@owl",
        },
      ],
      keyboard: [
        [
          {
            action: "set.open-lot",
            lotId: SET_LOT_ID,
            callbackData: lotCallback(SET_LOT_ID, 0),
          },
        ],
        [
          {
            action: "set.open-lot",
            lotId: SET_OTHER_LOT_ID,
            callbackData: lotCallback(SET_OTHER_LOT_ID, 0),
          },
        ],
        [
          {
            action: "set.back",
            callbackData: lotCallback(SET_LOT_ID, 0),
          },
        ],
      ],
    },
  },
];

const FINISHED_SUMMARY: AuctionSummaryView = {
  ...CONTRACT_SUMMARY,
  stage: "finished",
};

const resultsCallback = () =>
  encodeAuctionCallback({
    kind: "prediction-results",
    auctionId: CONTRACT_AUCTION_ID,
  });

const resultsReadCall = (): PortCall => ({
  port: "auction",
  method: "getPredictionResults",
  request: { viewer: CONTRACT_VIEWER, auctionId: CONTRACT_AUCTION_ID },
});

const resultsBackRow = [
  {
    action: "prediction-results.back" as const,
    callbackData: callback({ kind: "root", auctionId: CONTRACT_AUCTION_ID }),
  },
];

const resultsBody = (
  results: Extract<
    AuctionScreenBody["blocks"][number],
    { kind: "prediction-results" }
  >["results"],
): AuctionScreenBody => ({
  blocks: [
    {
      kind: "prediction-results",
      auctionId: CONTRACT_AUCTION_ID,
      results,
    },
  ],
  keyboard: [resultsBackRow],
});

const PREDICTION_RESULTS_CASES: readonly AuctionContractCase[] = [
  {
    intent: "root: finished auction offers prediction results",
    callbackData: rootCallback(CONTRACT_AUCTION_ID),
    auction: { ...AUCTION, summary: FINISHED_SUMMARY },
    auctionCalls: rootCalls(CONTRACT_AUCTION_ID),
    body: {
      blocks: [
        {
          kind: "root",
          auctionId: CONTRACT_AUCTION_ID,
          auction: FINISHED_SUMMARY,
        },
      ],
      keyboard: [
        rootLotsRow,
        rootPredictionsRow(CONTRACT_AUCTION_ID),
        [
          {
            action: "root.prediction-results",
            callbackData: resultsCallback(),
          },
        ],
      ],
    },
  },
  {
    intent: "prediction results: after the final",
    callbackData: resultsCallback(),
    auction: {
      ...AUCTION,
      summary: FINISHED_SUMMARY,
      predictionResults: { kind: "after-final" },
    },
    auctionCalls: [resultsReadCall()],
    body: resultsBody({ kind: "after-final" }),
  },
  {
    intent: "prediction results: counted",
    callbackData: resultsCallback(),
    auction: {
      ...AUCTION,
      summary: FINISHED_SUMMARY,
      predictionResults: {
        kind: "counted",
        nominations: [
          {
            nomination: "catalog-most-expensive-lot",
            value: {
              kind: "lots",
              lotIds: [CONTRACT_LOT.lotId, SOLD_LOT.lotId],
            },
            winnerNames: ["Сова*"],
            winnerCount: 1,
            mine: { kind: "guessed" },
          },
          {
            nomination: "catalog-total-sales",
            value: { kind: "number", value: 3_000_000 },
            winnerNames: [],
            winnerCount: 2,
            mine: { kind: "missed", deviation: 10_000 },
          },
        ],
      },
    },
    auctionCalls: [
      resultsReadCall(),
      findLotCall(CONTRACT_LOT.lotId),
      findLotCall(SOLD_LOT.lotId),
    ],
    body: resultsBody({
      kind: "counted",
      nominations: [
        {
          nomination: "catalog-most-expensive-lot",
          value: { kind: "lots", titles: ["Кружка с совой", "Плакат"] },
          winnerNames: ["Сова*"],
          winnerCount: 1,
          mine: { kind: "guessed" },
        },
        {
          nomination: "catalog-total-sales",
          value: { kind: "number", value: 3_000_000 },
          winnerNames: [],
          winnerCount: 2,
          mine: { kind: "missed", deviation: 10_000 },
        },
      ],
    }),
  },
  {
    intent: "prediction results: by hand",
    callbackData: resultsCallback(),
    auction: {
      ...AUCTION,
      summary: FINISHED_SUMMARY,
      predictionResults: { kind: "by-hand" },
    },
    auctionCalls: [resultsReadCall()],
    body: resultsBody({ kind: "by-hand" }),
  },
  {
    intent: "prediction results: cancelled",
    callbackData: resultsCallback(),
    auction: {
      ...AUCTION,
      summary: FINISHED_SUMMARY,
      predictionResults: { kind: "cancelled" },
    },
    auctionCalls: [resultsReadCall()],
    body: resultsBody({ kind: "cancelled" }),
  },
];

// Хроники дня (PER-725): вход в корне во время онлайн-недели — у контрактного
// аукциона она идёт — и номинации последних суток. Названия читаются только у
// выбранных лотов, каждое один раз; людей и служебных чисел пульта в теле нет.
const chronicleReadCall = (): PortCall => ({
  port: "auction",
  method: "getDayChronicle",
  request: { viewer: CONTRACT_VIEWER, auctionId: CONTRACT_AUCTION_ID },
});

const chronicleBody = (
  chronicle: Extract<
    AuctionScreenBody["blocks"][number],
    { kind: "day-chronicle" }
  >["chronicle"],
): AuctionScreenBody => ({
  blocks: [
    { kind: "day-chronicle", auctionId: CONTRACT_AUCTION_ID, chronicle },
  ],
  keyboard: [
    [
      {
        action: "day-chronicle.back",
        callbackData: callback({
          kind: "root",
          auctionId: CONTRACT_AUCTION_ID,
        }),
      },
    ],
  ],
});

const DAY_CHRONICLE_CASES: readonly AuctionContractCase[] = [
  {
    intent: "day chronicle: nominations of the last day",
    callbackData: chronicleCallback(),
    auction: {
      ...AUCTION,
      dayChronicle: {
        lots: [
          // Спорнее всех и дуэль: пять смен лидера, четыре подряд вдвоём, до
          // суток две ставки.
          {
            lotId: CONTRACT_LOT.lotId,
            bidCount: 4,
            leaderChanges: 5,
            longestDuel: 4,
            totalBidCount: 6,
            priceGrowth: { minorUnits: 15_000, currency: "RUB" },
          },
          // Тёмная лошадка: одна ставка до суток и наибольший рост от старта.
          {
            lotId: SOLD_LOT.lotId,
            bidCount: 2,
            leaderChanges: 1,
            longestDuel: 1,
            totalBidCount: 3,
            priceGrowth: { minorUnits: 50_000, currency: "RUB" },
          },
          // Без ставок за сутки лот не номинируется и не читается.
          {
            lotId: SCHEDULED_LOT.lotId,
            bidCount: 0,
            leaderChanges: 0,
            longestDuel: 0,
            totalBidCount: 0,
            priceGrowth: { minorUnits: 0, currency: "RUB" },
          },
        ],
      },
    },
    auctionCalls: [
      chronicleReadCall(),
      findLotCall(CONTRACT_LOT.lotId),
      findLotCall(SOLD_LOT.lotId),
    ],
    body: chronicleBody({
      kind: "nominated",
      contested: { title: "Кружка с совой", leaderChanges: 5 },
      darkHorse: {
        title: "Плакат",
        priceGrowth: { minorUnits: 50_000, currency: "RUB" },
        bidsBefore: 1,
      },
      duel: { title: "Кружка с совой", longestDuel: 4 },
    }),
  },
  {
    intent: "day chronicle: no bids in the last day",
    callbackData: chronicleCallback(),
    auction: {
      ...AUCTION,
      dayChronicle: {
        lots: [
          {
            lotId: CONTRACT_LOT.lotId,
            bidCount: 0,
            leaderChanges: 0,
            longestDuel: 0,
            totalBidCount: 6,
          },
        ],
      },
    },
    auctionCalls: [chronicleReadCall()],
    body: chronicleBody({ kind: "no-bids" }),
  },
  {
    intent: "day chronicle: no lots",
    callbackData: chronicleCallback(),
    auction: { ...AUCTION, dayChronicle: { lots: [] } },
    auctionCalls: [chronicleReadCall()],
    body: chronicleBody({ kind: "no-lots" }),
  },
  // Ставки были, а номинации не набрались: ни смены лидера, ни роста.
  {
    intent: "day chronicle: bids without a nominee",
    callbackData: chronicleCallback(),
    auction: {
      ...AUCTION,
      dayChronicle: {
        lots: [
          {
            lotId: CONTRACT_LOT.lotId,
            bidCount: 1,
            leaderChanges: 0,
            longestDuel: 0,
            totalBidCount: 9,
            priceGrowth: { minorUnits: 0, currency: "RUB" },
          },
        ],
      },
    },
    auctionCalls: [chronicleReadCall()],
    body: chronicleBody({ kind: "nominated" }),
  },
];

// Счета победителя (PER-322): «Мои счета» в корне, список с суммой и текстом
// организатора, счёт и выбор способа получения. Чужих счетов шпион не
// отдаёт, как Auction: в снимке только счета смотрящего.
const INVOICE_ID = "5b1f3c2e-8d4a-5e6f-9a0b-1c2d3e4f5a6b";
const FOREIGN_INVOICE_ID = "5b1f3c2e-8d4a-5e6f-9a0b-1c2d3e4f5a6c";

function invoicesCall(auctionId: string): PortCall {
  return {
    port: "auction",
    method: "listMyInvoices",
    request: { viewer: CONTRACT_VIEWER, auctionId },
  };
}

const SOLD_INVOICE = {
  invoiceId: INVOICE_ID,
  lotId: SOLD_LOT.lotId,
  amount: rub(3000),
  paymentDueAt: "2026-10-31T18:00:00Z",
  status: "awaiting-payment" as const,
};

const PAYMENT_TEXT = "Перевод на карту организатора до срока.";

const MY_INVOICES: MyInvoicesView = {
  invoices: [SOLD_INVOICE],
  paymentInstructions: PAYMENT_TEXT,
};

const invoicesCallback = encodeAuctionCallback({
  kind: "invoices",
  auctionId: CONTRACT_AUCTION_ID,
});

const invoiceCallback = (invoiceId: string) =>
  encodeAuctionCallback({ kind: "invoice", lotId: SOLD_LOT.lotId, invoiceId });

const fulfillmentCallback = (method: "pickup" | "delivery" | "digital") =>
  encodeAuctionCallback({
    kind: "fulfillment",
    lotId: SOLD_LOT.lotId,
    invoiceId: INVOICE_ID,
    method,
  });

const findSoldCall: PortCall = {
  port: "auction",
  method: "findLot",
  request: { viewer: CONTRACT_VIEWER, lotId: SOLD_LOT.lotId },
};

const choiceCall = (method: "pickup" | "delivery" | "digital"): PortCall => ({
  port: "auction",
  method: "chooseFulfillment",
  request: {
    viewer: CONTRACT_VIEWER,
    invoiceId: INVOICE_ID,
    method,
    opId: CONTRACT_OP_IDS[0],
  },
});

const fulfillmentRows = (["pickup", "delivery", "digital"] as const).map(
  (method) => [
    {
      action: "invoice.fulfillment" as const,
      method,
      callbackData: fulfillmentCallback(method),
    },
  ],
);

const toInvoicesRow = [
  { action: "invoice.back" as const, callbackData: invoicesCallback },
];

const INVOICE_CASES: readonly AuctionContractCase[] = [
  {
    intent: "root: with the invoices of the winner",
    callbackData: rootCallback(CONTRACT_AUCTION_ID),
    auction: { ...AUCTION, summary: CONTRACT_SUMMARY, invoices: MY_INVOICES },
    auctionCalls: rootCalls(CONTRACT_AUCTION_ID),
    body: {
      blocks: [
        {
          kind: "root",
          auctionId: CONTRACT_AUCTION_ID,
          auction: CONTRACT_SUMMARY,
        },
      ],
      keyboard: [
        rootLotsRow,
        rootPredictionsRow(CONTRACT_AUCTION_ID),
        rootChronicleRow,
        [{ action: "root.invoices", callbackData: invoicesCallback }],
      ],
    },
  },
  {
    intent: "my invoices: the invoices of the winner with the organizer's text",
    callbackData: invoicesCallback,
    auction: { ...AUCTION, invoices: MY_INVOICES },
    auctionCalls: [invoicesCall(CONTRACT_AUCTION_ID), findSoldCall],
    body: {
      blocks: [
        {
          kind: "invoices",
          auctionId: CONTRACT_AUCTION_ID,
          invoices: [{ ...SOLD_INVOICE, title: "Плакат" }],
          paymentInstructions: PAYMENT_TEXT,
        },
      ],
      keyboard: [
        [
          {
            action: "invoices.open",
            invoiceId: INVOICE_ID,
            callbackData: invoiceCallback(INVOICE_ID),
          },
        ],
        [
          {
            action: "invoices.back",
            callbackData: rootCallback(CONTRACT_AUCTION_ID),
          },
        ],
      ],
    },
  },
  {
    intent: "my invoice: an invoice with the choice of fulfillment",
    callbackData: invoiceCallback(INVOICE_ID),
    auction: { ...AUCTION, invoices: MY_INVOICES },
    auctionCalls: [findSoldCall, invoicesCall(CONTRACT_AUCTION_ID)],
    body: {
      blocks: [
        {
          kind: "invoice",
          auctionId: CONTRACT_AUCTION_ID,
          invoice: { ...SOLD_INVOICE, title: "Плакат" },
          paymentInstructions: PAYMENT_TEXT,
        },
      ],
      keyboard: [...fulfillmentRows, toInvoicesRow],
    },
  },
  {
    intent: "my invoice: an invoice of someone else is not found",
    callbackData: invoiceCallback(FOREIGN_INVOICE_ID),
    auction: { ...AUCTION, invoices: MY_INVOICES },
    auctionCalls: [findSoldCall, invoicesCall(CONTRACT_AUCTION_ID)],
    body: {
      blocks: [{ kind: "invoice-missing", auctionId: CONTRACT_AUCTION_ID }],
      keyboard: [toInvoicesRow],
    },
  },
  {
    intent: "fulfillment: the chosen method is shown on the invoice",
    callbackData: fulfillmentCallback("delivery"),
    auction: {
      ...AUCTION,
      invoices: MY_INVOICES,
      fulfillments: [{ kind: "accepted" }],
    },
    auctionCalls: [
      choiceCall("delivery"),
      findSoldCall,
      invoicesCall(CONTRACT_AUCTION_ID),
    ],
    body: {
      blocks: [
        {
          kind: "invoice",
          auctionId: CONTRACT_AUCTION_ID,
          invoice: {
            ...SOLD_INVOICE,
            fulfillment: "delivery",
            title: "Плакат",
          },
          paymentInstructions: PAYMENT_TEXT,
          notice: "fulfillment-chosen",
        },
      ],
      keyboard: [...fulfillmentRows, toInvoicesRow],
    },
  },
  {
    intent: "fulfillment: the chosen method shows while the read model lags",
    callbackData: fulfillmentCallback("digital"),
    auction: {
      ...AUCTION,
      invoices: MY_INVOICES,
      fulfillments: [{ kind: "accepted" }],
      lagging: true,
    },
    auctionCalls: [
      choiceCall("digital"),
      findSoldCall,
      invoicesCall(CONTRACT_AUCTION_ID),
    ],
    body: {
      blocks: [
        {
          kind: "invoice",
          auctionId: CONTRACT_AUCTION_ID,
          invoice: { ...SOLD_INVOICE, fulfillment: "digital", title: "Плакат" },
          paymentInstructions: PAYMENT_TEXT,
          notice: "fulfillment-chosen",
        },
      ],
      keyboard: [...fulfillmentRows, toInvoicesRow],
    },
  },
  {
    intent: "fulfillment: a handed over lot keeps its method",
    callbackData: fulfillmentCallback("pickup"),
    auction: {
      ...AUCTION,
      invoices: {
        invoices: [
          { ...SOLD_INVOICE, status: "handed-over", fulfillment: "digital" },
        ],
      },
      fulfillments: [{ kind: "refused", refusal: "fulfillment-frozen" }],
    },
    auctionCalls: [
      choiceCall("pickup"),
      findSoldCall,
      invoicesCall(CONTRACT_AUCTION_ID),
    ],
    body: {
      blocks: [
        {
          kind: "invoice",
          auctionId: CONTRACT_AUCTION_ID,
          invoice: {
            ...SOLD_INVOICE,
            status: "handed-over",
            fulfillment: "digital",
            title: "Плакат",
          },
          notice: "fulfillment-frozen",
        },
      ],
      keyboard: [toInvoicesRow],
    },
  },
];

export const AUCTION_CONTRACT_CASES: readonly AuctionContractCase[] = [
  ...SET_CASES,
  ...ROOT_CASES,
  ...PREDICTION_RESULTS_CASES,
  ...DAY_CHRONICLE_CASES,
  {
    intent: "feed",
    callbackData: feedCallback(CONTRACT_AUCTION_ID, 0),
    auction: AUCTION,
    auctionCalls: feedCalls(CONTRACT_AUCTION_ID, ["", "p2"]),
    body: FEED_BODY,
  },
  // Кнопка страницы, которой больше нет: лоты сняли, пока сообщение висело.
  {
    intent: "feed: stale page",
    callbackData: feedCallback(CONTRACT_AUCTION_ID, 7),
    auction: AUCTION,
    auctionCalls: feedCalls(CONTRACT_AUCTION_ID, ["", "p2"]),
    body: FEED_BODY,
  },
  {
    intent: "feed: empty",
    callbackData: feedCallback(EMPTY_AUCTION_ID, 0),
    auction: EMPTY_AUCTION,
    auctionCalls: feedCalls(EMPTY_AUCTION_ID, [""]),
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
      keyboard: [feedBackRow(EMPTY_AUCTION_ID)],
    },
  },
  // Разделы администратора (PER-719): кнопками над лотами, под ними общий
  // список — лот вне разделов, а за ним неупорядоченные в порядке создания.
  {
    intent: "feed: sections",
    callbackData: feedCallback(CONTRACT_AUCTION_ID, 0),
    auction: SECTIONED_AUCTION,
    auctionCalls: feedCalls(CONTRACT_AUCTION_ID, ["", "p2"]),
    body: {
      blocks: [
        {
          kind: "feed",
          auctionId: CONTRACT_AUCTION_ID,
          page: 0,
          pageCount: 1,
          lots: [WITHDRAWN_LOT, SOLD_LOT, UNSOLD_LOT].map(feedItemOfLot),
          sections: [{ sectionId: 2, name: "Книги", lotCount: 2 }],
        },
      ],
      keyboard: [
        [
          {
            action: "feed.open-section",
            sectionId: 2,
            callbackData: sectionCallback(CONTRACT_AUCTION_ID, 2),
          },
        ],
        ...[WITHDRAWN_LOT, SOLD_LOT, UNSOLD_LOT].map((lot) => [
          {
            action: "feed.open-lot" as const,
            lotId: lot.lotId,
            callbackData: lotCallback(lot.lotId, 0),
          },
        ]),
        feedBackRow(CONTRACT_AUCTION_ID),
      ],
    },
  },
  // Раздел — свои лоты в порядке администратора и возврат к разделам.
  {
    intent: "section",
    callbackData: sectionCallback(CONTRACT_AUCTION_ID, 2),
    auction: SECTIONED_AUCTION,
    auctionCalls: feedCalls(CONTRACT_AUCTION_ID, ["", "p2"]),
    body: {
      blocks: [
        {
          kind: "feed",
          auctionId: CONTRACT_AUCTION_ID,
          page: 0,
          pageCount: 1,
          lots: [SCHEDULED_LOT, CONTRACT_LOT].map(feedItemOfLot),
          section: { sectionId: 2, name: "Книги" },
        },
      ],
      keyboard: [
        ...[SCHEDULED_LOT, CONTRACT_LOT].map((lot) => [
          {
            action: "feed.open-lot" as const,
            lotId: lot.lotId,
            callbackData: lotCallback(lot.lotId, 0),
          },
        ]),
        [
          {
            action: "feed.back" as const,
            callbackData: feedCallback(CONTRACT_AUCTION_ID, 0),
          },
        ],
      ],
    },
  },
  // Ни один лот не торговался: сводка не о лидерстве, а о том, что торги не
  // начались (PER-618). Снятый лот торгов не доказывает.
  {
    intent: "feed: before trading",
    callbackData: feedCallback(PRE_TRADING_AUCTION_ID, 0),
    auction: PRE_TRADING_AUCTION,
    auctionCalls: feedCalls(PRE_TRADING_AUCTION_ID, [""]),
    body: {
      blocks: [
        {
          kind: "feed",
          auctionId: PRE_TRADING_AUCTION_ID,
          page: 0,
          pageCount: 1,
          lots: PRE_TRADING_ORDER.map((lot) => ({
            lotId: lot.lotId,
            ...(lot.card === undefined ? {} : { title: lot.card.title }),
            status: lot.status,
          })),
          beforeTrading: true,
        },
      ],
      keyboard: [
        ...PRE_TRADING_ORDER.map((lot) => [
          {
            action: "feed.open-lot" as const,
            lotId: lot.lotId,
            callbackData: lotCallback(lot.lotId, 0),
          },
        ]),
        feedBackRow(PRE_TRADING_AUCTION_ID),
      ],
    },
  },
  {
    intent: "lot: trading",
    callbackData: lotCallback(CONTRACT_LOT.lotId, 2),
    auction: AUCTION,
    auctionCalls: [
      getLotCall(CONTRACT_LOT.lotId),
      namesCall(LEADER_ID),
      ...CARD_CALLS,
    ],
    body: TRADING_LOT_BODY,
  },
  // Лидеру онлайна ставить против себя нечего: из рядов ставки остаётся
  // только лимит автоставки, как в финале — ни одной кнопки (прогон 13.10).
  {
    intent: "lot: trading, led by the viewer",
    callbackData: lotCallback(CONTRACT_LOT.lotId, 2),
    auction: LED_BY_VIEWER,
    auctionCalls: [
      getLotCall(CONTRACT_LOT.lotId),
      namesCall(CONTRACT_VIEWER.identityId),
      ...CARD_CALLS,
    ],
    body: {
      blocks: [
        {
          ...TRADING_LOT_BODY.blocks[0],
          status: LOT_LED_BY_VIEWER.status,
          participantName: "@me",
          standing: "leader",
        } as AuctionScreenBody["blocks"][number],
      ],
      keyboard: [
        [
          {
            action: "lot.proxy",
            callbackData: callback({
              kind: "ask",
              question: "proxy",
              lotId: CONTRACT_LOT.lotId,
              page: 2,
            }),
          },
        ],
        ...lotKeyboard(CONTRACT_LOT.lotId, 2),
      ],
    },
  },
  // «К лоту» после принятой команды, пока read model отстаёт (PER-470):
  // карточка просит лот не старее версии из кнопки и показывает новую цену, а
  // не прежнюю.
  {
    intent: "lot: after an accepted command while the read model lags",
    callbackData: lotCallback(CONTRACT_LOT.lotId, 2, 4),
    auction: { ...AUCTION, after: [LOT_CAUGHT_UP], lagging: true },
    auctionCalls: [
      getLotCall(CONTRACT_LOT.lotId, 4),
      namesCall(LEADER_ID),
      ...CARD_CALLS,
    ],
    body: {
      blocks: [
        {
          kind: "lot",
          lotId: CONTRACT_LOT.lotId,
          auctionId: CONTRACT_AUCTION_ID,
          version: 4,
          card: {
            title: "Кружка с совой",
            description: "Ручная роспись.",
            image: { version: "img-1" },
          },
          nextPrice: rub(1350),
          fixedStep: rub(50),
          status: LOT_CAUGHT_UP.status,
          participantName: "@owl",
        },
      ],
      keyboard: [
        ...bidRows(LOT_CAUGHT_UP, 2, 135000),
        ...lotKeyboard(CONTRACT_LOT.lotId, 2),
      ],
    },
  },
  // Read model не догнала за бюджет адаптера: карточка из последнего
  // прочитанного снимка, а не экран сбоя — команда уже принята.
  {
    intent:
      "lot: after an accepted command when the read model does not catch up",
    callbackData: lotCallback(CONTRACT_LOT.lotId, 2, 4),
    auction: { ...AUCTION, lagging: true },
    auctionCalls: [
      getLotCall(CONTRACT_LOT.lotId, 4),
      namesCall(LEADER_ID),
      ...CARD_CALLS,
    ],
    body: TRADING_LOT_BODY,
  },
  {
    intent: "lot: sold",
    callbackData: lotCallback(SOLD_LOT.lotId, 0),
    auction: AUCTION,
    auctionCalls: [
      getLotCall(SOLD_LOT.lotId),
      namesCall(WINNER_ID),
      ...CARD_CALLS,
    ],
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
    auctionCalls: [getLotCall(UNSOLD_LOT.lotId), ...CARD_CALLS],
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
    auctionCalls: [getLotCall(WITHDRAWN_LOT.lotId), ...CARD_CALLS],
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
    auctionCalls: [
      getLotCall(SOLD_LOT.lotId),
      namesCall(WINNER_ID),
      ...CARD_CALLS,
    ],
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
    auctionCalls: [getLotCall(SCHEDULED_LOT.lotId), ...CARD_CALLS],
    body: {
      blocks: [
        {
          kind: "lot",
          lotId: SCHEDULED_LOT.lotId,
          auctionId: CONTRACT_AUCTION_ID,
          version: 2,
          card: { title: "Носки", description: "" },
          fixedStep: rub(50),
          status: { kind: "scheduled", startingPrice: rub(500) },
        },
      ],
      keyboard: [
        ...pagerRows(
          FEED_ORDER,
          SCHEDULED_LOT.lotId,
          refreshRow(SCHEDULED_LOT.lotId, 0),
        ),
        backRow(0),
      ],
    },
  },
  // Шаг по порогам до торгов — те же пороги, что карточка покажет в торгах
  // (PER-618).
  {
    intent: "lot: scheduled, step by thresholds",
    callbackData: lotCallback(TIERED_SCHEDULED_LOT.lotId, 0),
    auction: PRE_TRADING_AUCTION,
    auctionCalls: [
      getLotCall(TIERED_SCHEDULED_LOT.lotId),
      ...feedCalls(PRE_TRADING_AUCTION_ID, [""]),
    ],
    body: {
      blocks: [
        {
          kind: "lot",
          lotId: TIERED_SCHEDULED_LOT.lotId,
          auctionId: PRE_TRADING_AUCTION_ID,
          version: 2,
          card: { title: "Свеча", description: "" },
          tiers: [
            { lowerBound: rub(0), step: rub(50) },
            { lowerBound: rub(5000), step: rub(250) },
          ],
          status: { kind: "scheduled", startingPrice: rub(700) },
        },
      ],
      keyboard: [
        ...pagerRows(
          PRE_TRADING_ORDER,
          TIERED_SCHEDULED_LOT.lotId,
          refreshRow(TIERED_SCHEDULED_LOT.lotId, 0),
        ),
        [
          {
            action: "lot.back",
            callbackData: feedCallback(PRE_TRADING_AUCTION_ID, 0),
          },
        ],
      ],
    },
  },
  // Отложенный в финал лот итога ещё не имеет: «Обновить» под ним стоит.
  {
    intent: "lot: held",
    callbackData: lotCallback(HELD_LOT.lotId, 0),
    auction: OFF_FEED_AUCTION,
    auctionCalls: [getLotCall(HELD_LOT.lotId), ...CARD_CALLS],
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
    auctionCalls: [getLotCall(DRAFT_LOT.lotId), ...CARD_CALLS],
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
          status: UNSOLD_LOT.status,
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
  ...FINAL_CASES,
  ...FAVORITE_CASES,
  ...NEIGHBOR_CASES,
  ...RAFFLE_CASES,
  ...PER595_CASES,
  ...PREDICTION_CASES,
  ...INVOICE_CASES,
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
  const follows = [...(snapshot.follows ?? [])];
  const registrations = [...(snapshot.registrations ?? [])];
  const cancellations = [...(snapshot.cancellations ?? [])];
  const predictionSubmissions = [...(snapshot.predictionSubmissions ?? [])];
  const predictionsRefusal =
    typeof snapshot.predictions === "string" ? snapshot.predictions : undefined;
  let predictionRounds: PredictionRoundView[] | undefined =
    snapshot.predictions === undefined ||
    typeof snapshot.predictions === "string"
      ? undefined
      : [...snapshot.predictions];
  const fulfillments = [...(snapshot.fulfillments ?? [])];
  let invoices = snapshot.invoices;
  const { followed, explainer } = snapshot;
  const followCommand = (outcome: FollowOutcome | undefined) => {
    if (outcome === undefined) throw new Error("follow is not expected");
    return outcome;
  };
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
        // Отставшая read model: новое видит только чтение с порогом версии.
        const caughtUp =
          snapshot.lagging === true
            ? request.atLeastVersion !== undefined
            : changed;
        const lots =
          caughtUp && snapshot.after !== undefined
            ? [...snapshot.after, ...snapshot.lots]
            : snapshot.lots;
        const lot = lots.find((each) => each.lotId === request.lotId);
        if (lot === undefined) throw new Error("lot is not in the snapshot");
        return lot;
      },
      // Лота нет в снимке — Auction его не знает: ответ, а не сбой.
      async findLot(request) {
        calls.push({ port: "auction", method: "findLot", request });
        return snapshot.lots.find((each) => each.lotId === request.lotId);
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
      async getOwnDisplayName(request) {
        calls.push({ port: "auction", method: "getOwnDisplayName", request });
        const { ownName } = snapshot;
        if (ownName === "unavailable") throw new Error("own name unavailable");
        if (ownName === "none") return undefined;
        return ownName ?? { text: "@contract", frozen: false };
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
      async getAuction(request) {
        calls.push({ port: "auction", method: "getAuction", request });
        if (snapshot.summary === "unavailable") {
          throw new Error("auction unavailable");
        }
        return snapshot.summary;
      },
      async getRaffle(request) {
        calls.push({ port: "auction", method: "getRaffle", request });
        if (snapshot.raffle === "unavailable") {
          throw new Error("raffle unavailable");
        }
        return snapshot.raffle;
      },
      async registerForRaffle(request) {
        calls.push({ port: "auction", method: "registerForRaffle", request });
        return settled(registrations.shift());
      },
      async cancelRaffleRegistration(request) {
        calls.push({
          port: "auction",
          method: "cancelRaffleRegistration",
          request,
        });
        return settled(cancellations.shift());
      },
      async getMyPredictions(request) {
        calls.push({ port: "auction", method: "getMyPredictions", request });
        if (predictionsRefusal === "forbidden") {
          throw new Error("predictions forbidden: PERMISSION_DENIED");
        }
        if (predictionsRefusal === "unavailable") {
          throw new Error("predictions unavailable");
        }
        if (predictionRounds === undefined) {
          throw new Error("predictions are not expected");
        }
        return predictionRounds;
      },
      async getPredictionResults(request) {
        calls.push({
          port: "auction",
          method: "getPredictionResults",
          request,
        });
        if (snapshot.predictionResults === undefined) {
          throw new Error("prediction results are not expected");
        }
        return snapshot.predictionResults;
      },
      async getDayChronicle(request) {
        calls.push({ port: "auction", method: "getDayChronicle", request });
        if (snapshot.dayChronicle === undefined) {
          throw new Error("the day chronicle is not expected");
        }
        return snapshot.dayChronicle;
      },
      async submitPrediction(request) {
        calls.push({ port: "auction", method: "submitPrediction", request });
        const outcome = settled(predictionSubmissions.shift());
        if (outcome.kind === "accepted") {
          if (predictionRounds === undefined) {
            throw new Error("prediction submission without a snapshot");
          }
          predictionRounds = predictionRounds.map((round) =>
            round.round === outcome.prediction.round
              ? { ...round, answers: outcome.prediction.answers }
              : round,
          );
        }
        return outcome;
      },
      async listMyInvoices(request) {
        calls.push({ port: "auction", method: "listMyInvoices", request });
        if (invoices === undefined || invoices === "unavailable") {
          throw new Error("invoices unavailable");
        }
        return invoices;
      },
      async chooseFulfillment(request) {
        calls.push({ port: "auction", method: "chooseFulfillment", request });
        const outcome = fulfillments.shift();
        if (outcome === undefined) throw new Error("choice is not expected");
        // Отставшая read model (`lagging`) принятого выбора ещё не видит.
        if (
          outcome.kind === "accepted" &&
          snapshot.lagging !== true &&
          invoices !== undefined &&
          invoices !== "unavailable"
        ) {
          invoices = {
            ...invoices,
            invoices: invoices.invoices.map((invoice) =>
              invoice.invoiceId === request.invoiceId
                ? { ...invoice, fulfillment: request.method }
                : invoice,
            ),
          };
        }
        return outcome;
      },
    },
    operations: {
      newOperationId() {
        const opId = opIds.shift();
        if (opId === undefined) throw new Error("no operation id left");
        return opId;
      },
    },
    ...(followed === undefined
      ? {}
      : {
          favorites: {
            async listFollowedLots(viewer) {
              calls.push({
                port: "favorites",
                method: "listFollowedLots",
                request: viewer,
              });
              if (followed === "unavailable") {
                throw new Error("favorites unavailable");
              }
              return followed;
            },
            async followLot(request) {
              calls.push({ port: "favorites", method: "followLot", request });
              return followCommand(follows.shift());
            },
            async unfollowLot(request) {
              calls.push({ port: "favorites", method: "unfollowLot", request });
              return followCommand(follows.shift());
            },
          },
        }),
    ...(explainer === undefined
      ? {}
      : {
          proxyExplainer: {
            async seen(viewer) {
              calls.push({
                port: "proxyExplainer",
                method: "seen",
                request: viewer,
              });
              if (explainer === "unavailable") {
                throw new Error("proxy explainer unavailable");
              }
              return explainer.seen;
            },
            async markSeen(viewer) {
              calls.push({
                port: "proxyExplainer",
                method: "markSeen",
                request: viewer,
              });
              if (explainer === "unavailable") {
                throw new Error("proxy explainer unavailable");
              }
            },
          },
        }),
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
  // Вызовы соседей, кроме Identity: Auction и Notifications в одном порядке.
  const auctionCalls = calls.filter((call) => call.port !== "identity");
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
