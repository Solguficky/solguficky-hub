// Публичная граница пакета. Сырые юзкейсы и диспетчер отсюда не уходят:
// приложение входит в аукцион только через `handleAuctionUpdate`, а `exports`
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
  handleAuctionUpdate,
} from "./gateway.js";
export type {
  AuctionBotPorts,
  AuctionPort,
  GlobalRole,
  IdentityPort,
  LotCardView,
  LotImage,
  LotImagePort,
  LotPage,
  LotStatusView,
  LotView,
  Money,
  ResolvedIdentity,
  TelegramUser,
  Viewer,
} from "./ports.js";
export type {
  AuctionBlock,
  AuctionButton,
  AuctionScreenBody,
  FeedItem,
} from "./screen.js";
