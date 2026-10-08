// Публичная граница аукционного дерева. Сырые юзкейсы и диспетчер отсюда не
// уходят: поверхность входит в аукцион только через `handleAuctionUpdate`, вход
// на поверхность решает `decideEntry` (ADR-044, «Доступ как обязательный
// шлюз»). Других входов у дерева нет, кроме `contract/index.ts` для тестов:
// это держит boundary.test.ts.

export {
  AUCTION_CALLBACK_DOMAIN,
  AuctionCallbackError,
  type AuctionCallbackErrorReason,
  type AuctionCommand,
  type AuctionIntent,
  type AuctionQuestion,
  encodeAuctionCallback,
  isAuctionQuestion,
  MAX_COMMAND_AMOUNT,
  MAX_FEED_PAGE,
  type ParsedAuctionCallback,
  type PendingCommand,
  parseAuctionCallback,
} from "./callback-data.js";
export {
  type AuctionDenial,
  type AuctionResult,
  type AuctionSurface,
  type AuctionUpdate,
  admission,
  applicationQueue,
  decideEntry,
  handleAuctionUpdate,
  type SurfaceEntry,
} from "./gateway.js";
export type {
  AccessRight,
  ApplicationQueue,
  AuctionBotPorts,
  AuctionPort,
  BidOriginView,
  BidRefusal,
  CommandOutcome,
  DisplayNameChoice,
  DisplayNameOutcome,
  DisplayNameRefusal,
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
  OperationIdPort,
  ProxyLimitRefusal,
  ResolvedIdentity,
  RoleRequest,
  RoleRequestAnswer,
  RoleRequestOutcome,
  TelegramUser,
  TradingPhase,
  Viewer,
} from "./ports.js";
export type {
  AnswerRefusal,
  AuctionBlock,
  AuctionButton,
  AuctionScreenBody,
  CommandResult,
  FeedItem,
  HistoryItem,
} from "./screen.js";
