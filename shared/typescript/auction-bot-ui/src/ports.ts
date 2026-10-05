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

// Плоский набор активных ролей, как его отдаёт Identity: вложенность кругов он
// не разворачивает (ADR-043), и проверку круга делает шлюз.
export type GlobalRole = (typeof GLOBAL_ROLES)[number];

export type ResolvedIdentity = {
  // Канонический UUIDv7 в нижнем регистре с дефисами.
  identityId: string;
  globalRoles: readonly GlobalRole[];
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

// Круг, который поверхность запрашивает на `/start`: `admin` и `maintainer`
// через вход не просят (`identity.v1.RequestRoleRequest`).
export type SurfaceCircle = Extract<GlobalRole, "member" | "public">;

// Вход на `/start` (ADR-060, пункты 1–7 и 17–19).
export type RoleRequest = {
  user: TelegramUser;
  requestedRole: SurfaceCircle;
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
  identityId: string;
  globalRoles: readonly GlobalRole[];
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
    }
  | { kind: "held"; currentPrice: Money; leaderId?: string }
  | { kind: "sold"; winnerId: string; price: Money }
  | { kind: "unsold" }
  | { kind: "withdrawn" };

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
}

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
};
