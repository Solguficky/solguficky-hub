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

// Смотрящий в запросах Auction. Отметки блокировки здесь нет, как и в
// `auction.v1.Viewer`: решение по ресурсу принимает Auction.
export type Viewer = {
  identityId: string;
  globalRoles: readonly GlobalRole[];
};

// Срез `auction.v1.LotSnapshot`, который нужен экранам. Поля добавляют листья,
// которые их показывают.
export type LotView = {
  lotId: string;
  auctionId: string;
  version: number;
};

export interface AuctionPort {
  getLot(request: { viewer: Viewer; lotId: string }): Promise<LotView>;
}

export type AuctionBotPorts = {
  identity: IdentityPort;
  auction: AuctionPort;
};
