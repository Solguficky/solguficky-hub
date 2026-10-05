// Публичная граница пакета. Сырые юзкейсы и диспетчер отсюда не уходят:
// приложение входит в аукцион только через `handleAuctionUpdate`, вход на
// поверхность решает `decideEntry`, а `exports`
// в package.json не открывает других путей (ADR-044, «Доступ как обязательный
// шлюз»). Граница проверяется test/boundary.typecheck.ts.

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
  decideEntry,
  handleAuctionUpdate,
  requestedRole,
  type SurfaceEntry,
} from "./gateway.js";
export type {
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
  SurfaceCircle,
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
