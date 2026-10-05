// Публичная граница пакета. Сырые юзкейсы и диспетчер отсюда не уходят:
// приложение входит в аукцион только через `handleAuctionUpdate`, вход на
// поверхность решает `decideEntry`, а `exports`
// в package.json не открывает других путей (ADR-044, «Доступ как обязательный
// шлюз»). Граница проверяется test/boundary.typecheck.ts.

export {
  AUCTION_CALLBACK_DOMAIN,
  AuctionCallbackError,
  type AuctionCallbackErrorReason,
  type AuctionIntent,
  encodeAuctionCallback,
  MAX_FEED_PAGE,
  type ParsedAuctionCallback,
  parseAuctionCallback,
} from "./callback-data.js";
export {
  type AuctionDenial,
  type AuctionResult,
  type AuctionSurface,
  type AuctionUpdate,
  decideEntry,
  handleAuctionUpdate,
  requestedRole,
  type SurfaceEntry,
} from "./gateway.js";
export type {
  AuctionBotPorts,
  AuctionPort,
  BidOriginView,
  EntryPort,
  GlobalRole,
  IdentityPort,
  LotCardView,
  LotHistoryEntryView,
  LotHistoryPage,
  LotImage,
  LotImagePort,
  LotPage,
  LotStatusView,
  LotView,
  Money,
  ResolvedIdentity,
  RoleRequest,
  RoleRequestAnswer,
  RoleRequestOutcome,
  SurfaceCircle,
  TelegramUser,
  Viewer,
} from "./ports.js";
export type {
  AuctionBlock,
  AuctionButton,
  AuctionScreenBody,
  FeedItem,
  HistoryItem,
} from "./screen.js";
