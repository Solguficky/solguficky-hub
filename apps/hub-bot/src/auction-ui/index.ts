// Публичная граница аукционного дерева. Сырые юзкейсы и диспетчер отсюда не
// уходят: поверхность входит в аукцион только через `handleAuctionUpdate`, вход
// на поверхность решает `decideEntry` (ADR-044, «Доступ как обязательный
// шлюз»). Других входов у дерева нет, кроме `contract/index.ts` для тестов:
// это держит boundary.test.ts.
//
// Исключение — `previewLot` (PER-512): тело карточки по снимку, который уже
// прочитал и проверил на право вызывающий. Команд он не шлёт и кнопок не
// ставит, поэтому шлюз ему не нужен. Второе — `liveLot` (PER-336): карточка
// финала по снимку из потока `WatchAuction` для правки сообщения вне update.
// Команд он тоже не шлёт; его кнопки возвращаются в дерево через шлюз.

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
  replacesAuctionQuestion,
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
export { liveLot, previewLot } from "./internal/use-cases/open-lot.js";
export type {
  AccessRequest,
  AccessRequestAnswer,
  AccessRequestOutcome,
  AccessRight,
  ApplicationQueue,
  AuctionBotPorts,
  AuctionPort,
  AuctionStageView,
  AuctionSummaryView,
  BidOriginView,
  BidRefusal,
  CommandOutcome,
  DisplayNameChoice,
  DisplayNameOutcome,
  DisplayNameRefusal,
  EntryPort,
  FavoritesPort,
  FinalLineupView,
  FollowOutcome,
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
  OwnDisplayName,
  ProxyExplainerPort,
  ProxyLimitRefusal,
  RaffleCancellationRefusal,
  RaffleOutcome,
  RaffleRegistrationRefusal,
  RaffleRevealView,
  RaffleStatusView,
  RaffleTicketView,
  RaffleView,
  ResolvedIdentity,
  StepTierView,
  StepWindowView,
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
  FinalBidOutcome,
  HistoryItem,
  LotStanding,
  ProxyExample,
} from "./screen.js";
