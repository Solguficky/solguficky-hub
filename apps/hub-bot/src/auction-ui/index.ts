export type {
  AchievementScreen,
  AchievementsPort,
} from "./achievement-types.js";
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
export type { DayNominations, DayNominee } from "./day-nominations.js";
export {
  biggestBy,
  darkHorseMaxBidsBefore,
  dayNominations,
  duelMinChanges,
} from "./day-nominations.js";
export { FinalBidReadUnavailable } from "./final-bid-failure.js";
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
  AntiSnipeView,
  ApplicationQueue,
  AuctionBotPorts,
  AuctionChronicleLot,
  AuctionChronicleView,
  AuctionPort,
  AuctionStageView,
  AuctionStepWindowView,
  AuctionSummaryView,
  BidOriginView,
  BidRefusal,
  CommandOutcome,
  DayChronicleLot,
  DayChronicleView,
  DisplayNameChoice,
  DisplayNameOutcome,
  DisplayNameRefusal,
  EntryPort,
  FavoritesPort,
  FinalLineupView,
  FollowOutcome,
  IdentityPort,
  InvoiceStatus,
  LotCardView,
  LotHistoryEntryView,
  LotHistoryPage,
  LotImage,
  LotImagePort,
  LotLayoutView,
  LotPage,
  LotPhotoView,
  LotSectionView,
  LotSetView,
  LotStatusView,
  LotView,
  Money,
  MyInvoicesView,
  OperationIdPort,
  OwnDisplayName,
  Prediction,
  PredictionAnswer,
  PredictionNominationResult,
  PredictionOutcome,
  PredictionOwnResult,
  PredictionRefusal,
  PredictionResultsView,
  PredictionRoundStatus,
  PredictionRoundView,
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
  WinnerInvoiceView,
} from "./ports.js";
export type {
  PredictionAnswerKind,
  PredictionNomination,
  PredictionNominationSpec,
  PredictionRound,
} from "./prediction-spec.js";
export {
  PREDICTION_NOMINATIONS,
  PREDICTION_ROUNDS,
  predictionNominationCode,
  predictionNominationFromCode,
  predictionNominationsFor,
  predictionRoundCode,
  predictionRoundFromCode,
  predictionSpec,
} from "./prediction-spec.js";
export type {
  AnswerRefusal,
  AuctionBlock,
  AuctionButton,
  AuctionScreenBody,
  BidExtension,
  CommandResult,
  FeedItem,
  FeedSectionItem,
  FinalBidOutcome,
  HistoryItem,
  InvoiceItem,
  LotStanding,
  ProxyExample,
} from "./screen.js";
