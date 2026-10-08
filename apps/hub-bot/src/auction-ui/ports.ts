// Порты, через которые пакет ходит в Identity и Auction. Реализаций здесь нет:
// клиентов gRPC держит приложение и переводит в эти типы сгенерированные
// сообщения. Пакет поэтому не зависит ни от `@bufbuild/protobuf`, ни от
// сгенерированного кода, а contract suite подставляет вместо клиентов шпионов.

export const GLOBAL_ROLES = [
  "admin",
  "maintainer",
  "member",
  "public",
] as const;

// Роли Identity в словаре пакета. Пакет их не читает: они едут транзитом в
// `auction.v1.Viewer`, где Auction решает по ним о своём ресурсе, пока все
// вызывающие не пришлют права.
export type GlobalRole = (typeof GLOBAL_ROLES)[number];

export const ACCESS_RIGHTS = [
  "hub",
  "auction",
  "manage-membership",
  "moderate-auction",
] as const;

// Права, которые Identity вывел из круга и выданных записей (ADR-064, пункты
// 6–7). Поверхность пускает по праву и никогда по роли; незнакомое право
// адаптер отбрасывает, и оно ничего не даёт.
export type AccessRight = (typeof ACCESS_RIGHTS)[number];

// Решение о допуске читает только `rights`: роли лежат в `viewer`, который
// уходит в Auction как есть.
export type ResolvedIdentity = {
  viewer: Viewer;
  rights: readonly AccessRight[];
  // Отметка блокировки. Допуск она не решает — только выбирает текст отказа.
  blocked: boolean;
};

export type TelegramUser = {
  telegramUserId: number;
  telegramUsername?: string;
};

export interface IdentityPort {
  resolveIdentity(user: TelegramUser): Promise<ResolvedIdentity>;
}

// Очередь, в которую поверхность ставит заявку на `/start`: хаб — в очередь
// сообщества, бот аукциона — в очередь аукциона (`identity.v1.ApplicationQueue`).
export type ApplicationQueue = "community" | "auction";

// Вход на `/start` (ADR-060, пункты 1–7 и 17–19; ADR-064, пункт 8).
export type RoleRequest = {
  user: TelegramUser;
  queue: ApplicationQueue;
  // Код канала из payload `s_<код>` без префикса, как пришёл: известен ли
  // канал, решает Identity. Нет — payload префикса не нёс; пустая строка —
  // пустой код после `s_`.
  sourceCode?: string;
  // `first_name` того же update — для карточки модератора.
  firstName: string;
};

export const ROLE_REQUEST_OUTCOMES = [
  "already-held",
  "granted-by-allowlist",
  "pending",
  "declined",
  "blocked",
  // Значение, которого край не знает. По контракту читается как отказ.
  "unspecified",
] as const;

// `identity.v1.RoleRequestOutcome` в словаре пакета.
export type RoleRequestOutcome = (typeof ROLE_REQUEST_OUTCOMES)[number];

// Отметки блокировки в ответе входа нет: её несёт исход `blocked`.
export type RoleRequestAnswer = {
  viewer: Viewer;
  rights: readonly AccessRight[];
  outcome: RoleRequestOutcome;
};

// Порт входа отдельный от `IdentityPort`: шлюзу нажатия он не нужен, а вход
// зовёт приложение — один раз на `/start`, вместо разрешения личности.
export interface EntryPort {
  requestRole(request: RoleRequest): Promise<RoleRequestAnswer>;
}

// Смотрящий в запросах Auction. Отметки блокировки здесь нет, как и в
// `auction.v1.Viewer`: решение по ресурсу принимает Auction.
export type Viewer = {
  identityId: string;
  globalRoles: readonly GlobalRole[];
};

// Сумма в минимальных единицах валюты — копейках для RUB. `number`, а не
// `bigint`: суммы аукциона далеко внутри безопасного целого, а снимок ходит
// через `JSON.stringify` в contract suite. Адаптер проверяет `int64` провода.
export type Money = {
  minorUnits: number;
  currency: string;
};

// Каталожная карточка лота (ADR-057). Изображение — только его версия: байты
// грузит приложение через `LotImagePort`, когда показывает карточку.
export type LotCardView = {
  title: string;
  // Пустая строка — описания нет.
  description: string;
  image?: { version: string };
};

// Где лот, — ветка `status` снимка. Причины снятия и непродажи экраны не
// показывают, поэтому их здесь нет.
export type LotStatusView =
  | { kind: "draft" }
  | { kind: "scheduled"; startingPrice: Money }
  | {
      kind: "trading";
      currentPrice: Money;
      leaderId?: string;
      // Момент RFC 3339 в UTC. Нет — лот ведёт человек, а не время.
      deadline?: string;
      // Онлайн-торги принимают любую сумму от порога, живой финал — ровно
      // следующую цену. Ставку из бота пакет предлагает только онлайн.
      phase: TradingPhase;
    }
  | { kind: "held"; currentPrice: Money; leaderId?: string }
  | { kind: "sold"; winnerId: string; price: Money }
  | { kind: "unsold" }
  | { kind: "withdrawn" };

export type TradingPhase = "online" | "live";

// Срез `auction.v1.LotSnapshot`, который нужен экранам. Поля добавляют листья,
// которые их показывают.
export type LotView = {
  lotId: string;
  auctionId: string;
  version: number;
  // Нет — у лота нет строки каталога; это не то же, что пустое описание.
  card?: LotCardView;
  // Порог ставки сейчас; есть только у лота в торгах.
  nextPrice?: Money;
  // Шаг, когда он один на все цены. Сетку шагов край не вычисляет: правило
  // шага принадлежит Auction, а `nextPrice` уже несёт его результат.
  fixedStep?: Money;
  // Принимает ли лот прокси-лимиты. У лота без условий торгов — нет.
  proxyEnabled: boolean;
  // Свой лимит смотрящего. Чужих лимитов Auction не отдаёт вовсе.
  viewerProxyLimit?: Money;
  status: LotStatusView;
};

// Одна страница `ListAuctionLots`. Пустой `nextPageToken` — лента кончилась.
export type LotPage = {
  lots: readonly LotView[];
  nextPageToken: string;
};

// Как поставлена ставка. Канал есть только у ручной: прокси-ставку ставит
// система в пределах лимита, а сам лимит в хронологию не попадает.
export type BidOriginView =
  | { kind: "manual"; source: "bot" | "floor" }
  | { kind: "proxy" };

// Запись хронологии лота — публичный факт его журнала. Сегодня это только
// ставка: серия автоставок уже свёрнута Auction в одну запись с итоговой
// ценой. Запись вида, которого пакет не знает, адаптер пропускает.
export type LotHistoryEntryView = {
  kind: "bid";
  // Позиция факта в журнале лота: монотонна, но не непрерывна.
  sequence: number;
  // Момент RFC 3339 в UTC.
  occurredAt: string;
  bidId: string;
  participantId: string;
  amount: Money;
  origin: BidOriginView;
};

// Одна страница `ListLotHistory` по возрастанию `sequence`. Пустой
// `nextPageToken` — хронология кончилась.
export type LotHistoryPage = {
  entries: readonly LotHistoryEntryView[];
  nextPageToken: string;
};

export interface AuctionPort {
  getLot(request: { viewer: Viewer; lotId: string }): Promise<LotView>;
  listAuctionLots(request: {
    viewer: Viewer;
    auctionId: string;
    pageToken: string;
  }): Promise<LotPage>;
  listLotHistory(request: {
    viewer: Viewer;
    lotId: string;
    pageToken: string;
  }): Promise<LotHistoryPage>;
  // Готовые к показу имена по идентификаторам участников (ADR-059): метки
  // ставит Auction, край их не добавляет.
  getDisplayNames(request: {
    viewer: Viewer;
    auctionId: string;
    participantIds: readonly string[];
  }): Promise<Readonly<Record<string, string>>>;
  placeBid(request: {
    viewer: Viewer;
    lotId: string;
    amount: Money;
    opId: string;
  }): Promise<CommandOutcome<BidRefusal>>;
  setProxyLimit(request: {
    viewer: Viewer;
    lotId: string;
    max: Money;
    opId: string;
  }): Promise<CommandOutcome<ProxyLimitRefusal>>;
  chooseDisplayName(request: {
    viewer: Viewer;
    auctionId: string;
    choice: DisplayNameChoice;
  }): Promise<DisplayNameOutcome>;
}

// Источник `op_id`: канонический UUIDv7 в нижнем регистре с дефисами. Портом,
// а не вызовом внутри пакета, чтобы contract suite видел ключ команды.
export interface OperationIdPort {
  newOperationId(): string;
}

// Именованные отказы команд участника (integration.md, «Auction gRPC»). Отказ
// окончателен: повторять команду после него край не вправе (RFC-011, П-06),
// поэтому он несёт цену, которую экран называет человеку.
export type BidRefusal =
  | { kind: "lot-not-open" }
  | { kind: "lot-on-hold"; currentPrice: Money }
  | { kind: "bid-below-minimum"; minRequired: Money }
  | { kind: "bid-not-at-next-price"; expected: Money }
  | { kind: "bidder-is-leader"; currentPrice: Money }
  | { kind: "currency-mismatch" }
  | { kind: "display-name-not-chosen" };

export type ProxyLimitRefusal =
  | { kind: "lot-not-open" }
  | { kind: "proxy-below-current-price"; minLimit: Money }
  | { kind: "proxy-disabled" }
  | { kind: "currency-mismatch" }
  | { kind: "display-name-not-chosen" };

// Исход команды с `op_id`. `unanswered` — ответа не было вовсе: дедлайн вызова
// истёк или связь оборвалась. Только его пакет повторяет, и тем же `op_id`:
// принятую команду Auction узнаёт по нему и второй раз не исполняет. Прочие
// сбои транспорта порт бросает.
export type CommandOutcome<Refusal> =
  | { kind: "accepted" }
  | { kind: "refused"; refusal: Refusal }
  | { kind: "unanswered" };

// Как участник показан в аукционе (ADR-059): ник из update без «@» — пустая
// строка значит, что ника нет, — или псевдоним, как его ввели.
export type DisplayNameChoice =
  | { kind: "username"; username: string }
  | { kind: "alias"; alias: string };

export type DisplayNameRefusal =
  | "username-missing"
  | "alias-invalid"
  | "alias-taken"
  | "name-frozen";

export type DisplayNameOutcome =
  | { kind: "accepted"; name: string }
  | { kind: "refused"; refusal: DisplayNameRefusal };

export type LotImage = {
  content: Uint8Array;
  mediaType: string;
  // Версия этих байтов; может быть новее версии из прочитанной карточки.
  version: string;
};

// Байты изображения лота. Пакет этот порт не зовёт: загрузка файла и кэш
// `file_id` — дело Telegram-края приложения (ADR-057, дополнение), а тип здесь,
// чтобы оба бота реализовали одну сигнатуру.
export interface LotImagePort {
  getLotImage(request: { viewer: Viewer; lotId: string }): Promise<LotImage>;
}

export type AuctionBotPorts = {
  identity: IdentityPort;
  auction: AuctionPort;
  operations: OperationIdPort;
};
