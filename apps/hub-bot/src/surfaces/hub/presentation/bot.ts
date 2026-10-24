import { Code, ConnectError } from "@connectrpc/connect";
import {
  type Bot,
  GrammyError,
  HttpError,
  InlineKeyboard,
  InputFile,
} from "grammy";
import { defaultFaq, type FaqContent } from "../../../auction-faq.js";
import {
  type ApplicationQueue,
  type AuctionBlock,
  type AuctionPort,
  type AuctionResult,
  type AuctionScreenBody,
  type AuctionUpdate,
  encodeAuctionCallback,
  type FavoritesPort,
  isAuctionQuestion,
  type LotImagePort,
  type ProxyExplainerPort,
  parseAuctionCallback,
  previewLot,
  replacesAuctionQuestion,
  type Viewer,
} from "../../../auction-ui/index.js";
import {
  createLiveCards,
  type LiveCardEntry,
  type LiveCards,
  type LiveEditOutcome,
  liveCardOf,
  liveEditFailure,
} from "../../../core/auction/live-cards.js";
import {
  reportLiveConsoleFailure,
  reportLiveEditFailure,
} from "../../../core/auction/live-failures.js";
import type { AuctionWatches } from "../../../core/auction/watch.js";
import type { EditLimiter } from "../../../core/bot/edit-limiter.js";
import { createBotShell, type ShellContext } from "../../../core/bot/shell.js";
import { markUpdateFailed } from "../../../core/bot/tracing.js";
import {
  defaultTelegramEnvironment,
  type TelegramEnvironment,
} from "../../../core/config.js";
import {
  applyLabel,
  createHintedAlbums,
  strayHintText,
  supportBotLink,
  supportLabel,
  withSourceCode,
} from "../../../core/entry.js";
import { countFailure, type FailureCategory } from "../../../core/failures.js";
import type { LogFields, Logger } from "../../../core/logging.js";
import { createChatCommandsSync } from "../../../core/menu-commands.js";
import {
  type AuctionNotificationChange,
  auctionNotificationsToast,
} from "../../../core/notifications/outbid.js";
import type { RpcMetadata } from "../../../core/rpc-metadata.js";
import type { Tracing } from "../../../core/tracing.js";
import { createUuidV7, uuidV7Of } from "../../../core/uuid-v7.js";
import { acceptsLots } from "../application/auction-console.js";
import {
  broadcastBodyLimit,
  checkBroadcastBody,
} from "../application/broadcasts.js";
import type { Dispatcher } from "../application/dispatcher.js";
import {
  decideHubAccess,
  type HubAccess,
  hubAccessErrors,
  hubAccessText,
  hubWelcome,
} from "../application/hub-access.js";
import { isSold, lotCurrency } from "../application/lot-form.js";
import {
  type CommunityToday,
  formatLocalMoment,
  formatSchedule,
  utcToday,
} from "../application/meetup-form.js";
import type {
  AuctionWeek,
  BroadcastAudience,
  ConsoleSort,
  ExecuteRequest,
  ExecuteResult,
  FinalAskError,
  FinalTimeAskError,
  FormField,
  LotAmount,
  LotAskError,
  LotFormView,
  LotQuestion,
  LotTierView,
  MeetupAuctionView,
  MeetupAuthor,
  MeetupStateAction,
  PaymentTextAskError,
  Person,
  PublishMomentRetry,
  RaffleAskError,
  RafflePrizeAskError,
  TradingHolder,
  WeekAskError,
  WindowAskError,
} from "../application/types.js";
import { type AuctionScreens, viewerOf } from "../auction/port.js";
import { type CommunityDay, isBeforeDay } from "../community-time.js";
import { cursorAtApplication } from "../identity/application-cursor.js";
import {
  type AccessRequester,
  type Administrator,
  type AdministratorManager,
  type ApplicationAdministrator,
  type ApplicationCursor,
  type ApplicationModerator,
  type ApplicationQueueRead,
  type CommunityAdministrator,
  type CommunityMemberResult,
  type CommunitySnapshot,
  type GrantRecordResult,
  type IdentityAdminResult,
  type IdentityResolver,
  type OrganizerResolver,
  type ParticipantUsernameResolver,
  type ReconsiderResult,
  type RecordRight,
  type RefusedApplication,
  type RightRecordAdministrator,
  type SourceChannel,
  type SourceChannelAdministrator,
  type TelegramRecipientResolver,
  toResolveIdentityInput,
} from "../identity/port.js";
import type {
  MeetupMaterialSource,
  MeetupSchedule,
  MeetupSnapshot,
  MeetupSummary,
} from "../meetups/port.js";
import type {
  CategoryState,
  MeetupCategory,
  NotificationCategory,
} from "../notifications/port.js";
import {
  type AuctionParents,
  createAuctionParents,
} from "./auction-parents.js";
import {
  hubTradeCallback,
  isAuctionCallback,
  packageIdentity,
  photoFileId,
} from "./auction-route.js";
import { parseBroadcastPreview } from "./broadcast-input.js";
import { decideHubEntry, hubAccessRequest } from "./hub-entry.js";
import {
  createLiveConsoles,
  type LiveConsoleEntry,
  type LiveConsoleRead,
  type LiveConsoles,
} from "./live-console.js";
import {
  createLiveFloors,
  type LiveFloorEntry,
  type LiveFloors,
} from "./live-floor.js";
import type { LiveScreenRead } from "./live-screens.js";
import { parseLotPhoto } from "./lot-photo-input.js";
import { createLotPhotos, type LotPhotos } from "./lot-photos.js";
import {
  isTypedText,
  type PendingMaterialSource as MaterialInputSource,
  materialConfirmationHtml,
  parseMaterialConfirmation,
  parseMaterialInput,
} from "./material-input.js";
import { withMeetupAuthor } from "./meetup-author.js";
import {
  meetupStartLink,
  tokenToUuid,
  uuidToToken,
} from "./meetup-deep-link.js";
import { newLotId, newLotIdOf, newLotKey } from "./new-lot-id.js";
import { telegramTextLimit } from "./notification-message.js";
import {
  applyData,
  auctionFaqData,
  type CallbackAction,
  type CardCursor,
  type CommunityPlace,
  consoleAskData,
  consoleFinalTimeData,
  consoleInvoiceMarkData,
  consoleInvoicesData,
  consolePaymentTextData,
  consoleRaffleData,
  consoleRafflePrizeData,
  consoleSetAskData,
  consoleSetsData,
  consoleViewData,
  consoleWeekData,
  consoleWindowAskData,
  consoleWindowLaunchData,
  consoleWindowsData,
  defaultConsoleSort,
  floorData,
  floorPickData,
  floorSearchData,
  lotAskData,
  lotCopyData,
  lotFormData,
  lotImageRemoveData,
  lotNewData,
  lotSkipData,
  lotStepModeData,
  type NewMeetupOrigin,
  type NotifiedMeetupCategory,
  type PublishOrigin,
  parseCallback,
  type QuestionStep,
  questionData,
  removalPickData,
  traceCallback,
  type WhenMode,
} from "./parse-callback.js";
import { parseUpdate, type SectionCommand } from "./parse-update.js";
import { RepliedKeyboardSchema } from "./schemas.js";
import {
  administratorOutcomeScreen,
  administratorsScreen,
  appointConfirmScreen,
  appointOutcome,
  appointPrompt,
  appointRetryScreen,
  appointUsername,
  dismissConfirmScreen,
  dismissOutcome,
  toAdministrators,
} from "./screens/administrators.js";
import {
  admittedNote,
  applicationCardScreen,
  applicationQueueEndScreen,
  decisionToast,
  declineConfirmScreen,
} from "./screens/application.js";
import {
  type AuctionView,
  auctionScreen,
  lotPhotoId,
} from "./screens/auction.js";
import {
  auctionDiscardedText,
  type ConsoleScreenView,
  cancelConfirmScreen,
  closeConfirmScreen,
  closedScreen,
  consoleMeetupCancelledText,
  consoleMissingText,
  consoleScreen,
  discardConfirmScreen,
  finalAskErrorText,
  finalAskText,
  finalTimeAskErrorText,
  finalTimeQuestionText,
  finalToast,
  launchQuestionText,
  launchScreen,
  lineupConfirmScreen,
  lineupOrderScreen,
  raffleAskErrorText,
  rafflePrizeAskErrorText,
  rafflePrizeQuestionText,
  raffleQuestionText,
  weekAskError,
  weekConfirmScreen,
  weekQuestionText,
  windowAskErrorText,
  windowLotToast,
  windowQuestionText,
  windowScreen,
  windowsScreen,
} from "./screens/auction-console.js";
import { daySummaryScreen } from "./screens/auction-day-summary.js";
import { auctionFaqScreen } from "./screens/auction-faq.js";
import {
  invoiceMarkConfirmScreen,
  invoiceMarkOutcomeScreen,
  invoiceMissingScreen,
  invoiceScreen,
  invoicesLabel,
  invoicesScreen,
  paymentTextAskErrorText,
  paymentTextPrompt,
} from "./screens/auction-invoices.js";
import type { ScreenId } from "./screens/catalog.js";
import {
  type CommunityView,
  closeAccessConfirmScreen,
  communityMemberRefusalKeyboard,
  communityMemberRefusalText,
  communityMemberScreen,
  communityScreen,
  demoteMemberConfirmScreen,
  firstCommunityPlace,
} from "./screens/community.js";
import {
  eventsScreen,
  type HubEvent,
  isAuctionEvent,
} from "./screens/events.js";
import {
  auctionEnabledScreen,
  extensionsScreen,
  settingsAuctionScreen,
  settingsExtensionsScreen,
} from "./screens/extensions.js";
import {
  type FloorScreenView,
  floorConfirmScreen,
  floorLeaderToast,
  floorScreen,
  floorSearchQuestionText,
  floorTitle,
} from "./screens/floor-bids.js";
import {
  type AuctionEntry,
  auctionEntryOf,
  cancelLabel,
  confirmKeyboard,
  escapeHtml,
  exitToMeetups,
  heading,
  outcomeText,
  type Parent,
  plural,
  readableMoment,
  refusalText,
  retryLabel,
  screenText,
  toCard,
  toCommunity,
  toEvents,
  toExtensions,
  toManage,
  toMaterials,
  toMeetups,
  toMenu,
  toSourceChannels,
  withNav,
} from "./screens/kit.js";
import {
  lotAskErrorText,
  lotChainLead,
  lotCopiesScreen,
  lotFormScreen,
  lotImageRemoveConfirmScreen,
  lotQuestionText,
  lotRefusalText,
  lotRemoveConfirmScreen,
  lotRemovedScreen,
  lotSavedNote,
  lotSavedScreen,
  lotScopeScreen,
  lotSetAppliedScreen,
  lotStepModeScreen,
  removePhotoLabel,
  skipPhotoLabel,
  toLot,
  toLots,
} from "./screens/lot-form.js";
import {
  lotSetAskErrorText,
  lotSetDeleteConfirmScreen,
  lotSetLotToast,
  lotSetPrompt,
  lotSetScreen,
  lotSetsScreen,
} from "./screens/lot-sets.js";
import {
  archiveScreen,
  cardScreen,
  draftScreen,
  editFieldsScreen,
  hiddenScreen,
  materialsScreen,
  materialTitle,
  meetupNotificationsLabel,
  meetupsScreen,
  meetupTitleLabel,
  publishConfirmScreen,
  stateConfirmScreen,
  statusScreen,
} from "./screens/meetup.js";
import {
  type ApplicationCounts,
  canAdmitBidders,
  canGrantAdmins,
  canManageMeetups,
  canManageMembers,
  canOpenManagement,
  canRunAuctions,
  commandsFor,
  helpScreen,
  manageGroupScreen,
  manageGroups,
  manageItemParent,
  manageScreen,
  menuScreen,
  settingsScreen,
} from "./screens/menu.js";
import {
  accessRequestCategories,
  auctionNotificationsChangeData,
  auctionNotificationsData,
  auctionNotificationsScreen,
  categoryLabels,
  globalNotificationsScreen,
  meetupNotificationsScreen,
  toggleToast,
} from "./screens/notifications.js";
import {
  removalConfirmScreen,
  removalOutcomeScreen,
  removalPeopleScreen,
} from "./screens/participant-removal.js";
import { reconsiderConfirmScreen, refusedScreen } from "./screens/refused.js";
import {
  releaseEmptyScreen,
  releasePostData,
  releasePostScreen,
} from "./screens/release-notes.js";
import {
  datePresetsScreen,
  scheduleTypePrompt,
} from "./screens/schedule-presets.js";
import {
  clearCallbackKeyboard,
  ScreenDeliveryError,
  type ScreenPhoto,
  type ShownScreen,
  screenMark,
  showScreen,
} from "./screens/show.js";
import {
  sourceChannelPage,
  sourceChannelsScreen,
} from "./screens/source-channels.js";
import { isSourceChannelCode } from "./source-deep-link.js";
import {
  createTelegramFiles,
  type FileDownload,
  type TelegramFiles,
} from "./telegram-files.js";
import { startWaiting, type Waiting } from "./waiting.js";

// Среда Telegram: `test` уводит вызовы Bot API на выделенную тестовую
// инфраструктуру (ADR-046). Значения совпадают с опцией grammY, чтобы между
// переменной окружения и клиентом не появилось второго словаря.

export type BotRuntime = {
  token: string;
  dispatcher: Dispatcher;
  identity: IdentityResolver &
    AccessRequester &
    Partial<CommunityAdministrator> &
    Partial<ApplicationAdministrator> &
    Partial<SourceChannelAdministrator> &
    Partial<ApplicationModerator> &
    Partial<RightRecordAdministrator> &
    Partial<AdministratorManager> &
    Partial<OrganizerResolver> &
    Partial<ParticipantUsernameResolver> &
    Partial<TelegramRecipientResolver>;
  logger: Logger;
  tracing: Tracing;
  presentation?: "rich" | "plain";
  environment?: TelegramEnvironment;
  // Имя бота аукциона без «@»: экран каналов собирает по нему вторую ссылку
  // `s_<код>`. Нет — экран отдаёт только ссылку в бот хаба.
  auctionBotUsername?: string;
  // Имя бота поддержки без «@»: «Помощь» и кадр ожидания допуска несут
  // ссылку «Написать в поддержку ↗» (PER-625). Нет — ни ряда, ни кнопки.
  supportBotUsername?: string;
  // Сегодняшний день сообщества: по нему экран решает, в каком списке стоит
  // сходка, и называет год у даты. Тот же источник, что у формы.
  today?: CommunityToday;
  // Экраны аукциона сходки (PER-307): порты аукционного дерева поверх клиента
  // Auction. Нет — кнопки домена `auc` отвечают кадром недоступности.
  auction?: AuctionScreens;
  // Избранные лоты у Notifications (PER-495): порт дерева на каждый update.
  // Нет — карточка лота без кнопки избранного, а лента без «Избранного».
  favorites?: (meta?: RpcMetadata) => FavoritesPort;
  // Отметка «пояснение автоставки видено» у Notifications (PER-517). Нет —
  // вопрос лимита объясняет автоставку каждый раз.
  proxyExplainer?: (meta?: RpcMetadata) => ProxyExplainerPort;
  // Пояс, в котором человек читает дедлайн лота; тот же, что у Meetups.
  communityTimeZone?: string;
  faq?: FaqContent;
  // Память процесса: тесты подставляют свою, чтобы проверить рестарт.
  auctionParents?: AuctionParents;
  lotPhotos?: LotPhotos;
  // Скачивание присланного файла по пути из `getFile` (PER-452). Нет — бот
  // ходит в Telegram сам, по токену и среде выше.
  files?: TelegramFiles;
  // Карточки финала (PER-336): поток аукциона, темп правок и имена для правки
  // вне update. Нет — карточка финала правится только нажатием.
  live?: {
    watches: AuctionWatches;
    limiter: EditLimiter;
    names: Pick<AuctionPort, "getDisplayNames">;
  };
};

const unavailableText = `Не получилось загрузить данные. Это на моей стороне.

Попробуй ещё раз через минуту.`;
// FAILED_PRECONDITION не говорит, что именно мешает: сходку отменили, пока
// экран висел, или у черновика нет названия для публикации. Кадр не утверждает
// ни то, ни другое, а ведёт к карточке, где видно текущее состояние (E-04).
const staleMeetupText =
  "Сейчас это действие недоступно. Открой сходку заново и проверь её состояние и название.";
// Публикация сразу без названия: Meetups отказывает, и подтверждать нечего.
const untitledPublishText =
  "У сходки нет названия, а без него сходку не опубликовать. Добавь название через «Изменить» на карточке.";
// Отложенная публикация черновика без названия (PER-457): Meetups отказывает,
// потому что опубликовать сходку без названия нельзя и по расписанию.
const untitledPublicationText =
  "У сходки нет названия, а без него публикацию не назначить. Добавь название через «Изменить» на карточке.";

// Отказ Meetups по самой команде человеку показывается кадром, а не текстом
// сервиса: код gRPC и текст уходят в запись границы (PER-397). FAILED_PRECONDITION —
// состояние сходки не допускает действия (E-04); INVALID_ARGUMENT на кнопке —
// неверную команду собрал бот, и это сбой на нашей стороне (E-05).
function invalidMeetupText(result: { precondition?: true }): string {
  return result.precondition === true ? staleMeetupText : unavailableText;
}
const formPrompts: Record<FormField, string> = {
  title: "Как называется сходка?",
  schedule: scheduleTypePrompt,
  venue: "Где встречаемся?",
  description: "Добавь короткое описание сходки.",
};

// Отказ по конфликту версий закреплён решением PER-78 и повторяется здесь
// дословно: человеку нужно увидеть, что его ввод не сохранён, а не догадываться
// об этом по общему тексту сбоя.
const conflictText =
  "Сходка уже изменилась. Твои изменения не сохранены. Проверь актуальные данные и повтори.";
const materialForbiddenText = "Это действие доступно организатору сходки.";
// Отказ сервиса по праву человек видит без имени сервиса: ему не нужно знать,
// кто из них решал (PER-396). Смысл кадра прежний — действие не разрешено.
const forbiddenText = "Это действие тебе недоступно.";
// Отменённая сходка аукциона не получает (ADR-047, дополнение 2026-10-12).
const auctionMeetupCancelledText =
  "Сходку отменили. Аукцион у неё не включить.";
// Категорию запросов доступа сервис показывает и даёт менять только
// модератору очереди. Нажатие из старого уведомления или экрана настроек после
// потери права получает `PERMISSION_DENIED`, и ответ называет причину, а не
// одно «недоступно».
const accessRequestsForbiddenText =
  "Запросы доступа настраивает только тот, кто решает заявки этой очереди.";
const managementForbiddenText = "Управление сходками доступно администратору.";
const communityForbiddenText =
  "Управлять составом сообщества может только администратор.";
const refusedForbiddenText =
  "Пересматривать отказы может только администратор.";
const auctionQueueForbiddenText = "Заявки в аукцион решает модератор аукциона.";
// Тексты записей прав с карточки человека (PER-547, PER-654).
const recordTexts: Readonly<
  Record<RecordRight, { granted: string; revoked: string; forbidden: string }>
> = {
  "admit-bidders": {
    granted: "Модерация выдана.",
    revoked: "Модерация отозвана.",
    forbidden: "Выдавать модерацию аукциона может тот, кто управляет составом.",
  },
  "run-auctions": {
    granted: "Ведение аукциона выдано.",
    revoked: "Ведение аукциона снято.",
    forbidden: "Выдавать ведение аукциона может тот, кто управляет составом.",
  },
};
const administratorsForbiddenText =
  "Назначать и снимать администраторов может только мейнтейнер.";
const channelSavedListFailedText =
  "Канал заведён, но список не загрузился. Открой каналы ещё раз через минуту.";
const sourceChannelsForbiddenText =
  "Вести каналы прихода может только администратор.";
const channelCodePrompt =
  "Какой код у канала? Латиница, цифры, «_» и «-», до 62 символов, например tg_ads: он станет хвостом ссылки после s_.";
const channelCodeRetryPrompt =
  "Такой код в ссылку не встанет. Пришли код ещё раз: латиница, цифры, «_» и «-», до 62 символов.";
const channelLabelPrompt =
  "Как подписать канал? Подпись модератор увидит на карточке заявки.";
const channelLabelRetryPrompt =
  "Подпись — одна строка до 64 символов. Пришли её ещё раз.";
const channelSaveRetryPrompt =
  "Канал не сохранился. Это на моей стороне. Пришли подпись ещё раз через минуту.";
// Ответ второму администратору, чей пересмотр опередили (ADR-060, пункт 14).
const reconsideredText = "Уже пересмотрено.";
const applicationsForbiddenText =
  "Разбирать заявки может только администратор.";
type ProductUseCase =
  | "create_meetup"
  | "update_meetup"
  | "find_meetup"
  | "view_meetup"
  | "manage_community"
  | "manage_notifications"
  | "send_broadcast"
  | "view_auction"
  | "enable_auction"
  | "manage_lot"
  | "manage_auction"
  | "view_release_notes";
// Сбой Auction на ответе формы лота: вопрос остаётся открытым, и тот же ответ
// можно прислать ещё раз.
const lotSaveRetryText =
  "Не получилось сохранить. Это на моей стороне. Пришли ответ ещё раз через минуту.";
const questionTtlMs = 60 * 60 * 1_000;
const questionLimit = 1_000;
const publishMomentPrompt =
  "Когда опубликовать сходку? Напиши дату и время по времени сообщества: ДД.ММ.ГГГГ ЧЧ:ММ";
// Прошедший момент — отдельный отказ со своим текстом, а не «не разобрал
// дату»: ввод понят, но время уже наступило (E-02, открытый вопрос раскадровки).
// Причина отказа моменту публикации: заголовок экрана исхода у ответа текстом
// и строка над экраном выбора даты, где дату жмут кнопкой.
const publishMomentRetryLead: Record<PublishMomentRetry, string> = {
  unparsed: "Не получилось разобрать дату.",
  past: "Это время уже прошло или его нельзя назначить по времени сообщества.",
  conflict: conflictText,
};
const textNeededHint = "Нужен ответ текстом.";

// Одна таблица «кнопка → действие» для шага вопроса и шага подтверждения:
// новое действие смены состояния добавляется строкой, а не двумя цепочками.
const stateActionByCallback: Record<
  Extract<
    CallbackAction["kind"],
    `manage-${"" | "confirm-"}${"unpublish" | "cancel" | "hold" | "unschedule"}`
  >,
  MeetupStateAction
> = {
  "manage-unpublish": "unpublish",
  "manage-confirm-unpublish": "unpublish",
  "manage-cancel": "cancel",
  "manage-confirm-cancel": "cancel",
  "manage-hold": "hold",
  "manage-confirm-hold": "hold",
  "manage-unschedule": "unschedule",
  "manage-confirm-unschedule": "unschedule",
};

type PendingQuestion = {
  kind: "meetup";
  mode: "create" | "edit";
  field: FormField;
  meetupId: string;
  // Вопрос о названии новой сходки и откуда он задан (`fn`, `fg`).
  fresh?: NewMeetupOrigin;
  telegramUserId: number;
  expiresAt: number;
};
type PendingUsername = {
  kind: "allowed-username";
  telegramUserId: number;
  expiresAt: number;
};
// Ник назначаемого администратора (PER-521): шаг целиком в кнопке вопроса.
type PendingAdministrator = {
  kind: "administrator-username";
  telegramUserId: number;
  expiresAt: number;
};
// `version` — версия карточки, с которой начато прикрепление: она доезжает до
// кнопки подтверждения и уходит в `expected_version` (PER-393).
type PendingMaterialInput = {
  kind: "material-source";
  meetupId: string;
  version: number;
  telegramUserId: number;
  expiresAt: number;
};
type PendingMaterialTitle = {
  kind: "material-title";
  meetupId: string;
  version: number;
  source: MaterialInputSource;
  telegramUserId: number;
  expiresAt: number;
};
type PendingPublishMoment = {
  kind: "publish-moment";
  meetupId: string;
  // Экран, с которого вопрос задан: туда возвращает «Отмена».
  origin: PublishOrigin;
  telegramUserId: number;
  expiresAt: number;
};
// Текст рассылки ждёт ответа на вопрос, как название материала. Дальше он
// живёт уже не здесь, а в сообщении предпросмотра: запись снимается, как только
// кадр подтверждения отправлен.
type PendingBroadcastBody = {
  kind: "broadcast-body";
  audience: BroadcastAudience;
  // Только для текста кадра подтверждения: сходку читают при вопросе, и её
  // название здесь — подпись, а не факт, по которому что-то решается.
  meetupTitle?: string;
  telegramUserId: number;
  expiresAt: number;
};
// Канал заводится двумя вопросами: код, затем подпись. Код ждёт подписи в
// памяти процесса — в кнопку «Отмена» он не помещается.
type PendingChannelCode = {
  kind: "channel-code";
  telegramUserId: number;
  expiresAt: number;
};
type PendingChannelLabel = {
  kind: "channel-label";
  code: string;
  telegramUserId: number;
  expiresAt: number;
};
// Вопрос формы лота (PER-319). Шаг целиком лежит в кнопке вопроса, поэтому
// запись в карте — только ускорение: ответ после рестарта принимается так же.
type PendingLot = {
  kind: "lot";
  question: LotQuestion;
  telegramUserId: number;
  expiresAt: number;
};
// Вопрос листа ставки (PER-317): шаг и адресат лежат в его «Отмене» и
// разбираются аукционным деревом. Запись в карте нужна только уборке брошенного
// вопроса — ответ принимается и после рестарта.
type PendingAuction = {
  kind: "auction";
  telegramUserId: number;
  expiresAt: number;
};
// Вопрос о сроках недели на пульте аукциона (PER-320). Шаг — аукцион — лежит
// в кнопке вопроса, и ответ после рестарта принимается так же.
type PendingConsoleWeek = {
  kind: "console-week";
  auctionId: string;
  telegramUserId: number;
  expiresAt: number;
};
// Вопрос о моменте розыгрыша на пульте (PER-593). Шаг — аукцион — лежит в
// кнопке вопроса, и ответ после рестарта принимается так же.
type PendingConsoleRaffle = {
  kind: "console-raffle";
  auctionId: string;
  telegramUserId: number;
  expiresAt: number;
};
// Вопрос о призе розыгрыша на пульте (PER-649). Шаг — аукцион — лежит в кнопке
// вопроса, и ответ после рестарта принимается так же.
type PendingConsolePrize = {
  kind: "console-raffle-prize";
  auctionId: string;
  telegramUserId: number;
  expiresAt: number;
};
// Вопрос об ориентировочном времени финала на пульте (PER-663). Шаг — аукцион —
// лежит в кнопке вопроса, и ответ после рестарта принимается так же.
type PendingConsoleFinalTime = {
  kind: "console-final-time";
  auctionId: string;
  telegramUserId: number;
  expiresAt: number;
};
// Вопрос о тексте «Как оплатить и получить» на «Счетах» (PER-322). Шаг —
// аукцион — лежит в кнопке вопроса, и ответ после рестарта принимается так же.
type PendingConsolePaymentText = {
  kind: "console-payment-text";
  auctionId: string;
  telegramUserId: number;
  expiresAt: number;
};
// Вопрос о новом окне «Счастливых часов» (PER-504). Шаг — аукцион — лежит в
// кнопке вопроса, и ответ после рестарта принимается так же.
type PendingConsoleWindow = {
  kind: "console-window";
  auctionId: string;
  telegramUserId: number;
  expiresAt: number;
};
// Вопрос о запуске окна по ходу торгов (PER-615). Шаг — аукцион — лежит в
// кнопке вопроса, и ответ после рестарта принимается так же.
type PendingConsoleLaunch = {
  kind: "console-launch";
  auctionId: string;
  telegramUserId: number;
  expiresAt: number;
};
// Вопрос о названии нового сета лотов (PER-509). Шаг — аукцион — лежит в
// кнопке вопроса, и ответ после рестарта принимается так же.
type PendingConsoleSet = {
  kind: "console-set";
  auctionId: string;
  telegramUserId: number;
  expiresAt: number;
};
// Вопрос о следующей цене лота финала (PER-337). Шаг — аукцион и номер лота в
// составе — лежит в кнопке вопроса, и ответ после рестарта принимается так же.
type PendingFinalAsk = {
  kind: "final-ask";
  auctionId: string;
  position: number;
  telegramUserId: number;
  expiresAt: number;
};
// Вопрос «Другой человек…» «Ставок зала» (PER-565). Шаг — аукцион — лежит в
// кнопке вопроса, и ответ после рестарта принимается так же.
type PendingFloorSearch = {
  kind: "floor-search";
  auctionId: string;
  telegramUserId: number;
  expiresAt: number;
};
type PendingInput = HubPendingInput | PendingAuction;
type HubPendingInput =
  | PendingQuestion
  | PendingPublishMoment
  | PendingUsername
  | PendingAdministrator
  | PendingChannelCode
  | PendingChannelLabel
  | PendingMaterialInput
  | PendingMaterialTitle
  | PendingBroadcastBody
  | PendingLot
  | PendingConsoleWeek
  | PendingConsoleRaffle
  | PendingConsolePrize
  | PendingConsoleFinalTime
  | PendingConsolePaymentText
  | PendingConsoleWindow
  | PendingConsoleLaunch
  | PendingConsoleSet
  | PendingFinalAsk
  | PendingFloorSearch;

// Вопрос пульта: вид ожидания — намерение и строка журнала о чужом ответе.
// Обе классификации по одному виду, и таблица держит их рядом: новая ветка
// не должна расходиться с прежней (PER-663).
const consoleQuestionIntents = {
  "console-week": {
    intent: "schedule-auction-week",
    foreign: "foreign auction week answer ignored",
  },
  "console-raffle": {
    intent: "set-auction-raffle",
    foreign: "foreign auction raffle answer ignored",
  },
  "console-raffle-prize": {
    intent: "set-auction-raffle-prize",
    foreign: "foreign raffle prize answer ignored",
  },
  "console-final-time": {
    intent: "set-auction-final-time",
    foreign: "foreign final time answer ignored",
  },
  "console-payment-text": {
    intent: "set-auction-payment-text",
    foreign: "foreign payment text answer ignored",
  },
  "console-window": {
    intent: "add-step-window",
    foreign: "foreign step window answer ignored",
  },
  "console-launch": {
    intent: "add-step-window-launch",
    foreign: "foreign step window launch answer ignored",
  },
  "console-set": {
    intent: "add-lot-set",
    foreign: "foreign lot set answer ignored",
  },
} as const;

type ConsoleQuestionPending = Extract<
  PendingInput,
  { kind: keyof typeof consoleQuestionIntents }
>;

function isConsoleQuestion(
  pending: PendingInput,
): pending is ConsoleQuestionPending {
  return pending.kind in consoleQuestionIntents;
}

type UpdateContext = ShellContext & {
  // Ожидание этого update: ответ на нажатие, индикатор и бюджет сервисов.
  waiting?: Waiting;
  // Кнопка стояла под следом: экран приходит новым сообщением.
  fresh?: boolean;
  // Сообщение нажатой кнопки удалено: править и снимать у него нечего.
  pressedGone?: boolean;
  // Сегодняшний день сообщества для этого update.
  today?: CommunityToday;
  // Пояс сообщества: в нём карточка сходки называет срок торгов аукциона.
  communityTimeZone?: string;
  // Telegram отверг карточку с постерами, и она ушла без них: причина едет в
  // запись границы, иначе деградация оператору не видна.
  postersRejected?: string;
  // Сходки аукционов, которые бот видел: родитель ленты лотов.
  auctionParents?: AuctionParents;
  // Личность, разрешённая на этом update: по её правам после ответа
  // сверяется список команд чата (PER-592).
  commandsPerson?: Person;
  // Открытые карточки финала (PER-336) и отметка, что этот update показал
  // карточку заново: без неё нажатие под карточкой её из реестра снимает.
  liveCards?: LiveCards;
  liveShown?: boolean;
  // Открытые пульты ведущего (PER-566) и отметка, что этот update показал
  // пульт финала: без неё нажатие под пультом его из реестра снимает.
  liveConsoles?: LiveConsoles;
  liveConsoleShown?: boolean;
  // То же у «Ставок зала» помощника (PER-565).
  liveFloors?: LiveFloors;
  liveFloorShown?: boolean;
};

type BoundaryOutcome =
  | {
      level: "info";
      message: string;
      result: "ok";
      use_case?: ProductUseCase;
      meetup_id?: string;
      identity_id?: string;
    }
  | {
      level: "warn" | "error";
      message: string;
      result: "error";
      use_case?: ProductUseCase;
      meetup_id?: string;
      identity_id?: string;
      error_category: FailureCategory;
      error: string;
      stack?: string;
      grpc_code?: string;
      reply_error?: string;
    };

export function createBot(options: BotRuntime): Bot<UpdateContext> {
  const runtime: BotRuntime = {
    ...options,
    dispatcher: withMeetupAuthor(options.dispatcher, options.identity),
  };
  const bot = createBotShell<UpdateContext>({
    token: runtime.token,
    environment: runtime.environment ?? defaultTelegramEnvironment,
    tracing: runtime.tracing,
  });
  const questions = new Map<string, PendingInput>();
  const auctionParents = runtime.auctionParents ?? createAuctionParents();
  const lotPhotos = runtime.lotPhotos ?? createLotPhotos();
  const files =
    runtime.files ??
    createTelegramFiles({
      token: runtime.token,
      environment: runtime.environment ?? defaultTelegramEnvironment,
    });
  const albums = createSeenAlbums();
  const hintedAlbums = createHintedAlbums();
  const syncCommands = createChatCommandsSync(runtime.logger);
  const liveCards =
    runtime.live === undefined
      ? undefined
      : createLiveCards({
          ...runtime.live,
          edit: (card, body) =>
            editLiveLotCard(bot.api, { card, body, runtime, lotPhotos }),
        });
  const liveConsoles =
    runtime.live === undefined
      ? undefined
      : createLiveConsoles({
          watches: runtime.live.watches,
          limiter: runtime.live.limiter,
          read: (entry) => readLiveConsole(runtime, entry),
          edit: (entry, screen) =>
            editLiveConsole(bot.api, runtime, entry, screen),
        });
  const liveFloors =
    runtime.live === undefined
      ? undefined
      : createLiveFloors({
          watches: runtime.live.watches,
          limiter: runtime.live.limiter,
          read: (entry) => readLiveFloor(runtime, entry),
          edit: (entry, screen) =>
            editLiveConsole(bot.api, runtime, entry, screen),
        });
  bot.use(async (ctx, next) => {
    ctx.today = runtime.today ?? utcToday;
    ctx.communityTimeZone = runtime.communityTimeZone ?? "UTC";
    ctx.auctionParents = auctionParents;
    if (liveCards !== undefined) ctx.liveCards = liveCards;
    if (liveConsoles !== undefined) ctx.liveConsoles = liveConsoles;
    if (liveFloors !== undefined) ctx.liveFloors = liveFloors;
    await next();
    // Нажатие под карточкой финала показало другой экран — меню, сходку,
    // вопрос: правка по потоку вернула бы карточку поверх него (PER-336).
    const pressed = ctx.callbackQuery?.message;
    if (liveCards !== undefined && pressed !== undefined && !ctx.liveShown) {
      liveCards.shown(pressed.chat.id, pressed.message_id, undefined);
    }
    // То же у пульта ведущего (PER-566): исход команды или другой экран в
    // сообщении пульта снимает его с правки по потоку.
    if (
      liveConsoles !== undefined &&
      pressed !== undefined &&
      !ctx.liveConsoleShown
    ) {
      liveConsoles.shown(pressed.chat.id, pressed.message_id, undefined);
    }
    // И у «Ставок зала» (PER-565).
    if (
      liveFloors !== undefined &&
      pressed !== undefined &&
      !ctx.liveFloorShown
    ) {
      liveFloors.shown(pressed.chat.id, pressed.message_id, undefined);
    }
    // Команды кнопки меню клиента — по правам, на каждом действии, где
    // личность разрешена, а не только на `/start` (PER-592): держателю права
    // управления — свой список чата с `/manage`, у снятого он снимается.
    // Запись идёт после ответа и его не задерживает; отказ Telegram пишется в
    // лог, а вызов уходит, только когда список расходится с тем, что процесс
    // уже записал.
    const person = ctx.commandsPerson;
    const chatId = ctx.chat?.id;
    if (person === undefined || chatId === undefined) return;
    await syncCommands(
      ctx.api,
      chatId,
      canOpenManagement(person) ? commandsFor(person) : undefined,
    );
  });
  bot.on("callback_query:data", (ctx) =>
    handleCallback(ctx, runtime, questions, lotPhotos),
  );
  bot.on("message", (ctx) =>
    handleMessage(
      ctx,
      runtime,
      questions,
      { files, albums },
      lotPhotos,
      hintedAlbums,
    ),
  );
  bot.catch((botError) => {
    writeBoundary(
      runtime.logger,
      botError.ctx,
      unexpectedOutcome(botError.error, botError),
    );
  });
  return bot;
}

async function handleMessage(
  ctx: UpdateContext,
  runtime: BotRuntime,
  questions: Map<string, PendingInput>,
  photos: { files: TelegramFiles; albums: SeenAlbums },
  lotPhotos: LotPhotos,
  hintedAlbums: ReturnType<typeof createHintedAlbums>,
): Promise<void> {
  let outcome: BoundaryOutcome | undefined;
  let useCase: ProductUseCase | undefined;
  const waiting = startWaiting(ctx);
  ctx.waiting = waiting;
  try {
    const parsed = parseUpdate(ctx.update, ctx.me.username);
    // Команда, выбранная, пока клиент держит режим ответа на вопрос,
    // приходит ответом на него. Это команда, а не значение поля: разбор ответа
    // её не видит. Человек ушёл от вопроса, и брошенный вопрос удаляется:
    // иначе клиент держал бы режим ответа на него и дальше.
    const command = parsed.kind === "start" || parsed.kind === "command";
    const replyId = command
      ? undefined
      : ctx.message?.reply_to_message?.message_id;
    // Сначала удаление: вычищенный по сроку вопрос карта уже не назовёт, и
    // его сообщение осталось бы держать режим ответа.
    if (command) await dropOpenQuestions(ctx, questions);
    removeExpiredQuestions(questions, Date.now());
    // Остальные снимки альбома, которому вопрос о фото лота уже отказал: отказ
    // ушёл на первый снимок, а вопрос задан заново.
    const album = ctx.message?.media_group_id;
    if (album !== undefined && photos.albums.seen(album)) {
      outcome = {
        level: "info",
        message: "lot photo album message ignored",
        result: "ok",
        use_case: "manage_lot",
      };
      return;
    }
    // Ответ принят либо отвергнут окончательно: вопрос больше не ждёт, и его
    // «Отмена» снимается. После сбоя сервиса вопрос остаётся открытым — тот же
    // ответ можно прислать ещё раз.
    const answered = async (result?: ExecuteResult): Promise<void> => {
      if (
        replyId === undefined ||
        (result !== undefined && retryable(result))
      ) {
        return;
      }
      questions.delete(questionKey(ctx.chat?.id, replyId));
      await closeQuestion(ctx, replyId);
    };
    const storedPending =
      replyId === undefined
        ? undefined
        : questions.get(questionKey(ctx.chat?.id, replyId));
    const repliedMessage = ctx.message?.reply_to_message;
    // Ответ на вопрос листа ставки: шаг — `auc`, его разбирает аукционное дерево.
    const auctionStep =
      replyId === undefined || repliedMessage?.from?.id !== ctx.me.id
        ? undefined
        : auctionQuestionOf(repliedMessage);
    if (replyId !== undefined && auctionStep !== undefined) {
      useCase = "view_auction";
      outcome = await handleAuctionCallback(
        ctx,
        runtime,
        auctionStep,
        lotPhotos,
        {
          questions,
          answer: {
            replyId,
            ...(ctx.message?.text === undefined
              ? {}
              : { text: ctx.message.text }),
          },
        },
      );
      return;
    }
    // Шаг вопроса и тот, кому он задан, лежат в его кнопке «Отмена» и
    // возвращаются с ответом: так вопрос переживает рестарт и после него
    // принимает ответ только от спрашиваемого. Вопрос прошлого релиза — без id
    // в кнопке или с маркером в тексте — устарел (PER-461).
    const recovered =
      storedPending === undefined && repliedMessage?.from?.id === ctx.me.id
        ? questionStepOf(repliedMessage)
        : undefined;
    const askedStep = recovered?.step;
    const pending: PendingInput | undefined =
      storedPending ??
      (recovered?.askedBy === undefined
        ? undefined
        : pendingOf(recovered.step, recovered.askedBy));
    if (
      replyId !== undefined &&
      pending?.kind === "publish-moment" &&
      ctx.message?.text !== undefined
    ) {
      useCase = "update_meetup";
      if (ctx.from?.id !== pending.telegramUserId) {
        outcome = {
          level: "info",
          message: "foreign publish moment answer ignored",
          result: "ok",
          use_case: useCase,
        };
        return;
      }
      const identity = await resolvePerson(ctx, runtime, useCase);
      if (identity.kind === "failed") {
        outcome = identity.outcome;
        return;
      }
      const denied = await denyHubAccessIfNeeded(
        ctx,
        runtime,
        identity,
        useCase,
        false,
      );
      if (denied !== undefined) {
        outcome = denied;
        return;
      }
      const result = await runtime.dispatcher.execute({
        identity: identity.person,
        intent: "schedule-publication",
        value: ctx.message.text,
        meetupId: pending.meetupId,
        ...rpcCall(ctx, useCase),
      });
      // Старый вопрос закрывается после того, как ушёл ответ на него: упавшая
      // отправка нового вопроса не теряет шаг.
      await renderFormResult(
        ctx,
        result,
        questions,
        runtime.presentation ?? "rich",
        pending.origin,
      );
      await answered(result);
      outcome = screenBoundary(result, {
        ok: [
          "ask-publish-moment",
          "publication-scheduled",
          "publication-unavailable",
        ],
        okMessage: "publish moment answer handled",
        rejectedMessage: "publish moment answer rejected",
        useCase,
        meetupId: pending.meetupId,
      });
      return;
    }
    if (
      replyId !== undefined &&
      (pending?.kind === "material-source" ||
        pending?.kind === "material-title")
    ) {
      useCase = "update_meetup";
      if (ctx.from?.id !== pending.telegramUserId) {
        outcome = {
          level: "info",
          message: "foreign material answer ignored",
          result: "ok",
          use_case: useCase,
        };
        return;
      }
      const identity = await resolvePerson(ctx, runtime, useCase);
      if (identity.kind === "failed") {
        outcome = identity.outcome;
        return;
      }
      const denied = await denyHubAccessIfNeeded(
        ctx,
        runtime,
        identity,
        useCase,
        false,
      );
      if (denied !== undefined) {
        outcome = denied;
        return;
      }
      if (!canManageMeetups(identity.person)) {
        await answered();
        await showRefusal(ctx, materialForbiddenText, exitToMeetups());
        outcome = materialForbiddenOutcome(identity.person, pending.meetupId);
        return;
      }
      if (pending.kind === "material-source") {
        const source = parseMaterialInput(ctx.message);
        if (source === undefined) {
          await refuseAnswer(
            ctx,
            questions,
            pending,
            isTypedText(ctx.message)
              ? "Текст сам по себе не материал: перешли сообщение из канала или чата, фото или документ."
              : "На это сообщение нельзя дать ссылку. Источник скрыт или пересылка из него запрещена: нужно пересланное сообщение с доступным источником, фотография или документ.",
            replyId,
          );
          outcome = {
            level: "info",
            message: "material source rejected",
            result: "ok",
            use_case: useCase,
            meetup_id: pending.meetupId,
            identity_id: identity.person.identityId,
          };
          return;
        }
        await askQuestion(
          ctx,
          questions,
          {
            kind: "material-title",
            meetupId: pending.meetupId,
            version: pending.version,
            source,
            telegramUserId: pending.telegramUserId,
          },
          "Как назвать материал в карточке? Напиши короткое название.",
          replyId,
        );
        outcome = {
          level: "info",
          message: "material title requested",
          result: "ok",
          use_case: useCase,
          meetup_id: pending.meetupId,
          identity_id: identity.person.identityId,
        };
        return;
      }
      const title = ctx.message?.text?.trim();
      if (title === undefined || title === "" || title.length > 200) {
        await refuseAnswer(
          ctx,
          questions,
          pending,
          "Название должно быть текстом от 1 до 200 символов.",
          replyId,
        );
        outcome = {
          level: "info",
          message: "material title rejected",
          result: "ok",
          use_case: useCase,
          meetup_id: pending.meetupId,
          identity_id: identity.person.identityId,
        };
        return;
      }
      await answered();
      await sendMaterialConfirmation(
        ctx,
        pending.meetupId,
        pending.version,
        title,
        pending.source,
      );
      outcome = {
        level: "info",
        message: "material confirmation sent",
        result: "ok",
        use_case: useCase,
        meetup_id: pending.meetupId,
        identity_id: identity.person.identityId,
      };
      return;
    }
    if (replyId !== undefined && pending?.kind === "broadcast-body") {
      useCase = "send_broadcast";
      const audience = pending.audience;
      const meetupId =
        audience.kind === "meetup" ? audience.meetupId : undefined;
      if (ctx.from?.id !== pending.telegramUserId) {
        outcome = {
          level: "info",
          message: "foreign broadcast answer ignored",
          result: "ok",
          use_case: useCase,
        };
        return;
      }
      const identity = await resolvePerson(ctx, runtime, useCase);
      if (identity.kind === "failed") {
        outcome = identity.outcome;
        return;
      }
      const denied = await denyHubAccessIfNeeded(
        ctx,
        runtime,
        identity,
        useCase,
        false,
      );
      if (denied !== undefined) {
        outcome = denied;
        return;
      }
      if (!canManageMeetups(identity.person)) {
        await answered();
        await showRefusal(
          ctx,
          broadcastForbiddenText[audience.kind],
          exitToMeetups(),
        );
        outcome = broadcastForbiddenOutcome(identity.person, meetupId);
        return;
      }
      // Фото, стикер и прочее без текста — тот же пустой ввод: рассылка несёт
      // только текст автора, а вопрос остаётся ждать настоящего ответа.
      const checked = checkBroadcastBody(ctx.message?.text ?? "");
      if (checked.kind !== "ok") {
        await refuseAnswer(
          ctx,
          questions,
          pending,
          broadcastBodyRetryText[checked.kind],
          replyId,
        );
        outcome = {
          level: "info",
          message: "broadcast body rejected",
          result: "ok",
          use_case: useCase,
          ...(meetupId === undefined ? {} : { meetup_id: meetupId }),
          identity_id: identity.person.identityId,
        };
        return;
      }
      // Сходку здесь не перечитывают: сбой Meetups на этом шаге стоил бы
      // человеку набранного текста. Название для кадра записано при вопросе, а
      // сходку, исчезнувшую за время набора, отклонит Notifications на отправке.
      // Вопрос снимается только после кадров: упавшая отправка оставляет его
      // ждать того же ответа.
      const preview = await runtime.dispatcher.execute({
        identity: identity.person,
        intent: "preview-broadcast",
        audience,
        ...rpcCall(ctx, useCase),
      });
      if (preview.kind !== "broadcast-audience") {
        await showFrame(
          ctx,
          "broadcast-result",
          previewFailureText(preview, audience),
          broadcastExit(audience),
          "new",
        );
        await answered(
          preview.kind === "dependency-rejected" &&
            (preview.reason === "timeout" || preview.reason === "unavailable")
            ? preview
            : undefined,
        );
        outcome = {
          ...screenBoundary(preview, {
            ok: ["broadcast-audience"],
            okMessage: "broadcast confirmation sent",
            rejectedMessage: "broadcast preview rejected",
            useCase,
            ...(meetupId === undefined ? {} : { meetupId }),
          }),
          identity_id: identity.person.identityId,
        };
        return;
      }
      await sendBroadcastConfirmation(
        ctx,
        audience,
        checked.body,
        pending.meetupTitle,
        preview.recipientCount,
      );
      await answered();
      outcome = {
        level: "info",
        message: "broadcast confirmation sent",
        result: "ok",
        use_case: useCase,
        ...(meetupId === undefined ? {} : { meetup_id: meetupId }),
        identity_id: identity.person.identityId,
      };
      return;
    }
    if (
      replyId !== undefined &&
      (pending?.kind === "channel-code" || pending?.kind === "channel-label") &&
      ctx.message?.text !== undefined
    ) {
      useCase = "manage_community";
      if (ctx.from?.id !== pending.telegramUserId) {
        outcome = {
          level: "info",
          message: "foreign channel answer ignored",
          result: "ok",
          use_case: useCase,
        };
        return;
      }
      const identity = await resolvePerson(ctx, runtime, useCase);
      if (identity.kind === "failed") {
        outcome = identity.outcome;
        return;
      }
      if (!canManageMembers(identity.person)) {
        await answered();
        await showRefusal(ctx, sourceChannelsForbiddenText, exitToMeetups());
        outcome = sourceChannelsForbiddenOutcome(identity.person);
        return;
      }
      const answer = ctx.message.text.trim();
      if (pending.kind === "channel-code") {
        // Код проверяется до вопроса о подписи: иначе отказ Identity пришёл бы
        // только после второго ответа, и подпись пришлось бы набирать заново.
        const valid = isSourceChannelCode(answer);
        if (valid) {
          await askQuestion(
            ctx,
            questions,
            {
              kind: "channel-label",
              code: answer,
              telegramUserId: pending.telegramUserId,
            },
            channelLabelPrompt,
            replyId,
          );
        } else {
          await refuseAnswer(
            ctx,
            questions,
            bodyOf(pending),
            channelCodeRetryPrompt,
            replyId,
          );
        }
        outcome = {
          level: "info",
          message: valid
            ? "source channel label requested"
            : "source channel code rejected",
          result: "ok",
          use_case: useCase,
          identity_id: identity.person.identityId,
        };
        return;
      }
      const result: IdentityAdminResult<boolean> =
        runtime.identity.createSourceChannel === undefined
          ? {
              kind: "unavailable",
              cause: new Error("source channels are not configured"),
            }
          : await runtime.identity.createSourceChannel(
              identity.person,
              { code: pending.code, label: answer },
              rpcCall(ctx, useCase),
            );
      if (result.kind === "invalid" || result.kind === "unavailable") {
        // Код проверен на первом шаге, поэтому отказ — о подписи. Сбой
        // Identity тоже переспрашивает подпись: канал не сохранён, и тот же
        // ответ можно прислать ещё раз, а не набирать код заново.
        await refuseAnswer(
          ctx,
          questions,
          bodyOf(pending),
          result.kind === "invalid"
            ? channelLabelRetryPrompt
            : channelSaveRetryPrompt,
          replyId,
        );
        outcome = adminOutcome(result, identity.person.identityId);
        return;
      }
      await answered();
      if (result.kind === "forbidden") {
        await showRefusal(ctx, sourceChannelsForbiddenText, exitToMeetups());
        outcome = adminOutcome(result, identity.person.identityId);
        return;
      }
      await renderSourceChannels(
        ctx,
        runtime,
        identity.person,
        { code: pending.code },
        result.value
          ? "Канал заведён."
          : "Канал с этим кодом уже есть, подпись прежняя.",
      );
      outcome = adminOutcome(result, identity.person.identityId);
      return;
    }
    if (
      replyId !== undefined &&
      pending !== undefined &&
      isConsoleQuestion(pending) &&
      ctx.message?.text !== undefined
    ) {
      useCase = "manage_auction";
      const question = consoleQuestionIntents[pending.kind];
      if (ctx.from?.id !== pending.telegramUserId) {
        outcome = {
          level: "info",
          message: question.foreign,
          result: "ok",
          use_case: useCase,
        };
        return;
      }
      const identity = await resolvePerson(ctx, runtime, useCase);
      if (identity.kind === "failed") {
        outcome = identity.outcome;
        return;
      }
      const denied = await denyHubAccessIfNeeded(
        ctx,
        runtime,
        identity,
        useCase,
        false,
      );
      if (denied !== undefined) {
        outcome = denied;
        return;
      }
      // Вопрос задаётся только держателю права вести аукцион, но старый
      // вопрос остаётся в чате: отказ приходит до Auction, как у формы лота.
      if (!canRunAuctions(identity.person)) {
        await answered();
        outcome = await refuseConsole(ctx, identity.person);
        return;
      }
      // Ключ команды выводится из самого ответа (PER-699): повторная доставка
      // того же сообщения Telegram приходит в Auction повтором команды и
      // получает исходный ответ. Новое сообщение с тем же текстом — новая
      // команда. Исключение — окно «Счастливых часов»: окна бот собирает из
      // прочитанного пульта и дописывает новое, поэтому поздний повтор
      // прислал бы окно дважды, а Auction ответил бы на тот же ключ исходным
      // «принято», не сверяя состав, — и бот нарисовал бы окно, которого нет.
      // Со своим ключом такой повтор честно получает отказ «пересекается».
      // Ответ о запуске окна команды не шлёт: её ключ рождается на «Да».
      const answer = {
        identity: identity.person,
        auctionId: pending.auctionId,
        value: ctx.message.text,
        opId:
          pending.kind === "console-window"
            ? createUuidV7()
            : answerOpId(ctx.message, pending.kind),
        ...rpcCall(ctx, useCase),
      };
      const result = await runtime.dispatcher.execute(
        pending.kind === "console-set"
          ? // Идентификатор сета выбирает вызывающий (ADR-073): он выводится
            // из ответа, как ключ команды, поэтому повтор того же сообщения
            // сохраняет тот же сет, а не заводит второй.
            {
              ...answer,
              intent: "add-lot-set",
              lotSetId: answerOpId(ctx.message, "console-set-id"),
            }
          : { ...answer, intent: consoleQuestionIntents[pending.kind].intent },
      );
      // Текст оплаты (PER-322) отвечает сводкой счетов, а не пультом.
      outcome = await (pending.kind === "console-payment-text"
        ? renderInvoicesResult
        : renderConsoleResult)(ctx, runtime, result, {
        person: identity.person,
        questions,
        replyId,
      });
      if (
        result.kind !== "auction-week-ask" &&
        result.kind !== "auction-raffle-ask" &&
        result.kind !== "auction-raffle-prize-ask" &&
        result.kind !== "auction-final-time-ask" &&
        result.kind !== "payment-text-ask" &&
        result.kind !== "step-window-ask" &&
        result.kind !== "step-window-launch-ask" &&
        result.kind !== "lot-set-ask"
      ) {
        await answered(result);
      }
      return;
    }
    if (
      replyId !== undefined &&
      pending?.kind === "final-ask" &&
      ctx.message?.text !== undefined
    ) {
      useCase = "manage_auction";
      if (ctx.from?.id !== pending.telegramUserId) {
        outcome = {
          level: "info",
          message: "foreign final ask answer ignored",
          result: "ok",
          use_case: useCase,
        };
        return;
      }
      const identity = await resolvePerson(ctx, runtime, useCase);
      if (identity.kind === "failed") {
        outcome = identity.outcome;
        return;
      }
      const denied = await denyHubAccessIfNeeded(
        ctx,
        runtime,
        identity,
        useCase,
        false,
      );
      if (denied !== undefined) {
        outcome = denied;
        return;
      }
      if (!canRunAuctions(identity.person)) {
        await answered();
        outcome = await refuseConsole(ctx, identity.person);
        return;
      }
      // Ключ команды выводится из самого ответа (PER-699): повторная доставка
      // того же сообщения не поднимает ask второй раз — Auction отвечает
      // исходным исходом. Новое сообщение с той же ценой — новая команда.
      const result = await runtime.dispatcher.execute({
        identity: identity.person,
        intent: "advance-final-ask",
        auctionId: pending.auctionId,
        position: pending.position,
        value: ctx.message.text,
        opId: answerOpId(ctx.message, "final-ask"),
        ...rpcCall(ctx, useCase),
      });
      outcome = await renderConsoleResult(ctx, runtime, result, {
        person: identity.person,
        questions,
        replyId,
      });
      if (result.kind !== "final-ask") await answered(result);
      return;
    }
    // «Другой человек…» (PER-565): ответ — имя или его часть; найденные —
    // экран с людьми, «Никого не нашлось» — экран с исходом.
    if (
      replyId !== undefined &&
      pending?.kind === "floor-search" &&
      ctx.message?.text !== undefined
    ) {
      useCase = "manage_auction";
      if (ctx.from?.id !== pending.telegramUserId) {
        outcome = {
          level: "info",
          message: "foreign floor search answer ignored",
          result: "ok",
          use_case: useCase,
        };
        return;
      }
      const identity = await resolvePerson(ctx, runtime, useCase);
      if (identity.kind === "failed") {
        outcome = identity.outcome;
        return;
      }
      const denied = await denyHubAccessIfNeeded(
        ctx,
        runtime,
        identity,
        useCase,
        false,
      );
      if (denied !== undefined) {
        outcome = denied;
        return;
      }
      if (!canRunAuctions(identity.person)) {
        await answered();
        outcome = await refuseConsole(ctx, identity.person);
        return;
      }
      const result = await runtime.dispatcher.execute({
        identity: identity.person,
        intent: "view-floor-bids",
        auctionId: pending.auctionId,
        page: 0,
        search: ctx.message.text,
        ...rpcCall(ctx, useCase),
      });
      outcome = await renderFloorResult(ctx, runtime, result, {
        person: identity.person,
        questions,
        replyId,
      });
      await answered(result);
      return;
    }
    if (
      replyId !== undefined &&
      pending?.kind === "lot" &&
      pending.question.kind === "image"
    ) {
      useCase = "manage_lot";
      const question = pending.question;
      if (ctx.from?.id !== pending.telegramUserId) {
        outcome = {
          level: "info",
          message: "foreign lot form answer ignored",
          result: "ok",
          use_case: useCase,
        };
        return;
      }
      const identity = await resolvePerson(ctx, runtime, useCase);
      if (identity.kind === "failed") {
        outcome = identity.outcome;
        return;
      }
      const denied = await denyHubAccessIfNeeded(
        ctx,
        runtime,
        identity,
        useCase,
        false,
      );
      if (denied !== undefined) {
        outcome = denied;
        return;
      }
      if (!canRunAuctions(identity.person)) {
        await answered();
        outcome = await refuseLotForm(ctx, identity.person);
        return;
      }
      outcome = await answerLotPhoto(ctx, runtime, questions, photos, {
        person: identity.person,
        question,
        replyId,
        answered,
      });
      return;
    }
    if (
      replyId !== undefined &&
      pending?.kind === "lot" &&
      pending.question.kind !== "image" &&
      ctx.message?.text !== undefined
    ) {
      useCase = "manage_lot";
      const question = pending.question;
      if (ctx.from?.id !== pending.telegramUserId) {
        outcome = {
          level: "info",
          message: "foreign lot form answer ignored",
          result: "ok",
          use_case: useCase,
        };
        return;
      }
      const identity = await resolvePerson(ctx, runtime, useCase);
      if (identity.kind === "failed") {
        outcome = identity.outcome;
        return;
      }
      const denied = await denyHubAccessIfNeeded(
        ctx,
        runtime,
        identity,
        useCase,
        false,
      );
      if (denied !== undefined) {
        outcome = denied;
        return;
      }
      // Вопрос формы задаётся только держателю права вести аукцион, но старый
      // вопрос остаётся в чате, и шаг его кнопки можно прислать и чужой.
      // Отказ приходит до Auction: иначе цена прошла бы разбор и человек
      // получил бы второй вопрос вместо отказа.
      if (!canRunAuctions(identity.person)) {
        await answered();
        outcome = await refuseLotForm(ctx, identity.person);
        return;
      }
      const result = await runtime.dispatcher.execute(
        lotAnswerRequest(question, ctx.message.text, {
          identity: identity.person,
          ...rpcCall(ctx, useCase),
        }),
      );
      // Новый вопрос сам снимает прежний после того, как ушёл; остальные
      // исходы, кроме сбоя Auction, вопрос закрывают.
      outcome = await renderLotAnswer(ctx, questions, result, {
        person: identity.person,
        answered: question,
        replyId,
      });
      if (result.kind !== "lot-ask") await answered(result);
      return;
    }
    // Ник назначаемого администратора (PER-521): Identity здесь не зовётся —
    // ник проверяется по форме и уходит в «Да» подтверждения, а назначение
    // делает нажатие. Без права вопрос не задаётся, но старый остаётся в чате.
    if (
      replyId !== undefined &&
      pending?.kind === "administrator-username" &&
      ctx.message?.text !== undefined
    ) {
      useCase = "manage_community";
      if (ctx.from?.id !== pending.telegramUserId) {
        outcome = {
          level: "info",
          message: "foreign form answer ignored",
          result: "ok",
          use_case: useCase,
        };
        return;
      }
      const identity = await resolvePerson(ctx, runtime, useCase);
      if (identity.kind === "failed") {
        outcome = identity.outcome;
        return;
      }
      const denied = await denyHubAccessIfNeeded(
        ctx,
        runtime,
        identity,
        useCase,
        false,
      );
      if (denied !== undefined) {
        outcome = denied;
        return;
      }
      if (!canGrantAdmins(identity.person)) {
        await answered();
        await showRefusal(
          ctx,
          administratorsForbiddenText,
          exitToMeetups(),
          "new",
        );
        outcome = {
          level: "warn",
          message: "management rejected",
          result: "error",
          use_case: useCase,
          identity_id: identity.person.identityId,
          error_category: "authorization",
          error: "management_forbidden",
        };
        return;
      }
      const username = appointUsername(ctx.message.text);
      if (username === undefined) {
        await refuseAnswer(
          ctx,
          questions,
          bodyOf(pending),
          "Это не похоже на ник Telegram. Ник присылают с @ или без.",
          replyId,
        );
        outcome = {
          level: "info",
          message: "administrator username rejected",
          result: "ok",
          use_case: useCase,
          identity_id: identity.person.identityId,
        };
        return;
      }
      await answered();
      await showScreen(ctx, {
        ...appointConfirmScreen(
          username,
          ctx.from?.username?.toLowerCase() === username.toLowerCase(),
        ),
        delivery: "new",
      });
      outcome = {
        level: "info",
        message: "administrator appointment asked",
        result: "ok",
        use_case: useCase,
        identity_id: identity.person.identityId,
      };
      return;
    }
    if (
      replyId !== undefined &&
      pending !== undefined &&
      (pending.kind === "allowed-username" || pending.kind === "meetup") &&
      ctx.message?.text !== undefined
    ) {
      useCase =
        pending.kind === "allowed-username"
          ? "manage_community"
          : pending.mode === "edit"
            ? "update_meetup"
            : "create_meetup";
      if (ctx.from?.id !== pending.telegramUserId) {
        outcome = {
          level: "info",
          message: "foreign form answer ignored",
          result: "ok",
          use_case: useCase,
        };
        return;
      }
      if (pending.kind === "allowed-username") {
        useCase = "manage_community";
        const identity = await resolvePerson(ctx, runtime, useCase);
        if (identity.kind === "failed") {
          outcome = identity.outcome;
          return;
        }
        const result =
          runtime.identity.addAllowedUsername === undefined
            ? {
                kind: "unavailable" as const,
                cause: new Error("community administration is not configured"),
              }
            : await runtime.identity.addAllowedUsername(
                identity.person,
                ctx.message.text,
                rpcCall(ctx, useCase),
              );
        if (result.kind === "invalid") {
          // Отказ задаёт вопрос заново: обычное сообщение после него ушло бы
          // мимо формы, и следующий текст остался бы без ответа.
          await refuseAnswer(
            ctx,
            questions,
            pending,
            "Это не похоже на ник Telegram. Ник присылают с @ или без.",
            replyId,
          );
          outcome = adminOutcome(result, identity.person.identityId);
          return;
        }
        if (result.kind === "ok") await answered();
        // Ответ на вопрос — сообщение, всплывающего текста у него нет: чем
        // кончилось, говорит строка над списком.
        await renderCommunity(
          ctx,
          runtime,
          identity.person,
          { kind: "usernames", page: 0 },
          result.kind === "ok"
            ? result.value
              ? "Ник добавлен."
              : "Этот ник уже есть в списке."
            : undefined,
        );
        outcome = adminOutcome(result, identity.person.identityId);
        return;
      }
      const identity = await resolvePerson(ctx, runtime, useCase);
      if (identity.kind === "failed") {
        outcome = identity.outcome;
        return;
      }
      const denied = await denyHubAccessIfNeeded(
        ctx,
        runtime,
        identity,
        useCase,
        false,
      );
      if (denied !== undefined) {
        outcome = denied;
        return;
      }
      const result = await runtime.dispatcher.execute({
        identity: identity.person,
        intent:
          pending.mode === "edit" ? "update-meetup-field" : "set-meetup-field",
        field: pending.field,
        value: ctx.message.text,
        meetupId: pending.meetupId,
        ...(pending.fresh === undefined ? {} : { fresh: true as const }),
        ...rpcCall(ctx, useCase),
      });
      await renderFormResult(
        ctx,
        result,
        questions,
        runtime.presentation ?? "rich",
        "status",
        pending.fresh,
      );
      await answered(result);
      outcome = screenBoundary(result, {
        ok: [
          "ask",
          "edit-ask",
          "draft",
          "published",
          "meetup-updated",
          "edit-unavailable",
          "confirm-past-schedule",
          "meetup-exists",
        ],
        okMessage: "meetup form answer handled",
        rejectedMessage: "meetup form answer rejected",
        useCase,
        meetupId: pending.meetupId,
      });
      return;
    }
    // Ответ без текста — фото, стикер, голос — значением не является. Вопрос
    // задаётся заново с подсказкой: клиент снова открывает режим ответа, а шаг
    // не теряется.
    if (
      replyId !== undefined &&
      pending !== undefined &&
      (pending.kind === "meetup" ||
        pending.kind === "allowed-username" ||
        pending.kind === "administrator-username" ||
        pending.kind === "channel-code" ||
        pending.kind === "channel-label" ||
        pending.kind === "publish-moment" ||
        pending.kind === "lot" ||
        pending.kind === "console-week" ||
        pending.kind === "console-raffle" ||
        pending.kind === "console-raffle-prize" ||
        pending.kind === "console-final-time" ||
        pending.kind === "console-payment-text" ||
        pending.kind === "console-window" ||
        pending.kind === "console-launch" ||
        pending.kind === "console-set" ||
        pending.kind === "final-ask" ||
        pending.kind === "floor-search") &&
      ctx.message?.text === undefined
    ) {
      useCase =
        pending.kind === "allowed-username" ||
        pending.kind === "administrator-username" ||
        pending.kind === "channel-code" ||
        pending.kind === "channel-label"
          ? "manage_community"
          : pending.kind === "lot"
            ? "manage_lot"
            : pending.kind === "console-week" ||
                pending.kind === "console-raffle" ||
                pending.kind === "console-raffle-prize" ||
                pending.kind === "console-final-time" ||
                pending.kind === "console-payment-text" ||
                pending.kind === "console-window" ||
                pending.kind === "console-launch" ||
                pending.kind === "console-set" ||
                pending.kind === "final-ask" ||
                pending.kind === "floor-search"
              ? "manage_auction"
              : pending.kind === "meetup" && pending.mode === "create"
                ? "create_meetup"
                : "update_meetup";
      if (ctx.from?.id === pending.telegramUserId) {
        await refuseAnswer(
          ctx,
          questions,
          bodyOf(pending),
          textNeededHint,
          replyId,
        );
      }
      outcome = {
        level: "info",
        message: "non-text answer asked again",
        result: "ok",
        use_case: useCase,
      };
      return;
    }
    if (
      replyId !== undefined &&
      ctx.message?.reply_to_message?.from?.id === ctx.me.id
    ) {
      useCase =
        askedStep?.kind === "channel-label"
          ? "manage_community"
          : "create_meetup";
      // Название материала по кнопке вопроса не восстановить — источник файла
      // жил в памяти процесса. Выход ведёт к материалам той же сходки.
      // Подпись канала — тоже: код, к которому она относится, жил в памяти.
      await showRefusal(
        ctx,
        askedStep?.kind === "material-title"
          ? "Этот вопрос уже устарел. Прикрепи материал заново."
          : askedStep?.kind === "channel-label"
            ? "Этот вопрос уже устарел. Заведи канал заново."
            : "Этот вопрос уже устарел. Открой раздел заново и повтори действие.",
        askedStep?.kind === "material-title"
          ? withNav(new InlineKeyboard(), toMaterials(askedStep.token))
          : askedStep?.kind === "channel-label"
            ? withNav(new InlineKeyboard(), toSourceChannels)
            : exitToMeetups(),
      );
      outcome = {
        level: "info",
        message: "stale form answer handled",
        result: "ok",
        use_case: useCase,
      };
      return;
    }
    if (parsed.kind === "malformed") {
      outcome = {
        level: "warn",
        message: "malformed telegram update",
        result: "error",
        error_category: "invariant",
        error: "telegram update failed validation",
      };
      return;
    }
    if (parsed.kind === "stray") {
      // Альбом приходит сообщением на каждый снимок: подсказка — одна.
      const group = ctx.message?.media_group_id;
      if (group !== undefined && !hintedAlbums.first(group)) {
        outcome = {
          level: "info",
          message: "stray album message ignored",
          result: "ok",
        };
        return;
      }
      outcome = await hintStray(ctx, questions);
      return;
    }
    if (parsed.kind === "ignored") {
      outcome = {
        level: "info",
        message: "update ignored",
        result: "ok",
      };
      return;
    }
    if (parsed.kind === "command") {
      useCase = commandUseCase[parsed.command];
      outcome = await handleSectionCommand(
        ctx,
        runtime,
        parsed.command,
        useCase,
      );
      return;
    }
    const deepLink = "deepLink" in parsed ? parsed.deepLink : undefined;
    useCase = deepLink?.kind === "meetup" ? "view_meetup" : "find_meetup";
    // `/start` заявку не ставит (PER-592, дополнение ADR-060 от 2026-10-12):
    // личность разрешается, как у нажатия, и белый список Identity гасит в том
    // же вызове. Человеку без права хаба — приветствие с кнопкой «Подать
    // заявку», и код канала из ссылки `s_<код>` едет в ней.
    // Отказ Identity на входе — кадр недоступности через `replyFailClosed`:
    // если Telegram отвергнет и его, граница сохранит причину входа.
    const resolved = await runtime.identity.resolve(
      toResolveIdentityInput(parsed.telegramUserId, parsed.telegramUsername),
      rpcCall(ctx, useCase),
    );
    if (resolved.kind !== "resolved") {
      outcome = await replyFailClosed(
        ctx,
        identityFailureOutcome(resolved, useCase),
      );
      return;
    }
    const identity = {
      person: { identityId: resolved.identityId, rights: resolved.rights },
      blocked: resolved.blocked,
    };
    ctx.commandsPerson = identity.person;
    const denied = await denyHubAccessIfNeeded(
      ctx,
      runtime,
      identity,
      useCase,
      false,
      deepLink?.kind === "source" ? deepLink.code : undefined,
    );
    if (denied !== undefined) {
      outcome = denied;
      return;
    }
    const person = identity.person;
    if (deepLink?.kind === "meetup") {
      const result = await runtime.dispatcher.execute({
        identity: person,
        intent: "view-meetup",
        meetupId: tokenToUuid(deepLink.payload.slice(2)),
        ...rpcCall(ctx, "view_meetup"),
      });
      await renderMeetupCard(
        ctx,
        result,
        false,
        runtime.presentation ?? "rich",
        canManageMeetups(person),
      );
      outcome = screenBoundary(result, {
        ok: ["meetup-card"],
        okMessage: "meetup card sent",
        rejectedMessage: "meetup card rejected",
        useCase,
      });
    } else {
      // Вход без ссылки на сходку открывает корневое меню: из него видно
      // всё, что доступно человеку (PER-592).
      outcome = await openMenu(ctx, runtime, person, useCase);
    }
  } catch (cause) {
    if (isScreenDeliveryFailure(cause)) {
      outcome = await replyScreenFailure({
        ctx,
        cause,
        previous: outcome,
        useCase,
      });
    } else if (outcome === undefined) {
      outcome = unexpectedOutcome(cause, undefined, useCase);
    }
  } finally {
    await waiting.finish();
    if (outcome !== undefined) {
      writeBoundary(runtime.logger, ctx, outcome);
    }
  }
}

async function handleCallback(
  ctx: UpdateContext,
  runtime: BotRuntime,
  questions: Map<string, PendingInput>,
  lotPhotos: LotPhotos,
): Promise<void> {
  let outcome: BoundaryOutcome | undefined;
  let useCase: ProductUseCase | undefined;
  // Ответ на нажатие уходит вместе с результатом, а не до похода к сервисам:
  // пока его нет, клиент сам крутит индикатор на кнопке (дизайн-код,
  // «Ожидание»). Отвечает первый видимый вызов Bot API либо `finish` ниже.
  const waiting = startWaiting(ctx);
  ctx.waiting = waiting;
  try {
    // Кнопки домена `auc` пишет и разбирает аукционное дерево (ADR-044):
    // до разбора хаба они не доходят.
    const data = ctx.callbackQuery?.data ?? "";
    if (isAuctionCallback(data)) {
      // Кнопка под адресным фактом сохраняет его в истории: снимаем trace-маркер
      // перед parser аукционного дерева и открываем карточку новым сообщением.
      const traced = data.startsWith("v1:t:auc:");
      const auctionData = traced ? `v1:${data.slice("v1:t:".length)}` : data;
      // Вход из «Событий» (PER-669) — домен `aue`; дерево разбирает `auc`.
      const treeData = auctionEntryOf(auctionData).data;
      if (traced) ctx.fresh = true;
      useCase = "view_auction";
      const pressedId = ctx.callbackQuery?.message?.message_id;
      // «Отмена» под вопросом листа ставки: вопрос удаляется, экран приходит
      // новым сообщением; не дал Telegram удалить — правится на месте.
      // «Как это работает» под вопросом лимита задаёт его заново тем же
      // путём: нажатый вопрос удаляется, новый приходит следом (PER-517).
      if (isAuctionQuestion(treeData) || replacesAuctionQuestion(treeData)) {
        if (pressedId !== undefined) {
          questions.delete(questionKey(ctx.chat?.id, pressedId));
        }
        const deleted = await deletePressed(ctx);
        // Вопрос под «Как это работает», который Telegram удалить не дал,
        // остаётся живым: клавиатура с шагом в «Отмене» с него не снимается.
        ctx.pressedGone = deleted || replacesAuctionQuestion(treeData);
        ctx.fresh = ctx.pressedGone;
      }
      await dropOpenQuestions(ctx, questions, pressedId);
      outcome = await handleAuctionCallback(
        ctx,
        runtime,
        auctionData,
        lotPhotos,
        {
          questions,
        },
      );
      return;
    }
    const pressed = parseCallback(ctx.callbackQuery?.data);
    // «Отмена» под вопросом: вопрос удаляется, а экран, с которого он задан,
    // приходит новым сообщением. Правка вопроса на месте режим ответа в
    // клиенте не снимает (зонд PER-443); она остаётся запасным путём, когда
    // Telegram удалить сообщение не дал. Дальше нажатие идёт как обычная
    // кнопка этого экрана.
    const action: ScreenAction =
      pressed.kind === "question" ? cancelTarget(pressed.step) : pressed;
    const pressedId = ctx.callbackQuery?.message?.message_id;
    // «Пропустить» под вопросом о фото нового лота (PER-618) и «Убрать фото»
    // (PER-715) уходят от вопроса так же, как «Отмена»: вопрос удаляется, итог
    // или подтверждение приходит новым сообщением.
    if (
      pressed.kind === "question" ||
      pressed.kind === "lot-skip" ||
      pressed.kind === "lot-image-remove"
    ) {
      if (pressedId !== undefined) {
        questions.delete(questionKey(ctx.chat?.id, pressedId));
      }
      ctx.pressedGone = await deletePressed(ctx);
    }
    // Нажатие вне вопроса — человек ушёл от него: брошенные вопросы удаляются.
    await dropOpenQuestions(ctx, questions, pressedId);
    if (action.kind === "malformed") {
      outcome = {
        level: "warn",
        message: "malformed callback data",
        result: "error",
        error_category: "invariant",
        error: "callback data failed validation",
      };
      await showRefusal(
        ctx,
        "Не получилось прочитать эту кнопку. Открой раздел заново.",
        exitToMeetups(),
      );
      return;
    }
    ctx.fresh = action.trace === true || ctx.pressedGone === true;
    // «Отмена» под вопросом о названии нового лота возвращает в ленту
    // аукциона, а её рисует аукционное дерево: дальше нажатие идёт как кнопка ленты,
    // с той же политикой хаба и тем же шлюзом.
    if (action.kind === "lot-feed") {
      useCase = "view_auction";
      outcome = await handleAuctionCallback(
        ctx,
        runtime,
        encodeAuctionCallback({
          kind: "feed",
          auctionId: tokenToUuid(action.auction),
          page: 0,
        }),
        lotPhotos,
        { questions },
      );
      return;
    }
    if (action.kind === "auction-faq") {
      useCase = "view_auction";
      outcome = await handleAuctionFaqCallback(
        ctx,
        runtime,
        action.auction,
        action.viaEvents === true,
      );
      return;
    }
    useCase = callbackUseCase(action.kind);
    // Вопрос о прошедшей дате задают и в форме создания, и в правке: сценарий
    // тот же, что у ответа текстом, который его породил.
    if (
      ((action.kind === "manage-confirm-past-schedule" ||
        action.kind === "manage-retry-past-schedule") &&
        !action.editing) ||
      ((action.kind === "manage-pick-day" ||
        action.kind === "manage-pick-schedule" ||
        action.kind === "manage-type-schedule") &&
        action.mode === "c")
    ) {
      useCase = "create_meetup";
    }
    // «Подать заявку» — вход, а не нажатие по дереву: вместо разрешения
    // личности бот ставит заявку (дополнение ADR-060 от 2026-10-12).
    if (action.kind === "apply") {
      outcome = await applyForHub(ctx, runtime, action.sourceCode);
      return;
    }
    const retryCallback =
      action.kind === "outdated"
        ? "v1:nav:hub"
        : (ctx.callbackQuery?.data ?? "v1:nav:hub");
    const identity = await resolvePerson(ctx, runtime, useCase, retryCallback);
    if (identity.kind === "failed") {
      outcome = identity.outcome;
      return;
    }
    const denied = await denyHubAccessIfNeeded(
      ctx,
      runtime,
      identity,
      useCase,
      true,
    );
    if (denied !== undefined) {
      outcome = denied;
      return;
    }
    const person = identity.person;
    // Вход в управление и его пункты бот показывает по правам (ADR-064,
    // пункт 6), но старая кнопка остаётся в чате, а нажатие можно подделать.
    // Меню сервиса за собой не имеет, а вопрос отказал бы лишь после набора
    // ответа, поэтому отказ приходит здесь, до Identity. Очередь аукциона
    // требует права модерировать аукцион, очередь сообщества, состав и каналы —
    // права управлять составом (решение владельца по PER-534). Остальные
    // кнопки меню, кроме объявления с его вопросом, бот пропускает: право на
    // них решают Meetups и Identity (PER-396). Отказ приходит правкой.
    const refusedText = managementRefusal(action, person);
    if (refusedText !== undefined) {
      await showRefusal(ctx, refusedText, exitToMeetups());
      outcome = {
        level: "warn",
        message: "management rejected",
        result: "error",
        use_case: useCase,
        identity_id: person.identityId,
        error_category: "authorization",
        error: "management_forbidden",
      };
      return;
    }
    // Форма лота (PER-319): входы в неё видит только держатель права вести
    // аукцион — по нему Auction пускает в каталог (PER-652), — но старая
    // кнопка остаётся в чате. Вопрос отказал бы лишь после набора ответа, а
    // экран правки без права ничего сделать не даёт, поэтому отказ приходит
    // здесь. Право на сами команды решают Auction и Meetups.
    if (
      action.kind === "lot-new" ||
      action.kind === "lot-form" ||
      action.kind === "lot-ask" ||
      action.kind === "lot-step-mode" ||
      action.kind === "lot-skip" ||
      action.kind === "lot-keep-step" ||
      action.kind === "lot-image-remove" ||
      action.kind === "lot-image-remove-confirm" ||
      action.kind === "lot-scope" ||
      action.kind === "lot-set-retry" ||
      action.kind === "lot-copy" ||
      action.kind === "lot-remove" ||
      action.kind === "lot-remove-confirm"
    ) {
      outcome = canRunAuctions(person)
        ? await handleLotFormCallback(ctx, runtime, questions, person, action)
        : await refuseLotForm(ctx, person);
      return;
    }
    // Лот глазами участника (PER-512) — экран формы и тот же отказ без права:
    // поддельная кнопка не открывает лот до Auction.
    if (action.kind === "lot-view") {
      outcome = canRunAuctions(person)
        ? await handleLotPreviewCallback(
            ctx,
            runtime,
            lotPhotos,
            person,
            action.lot,
          )
        : await refuseLotForm(ctx, person);
      return;
    }
    // Пульт аукциона (PER-320): вход видит только держатель права вести
    // аукцион (PER-654), старая кнопка получает отказ до Auction. Право на чтение и команды решает
    // Auction у Meetups и отвечает своим отказом.
    if (
      action.kind === "console-view" ||
      action.kind === "console-week" ||
      action.kind === "console-raffle" ||
      action.kind === "console-raffle-remove" ||
      action.kind === "console-raffle-prize" ||
      action.kind === "console-raffle-prize-remove" ||
      action.kind === "console-final-time" ||
      action.kind === "console-final-time-remove" ||
      action.kind === "console-final" ||
      action.kind === "console-visibility" ||
      action.kind === "console-open" ||
      action.kind === "console-confirm" ||
      action.kind === "console-discard" ||
      action.kind === "console-discard-confirm" ||
      action.kind === "console-cancel" ||
      action.kind === "console-cancel-confirm" ||
      action.kind === "console-mark" ||
      action.kind === "console-lineup" ||
      action.kind === "console-lineup-confirm" ||
      action.kind === "console-start-final" ||
      action.kind === "console-next-lot" ||
      action.kind === "console-ask" ||
      action.kind === "console-close" ||
      action.kind === "console-close-confirm" ||
      action.kind === "console-windows" ||
      action.kind === "console-day-summary" ||
      action.kind === "console-window" ||
      action.kind === "console-window-ask" ||
      action.kind === "console-window-lot" ||
      action.kind === "console-window-remove" ||
      action.kind === "console-window-launch" ||
      action.kind === "console-window-launch-lot" ||
      action.kind === "console-window-launch-go" ||
      action.kind === "console-window-launch-page" ||
      action.kind === "console-sets" ||
      action.kind === "console-set-ask" ||
      action.kind === "console-set" ||
      action.kind === "console-set-lot" ||
      action.kind === "console-set-delete" ||
      action.kind === "console-set-delete-confirm"
    ) {
      outcome = canRunAuctions(person)
        ? await handleConsoleCallback(ctx, runtime, questions, person, action)
        : await refuseConsole(ctx, person);
      return;
    }
    // «Ставки зала» (PER-565): вход видит только держатель права вести
    // аукцион, подделанная кнопка получает отказ до Auction (ADR-070 п. 6).
    if (
      action.kind === "console-floor" ||
      action.kind === "console-floor-search" ||
      action.kind === "console-floor-pick" ||
      action.kind === "console-floor-confirm" ||
      action.kind === "console-floor-leader"
    ) {
      outcome = canRunAuctions(person)
        ? await handleFloorCallback(ctx, runtime, questions, person, action)
        : await refuseConsole(ctx, person);
      return;
    }
    // Снятие участника с лота (PER-659): ряд на «Ставках» видит только
    // держатель права вести аукцион, подделанная кнопка получает отказ до
    // Auction.
    if (
      action.kind === "console-removal" ||
      action.kind === "console-removal-pick" ||
      action.kind === "console-removal-confirm"
    ) {
      outcome = canRunAuctions(person)
        ? await handleRemovalCallback(ctx, runtime, questions, person, action)
        : await refuseConsole(ctx, person);
      return;
    }
    // Счета аукциона (PER-321): ряд «Счета» пульта видит только держатель
    // права вести аукцион, подделанная кнопка получает отказ до Auction.
    if (
      action.kind === "console-invoices" ||
      action.kind === "console-invoice" ||
      action.kind === "console-invoice-mark" ||
      action.kind === "console-invoice-mark-confirm" ||
      action.kind === "console-payment-text" ||
      action.kind === "console-payment-text-remove"
    ) {
      outcome = canRunAuctions(person)
        ? await handleInvoicesCallback(ctx, runtime, questions, person, action)
        : await refuseConsole(ctx, person);
      return;
    }
    if (action.kind === "open-material-file") {
      const meetupId = tokenToUuid(action.token);
      const materialId = tokenToUuid(action.materialToken);
      const current = await runtime.dispatcher.execute({
        identity: person,
        intent: "view-meetup",
        meetupId,
        ...rpcCall(ctx, useCase),
      });
      if (current.kind !== "meetup-card") {
        await renderMeetupCard(
          ctx,
          current,
          true,
          runtime.presentation ?? "rich",
        );
        outcome = screenBoundary(current, {
          ok: ["meetup-card"],
          okMessage: "material file sent",
          rejectedMessage: "material file rejected",
          useCase,
          meetupId,
        });
        return;
      }
      const material = current.meetup.materials.find(
        (candidate) =>
          candidate.id === materialId && candidate.source.kind === "file",
      );
      if (material === undefined || material.source.kind !== "file") {
        await showRefusal(
          ctx,
          "Материал больше не найден. Открой актуальную карточку сходки.",
          exitToCard(action.token),
        );
        outcome = {
          level: "warn",
          message: "material file missing",
          result: "error",
          use_case: useCase,
          meetup_id: meetupId,
          identity_id: person.identityId,
          error_category: "visibility",
          error: "material_not_visible",
        };
        return;
      }
      const delivery = await sendStoredMaterialFile(
        ctx,
        material.source,
        material.title,
        action.token,
      );
      if (delivery.kind === "failed") {
        await showRefusal(
          ctx,
          "Не получилось показать материал. Возможно, файл больше недоступен или Telegram временно не отвечает.",
          exitToCard(action.token),
        );
        outcome = unexpectedOutcome(
          delivery.cause,
          undefined,
          useCase,
          meetupId,
          person.identityId,
        );
        return;
      }
      outcome = {
        level: "info",
        message: "material file sent",
        result: "ok",
        use_case: useCase,
        meetup_id: meetupId,
        identity_id: person.identityId,
      };
      return;
    }
    if (action.kind === "confirm-attach-material") {
      const meetupId = tokenToUuid(action.token);
      const confirmation = parseMaterialConfirmation(
        ctx.callbackQuery?.message,
      );
      if (confirmation === undefined) {
        await showRefusal(
          ctx,
          "Этот экран прикрепления устарел. Начни действие заново из карточки сходки.",
          exitToCard(action.token),
        );
        outcome = {
          level: "warn",
          message: "material confirmation malformed",
          result: "error",
          use_case: useCase,
          meetup_id: meetupId,
          identity_id: person.identityId,
          error_category: "invariant",
          error: "material confirmation failed validation",
        };
        return;
      }
      const materialId = tokenToUuid(action.materialToken);
      const result =
        action.version === undefined
          ? await unversionedConfirmation(
              runtime,
              person,
              meetupId,
              rpcCall(ctx, useCase),
              {
                reached: (meetup) =>
                  meetup.materials.some(
                    (material) => material.id === materialId,
                  ),
                kind: "material-attached",
              },
            )
          : await runtime.dispatcher.execute({
              identity: person,
              intent: "attach-material",
              meetupId,
              material: {
                id: materialId,
                title: confirmation.title,
                source: confirmation.source,
              },
              expectedVersion: action.version,
              ...rpcCall(ctx, useCase),
            });
      if (result.kind === "conflict") {
        // Подтверждение — сообщение с источником, и его название и файл бот
        // читает обратно при нажатии. Поэтому текст конфликта уходит новым
        // сообщением, а у подтверждения меняется только версия в кнопке.
        const renewed = await renewConfirmationKeyboard(
          ctx,
          materialConfirmationKeyboard(
            action.token,
            action.materialToken,
            result.meetup.version,
            confirmation.source,
          ),
        );
        await ctx.reply(
          renewed
            ? `${conflictText}\n\nПроверь материал и подтверди прикрепление ещё раз.`
            : `${conflictText}\n\nНачни прикрепление заново из карточки сходки.`,
        );
      } else {
        await renderMaterialResult(
          ctx,
          result,
          action.token,
          `Прикреплено: ${confirmation.title}`,
        );
      }
      outcome = screenBoundary(result, {
        ok: ["material-attached"],
        okMessage: "material attached",
        rejectedMessage: "material attach rejected",
        useCase,
        meetupId,
      });
      return;
    }
    if (action.kind === "confirm-remove-material") {
      const meetupId = tokenToUuid(action.token);
      const materialId = tokenToUuid(action.materialToken);
      const result =
        action.version === undefined
          ? await unversionedConfirmation(
              runtime,
              person,
              meetupId,
              rpcCall(ctx, useCase),
              {
                reached: (meetup) =>
                  !meetup.materials.some(
                    (material) => material.id === materialId,
                  ),
                kind: "material-removed",
              },
            )
          : await runtime.dispatcher.execute({
              identity: person,
              intent: "remove-material",
              meetupId,
              materialId,
              expectedVersion: action.version,
              ...rpcCall(ctx, useCase),
            });
      if (result.kind === "conflict") {
        // Уже убранный материал Meetups отдаёт успехом по любой версии, а кнопка
        // без версии проверяет это сама, так что здесь он ещё на месте. Исход —
        // свой экран (PER-472): «‹ Материалы» открывает список по свежей
        // версии, и убрать материал можно оттуда.
        const material = result.meetup.materials.find(
          (candidate) => candidate.id === materialId,
        );
        await showScreen(ctx, {
          id: "outcome",
          text: outcomeText(
            conflictText,
            material === undefined ? undefined : materialTitle(material, 1),
          ),
          keyboard: withNav(new InlineKeyboard(), toMaterials(action.token)),
          format: "HTML",
        });
      } else {
        await renderMaterialResult(ctx, result, action.token);
      }
      outcome = screenBoundary(result, {
        ok: ["material-removed"],
        okMessage: "material removed",
        rejectedMessage: "material removal rejected",
        useCase,
        meetupId,
      });
      return;
    }
    if (
      action.kind === "manage-materials" ||
      action.kind === "decline-attach-material" ||
      action.kind === "begin-attach-material" ||
      action.kind === "remove-material"
    ) {
      const meetupId = tokenToUuid(action.token);
      const canManageMaterials = canManageMeetups(person);
      if (
        action.kind !== "manage-materials" &&
        action.kind !== "decline-attach-material" &&
        !canManageMaterials
      ) {
        await showRefusal(ctx, materialForbiddenText, exitToCard(action.token));
        outcome = materialForbiddenOutcome(person, meetupId);
        return;
      }
      const current = await runtime.dispatcher.execute({
        identity: person,
        intent: "view-meetup",
        meetupId,
        ...rpcCall(ctx, useCase),
      });
      if (current.kind !== "meetup-card") {
        await renderMeetupCard(
          ctx,
          current,
          true,
          runtime.presentation ?? "rich",
          true,
        );
        outcome = screenBoundary(current, {
          ok: ["meetup-card"],
          okMessage: "material management opened",
          rejectedMessage: "material management rejected",
          useCase,
          meetupId,
        });
        return;
      }
      if (
        current.meetup.lifecycle === "cancelled" &&
        action.kind !== "manage-materials" &&
        action.kind !== "decline-attach-material"
      ) {
        await showRefusal(
          ctx,
          "Сходка уже отменена. Изменять её материалы больше нельзя.",
          exitToCard(action.token),
        );
      } else if (action.kind === "manage-materials") {
        await renderMaterialManagement(
          ctx,
          current.meetup,
          canManageMaterials,
          action.page ?? 0,
        );
      } else if (action.kind === "decline-attach-material") {
        // «Нет» под только что присланным материалом — экран исхода с «Ввести
        // заново» (решение владельца 10 октября 2026 года). Файл в
        // подтверждении остаётся следом с подписью «Не прикреплено.».
        const step = { kind: "material-title", token: action.token } as const;
        await showScreen(ctx, {
          id: "outcome",
          text: outcomeText(
            "Не прикреплено. Связь со сходкой не появилась.",
            current.meetup.title,
          ),
          keyboard: withNav(
            new InlineKeyboard().text(retryAnswerLabel, reopenData(step)),
            answerParent(step),
          ),
          format: "HTML",
          fileTrace: "Не прикреплено.",
        });
      } else if (action.kind === "begin-attach-material") {
        await askQuestion(
          ctx,
          questions,
          {
            kind: "material-source",
            meetupId,
            version: current.meetup.version,
            telegramUserId: ctx.from?.id ?? 0,
          },
          `Перешли сообщение или отправь фотографию либо документ для сходки «${current.meetup.title}». Я не читаю чат целиком: связь появится только после твоего подтверждения.`,
        );
      } else {
        const materialId = tokenToUuid(action.materialToken);
        const material = current.meetup.materials.find(
          (candidate) => candidate.id === materialId,
        );
        if (material === undefined) {
          await showRefusal(
            ctx,
            "Материал уже отсутствует. Оригинал в Telegram не изменён.",
            withNav(new InlineKeyboard(), toMaterials(action.token)),
          );
        } else {
          await showScreen(
            ctx,
            removeConfirmScreen({
              token: action.token,
              materialToken: action.materialToken,
              version: current.meetup.version,
              title: materialTitle(material, 1),
            }),
          );
        }
      }
      outcome = {
        level: "info",
        message: "material management step sent",
        result: "ok",
        use_case: useCase,
        meetup_id: meetupId,
        identity_id: person.identityId,
      };
      return;
    }
    if (action.kind === "community" || action.kind === "community-usernames") {
      const result = await renderCommunity(
        ctx,
        runtime,
        person,
        action.kind === "community"
          ? { kind: "list", place: action.place ?? firstCommunityPlace }
          : { kind: "usernames", page: action.page },
      );
      outcome = adminOutcome(result, person.identityId);
      return;
    }
    // Карточка и вопрос о закрытии доступа читают человека заново: его могли
    // закрыть или назначить администратором, пока экран висел. Право решает
    // Identity и отказывает значением ответа (PER-547).
    if (
      action.kind === "community-member" ||
      action.kind === "ask-block-member" ||
      action.kind === "ask-demote-member"
    ) {
      const result = await renderCommunityMember(
        ctx,
        runtime,
        person,
        tokenToUuid(action.token),
        action.place,
        action.kind === "community-member"
          ? "card"
          : action.kind === "ask-block-member"
            ? "close-access"
            : "demote",
      );
      outcome = memberOutcome(result, person.identityId);
      return;
    }
    if (
      action.kind === "refused-applications" ||
      action.kind === "ask-reconsider"
    ) {
      const result = await readRefused(ctx, runtime, person, action.queue);
      if (result.kind !== "ok") {
        await showRefusedRefusal(ctx, result, action.queue);
      } else if (action.kind === "refused-applications") {
        await showScreen(
          ctx,
          refusedScreen(
            action.queue,
            result.value,
            action.page,
            communityToday(ctx),
            canManageMembers(person),
            manageItemParent("applications"),
          ),
        );
      } else {
        const applicationId = tokenToUuid(action.token);
        const application = result.value.find(
          (candidate) => candidate.applicationId === applicationId,
        );
        if (application === undefined) {
          // Отказ пересмотрел другой администратор, пока этот экран был открыт.
          await waiting.answer(reconsideredText);
          await showScreen(
            ctx,
            refusedScreen(
              action.queue,
              result.value,
              action.page,
              communityToday(ctx),
              canManageMembers(person),
              manageItemParent("applications"),
            ),
          );
        } else {
          await showScreen(
            ctx,
            reconsiderConfirmScreen(action.queue, application, action.page),
          );
        }
      }
      outcome = adminOutcome(result, person.identityId);
      return;
    }
    if (action.kind === "reconsider") {
      const result: ReconsiderResult =
        runtime.identity.reconsiderApplication === undefined
          ? {
              kind: "unavailable",
              cause: new Error("application administration is not configured"),
            }
          : await runtime.identity.reconsiderApplication(
              person,
              tokenToUuid(action.token),
              rpcCall(ctx, "manage_community"),
            );
      // `changed = false` — круг уже выдан после отказа: пересмотр опередил
      // другой администратор или выдача иным путём.
      const toast =
        result.kind === "ok"
          ? result.value
            ? "Отказ пересмотрен."
            : reconsideredText
          : result.kind === "not-refused"
            ? "Пересмотреть нельзя: профиль заблокирован."
            : result.kind === "invalid"
              ? "Изменение не сохранилось. Список перечитан заново."
              : result.kind === "forbidden"
                ? forbiddenToast(action.queue)
                : "Не получилось сохранить. Попробуй ещё раз.";
      await waiting.answer(toast);
      await renderRefused(ctx, runtime, person, action.queue, action.page);
      outcome = adminOutcome(result, person.identityId);
      return;
    }
    if (action.kind === "grant-record" || action.kind === "revoke-record") {
      const identityId = tokenToUuid(action.token);
      const records = runtime.identity;
      const result: GrantRecordResult =
        action.kind === "grant-record"
          ? records.grantRightRecord === undefined
            ? {
                kind: "unavailable",
                cause: new Error("right records are not configured"),
              }
            : await records.grantRightRecord(
                person,
                identityId,
                action.right,
                rpcCall(ctx, "manage_community"),
              )
          : records.revokeRightRecord === undefined
            ? {
                kind: "unavailable",
                cause: new Error("right records are not configured"),
              }
            : await records.revokeRightRecord(
                person,
                identityId,
                action.right,
                rpcCall(ctx, "manage_community"),
              );
      await waiting.answer(recordToast(action.kind, action.right, result));
      // После команды карточка перечитывается из Identity: она показывает то,
      // что сохранилось, а не то, что нажали.
      await renderCommunityMember(
        ctx,
        runtime,
        person,
        identityId,
        action.place,
        "card",
      );
      // Не участник или заблокирован — штатный ответ контракта, а не сбой.
      outcome =
        result.kind === "not-member"
          ? {
              level: "info",
              message: "auction moderation not granted",
              result: "ok",
              use_case: "manage_community",
              identity_id: person.identityId,
            }
          : adminOutcome(result, person.identityId);
      return;
    }
    if (action.kind === "administrators") {
      const result = await renderAdministrators(ctx, runtime, person);
      outcome = adminOutcome(result, person.identityId);
      return;
    }
    if (action.kind === "ask-appoint-administrator") {
      await askQuestion(
        ctx,
        questions,
        { kind: "administrator-username", telegramUserId: ctx.from?.id ?? 0 },
        appointPrompt,
      );
      outcome = {
        level: "info",
        message: "administrator username requested",
        result: "ok",
        use_case: "manage_community",
        identity_id: person.identityId,
      };
      return;
    }
    if (action.kind === "decline-appoint-administrator") {
      // «Нет» под только что присланным ником — исход с «Ввести заново»:
      // ник жил только в кнопке «Да» (дизайн-код, «Вопросы»).
      await showScreen(
        ctx,
        appointRetryScreen("Не назначено. Никому ничего не выдано."),
      );
      outcome = {
        level: "info",
        message: "administrator appointment declined",
        result: "ok",
        use_case: "manage_community",
        identity_id: person.identityId,
      };
      return;
    }
    if (action.kind === "confirm-appoint-administrator") {
      const result =
        runtime.identity.appointAdministrator === undefined
          ? {
              kind: "unavailable" as const,
              cause: new Error("administrators are not configured"),
            }
          : await runtime.identity.appointAdministrator(
              person,
              action.username,
              rpcCall(ctx, "manage_community"),
            );
      // `invalid` — Identity не разобрал запрос, который бот уже проверил:
      // это не ошибка ника, а рассинхрон, и человек видит сбой.
      if (
        result.kind === "forbidden" ||
        result.kind === "unavailable" ||
        result.kind === "invalid"
      ) {
        await refuseAdministrators(ctx, result);
        outcome = adminOutcome(result, person.identityId);
        return;
      }
      const shown = appointOutcome(result, person.identityId);
      const subject = `@${action.username}`;
      await showScreen(
        ctx,
        shown.retry
          ? appointRetryScreen(shown.text, subject)
          : administratorOutcomeScreen(shown.text, subject),
      );
      // Отказ по цели — штатный ответ Identity, а не сбой: метрика отказов на
      // нём не растёт.
      outcome = {
        level: "info",
        message:
          result.kind === "ok"
            ? "administrator appointed"
            : `administrator not appointed: ${result.kind}`,
        result: "ok",
        use_case: "manage_community",
        identity_id: person.identityId,
      };
      return;
    }
    if (action.kind === "ask-dismiss-administrator") {
      const list = await readAdministrators(ctx, runtime, person);
      if (list.kind !== "ok") {
        await refuseAdministrators(ctx, list);
        outcome = adminOutcome(list, person.identityId);
        return;
      }
      const identityId = tokenToUuid(action.token);
      const target = list.value.find(
        (administrator) =>
          administrator.identityId === identityId && administrator.admin,
      );
      // Набор сняли, пока экран был открыт: спрашивать не о чем.
      await showScreen(
        ctx,
        target === undefined
          ? administratorOutcomeScreen(
              "Уже не администратор. Список изменился, пока экран был открыт.",
            )
          : dismissConfirmScreen(target, person.identityId),
      );
      outcome = adminOutcome(list, person.identityId);
      return;
    }
    if (action.kind === "dismiss-administrator") {
      const result =
        runtime.identity.dismissAdministrator === undefined
          ? {
              kind: "unavailable" as const,
              cause: new Error("administrators are not configured"),
            }
          : await runtime.identity.dismissAdministrator(
              person,
              tokenToUuid(action.token),
              rpcCall(ctx, "manage_community"),
            );
      if (
        result.kind === "forbidden" ||
        result.kind === "unavailable" ||
        result.kind === "invalid"
      ) {
        await refuseAdministrators(ctx, result);
        outcome = adminOutcome(result, person.identityId);
        return;
      }
      await showScreen(ctx, administratorOutcomeScreen(dismissOutcome(result)));
      outcome =
        result.kind === "identity-unknown"
          ? {
              level: "info",
              message: "administrator not dismissed: identity-unknown",
              result: "ok",
              use_case: "manage_community",
              identity_id: person.identityId,
            }
          : adminOutcome(result, person.identityId);
      return;
    }
    if (action.kind === "source-channels") {
      const result = await renderSourceChannels(ctx, runtime, person, {
        page: action.page,
      });
      outcome = adminOutcome(result, person.identityId);
      return;
    }
    if (action.kind === "ask-source-channel") {
      await askQuestion(
        ctx,
        questions,
        { kind: "channel-code", telegramUserId: ctx.from?.id ?? 0 },
        channelCodePrompt,
      );
      outcome = {
        level: "info",
        message: "source channel code requested",
        result: "ok",
        use_case: "manage_community",
        identity_id: person.identityId,
      };
      return;
    }
    if (action.kind === "application-card") {
      const result = await renderApplicationCard(
        ctx,
        runtime,
        person,
        action.queue,
        action.cursor === undefined
          ? undefined
          : queueCursor(action.cursor, action.from ?? "after"),
      );
      outcome = adminOutcome(result, person.identityId);
      return;
    }
    if (action.kind === "ask-decline-application") {
      const result = await readApplicationQueue(
        ctx,
        runtime,
        person,
        action.queue,
        queueCursor(action.cursor, "at"),
      );
      if (result.kind !== "ok") {
        await showApplicationRefusal(ctx, result, action.queue);
      } else {
        const card = result.value.card;
        if (
          card?.application.applicationId === tokenToUuid(action.cursor.token)
        ) {
          await showScreen(
            ctx,
            declineConfirmScreen(action.queue, card.application),
          );
        } else {
          // Заявку решил другой администратор, пока карточка висела: исход
          // назовёт только решение, а вопрос о нём уже не к месту.
          await waiting.answer("Эту заявку уже решили.");
          await showApplicationQueue(ctx, action.queue, result.value, true);
        }
      }
      outcome = adminOutcome(result, person.identityId);
      return;
    }
    if (
      action.kind === "admit-application" ||
      action.kind === "decline-application"
    ) {
      const decide =
        action.kind === "admit-application"
          ? runtime.identity.admitApplication
          : runtime.identity.declineApplication;
      // Ответ решения не называет человека, поэтому допуск читает карточку до
      // решения: экран после него называет допущенного (прогон 14.10, №51).
      // Чтение не прошло или заявка уже другая — строки нет, решение идёт.
      const before =
        action.kind === "admit-application" && decide !== undefined
          ? await readApplicationQueue(
              ctx,
              runtime,
              person,
              action.queue,
              queueCursor(action.cursor, "at"),
            )
          : undefined;
      const admitted =
        before?.kind === "ok" &&
        before.value.card?.application.applicationId ===
          tokenToUuid(action.cursor.token)
          ? before.value.card.application
          : undefined;
      const result =
        decide === undefined
          ? {
              kind: "unavailable" as const,
              cause: new Error("application moderation is not configured"),
            }
          : await decide(
              person,
              tokenToUuid(action.cursor.token),
              rpcCall(ctx, "manage_community"),
            );
      // Сбой не значит, что решения нет: ответ мог потеряться после записи
      // или не разобраться. Поэтому ответ не утверждает ни того, ни другого,
      // а экран перечитывает заявку: открыта — та же карточка, решена —
      // следующая.
      await waiting.answer(
        result.kind === "ok"
          ? decisionToast(result.value)
          : result.kind === "forbidden"
            ? forbiddenToast(action.queue)
            : "Решение не подтвердилось. Карточка перечитана заново.",
      );
      // Решённая заявка уступает место следующей. Неподтверждённое решение
      // перечитывает ту же: уйди очередь дальше, отказ выглядел бы принятым.
      await renderApplicationCard(
        ctx,
        runtime,
        person,
        action.queue,
        queueCursor(action.cursor, result.kind === "ok" ? "after" : "at"),
        result.kind === "ok" &&
          !result.value.already &&
          result.value.outcome === "admitted" &&
          admitted !== undefined
          ? admittedNote(admitted)
          : undefined,
      );
      outcome = adminOutcome(result, person.identityId);
      return;
    }
    if (action.kind === "ask-allowed-username") {
      await askQuestion(
        ctx,
        questions,
        { kind: "allowed-username", telegramUserId: ctx.from?.id ?? 0 },
        "Какой ник разрешить? Отправь его с @ или без.",
      );
      outcome = {
        level: "info",
        message: "allowed username requested",
        result: "ok",
        use_case: "manage_community",
        identity_id: person.identityId,
      };
      return;
    }
    if (
      action.kind === "block-member" ||
      action.kind === "remove-allowed-username"
    ) {
      const result =
        action.kind === "block-member"
          ? runtime.identity.block === undefined
            ? {
                kind: "unavailable" as const,
                cause: new Error("community administration is not configured"),
              }
            : await runtime.identity.block(
                person,
                tokenToUuid(action.token),
                rpcCall(ctx, "manage_community"),
              )
          : runtime.identity.removeAllowedUsername === undefined
            ? {
                kind: "unavailable" as const,
                cause: new Error("community administration is not configured"),
              }
            : await runtime.identity.removeAllowedUsername(
                person,
                action.username,
                rpcCall(ctx, "manage_community"),
              );
      // Чем кончилось нажатие, говорит ответ на него: экран после действия
      // показывает уже ту же страницу списка.
      const toast =
        result.kind === "ok"
          ? result.value
            ? action.kind === "block-member"
              ? "Доступ закрыт."
              : "Ник убран."
            : "Состояние уже было актуальным."
          : result.kind === "invalid"
            ? "Изменение не сохранилось. Экран перечитан заново."
            : result.kind === "forbidden"
              ? "Это может только администратор."
              : "Не получилось сохранить. Попробуй ещё раз.";
      await waiting.answer(toast);
      // Закрытый уходит из списка, и экран возвращается на его страницу.
      // Отказ оставляет карточку того же человека: список без него выглядел бы
      // так, будто доступ закрыт.
      if (action.kind === "block-member" && result.kind !== "ok") {
        await renderCommunityMember(
          ctx,
          runtime,
          person,
          tokenToUuid(action.token),
          action.place,
          "card",
        );
      } else {
        await renderCommunity(
          ctx,
          runtime,
          person,
          action.kind === "block-member"
            ? { kind: "list", place: action.place }
            : { kind: "usernames", page: action.page },
        );
      }
      outcome = adminOutcome(result, person.identityId);
      return;
    }
    // Понижение до гостя (PER-642): Identity одной транзакцией меняет круг,
    // пишет заявку `declined` и событие `circle_changed`, по которому человеку
    // уходит весть о смене круга. Карточка перечитывается и показывает итог:
    // она говорит то, что сохранилось, а не то, что нажали.
    if (action.kind === "demote-member") {
      const identityId = tokenToUuid(action.token);
      const result =
        runtime.identity.demote === undefined
          ? {
              kind: "unavailable" as const,
              cause: new Error("community administration is not configured"),
            }
          : await runtime.identity.demote(
              person,
              identityId,
              rpcCall(ctx, "manage_community"),
            );
      const demoted = result.kind === "ok" && result.value;
      await waiting.answer(demoteToast(result));
      await renderCommunityMember(
        ctx,
        runtime,
        person,
        identityId,
        action.place,
        "card",
        demoted ? demotedNotice : undefined,
      );
      outcome = adminOutcome(result, person.identityId);
      return;
    }
    if (action.kind === "settings") {
      await showScreen(ctx, settingsScreen());
      outcome = {
        level: "info",
        message: "settings sent",
        result: "ok",
        use_case: useCase,
      };
      return;
    }
    if (action.kind === "help") {
      outcome = await openHelp(ctx, runtime, person, useCase);
      return;
    }
    if (action.kind === "release-notes") {
      outcome = await openReleaseNotes(ctx, runtime, person, action, useCase);
      return;
    }
    // «Расширения» в «Настройках» (PER-605): только список расширений (№74),
    // ни Notifications, ни Auction экран не зовёт.
    if (action.kind === "settings-extensions") {
      await showScreen(
        ctx,
        settingsExtensionsScreen(runtime.auction !== undefined),
      );
      outcome = {
        level: "info",
        message: "settings extensions sent",
        result: "ok",
        use_case: useCase,
      };
      return;
    }
    // «Аукцион» в «Расширениях» настроек (№74): Notifications экран не зовёт —
    // настройки читает экран «Уведомления» за ним. Идущий аукцион для пункта
    // «Имя в аукционе» (PER-595) читается у Auction; отказ убирает пункт, а не
    // роняет экран: уведомления от него не зависят. Кнопка из сборки с
    // Auction в сборке без него открывает пустые «Расширения».
    if (action.kind === "settings-auction") {
      if (runtime.auction === undefined) {
        await showScreen(ctx, settingsExtensionsScreen(false));
      } else {
        const current = await runtime.auction.currentAuction(
          person,
          rpcCall(ctx, useCase),
        );
        await showScreen(
          ctx,
          settingsAuctionScreen(
            current.kind === "ok" ? current.auctionId : undefined,
          ),
        );
      }
      outcome = {
        level: "info",
        message: "settings auction sent",
        result: "ok",
        use_case: useCase,
      };
      return;
    }
    if (action.kind === "meetup-extensions") {
      outcome = await openMeetupExtensions(
        ctx,
        runtime,
        person,
        action.token,
        useCase,
      );
      return;
    }
    if (action.kind === "next") {
      outcome = await openNextMeetup(ctx, runtime, person, useCase);
      return;
    }
    if (action.kind === "events") {
      outcome = await openEvents(ctx, runtime, person, useCase);
      return;
    }
    // «‹ Меню» и прежние кнопки «Меню» открывают корневое меню (PER-592).
    if (action.kind === "home") {
      outcome = await openMenu(ctx, runtime, person, useCase);
      return;
    }
    if (action.kind === "hub" || action.kind === "outdated") {
      outcome = await openNavScreen(
        ctx,
        runtime,
        person,
        "hub",
        useCase,
        action.kind === "hub" ? action.page : undefined,
      );
      return;
    }
    if (action.kind === "archive") {
      outcome = await openNavScreen(
        ctx,
        runtime,
        person,
        "archive",
        useCase,
        action.page,
      );
      return;
    }
    if (action.kind === "view-meetup") {
      const meetupId = tokenToUuid(action.token);
      const result = await runtime.dispatcher.execute({
        identity: person,
        intent: "view-meetup",
        meetupId,
        ...rpcCall(ctx, useCase),
      });
      await renderMeetupCard(
        ctx,
        result,
        true,
        runtime.presentation ?? "rich",
        canManageMeetups(person),
      );
      outcome = screenBoundary(result, {
        ok: ["meetup-card"],
        okMessage: "meetup card sent",
        rejectedMessage: "meetup card rejected",
        useCase,
        meetupId,
      });
      return;
    }
    if (
      action.kind === "manage-edit" ||
      action.kind === "manage-field" ||
      action.kind === "manage-draft" ||
      action.kind === "manage-status" ||
      action.kind === "manage-unpublish" ||
      action.kind === "manage-cancel" ||
      action.kind === "manage-hold" ||
      action.kind === "manage-publish" ||
      action.kind === "manage-publish-later" ||
      action.kind === "manage-unschedule" ||
      action.kind === "manage-retry-past-schedule"
    ) {
      const meetupId = tokenToUuid(action.token);
      const current = await runtime.dispatcher.execute({
        identity: person,
        intent: "view-meetup",
        meetupId,
        ...(action.kind === "manage-cancel"
          ? { withCancelConsequence: true as const }
          : {}),
        ...rpcCall(ctx, useCase),
      });
      if (current.kind !== "meetup-card") {
        await renderMeetupCard(
          ctx,
          current,
          true,
          runtime.presentation ?? "rich",
          true,
        );
        outcome = screenBoundary(current, {
          ok: ["meetup-card"],
          okMessage: "meetup management opened",
          rejectedMessage: "meetup management rejected",
          useCase,
          meetupId,
        });
        return;
      }
      const meetup = current.meetup;
      const token = uuidToToken(meetup.id);
      if (meetup.lifecycle === "cancelled") {
        await showRefusal(
          ctx,
          `Сходка «${meetup.title}» уже отменена. Изменять её больше нельзя.`,
          exitToCard(token),
        );
        outcome = {
          level: "info",
          message: "cancelled meetup management handled",
          result: "ok",
          use_case: "update_meetup",
          meetup_id: meetup.id,
        };
        return;
      }
      if (action.kind === "manage-edit") {
        await showScreen(ctx, editFieldsScreen(meetup));
      } else if (action.kind === "manage-field") {
        await renderFormResult(
          ctx,
          {
            kind: "edit-ask",
            field: action.field,
            meetup,
          },
          questions,
          runtime.presentation ?? "rich",
        );
      } else if (action.kind === "manage-draft" && action.field !== undefined) {
        // Под устаревшим черновиком сходку уже опубликовали: вопрос идёт как
        // точечная правка, и ответ вернёт карточку, а не черновик.
        await renderFormResult(
          ctx,
          {
            kind: meetup.visibility === "visible" ? "edit-ask" : "ask",
            field: action.field,
            meetup,
          },
          questions,
          runtime.presentation ?? "rich",
        );
      } else if (action.kind === "manage-draft") {
        // Опубликованная сходка уже не черновик: устаревшая кнопка и «Отмена»
        // под вопросом открывают её обычной карточкой.
        if (meetup.visibility === "visible") {
          await renderMeetupCard(
            ctx,
            current,
            true,
            runtime.presentation ?? "rich",
            true,
          );
        } else {
          await showScreen(
            ctx,
            draftScreen({
              meetup,
              presentation: runtime.presentation ?? "rich",
              today: communityToday(ctx),
            }),
          );
        }
      } else if (action.kind === "manage-retry-past-schedule") {
        // Кадр подтверждения одноразовый: он правится в экран выбора даты,
        // и старое «Сохранить дату» не откатит дату позже.
        await renderFormResult(
          ctx,
          {
            kind: action.editing ? "edit-ask" : "ask",
            field: "schedule",
            meetup,
          },
          questions,
          runtime.presentation ?? "rich",
        );
      } else if (action.kind === "manage-status") {
        await showScreen(
          ctx,
          statusScreen(meetup, current.author, communityToday(ctx)),
        );
      } else if (
        action.kind === "manage-cancel" &&
        meetup.lifecycle === "held"
      ) {
        await showRefusal(
          ctx,
          "Состоявшуюся сходку отменить нельзя.",
          exitToCard(token),
        );
      } else if (action.kind === "manage-hold" && meetup.lifecycle === "held") {
        // Устаревшая кнопка: кто-то уже отметил сходку состоявшейся. Confirm
        // здесь был бы подтверждением действия, которое уже не изменит
        // состояние, — то же обращение со stale-кнопкой, что и у отмены выше.
        await showRefusal(
          ctx,
          "Сходка уже отмечена состоявшейся.",
          exitToCard(token),
        );
      } else if (
        action.kind === "manage-publish-later" &&
        meetup.visibility === "visible"
      ) {
        // Устаревшая кнопка (E-04): сходку уже опубликовали — вручную или по
        // расписанию. Вопрос о моменте здесь закончился бы отказом домена.
        await showRefusal(
          ctx,
          "Сходка уже опубликована. Назначать публикацию больше не нужно.",
          exitToCard(token),
        );
      } else if (
        action.kind === "manage-publish-later" &&
        meetup.title.trim() === ""
      ) {
        // Черновик без названия Meetups опубликовать не даст ни сразу, ни по
        // расписанию (PER-457): вопрос о моменте закончился бы отказом домена.
        // Название добавляется на карточке через «Изменить».
        await showRefusal(ctx, untitledPublicationText, exitToCard(token));
      } else if (action.kind === "manage-publish-later") {
        await renderFormResult(
          ctx,
          { kind: "ask-publish-moment", meetup },
          questions,
          runtime.presentation ?? "rich",
          action.origin,
        );
      } else if (
        action.kind === "manage-unschedule" &&
        meetup.publishAt === undefined
      ) {
        await showRefusal(
          ctx,
          "Отложенной публикации у сходки уже нет.",
          exitToCard(token),
        );
      } else if (
        action.kind === "manage-publish" &&
        meetup.visibility === "visible"
      ) {
        // Устаревшая кнопка: сходку уже опубликовали — вручную или по
        // расписанию. Подтверждать нечего.
        await renderMeetupCard(
          ctx,
          current,
          true,
          runtime.presentation ?? "rich",
          true,
          `Сходка уже опубликована. Ссылка для чата: ${meetupStartLink(ctx.me.username, meetup.id)}`,
        );
      } else if (
        action.kind === "manage-publish" &&
        meetup.title.trim() === ""
      ) {
        // Без названия Meetups сходку не опубликует (PER-457): подтверждение
        // закончилось бы отказом домена.
        await showRefusal(ctx, untitledPublishText, exitToCard(token));
      } else if (action.kind === "manage-publish") {
        // Публикация выходит наружу — через подтверждение (решение владельца
        // 10 октября 2026 года); «Да» несёт версию этого снимка.
        await showScreen(
          ctx,
          publishConfirmScreen({ meetup, origin: action.origin }),
        );
      } else {
        // Все действия смены состояния живут в «Статусе», и отказ от
        // подтверждения возвращает туда.
        await showScreen(
          ctx,
          stateConfirmScreen({
            action: stateActionByCallback[action.kind],
            meetup,
            back: `v1:manage:status:${token}`,
            ...(current.cancelConsequence === undefined
              ? {}
              : { consequence: current.cancelConsequence }),
          }),
        );
      }
      outcome = {
        level: "info",
        message: "meetup management step sent",
        result: "ok",
        use_case: "update_meetup",
        meetup_id: meetup.id,
      };
      return;
    }
    if (
      action.kind === "manage-confirm-unpublish" ||
      action.kind === "manage-confirm-cancel" ||
      action.kind === "manage-confirm-hold" ||
      action.kind === "manage-confirm-unschedule"
    ) {
      const meetupId = tokenToUuid(action.token);
      const result = await runtime.dispatcher.execute({
        identity: person,
        intent: "change-meetup-state",
        action: stateActionByCallback[action.kind],
        meetupId,
        ...(action.version === undefined
          ? {}
          : { expectedVersion: action.version }),
        ...rpcCall(ctx, useCase),
      });
      await renderStateResult(ctx, result, runtime.presentation ?? "rich");
      outcome = screenBoundary(result, {
        ok: ["meetup-state-changed", "meetup-state-unchanged"],
        okMessage: "meetup state handled",
        rejectedMessage: "meetup state rejected",
        useCase,
        meetupId,
      });
      return;
    }
    if (action.kind === "manage-pick-day") {
      // Экран выбора даты правится на месте: день сменяется временем. Сервис
      // здесь не нужен.
      await showScreen(
        ctx,
        datePresetsScreen({
          picker: { token: action.token, mode: action.mode },
          today: communityToday(ctx),
          picked: action.picked,
        }),
      );
      outcome = {
        level: "info",
        message: "schedule presets shown",
        result: "ok",
        use_case: useCase,
        meetup_id: tokenToUuid(action.token),
      };
      return;
    }
    if (action.kind === "manage-type-schedule") {
      // «Ввести дату»: экран выбора уступает место вопросу. Он удаляется, а не
      // остаётся без кнопок — иначе над вопросом висел бы тот же вопрос.
      // Удаление идёт после отправки вопроса: упавшая отправка не должна
      // оставить человека без обоих.
      const meetupId = tokenToUuid(action.token);
      ctx.pressedGone = true;
      const origin = publishOriginOf(action.mode);
      await askQuestion(
        ctx,
        questions,
        origin === undefined
          ? {
              kind: "meetup",
              mode: action.mode === "e" ? "edit" : "create",
              field: "schedule",
              meetupId,
              telegramUserId: ctx.from?.id ?? 0,
            }
          : {
              kind: "publish-moment",
              meetupId,
              origin,
              telegramUserId: ctx.from?.id ?? 0,
            },
        origin === undefined ? formPrompts.schedule : publishMomentPrompt,
      );
      if (!(await deletePressed(ctx))) await clearCallbackKeyboard(ctx);
      outcome = {
        level: "info",
        message: "schedule question asked",
        result: "ok",
        use_case: useCase,
        meetup_id: meetupId,
      };
      return;
    }
    if (
      action.kind === "manage-confirm-past-schedule" ||
      action.kind === "manage-pick-schedule"
    ) {
      // Кадр подтверждения одноразовый: его кнопки снимаются до команды, чтобы
      // нажатие после «Нет» не переписало дату ещё раз.
      if (action.kind === "manage-confirm-past-schedule") {
        await clearCallbackKeyboard(ctx);
      }
      const meetupId = tokenToUuid(action.token);
      // Кнопка времени несёт тот же ответ, что и текст, и идёт тем же разбором:
      // дата сходки — в форму, момент публикации — в назначение. Экран выбора
      // правится в результат на месте, а при сбое сервиса остаётся как был.
      const origin =
        action.kind === "manage-pick-schedule"
          ? publishOriginOf(action.mode)
          : undefined;
      const editing =
        action.kind === "manage-pick-schedule"
          ? action.mode === "e"
          : action.editing;
      const result = await runtime.dispatcher.execute(
        origin !== undefined
          ? {
              identity: person,
              intent: "schedule-publication",
              value: action.value,
              meetupId,
              ...rpcCall(ctx, useCase),
            }
          : {
              identity: person,
              intent: editing ? "update-meetup-field" : "set-meetup-field",
              field: "schedule",
              value: action.value,
              meetupId,
              ...(action.kind === "manage-confirm-past-schedule"
                ? { confirmedPast: true as const }
                : {}),
              ...rpcCall(ctx, useCase),
            },
      );
      await renderFormResult(
        ctx,
        result,
        questions,
        runtime.presentation ?? "rich",
        origin,
      );
      outcome = screenBoundary(result, {
        ok: [
          "ask",
          "edit-ask",
          "draft",
          "meetup-updated",
          "edit-unavailable",
          "confirm-past-schedule",
          "ask-publish-moment",
          "publication-scheduled",
          "publication-unavailable",
        ],
        okMessage:
          action.kind === "manage-pick-schedule"
            ? "meetup date picked"
            : "past meetup date confirmed",
        rejectedMessage:
          action.kind === "manage-pick-schedule"
            ? "meetup date pick rejected"
            : "past meetup date rejected",
        useCase,
        meetupId,
      });
      return;
    }
    if (action.kind === "manage-hidden") {
      // Отдельного запроса нет: правило видимости ADR-022 уже отдало скрытые
      // сходки только тем, кому их можно видеть, и экран лишь выбирает их из
      // того же списка. Постороннему раздел поэтому показывает пустоту.
      const result = await runtime.dispatcher.execute({
        identity: person,
        intent: "list-visible-meetups",
        ...rpcCall(ctx, useCase),
      });
      await renderHiddenMeetupList(ctx, result, action.page);
      outcome = screenBoundary(result, {
        ok: ["meetup-list"],
        okMessage: "hidden meetup list sent",
        rejectedMessage: "hidden meetup list rejected",
        useCase,
      });
      return;
    }
    if (
      action.kind === "begin-meetup-broadcast" ||
      action.kind === "begin-community-broadcast"
    ) {
      const audience: BroadcastAudience =
        action.kind === "begin-meetup-broadcast"
          ? { kind: "meetup", meetupId: tokenToUuid(action.token) }
          : { kind: "community" };
      const meetupId =
        audience.kind === "meetup" ? audience.meetupId : undefined;
      // Кнопка входа есть только у администратора, но `callback_data` можно
      // прислать и без неё. Отказ приходит до набора текста, а окончательное
      // решение о праве всё равно принимает Notifications на отправке.
      if (!canManageMeetups(person)) {
        await showRefusal(
          ctx,
          broadcastForbiddenText[audience.kind],
          broadcastExit(audience),
        );
        outcome = broadcastForbiddenOutcome(person, meetupId);
        return;
      }
      let question = communityBroadcastPrompt;
      let meetupTitle: string | undefined;
      if (meetupId !== undefined) {
        const current = await runtime.dispatcher.execute({
          identity: person,
          intent: "view-meetup",
          meetupId,
          ...rpcCall(ctx, useCase),
        });
        if (current.kind !== "meetup-card") {
          await renderMeetupCard(
            ctx,
            current,
            true,
            runtime.presentation ?? "rich",
            true,
          );
          outcome = screenBoundary(current, {
            ok: ["meetup-card"],
            okMessage: "broadcast meetup reread",
            rejectedMessage: "broadcast meetup rejected",
            useCase,
            meetupId,
          });
          return;
        }
        meetupTitle = current.meetup.title;
        question = meetupBroadcastPrompt(meetupTitle);
      }
      await askQuestion(
        ctx,
        questions,
        {
          kind: "broadcast-body",
          audience,
          ...(meetupTitle === undefined ? {} : { meetupTitle }),
          telegramUserId: ctx.from?.id ?? 0,
        },
        question,
      );
      outcome = {
        level: "info",
        message: "broadcast body requested",
        result: "ok",
        use_case: useCase,
        ...(meetupId === undefined ? {} : { meetup_id: meetupId }),
        identity_id: person.identityId,
      };
      return;
    }
    if (action.kind === "cancel-broadcast") {
      // «Нет» под текстом, который человек только что прислал, — экран исхода
      // с «Ввести заново» (решение владельца 10 октября 2026 года): текст в
      // кнопку не помещается, и вопрос задаётся снова с начала.
      const step: QuestionStep =
        action.token === undefined
          ? { kind: "broadcast" }
          : { kind: "broadcast", token: action.token };
      await showScreen(ctx, {
        id: "outcome",
        text: outcomeText("Не отправлено. Текст никуда не ушёл."),
        keyboard: withNav(
          new InlineKeyboard().text(retryAnswerLabel, reopenData(step)),
          answerParent(step),
        ),
        format: "HTML",
      });
      outcome = {
        level: "info",
        message: "broadcast cancelled",
        result: "ok",
        use_case: useCase,
        identity_id: person.identityId,
      };
      return;
    }
    if (
      action.kind === "confirm-meetup-broadcast" ||
      action.kind === "confirm-community-broadcast"
    ) {
      const audience: BroadcastAudience =
        action.kind === "confirm-meetup-broadcast"
          ? { kind: "meetup", meetupId: tokenToUuid(action.token) }
          : { kind: "community" };
      const meetupId =
        audience.kind === "meetup" ? audience.meetupId : undefined;
      const body = parseBroadcastPreview(ctx.callbackQuery?.message, ctx.me.id);
      if (body === undefined) {
        await showRefusal(
          ctx,
          "Этот экран подтверждения устарел, и текста рассылки в нём больше нет. Начни рассылку заново. Ничего не отправлено.",
          broadcastExit(audience),
        );
        outcome = {
          level: "warn",
          message: "broadcast confirmation malformed",
          result: "error",
          use_case: useCase,
          ...(meetupId === undefined ? {} : { meetup_id: meetupId }),
          identity_id: person.identityId,
          error_category: "invariant",
          error: "broadcast confirmation failed validation",
        };
        return;
      }
      // Права бот здесь не проверяет: вход он уже скрыл, а отказ по праву
      // обязан прийти от Notifications, чтобы вызов мимо кадра отклонялся тем
      // же путём, что и нажатие в нём.
      const result = await runtime.dispatcher.execute({
        identity: person,
        intent: "send-broadcast",
        audience,
        broadcastId: tokenToUuid(action.broadcastToken),
        body,
        ...rpcCall(ctx, useCase),
      });
      await renderBroadcastResult(ctx, result, audience, retryCallback);
      outcome = {
        ...screenBoundary(result, {
          ok: ["broadcast-accepted"],
          okMessage: "broadcast accepted",
          rejectedMessage: "broadcast rejected",
          useCase,
          ...(meetupId === undefined ? {} : { meetupId }),
        }),
        identity_id: person.identityId,
      };
      return;
    }
    if (action.kind === "manage-menu") {
      await showScreen(ctx, manageScreen(person));
      outcome = {
        level: "info",
        message: "manage menu sent",
        result: "ok",
        use_case: useCase,
      };
      return;
    }
    if (action.kind === "manage-group") {
      await showScreen(
        ctx,
        manageGroupScreen(
          person,
          action.group,
          uuidToToken(createUuidV7()),
          action.group === "applications"
            ? await readApplicationCounts(ctx, runtime, person)
            : undefined,
        ),
      );
      outcome = {
        level: "info",
        message: "manage group sent",
        result: "ok",
        use_case: useCase,
      };
      return;
    }
    // «Создать сходку» Meetups не зовёт: она задаёт вопрос о названии, а
    // черновик рождается ответом (прогон 14.10, №14 и №54). Id будущей сходки
    // едет в вопросе, поэтому ответ после рестарта создаёт ту же сходку.
    if (action.kind === "create-meetup") {
      await askQuestion(
        ctx,
        questions,
        {
          kind: "meetup",
          mode: "create",
          field: "title",
          meetupId: tokenToUuid(action.token),
          fresh: action.from ?? "manage",
          telegramUserId: ctx.from?.id ?? 0,
        },
        formPrompts.title,
      );
      outcome = {
        level: "info",
        message: "meetup title requested",
        result: "ok",
        use_case: useCase,
        identity_id: person.identityId,
      };
      return;
    }
    if (
      action.kind === "publish-meetup" ||
      action.kind === "manage-confirm-publish"
    ) {
      const meetupId = tokenToUuid(action.token);
      const result = await runtime.dispatcher.execute({
        identity: person,
        intent: "publish-meetup",
        meetupId,
        ...(action.version === undefined
          ? {}
          : { expectedVersion: action.version }),
        ...rpcCall(ctx, useCase),
      });
      if (result.kind === "conflict" && action.version !== undefined) {
        // Подтверждение устарело, пока человек решал: заново оно не задаётся,
        // приходит исход, и публикацию человек повторяет по свежим данным.
        await showScreen(ctx, {
          id: "outcome",
          text: outcomeText(
            conflictText,
            meetupTitleLabel(result.meetup.title),
          ),
          keyboard: exitToCard(uuidToToken(result.meetup.id)),
          format: "HTML",
        });
      } else if (result.kind === "published" && result.repeated === true) {
        // Повтор (E-09) и устаревший предпросмотр (E-04): карточка по текущему
        // состоянию вместо второго «Сходка создана». При повторе правка стирает
        // сообщение первой публикации, поэтому ссылка для чата стоит на
        // карточке; при устаревшем предпросмотре она просто повторяется.
        await renderMeetupCard(
          ctx,
          cardFrom(result),
          true,
          runtime.presentation ?? "rich",
          true,
          `Сходка уже опубликована. Ссылка для чата: ${meetupStartLink(ctx.me.username, result.meetup.id)}`,
        );
      } else {
        await renderFormResult(
          ctx,
          result,
          questions,
          runtime.presentation ?? "rich",
        );
      }
      outcome = screenBoundary(result, {
        ok: ["published"],
        okMessage: "meetup published",
        rejectedMessage: "meetup publish rejected",
        useCase,
        meetupId,
      });
      return;
    }
    if (action.kind === "notify-global") {
      outcome = await openNavScreen(
        ctx,
        runtime,
        person,
        "notify-global",
        useCase,
      );
      return;
    }
    if (action.kind === "notify-set-global") {
      const result = await runtime.dispatcher.execute({
        identity: person,
        intent: "set-global-category",
        category: action.category,
        enabled: action.enabled,
        ...rpcCall(ctx, useCase),
      });
      if (result.kind === "global-notification-settings") {
        await waiting.answer(toggleToast(action.category, action.enabled));
      }
      await renderNotificationSettings(
        ctx,
        result,
        "v1:notify:global",
        categoryForbiddenText(action.category),
      );
      outcome = screenBoundary(result, {
        ok: ["global-notification-settings"],
        okMessage: "global notification settings sent",
        rejectedMessage: "global notification settings rejected",
        useCase,
      });
      return;
    }
    // Настройки уведомлений аукциона (PER-552, PER-539, PER-645): частота
    // «перебили», «перебили» в живом финале и анонс финала. Выбор — целевое значение, и экран с подтверждением
    // показывают то, что ответил Notifications. Подтверждение уходит до показа
    // экрана: показ ответил бы на нажатие сам. «Частота уведомлений» под вестью
    // о торгах открывает тот же экран новым сообщением (`v1:t:`), а повтор
    // после сбоя — уже на месте, без следа.
    if (
      action.kind === "notify-outbid" ||
      action.kind === "notify-set-outbid" ||
      action.kind === "notify-set-final" ||
      action.kind === "notify-set-live" ||
      action.kind === "notify-set-news"
    ) {
      const change: AuctionNotificationChange | undefined =
        action.kind === "notify-set-outbid"
          ? { kind: "frequency", frequency: action.frequency }
          : action.kind === "notify-set-final"
            ? { kind: "final", enabled: action.enabled }
            : action.kind === "notify-set-live"
              ? { kind: "live", enabled: action.enabled }
              : action.kind === "notify-set-news"
                ? { kind: "announcements", enabled: action.enabled }
                : undefined;
      // Из вести экран открывается без возврата в дерево настроек (№73
      // прогона 14 октября 2026 года): след прежних вестей ведёт туда же.
      const detached = action.trace === true || action.detached === true;
      const result = await runtime.dispatcher.execute(
        change === undefined
          ? {
              identity: person,
              intent: "view-auction-notifications",
              ...rpcCall(ctx, useCase),
            }
          : {
              identity: person,
              intent: "set-auction-notifications",
              change,
              ...rpcCall(ctx, useCase),
            },
      );
      if (result.kind === "auction-notifications") {
        if (change !== undefined) {
          await waiting.answer(
            auctionNotificationsToast(change, result.settings),
          );
        }
        await showScreen(
          ctx,
          auctionNotificationsScreen(result.settings, detached),
        );
      } else {
        // Отвергнутый выбор не повторяется: экран устарел, и повтор
        // перечитывает его, а не шлёт то же значение.
        const stale =
          result.kind === "dependency-rejected" && result.reason === "invalid";
        await renderNotificationFailure(
          ctx,
          result,
          change === undefined || stale
            ? auctionNotificationsData(detached)
            : auctionNotificationsChangeData(change, detached),
        );
      }
      outcome = screenBoundary(result, {
        ok: ["auction-notifications"],
        okMessage: "auction notification settings sent",
        rejectedMessage: "auction notification settings rejected",
        useCase,
      });
      return;
    }
    // Кнопка из уведомления меняет ту же глобальную настройку, что и P-09, но
    // уведомление остаётся на месте: результат дописывается под ним, а отказ
    // приходит отдельным сообщением, чтобы не стереть то, о чём уведомляли.
    // Своей кнопки повтора у отказа нет: повтор — та же кнопка в уведомлении,
    // иначе успех дописался бы под текстом отказа, а не под уведомлением.
    if (action.kind === "notify-disable-global") {
      const result = await runtime.dispatcher.execute({
        identity: person,
        intent: "set-global-category",
        category: action.category,
        enabled: false,
        ...rpcCall(ctx, useCase),
      });
      if (result.kind === "global-notification-settings") {
        await confirmCategoryDisabled(ctx, {
          note: globalCategoryDisabledNote(action.category),
          settings: {
            text: "Настроить уведомления",
            data: traceCallback("v1:notify:global"),
          },
        });
      } else {
        await showRefusal(
          ctx,
          result.kind === "dependency-rejected" && result.reason === "forbidden"
            ? categoryForbiddenText(action.category)
            : unavailableText,
          exitToMeetups(),
          "new",
        );
      }
      outcome = screenBoundary(result, {
        ok: ["global-notification-settings"],
        okMessage: "notification category disabled",
        rejectedMessage: "notification category disable rejected",
        useCase,
      });
      return;
    }
    // То же, что отключение из уведомления о новой сходке, но у одной сходки:
    // результат дописывается под уведомлением, отказ и исчезнувшая сходка
    // приходят отдельным сообщением, а текст уведомления остаётся.
    if (action.kind === "notify-disable-meetup") {
      const meetupId = tokenToUuid(action.token);
      const result = await runtime.dispatcher.execute({
        identity: person,
        intent: "set-meetup-category",
        meetupId,
        category: action.category,
        enabled: false,
        ...rpcCall(ctx, useCase),
      });
      if (result.kind === "meetup-notification-settings") {
        await confirmCategoryDisabled(ctx, {
          note: meetupCategoryDisabledNote(action.category),
          settings: {
            text: meetupNotificationsLabel,
            data: traceCallback(`v1:notify:settings:${action.token}`),
          },
        });
      } else if (result.kind === "meetup-not-found") {
        // Настройка пишется раньше, чем читается карточка, поэтому «не
        // найдена» не значит «не выключено»: сходку могли скрыть между
        // уведомлением и нажатием. Текст не обещает ни того, ни другого, а
        // говорит то, что верно в обоих случаях.
        await showRefusal(
          ctx,
          "Сходка больше недоступна: пока её снова не опубликуют, уведомлений по ней не будет.",
          exitToMeetups(),
          "new",
        );
      } else {
        await showRefusal(
          ctx,
          result.kind === "dependency-rejected" && result.reason === "forbidden"
            ? forbiddenText
            : unavailableText,
          exitToMeetups(),
          "new",
        );
      }
      outcome = screenBoundary(result, {
        ok: ["meetup-notification-settings"],
        okMessage: "meetup notification category disabled",
        rejectedMessage: "meetup notification category disable rejected",
        useCase,
        meetupId,
      });
      return;
    }
    // Подписка и отписка отвечают экраном исхода (PER-472, решение владельца
    // 10 октября 2026 года): исход не стоит над карточкой, а карточку человек
    // открывает возвратом «‹ Сходка» и видит на ней обновлённую кнопку.
    if (action.kind === "notify-subscription") {
      const meetupId = tokenToUuid(action.token);
      const result = await runtime.dispatcher.execute({
        identity: person,
        intent: "set-meetup-subscription",
        meetupId,
        subscribed: action.subscribed,
        ...rpcCall(ctx, useCase),
      });
      if (result.kind === "meetup-card") {
        // Пояснение разовое: оно отвечает на нажатие и при следующем открытии
        // карточки не повторяется, чтобы подписанному не читать его каждый
        // раз. Поэтому его собирает этот обработчик, а не рендер карточки.
        await showScreen(
          ctx,
          subscriptionOutcomeScreen(
            action.token,
            result.meetup.title,
            action.subscribed,
            action.subscribed && result.categories !== undefined
              ? subscriptionExplanation(result.categories)
              : undefined,
          ),
        );
      } else if (result.kind === "meetup-not-found") {
        await renderMeetupCard(
          ctx,
          result,
          true,
          runtime.presentation ?? "rich",
          canManageMeetups(person),
        );
      } else {
        await renderNotificationFailure(ctx, result, `v1:view:${action.token}`);
      }
      outcome = screenBoundary(result, {
        ok: ["meetup-card"],
        okMessage: "meetup subscription changed",
        rejectedMessage: "meetup subscription rejected",
        useCase,
        meetupId,
      });
      return;
    }
    if (
      action.kind === "notify-settings" ||
      action.kind === "notify-set-meetup"
    ) {
      const meetupId = tokenToUuid(action.token);
      const call = { ...rpcCall(ctx, useCase) };
      const result = await runtime.dispatcher.execute(
        action.kind === "notify-settings"
          ? {
              identity: person,
              intent: "view-meetup-notifications",
              meetupId,
              ...call,
            }
          : {
              identity: person,
              intent: "set-meetup-category",
              meetupId,
              category: action.category,
              enabled: action.enabled,
              ...call,
            },
      );
      // Сходка могла исчезнуть между отрисовкой кнопки и нажатием: кадр
      // настроек читает её ради заголовка и отвечает тем же «не найдено», что и
      // карточка, а не пустым списком категорий.
      if (result.kind === "meetup-not-found") {
        await renderMeetupCard(
          ctx,
          result,
          true,
          runtime.presentation ?? "rich",
        );
      } else {
        if (
          action.kind === "notify-set-meetup" &&
          result.kind === "meetup-notification-settings"
        ) {
          await waiting.answer(toggleToast(action.category, action.enabled));
        }
        await renderNotificationSettings(
          ctx,
          result,
          `v1:notify:settings:${action.token}`,
        );
      }
      outcome = screenBoundary(result, {
        ok: ["meetup-notification-settings"],
        okMessage: "meetup notification settings sent",
        rejectedMessage: "meetup notification settings rejected",
        useCase,
        meetupId,
      });
      return;
    }
    // «Включить аукцион» видит только держатель права вести аукцион, но старая
    // кнопка остаётся в чате: отказ приходит до Auction (PER-654).
    if (action.kind === "enable-auction") {
      outcome = canRunAuctions(person)
        ? await enableAuction(ctx, runtime, person, action.token)
        : await refuseEnableAuction(ctx, person, action.token);
      return;
    }
    const _exhaustive: never = action;
    outcome = unexpectedOutcome(
      `unhandled callback ${_exhaustive}`,
      undefined,
      useCase,
    );
  } catch (cause) {
    if (isScreenDeliveryFailure(cause)) {
      outcome = await replyScreenFailure({
        ctx,
        cause,
        previous: outcome,
        useCase,
      });
    } else if (outcome === undefined) {
      outcome = unexpectedOutcome(cause, undefined, useCase);
    } else if (outcome.result === "error") {
      outcome = { ...outcome, reply_error: errorText(cause) };
    }
  } finally {
    await waiting.finish();
    if (outcome !== undefined) {
      writeBoundary(runtime.logger, ctx, outcome);
    }
  }
}

// Кнопка подтверждения прошлого релиза не несёт версии, по которой человек
// решал, а команда без неё Meetups не принимает. Решение по такой кнопке
// равносильно устаревшему экрану: человек получает кадр конфликта по текущей
// карточке и подтверждает её версию заново. Прежде кадра карточка отвечает
// тем же, что ответил бы Meetups: достигнутая цель — успех, отмена — отказ по
// состоянию, нет права — отказ по праву. Иначе кадр предлагал бы подтвердить
// заведомо невыполнимое или уже сделанное.
async function unversionedConfirmation(
  runtime: BotRuntime,
  person: Person,
  meetupId: string,
  call: RpcMetadata,
  target: {
    reached: (meetup: MeetupSnapshot) => boolean;
    kind: "material-attached" | "material-removed";
  },
): Promise<ExecuteResult> {
  if (!canManageMeetups(person)) {
    return { kind: "dependency-rejected", reason: "forbidden" };
  }
  const current = await runtime.dispatcher.execute({
    identity: person,
    intent: "view-meetup",
    meetupId,
    ...call,
  });
  if (current.kind !== "meetup-card") return current;
  if (target.reached(current.meetup)) {
    return { kind: target.kind, meetup: current.meetup };
  }
  if (current.meetup.lifecycle === "cancelled") {
    return {
      kind: "dependency-rejected",
      reason: "invalid",
      cause: new Error("material confirmation on a cancelled meetup"),
      precondition: true,
    };
  }
  return { kind: "conflict", meetup: current.meetup };
}

// Подтверждение прикрепления живёт в сообщении с источником, поэтому после
// конфликта у него меняется только клавиатура. Повторная правка тем же
// содержимым и удалённое сообщение — ожидаемые отказы Telegram; в обоих
// случаях человек получает текст конфликта, а не тишину.
async function renewConfirmationKeyboard(
  ctx: UpdateContext,
  keyboard: InlineKeyboard,
): Promise<boolean> {
  try {
    await ctx.editMessageReplyMarkup({
      ...screenMark("material-confirm"),
      reply_markup: keyboard,
    });
    return true;
  } catch (cause) {
    return errorText(cause).includes("message is not modified");
  }
}

function confirmAttachCallback(
  meetupToken: string,
  materialToken: string,
  version: number,
): string {
  return `v1:mm:ca:${meetupToken}:${materialToken}:${version}`;
}

function confirmRemoveCallback(
  meetupToken: string,
  materialToken: string,
  version: number,
): string {
  return `v1:mm:cr:${meetupToken}:${materialToken}:${version}`;
}

// Клавиатура подтверждения прикрепления. Ключ материала и источник в ней
// постоянны, меняется только версия: после конфликта та же кнопка несёт версию
// перечитанной карточки.
function materialConfirmationKeyboard(
  meetupToken: string,
  materialToken: string,
  version: number,
  source: MeetupMaterialSource,
): InlineKeyboard {
  return confirmKeyboard({
    yes: "Да, прикрепить",
    yesData: confirmAttachCallback(meetupToken, materialToken, version),
    noData: `v1:mm:no:${meetupToken}`,
    ...(source.kind === "message-link"
      ? { lead: { text: "Открыть источник ↗", url: source.url } }
      : {}),
  });
}

async function sendMaterialConfirmation(
  ctx: UpdateContext,
  meetupId: string,
  version: number,
  title: string,
  source: MaterialInputSource,
): Promise<void> {
  const other = {
    ...screenMark("material-confirm"),
    parse_mode: "HTML" as const,
    reply_markup: materialConfirmationKeyboard(
      uuidToToken(meetupId),
      uuidToToken(createUuidV7()),
      version,
      source,
    ),
  };
  const text = materialConfirmationHtml(title, escapeHtml);
  if (source.kind === "message-link") {
    await ctx.reply(text, other);
  } else if (source.fileKind === "document") {
    await ctx.replyWithDocument(source.fileId, { caption: text, ...other });
  } else {
    await ctx.replyWithPhoto(source.fileId, { caption: text, ...other });
  }
}

// Подтверждение удаления: исчезнет только привязка, оригинал остаётся.
function removeConfirmScreen(confirm: {
  token: string;
  materialToken: string;
  version: number;
  title: string;
}): ShownScreen {
  return {
    id: "material-remove-confirm",
    text: [
      heading("Убрать материал?"),
      "",
      `${confirm.title === "" ? "Привязка" : `«${escapeHtml(confirm.title)}»`} исчезнет из сходки. Оригинал в Telegram останется на месте.`,
    ].join("\n"),
    keyboard: confirmKeyboard({
      yes: "Да, убрать материал",
      yesData: confirmRemoveCallback(
        confirm.token,
        confirm.materialToken,
        confirm.version,
      ),
      noData: `v1:mm:list:${confirm.token}`,
      irreversible: true,
    }),
    format: "HTML",
  };
}

// Файл уходит тем видом, каким записан. Второй вид остаётся запасным: у файла,
// прикреплённого до PER-443, вид не записан, и фото среди них читается
// документом. Под файлом — одна кнопка «‹ Материалы» (решение владельца по
// прогону 14 октября 2026 года, PER-644): список остаётся выше в чате, и без
// неё за следующим материалом пришлось бы листать вверх. Нажатие под файлом
// снимает с него кнопку и присылает «Материалы» новым сообщением.
async function sendStoredMaterialFile(
  ctx: UpdateContext,
  source: Extract<MeetupMaterialSource, { kind: "file" }>,
  title: string,
  token: string,
): Promise<{ kind: "sent" } | { kind: "failed"; cause: unknown }> {
  const other = {
    caption: title,
    reply_markup: withNav(new InlineKeyboard(), toMaterials(token)),
    ...screenMark("material-file"),
  };
  const asDocument = () => ctx.replyWithDocument(source.fileId, other);
  const asPhoto = () => ctx.replyWithPhoto(source.fileId, other);
  const [first, second] =
    source.fileKind === "photo" ? [asPhoto, asDocument] : [asDocument, asPhoto];
  try {
    await first();
    return { kind: "sent" };
  } catch (firstCause) {
    try {
      await second();
      return { kind: "sent" };
    } catch (secondCause) {
      return {
        kind: "failed",
        cause: new AggregateError(
          [firstCause, secondCause],
          "Telegram could not send the stored material file",
        ),
      };
    }
  }
}

async function renderMaterialManagement(
  ctx: UpdateContext,
  meetup: MeetupSnapshot,
  canManage = true,
  requestedPage = 0,
  fileTrace?: string,
): Promise<void> {
  await showScreen(ctx, {
    ...materialsScreen(meetup, canManage, requestedPage),
    ...(fileTrace === undefined ? {} : { fileTrace }),
  });
}

async function renderMaterialResult(
  ctx: UpdateContext,
  result: Awaited<ReturnType<Dispatcher["execute"]>>,
  meetupToken: string,
  fileTrace?: string,
): Promise<void> {
  if (result.kind === "material-attached") {
    await renderMaterialManagement(ctx, result.meetup, true, 0, fileTrace);
    return;
  }
  if (result.kind === "material-removed") {
    await renderMaterialManagement(ctx, result.meetup);
    return;
  }
  const text =
    result.kind === "dependency-rejected" && result.reason === "forbidden"
      ? materialForbiddenText
      : result.kind === "dependency-rejected" && result.reason === "invalid"
        ? invalidMeetupText(result)
        : unavailableText;
  await showRefusal(ctx, text, exitToCard(meetupToken));
}

function materialForbiddenOutcome(
  person: Person,
  meetupId: string,
): BoundaryOutcome {
  return {
    level: "warn",
    message: "material management rejected",
    result: "error",
    use_case: "update_meetup",
    meetup_id: meetupId,
    identity_id: person.identityId,
    error_category: "authorization",
    error: "material_action_forbidden",
  };
}

// Кадры рассылки. Число — сколько человек получит сообщение сейчас. Пока
// предпросмотр его не назвал, кадра отправки нет: `BroadcastAccepted`
// подтверждает приём, а не доставку.
const broadcastForbiddenText: Record<BroadcastAudience["kind"], string> = {
  meetup: "Писать подписчикам может только организатор сходки.",
  community: "Объявления сообществу доступны администратору.",
};
const broadcastBodyRetryText: Record<
  Exclude<ReturnType<typeof checkBroadcastBody>["kind"], "ok">,
  string
> = {
  empty: "Нужен текст сообщения. Пришли его ответом на это сообщение.",
  "too-long": `Текст длиннее ${broadcastBodyLimit} символов, а столько Telegram одним сообщением не отправит. Сократи его и пришли ответом на это сообщение.`,
  nul: "В тексте есть символ, который нельзя отправить. Пришли текст заново ответом на это сообщение.",
};
const communityBroadcastPrompt =
  "Что написать сообществу? Пришли текст объявления ответом на это сообщение. До отправки я покажу, как он выглядит, и спрошу подтверждение.";
const broadcastIrreversibleText =
  "Отменить отправку будет нельзя: отозвать сообщение у получателей невозможно.";

function meetupBroadcastPrompt(title: string): string {
  return `Что написать подписчикам сходки «${meetupTitleLabel(title)}»? Пришли текст ответом на это сообщение. До отправки я покажу, как он выглядит, и спрошу подтверждение.`;
}

function broadcastExit(
  audience: BroadcastAudience,
  keyboard = new InlineKeyboard(),
): InlineKeyboard {
  return withNav(
    keyboard,
    audience.kind === "meetup"
      ? toCard(uuidToToken(audience.meetupId))
      : toManage,
  );
}

function broadcastForbiddenOutcome(
  person: Person,
  meetupId: string | undefined,
): BoundaryOutcome {
  return {
    level: "warn",
    message: "broadcast rejected",
    result: "error",
    use_case: "send_broadcast",
    ...(meetupId === undefined ? {} : { meetup_id: meetupId }),
    identity_id: person.identityId,
    error_category: "authorization",
    error: "broadcast_forbidden",
  };
}

function broadcastCountLine(recipientCount: number): string {
  return recipientCount === 0
    ? "Сообщение никто не получит."
    : `Его получит ${plural(recipientCount, ["человек", "человека", "человек"])}.`;
}

function previewFailureText(
  result: ExecuteResult,
  audience: BroadcastAudience,
): string {
  if (result.kind === "dependency-rejected" && result.reason === "forbidden") {
    return `${broadcastForbiddenText[audience.kind]} Ничего не отправлено.`;
  }
  if (result.kind === "dependency-rejected" && result.reason === "invalid") {
    return "Сообщение не принято. Ничего не отправлено.";
  }
  if (
    result.kind === "dependency-rejected" &&
    (result.reason === "timeout" || result.reason === "unavailable")
  ) {
    return "Не получилось узнать, сколько человек получит сообщение. Это на моей стороне. Ничего не отправлено.\n\nПришли текст ещё раз ответом на вопрос.";
  }
  return "Не получилось узнать, сколько человек получит сообщение. Это на моей стороне. Ничего не отправлено.";
}

// Предпросмотр — сам текст отдельным сообщением, без заголовка и разметки:
// ровно тот текст автора, что уйдёт получателям (заголовок и кнопки канал
// добавит при доставке), и ровно то, что кнопка подтверждения потом прочтёт
// обратно. Кадр подтверждения отвечает на него и несёт ключ рассылки.
async function sendBroadcastConfirmation(
  ctx: UpdateContext,
  audience: BroadcastAudience,
  body: string,
  meetupTitle: string | undefined,
  recipientCount: number,
): Promise<void> {
  const preview = await ctx.reply(body);
  const broadcastToken = uuidToToken(createUuidV7());
  const confirm =
    audience.kind === "meetup"
      ? `v1:bc:ms:${uuidToToken(audience.meetupId)}:${broadcastToken}`
      : `v1:bc:cs:${broadcastToken}`;
  const recipients =
    audience.kind === "meetup"
      ? `Выше — текст для подписчиков сходки «${meetupTitleLabel(meetupTitle ?? "")}». Его получат те из них, у кого включены сообщения организатора.`
      : "Выше — текст объявления. Его получат участники сообщества, у которых включены объявления.";
  const question =
    audience.kind === "meetup"
      ? "Отправить подписчикам?"
      : "Отправить объявление?";
  await ctx.reply(
    `${heading(question)}\n\n${escapeHtml(recipients)}\n\n${escapeHtml(broadcastCountLine(recipientCount))}\n\n${broadcastIrreversibleText}`,
    {
      reply_parameters: { message_id: preview.message_id },
      parse_mode: "HTML",
      ...screenMark("broadcast-confirm"),
      reply_markup: confirmKeyboard({
        yes: "Да, отправить",
        yesData: confirm,
        noData:
          audience.kind === "meetup"
            ? `v1:bc:no:${uuidToToken(audience.meetupId)}`
            : "v1:bc:no",
        irreversible: true,
      }),
    },
  );
}

// Отказ Notifications отвечает кадром из принятого набора: E-01 по праву, E-05
// при недоступности, E-09 на повторе. «Повторить» после сбоя несёт тот же ключ
// рассылки, поэтому второго сообщения повтор не создаст.
async function renderBroadcastResult(
  ctx: UpdateContext,
  result: ExecuteResult,
  audience: BroadcastAudience,
  retry: string,
): Promise<void> {
  const back = broadcastExit(audience);
  if (result.kind === "broadcast-accepted") {
    await showFrame(
      ctx,
      "broadcast-result",
      result.repeated === true
        ? "Это сообщение уже принято к отправке раньше. Второй раз оно не уйдёт."
        : audience.kind === "meetup"
          ? "Сообщение принято к отправке подписчикам сходки."
          : "Объявление принято к отправке участникам сообщества.",
      back,
    );
    return;
  }
  if (result.kind === "dependency-rejected" && result.reason === "forbidden") {
    await showFrame(
      ctx,
      "broadcast-result",
      `${broadcastForbiddenText[audience.kind]} Ничего не отправлено.`,
      back,
    );
    return;
  }
  if (result.kind === "dependency-rejected" && result.reason === "invalid") {
    await showFrame(
      ctx,
      "broadcast-result",
      "Сообщение не принято. Ничего не отправлено.",
      back,
    );
    return;
  }
  if (result.kind === "dependency-rejected" && result.reason === "conflict") {
    await showFrame(
      ctx,
      "broadcast-result",
      "С этой кнопки уже отправлен другой текст. Начни рассылку заново.",
      back,
    );
    return;
  }
  // Сбой и истёкший срок ответа не говорят, принята ли рассылка: повтор с тем
  // же ключом это выяснит и второй раз её не разошлёт.
  await showFrame(
    ctx,
    "broadcast-result",
    "Не получилось подтвердить отправку. Это на моей стороне.\n\nНажми «Повторить» через минуту: второй раз сообщение не уйдёт.",
    broadcastExit(audience, new InlineKeyboard().text(retryLabel, retry)),
  );
}

function readCommunity(
  ctx: UpdateContext,
  runtime: BotRuntime,
  actor: Person,
  view: CommunityView,
): Promise<IdentityAdminResult<CommunitySnapshot>> {
  return runtime.identity.community === undefined
    ? Promise.resolve({
        kind: "unavailable" as const,
        cause: new Error("community administration is not configured"),
      })
    : runtime.identity.community(
        actor,
        view.kind === "list" ? view.place.filter : "members",
        rpcCall(ctx, "manage_community"),
      );
}

// Отказ возвращает на уровень выше экрана, который не открылся: со списка — в
// управление, с ников — в состав.
function showCommunityRefusal(
  ctx: UpdateContext,
  result: Exclude<IdentityAdminResult<unknown>, { kind: "ok" }>,
  view: CommunityView,
): Promise<void> {
  return showRefusal(
    ctx,
    result.kind === "forbidden" ? communityForbiddenText : unavailableText,
    withNav(
      new InlineKeyboard(),
      view.kind === "list" ? toManage : toCommunity,
    ),
  );
}

async function renderCommunity(
  ctx: UpdateContext,
  runtime: BotRuntime,
  actor: Person,
  view: CommunityView,
  notice?: string,
): Promise<IdentityAdminResult<CommunitySnapshot>> {
  const result = await readCommunity(ctx, runtime, actor, view);
  if (result.kind !== "ok") {
    await showCommunityRefusal(ctx, result, view);
    return result;
  }
  await showScreen(
    ctx,
    communityScreen(result.value, view, {
      notice,
      parent: manageItemParent("members"),
      viewerId: actor.identityId,
    }),
  );
  return result;
}

// Карточка человека или вопрос о закрытии его доступа. Отказ Identity — текстом
// экрана с возвратом на то же место списка (PER-547).
async function renderCommunityMember(
  ctx: UpdateContext,
  runtime: BotRuntime,
  actor: Person,
  identityId: string,
  place: CommunityPlace,
  screen: "card" | "close-access" | "demote",
  notice?: string,
): Promise<CommunityMemberResult> {
  const result: CommunityMemberResult =
    runtime.identity.communityMember === undefined
      ? {
          kind: "unavailable",
          cause: new Error("community administration is not configured"),
        }
      : await runtime.identity.communityMember(
          actor,
          identityId,
          rpcCall(ctx, "manage_community"),
        );
  if (result.kind !== "ok") {
    await showRefusal(
      ctx,
      communityMemberRefusalText(
        result,
        communityForbiddenText,
        unavailableText,
      ),
      communityMemberRefusalKeyboard(result, place, actor),
    );
    return result;
  }
  await showScreen(
    ctx,
    screen === "card"
      ? communityMemberScreen(result.value, place, notice)
      : screen === "close-access"
        ? closeAccessConfirmScreen(result.value, place)
        : demoteMemberConfirmScreen(result.value, place),
  );
  return result;
}

// Человек ушёл из состава, пока карточка висела, — штатный ответ контракта, а
// не сбой: метрика отказов на нём не растёт.
function memberOutcome(
  result: CommunityMemberResult,
  identityId: string,
): BoundaryOutcome {
  switch (result.kind) {
    case "identity-unknown":
    case "blocked":
    case "holds-preset":
      return {
        level: "info",
        message: "community member not shown",
        result: "ok",
        use_case: "manage_community",
        identity_id: identityId,
      };
    default:
      return adminOutcome(result, identityId);
  }
}

// Какой отказ бот даёт сам, до сервиса: пункт управления, на который у
// человека нет права. `undefined` — пропустить к обработчику.
function managementRefusal(
  action: CallbackAction,
  person: Person,
): string | undefined {
  switch (action.kind) {
    case "manage-menu":
      return canOpenManagement(person) ? undefined : managementForbiddenText;
    case "manage-group":
      return manageGroups(person).includes(action.group)
        ? undefined
        : managementForbiddenText;
    case "ask-allowed-username":
      return canManageMembers(person) ? undefined : communityForbiddenText;
    // Вопрос о названии новой сходки Meetups не спрашивает: сходка рождается
    // ответом, поэтому без права он не задаётся.
    case "create-meetup":
      return canManageMeetups(person) ? undefined : managementForbiddenText;
    // Вопрос о нике Identity не спрашивает, поэтому без права он не задаётся.
    // Список, назначение и снятие бот пропускает: право решает Identity и
    // отвечает отказом значением (PER-521).
    case "ask-appoint-administrator":
      return canGrantAdmins(person) ? undefined : administratorsForbiddenText;
    case "source-channels":
    case "ask-source-channel":
      return canManageMembers(person) ? undefined : sourceChannelsForbiddenText;
    case "application-card":
    case "admit-application":
    case "ask-decline-application":
    case "decline-application":
      return queueAllowed(action.queue, person)
        ? undefined
        : queueForbiddenText(action.queue);
    case "refused-applications":
    case "ask-reconsider":
    case "reconsider":
      return queueAllowed(action.queue, person)
        ? undefined
        : queueTexts[action.queue].refusedForbidden;
    default:
      return undefined;
  }
}

function queueAllowed(queue: ApplicationQueue, person: Person): boolean {
  return queue === "community"
    ? canManageMembers(person)
    : canAdmitBidders(person);
}

// Тексты отказа у каждой очереди свои: кто решает её заявки и отказанных.
// `toast` — всплывающий ответ на отказ сервиса посреди решения.
const queueTexts: Record<
  ApplicationQueue,
  { forbidden: string; refusedForbidden: string; toast: string }
> = {
  community: {
    forbidden: applicationsForbiddenText,
    refusedForbidden: refusedForbiddenText,
    toast: "Это может только администратор.",
  },
  auction: {
    forbidden: auctionQueueForbiddenText,
    refusedForbidden: auctionQueueForbiddenText,
    toast: "Это может только модератор аукциона.",
  },
};

function queueForbiddenText(queue: ApplicationQueue): string {
  return queueTexts[queue].forbidden;
}

function forbiddenToast(queue: ApplicationQueue): string {
  return queueTexts[queue].toast;
}

function recordToast(
  kind: "grant-record" | "revoke-record",
  right: RecordRight,
  result: GrantRecordResult,
): string {
  const texts = recordTexts[right];
  switch (result.kind) {
    case "ok":
      return !result.value
        ? "Состояние уже было актуальным."
        : kind === "grant-record"
          ? texts.granted
          : texts.revoked;
    case "not-member":
      return "Выдать нельзя: человек не участник сообщества.";
    case "forbidden":
      return texts.forbidden;
    case "invalid":
      return "Изменение не сохранилось. Список перечитан заново.";
    default:
      return "Не получилось сохранить. Попробуй ещё раз.";
  }
}

// Итог понижения до гостя (PER-642). Ответ на нажатие называет то же, что и
// строка карточки: понижение — смена круга, и человеку о ней ещё придёт весть.
const demotedNotice = "Понижен до гостя.";

function demoteToast(result: IdentityAdminResult<boolean>): string {
  switch (result.kind) {
    case "ok":
      return result.value ? demotedNotice : "Состояние уже было актуальным.";
    case "forbidden":
      return "Это может только администратор.";
    case "invalid":
      return "Изменение не сохранилось. Экран перечитан заново.";
    default:
      return "Не получилось сохранить. Попробуй ещё раз.";
  }
}

// Держатели наборов читаются заново на каждый показ: состав меняет и другой
// мейнтейнер, и общий секрет.
function readAdministrators(
  ctx: UpdateContext,
  runtime: BotRuntime,
  actor: Person,
): Promise<IdentityAdminResult<readonly Administrator[]>> {
  return runtime.identity.administrators === undefined
    ? Promise.resolve({
        kind: "unavailable" as const,
        cause: new Error("administrators are not configured"),
      })
    : runtime.identity.administrators(actor, rpcCall(ctx, "manage_community"));
}

async function renderAdministrators(
  ctx: UpdateContext,
  runtime: BotRuntime,
  actor: Person,
): Promise<IdentityAdminResult<unknown>> {
  const result = await readAdministrators(ctx, runtime, actor);
  if (result.kind !== "ok") {
    await refuseAdministrators(ctx, result);
    return result;
  }
  await showScreen(
    ctx,
    administratorsScreen(
      result.value,
      actor.identityId,
      manageItemParent("members"),
    ),
  );
  return result;
}

// Отказ Identity по праву уводит из раздела: экран без права ничего не даёт.
// Сбой и неразобранный запрос возвращают в список — его можно открыть заново.
function refuseAdministrators(
  ctx: UpdateContext,
  result: { kind: "forbidden" } | { kind: "invalid" } | { kind: "unavailable" },
): Promise<void> {
  return result.kind === "forbidden"
    ? showRefusal(ctx, administratorsForbiddenText, exitToMeetups())
    : showRefusal(
        ctx,
        unavailableText,
        withNav(new InlineKeyboard(), toAdministrators),
      );
}

function readRefused(
  ctx: UpdateContext,
  runtime: BotRuntime,
  actor: Person,
  queue: ApplicationQueue,
): Promise<IdentityAdminResult<readonly RefusedApplication[]>> {
  return runtime.identity.refusedApplications === undefined
    ? Promise.resolve({
        kind: "unavailable" as const,
        cause: new Error("application administration is not configured"),
      })
    : runtime.identity.refusedApplications(
        actor,
        queue,
        rpcCall(ctx, "manage_community"),
      );
}

// Список открывается из управления, туда и возвращает отказ.
function showRefusedRefusal(
  ctx: UpdateContext,
  result: Exclude<IdentityAdminResult<unknown>, { kind: "ok" }>,
  queue: ApplicationQueue,
): Promise<void> {
  return showRefusal(
    ctx,
    result.kind === "forbidden"
      ? queueTexts[queue].refusedForbidden
      : unavailableText,
    withNav(new InlineKeyboard(), toManage),
  );
}

async function renderRefused(
  ctx: UpdateContext,
  runtime: BotRuntime,
  actor: Person,
  queue: ApplicationQueue,
  page: number,
): Promise<void> {
  const result = await readRefused(ctx, runtime, actor, queue);
  if (result.kind !== "ok") {
    await showRefusedRefusal(ctx, result, queue);
    return;
  }
  await showScreen(
    ctx,
    refusedScreen(
      queue,
      result.value,
      page,
      communityToday(ctx),
      canManageMembers(actor),
      manageItemParent("applications"),
    ),
  );
}

// Экран каналов открывается из управления, туда и возвращает отказ. После
// заведения он открывается на странице нового канала: ссылку видно сразу.
async function renderSourceChannels(
  ctx: UpdateContext,
  runtime: BotRuntime,
  actor: Person,
  at: { page: number } | { code: string },
  notice?: string,
): Promise<IdentityAdminResult<readonly SourceChannel[]>> {
  // После заведения канал уже сохранён: сбой чтения списка не должен
  // выглядеть как сбой заведения, иначе администратор заведёт его заново.
  const saved = "code" in at;
  const result: IdentityAdminResult<readonly SourceChannel[]> =
    runtime.identity.sourceChannels === undefined
      ? {
          kind: "unavailable",
          cause: new Error("source channels are not configured"),
        }
      : await runtime.identity.sourceChannels(
          actor,
          rpcCall(ctx, "manage_community"),
        );
  if (result.kind !== "ok") {
    await showRefusal(
      ctx,
      result.kind === "forbidden"
        ? sourceChannelsForbiddenText
        : saved
          ? channelSavedListFailedText
          : unavailableText,
      withNav(new InlineKeyboard(), saved ? toSourceChannels : toManage),
    );
    return result;
  }
  const page =
    "page" in at ? at.page : sourceChannelPage(result.value, at.code);
  await showScreen(
    ctx,
    sourceChannelsScreen(
      result.value,
      page,
      {
        hub: ctx.me.username,
        ...(runtime.auctionBotUsername === undefined
          ? {}
          : { auction: runtime.auctionBotUsername }),
      },
      notice,
      manageItemParent("members"),
    ),
  );
  return result;
}

function sourceChannelsForbiddenOutcome(person: Person): BoundaryOutcome {
  return {
    level: "warn",
    message: "management rejected",
    result: "error",
    use_case: "manage_community",
    identity_id: person.identityId,
    error_category: "authorization",
    error: "management_forbidden",
  };
}

// Курсор очереди из кнопки. `after` — следующая заявка за этой, `at` — эта же,
// если она ещё открыта (`cursorAtApplication`).
function queueCursor(
  cursor: CardCursor,
  from: "after" | "at",
): ApplicationCursor {
  const applicationId = tokenToUuid(cursor.token);
  return from === "after"
    ? { createdAtMs: cursor.createdAtMs, applicationId }
    : cursorAtApplication({ applicationId, createdAtMs: cursor.createdAtMs });
}

function readApplicationQueue(
  ctx: UpdateContext,
  runtime: BotRuntime,
  actor: Person,
  queue: ApplicationQueue,
  after: ApplicationCursor | undefined,
): Promise<IdentityAdminResult<ApplicationQueueRead>> {
  return runtime.identity.readApplicationQueue === undefined
    ? Promise.resolve({
        kind: "unavailable" as const,
        cause: new Error("application moderation is not configured"),
      })
    : runtime.identity.readApplicationQueue(
        actor,
        queue,
        after,
        rpcCall(ctx, "manage_community"),
      );
}

// Числа на кнопках очередей заявок (PER-636): существующие чтения Identity идут
// параллельно, и отказ одного оставляет его кнопку без числа — экран всё равно
// открывается. Читаются только те очереди, которые смотрящий видит по праву.
async function readApplicationCounts(
  ctx: UpdateContext,
  runtime: BotRuntime,
  actor: Person,
): Promise<ApplicationCounts> {
  const [communityQueue, auctionQueue, communityRefused, auctionRefused] =
    await Promise.all([
      canManageMembers(actor)
        ? readApplicationQueue(ctx, runtime, actor, "community", undefined)
        : undefined,
      canAdmitBidders(actor)
        ? readApplicationQueue(ctx, runtime, actor, "auction", undefined)
        : undefined,
      canManageMembers(actor)
        ? readRefused(ctx, runtime, actor, "community")
        : undefined,
      canAdmitBidders(actor)
        ? readRefused(ctx, runtime, actor, "auction")
        : undefined,
    ]);
  const queue: Partial<Record<ApplicationQueue, number>> = {};
  const refused: Partial<Record<ApplicationQueue, number>> = {};
  if (communityQueue?.kind === "ok")
    queue.community = communityQueue.value.total;
  if (auctionQueue?.kind === "ok") queue.auction = auctionQueue.value.total;
  if (communityRefused?.kind === "ok")
    refused.community = communityRefused.value.length;
  if (auctionRefused?.kind === "ok")
    refused.auction = auctionRefused.value.length;
  return { queue, refused };
}

// Карточка открывается из управления, туда и возвращает отказ.
function showApplicationRefusal(
  ctx: UpdateContext,
  result: Exclude<IdentityAdminResult<unknown>, { kind: "ok" }>,
  queue: ApplicationQueue,
): Promise<void> {
  return showRefusal(
    ctx,
    result.kind === "forbidden" ? queueForbiddenText(queue) : unavailableText,
    withNav(new InlineKeyboard(), toManage),
  );
}

async function showApplicationQueue(
  ctx: UpdateContext,
  queue: ApplicationQueue,
  read: ApplicationQueueRead,
  afterCursor: boolean,
  note?: string,
): Promise<void> {
  const parent = manageItemParent("applications");
  await showScreen(
    ctx,
    read.card === undefined
      ? applicationQueueEndScreen(queue, read.total, afterCursor, parent, note)
      : applicationCardScreen(
          queue,
          read.card,
          read.total,
          Date.now(),
          parent,
          note,
        ),
  );
}

async function renderApplicationCard(
  ctx: UpdateContext,
  runtime: BotRuntime,
  actor: Person,
  queue: ApplicationQueue,
  after: ApplicationCursor | undefined,
  note?: string,
): Promise<IdentityAdminResult<ApplicationQueueRead>> {
  const result = await readApplicationQueue(ctx, runtime, actor, queue, after);
  if (result.kind !== "ok") {
    await showApplicationRefusal(ctx, result, queue);
    return result;
  }
  await showApplicationQueue(
    ctx,
    queue,
    result.value,
    after !== undefined,
    note,
  );
  return result;
}

function adminOutcome(
  result: IdentityAdminResult<unknown> | { kind: "not-refused" },
  identityId: string,
): BoundaryOutcome {
  // Отказ, который сейчас не пересмотреть, — штатный ответ контракта, а не
  // сбой: метрика отказов на нём не растёт.
  if (result.kind === "not-refused")
    return {
      level: "info",
      message: "refusal not reconsidered",
      result: "ok",
      use_case: "manage_community",
      identity_id: identityId,
    };
  if (result.kind === "ok")
    return {
      level: "info",
      message: "community changed",
      result: "ok",
      use_case: "manage_community",
      identity_id: identityId,
    };
  return {
    level: "warn",
    message: "community change rejected",
    result: "error",
    use_case: "manage_community",
    identity_id: identityId,
    error_category:
      result.kind === "forbidden"
        ? "authorization"
        : result.kind === "invalid"
          ? "invariant"
          : "dependency_unavailable",
    error: result.kind,
  };
}

// Итог точечной правки называет поле и новое значение, как сроки недели на
// пульте (прогон 14.10, №56). Описание длинное — оно только называется.
function changedField(
  result: Extract<ExecuteResult, { kind: "meetup-updated" }>,
  today: CommunityDay,
): string | undefined {
  const { meetup } = result;
  switch (result.field) {
    case undefined:
      return undefined;
    case "title":
      return `Название: ${meetup.title}.`;
    case "venue":
      return `Место: ${meetup.venue}.`;
    case "schedule":
      return meetup.schedule === undefined
        ? undefined
        : `Дата и время: ${readableMoment(meetup.schedule, today)}.`;
    case "description":
      return "Описание обновлено.";
    default: {
      const _exhaustive: never = result.field;
      return _exhaustive;
    }
  }
}

async function renderMeetupList(
  ctx: UpdateContext,
  person: Person,
  result: Awaited<ReturnType<Dispatcher["execute"]>>,
  page = 0,
): Promise<void> {
  if (result.kind === "meetup-list") {
    await showScreen(
      ctx,
      meetupsScreen(
        result.meetups,
        page,
        communityToday(ctx),
        canManageMeetups(person) ? uuidToToken(createUuidV7()) : undefined,
      ),
    );
    return;
  }
  if (result.kind === "dependency-rejected" || result.kind === "rejected") {
    await renderMeetupListFailure(ctx, "v1:nav:hub");
  }
}

// «Сходки» и «Скрытые сходки» читают один и тот же список, поэтому и
// отказ у них один; различается только экран, на который ведёт повтор.
async function renderMeetupListFailure(
  ctx: UpdateContext,
  retry: string,
): Promise<void> {
  await showRefusal(
    ctx,
    `Не получилось загрузить сходки. Это на моей стороне.\n\nПопробуй ещё раз через минуту.`,
    exitRetry(retry),
  );
}

async function renderHiddenMeetupList(
  ctx: UpdateContext,
  result: Awaited<ReturnType<Dispatcher["execute"]>>,
  page = 0,
): Promise<void> {
  if (result.kind === "meetup-list") {
    await showScreen(
      ctx,
      hiddenScreen(
        result.meetups,
        page,
        communityToday(ctx),
        manageItemParent("meetups"),
      ),
    );
    return;
  }
  if (result.kind === "dependency-rejected" || result.kind === "rejected") {
    await renderMeetupListFailure(ctx, "v1:manage:hidden");
  }
}

async function renderArchiveList(
  ctx: UpdateContext,
  result: Awaited<ReturnType<Dispatcher["execute"]>>,
  page = 0,
): Promise<void> {
  if (result.kind === "archived-meetup-list") {
    await showScreen(
      ctx,
      archiveScreen(result.meetups, page, communityToday(ctx)),
    );
    return;
  }
  if (result.kind === "dependency-rejected" || result.kind === "rejected") {
    await showRefusal(
      ctx,
      `Не получилось загрузить архив. Это на моей стороне.\n\nПопробуй ещё раз через минуту.`,
      exitRetry("v1:nav:archive"),
    );
  }
}

// Кадр отказа или итоговый кадр: первое предложение жирным вместо заголовка
// и выход последним рядом. Тексты кадров ошибок по смыслу не меняются.
async function showFrame(
  ctx: UpdateContext,
  id: "refusal" | "broadcast-result" | "no-access" | "no-access-support",
  text: string,
  keyboard: InlineKeyboard,
  delivery?: "new",
): Promise<void> {
  await showScreen(ctx, {
    id,
    text: refusalText(text),
    keyboard,
    format: "HTML",
    ...(delivery === undefined ? {} : { delivery }),
  });
}

function showRefusal(
  ctx: UpdateContext,
  text: string,
  keyboard: InlineKeyboard,
  delivery?: "new",
): Promise<void> {
  return showFrame(ctx, "refusal", text, keyboard, delivery);
}

/** Выход к карточке сходки: `[‹ Сходка]`. */
function exitToCard(token: string): InlineKeyboard {
  return withNav(new InlineKeyboard(), toCard(token));
}

function exitToExtensions(token: string): InlineKeyboard {
  return withNav(new InlineKeyboard(), toExtensions(token));
}

/**
 * Повтор после сбоя и выход: `[Повторить]`, под ним `[‹ Сходки]`. Сбой самих
 * «Сходок» несёт только повтор: возврат вёл бы туда же.
 */
function exitRetry(data: string): InlineKeyboard {
  const keyboard = new InlineKeyboard().text(retryLabel, data);
  return data === toMeetups.data ? keyboard : exitToMeetups(keyboard);
}

// Переходная форма единого отправителя: срезы перевёрстки заменяют её
// экранами-данными, а до тех пор каждое место называет свою запись каталога.
async function editScreen(
  ctx: UpdateContext,
  id: ScreenId,
  text: string,
  keyboard: InlineKeyboard,
  parseMode?: "HTML",
): Promise<void> {
  await showScreen(ctx, {
    id,
    text,
    keyboard,
    ...(parseMode === undefined ? {} : { format: parseMode }),
  });
}

// Экраны за кнопками навигации `v1:nav:*`: те же, что открывает стартовый
// экран. Это те же экраны, что за кнопками списка сходок, — кнопка даёт к ним
// вход, а не новый сценарий. Правит ли кнопка своё сообщение или отвечает
// новым, решает editScreen, а не вызывающий.
type NavScreen = "hub" | "archive" | "notify-global";

async function openNavScreen(
  ctx: UpdateContext,
  runtime: BotRuntime,
  person: Person,
  screen: NavScreen,
  useCase: ProductUseCase,
  page = 0,
): Promise<BoundaryOutcome> {
  switch (screen) {
    case "hub": {
      const result = await runtime.dispatcher.execute({
        identity: person,
        intent: "list-visible-meetups",
        ...rpcCall(ctx, useCase),
      });
      await renderMeetupList(ctx, person, result, page);
      return screenBoundary(result, {
        ok: ["meetup-list"],
        okMessage: "meetup list sent",
        rejectedMessage: "meetup list rejected",
        useCase,
      });
    }
    case "archive": {
      const result = await runtime.dispatcher.execute({
        identity: person,
        intent: "list-archived-meetups",
        ...rpcCall(ctx, useCase),
      });
      await renderArchiveList(ctx, result, page);
      return screenBoundary(result, {
        ok: ["archived-meetup-list"],
        okMessage: "archive list sent",
        rejectedMessage: "archive list rejected",
        useCase,
      });
    }
    case "notify-global": {
      const result = await runtime.dispatcher.execute({
        identity: person,
        intent: "view-global-notifications",
        ...rpcCall(ctx, useCase),
      });
      await renderNotificationSettings(
        ctx,
        result,
        "v1:notify:global",
        forbiddenText,
      );
      return screenBoundary(result, {
        ok: ["global-notification-settings"],
        okMessage: "global notification settings sent",
        rejectedMessage: "global notification settings rejected",
        useCase,
      });
    }
    default: {
      const _exhaustive: never = screen;
      return unexpectedOutcome(
        `unhandled navigation screen ${String(_exhaustive)}`,
        undefined,
        useCase,
      );
    }
  }
}

const commandUseCase: Record<SectionCommand, ProductUseCase> = {
  menu: "find_meetup",
  meetups: "find_meetup",
  next: "view_meetup",
  events: "view_auction",
  settings: "manage_notifications",
  manage: "create_meetup",
  help: "find_meetup",
};

// Данные кнопки того же раздела: по ним «Повторить» под кадром сбоя повторяет
// команду нажатием.
const commandRetry: Record<SectionCommand, string> = {
  menu: toMenu.data,
  meetups: "v1:nav:hub",
  next: "v1:nav:next",
  events: toEvents.data,
  settings: "v1:nav:settings",
  manage: "v1:manage:menu",
  help: "v1:nav:help",
};

/**
 * Команда раздела из кнопки меню клиента: корень раздела новым сообщением
 * (дизайн-код, «Доставка»). Команда входом не является — заявку она не
 * ставит: личность разрешается, как у нажатия, и недопущенный получает свой
 * кадр (решение владельца 10 октября 2026 года).
 */
async function handleSectionCommand(
  ctx: UpdateContext,
  runtime: BotRuntime,
  command: SectionCommand,
  useCase: ProductUseCase,
): Promise<BoundaryOutcome> {
  const identity = await resolvePerson(
    ctx,
    runtime,
    useCase,
    commandRetry[command],
  );
  if (identity.kind === "failed") return identity.outcome;
  const denied = await denyHubAccessIfNeeded(
    ctx,
    runtime,
    identity,
    useCase,
    false,
  );
  if (denied !== undefined) return denied;
  const person = identity.person;
  switch (command) {
    case "menu":
      return openMenu(ctx, runtime, person, useCase);
    case "meetups":
      return openNavScreen(ctx, runtime, person, "hub", useCase);
    case "next":
      return openNextMeetup(ctx, runtime, person, useCase);
    case "events":
      return openEvents(ctx, runtime, person, useCase);
    case "settings":
      await showScreen(ctx, settingsScreen());
      return {
        level: "info",
        message: "settings sent",
        result: "ok",
        use_case: useCase,
      };
    case "help":
      return openHelp(ctx, runtime, person, useCase);
    case "manage":
      if (!canOpenManagement(person)) {
        await showRefusal(ctx, managementForbiddenText, exitToMeetups());
        return {
          level: "warn",
          message: "management rejected",
          result: "error",
          use_case: useCase,
          identity_id: person.identityId,
          error_category: "authorization",
          error: "management_forbidden",
        };
      }
      await showScreen(ctx, manageScreen(person));
      return {
        level: "info",
        message: "manage menu sent",
        result: "ok",
        use_case: useCase,
      };
    default: {
      const _exhaustive: never = command;
      return _exhaustive;
    }
  }
}

// Корневое меню — общий родитель разделов (PER-592): его открывают `/menu`,
// вход без ссылки на сходку, «‹ Меню» с разделов и прежние кнопки «Меню».
async function openMenu(
  ctx: UpdateContext,
  runtime: BotRuntime,
  person: Person,
  useCase: ProductUseCase,
): Promise<BoundaryOutcome> {
  // Меню — горячий путь `/start` и «‹ Меню»: медленный Auction его не держит,
  // а события после срока пропадают, как при отказе (PER-669).
  const events = await within(
    currentEvents(ctx, runtime, person, useCase),
    menuEventsBudgetMs,
    { kind: "unavailable" as const },
  );
  await showScreen(
    ctx,
    menuScreen(person, {
      events: events.kind === "ok" ? events.events : [],
      timeZone: runtime.communityTimeZone ?? "UTC",
      today: communityToday(ctx),
    }),
  );
  return {
    level: "info",
    message:
      events.kind === "ok" ? "menu sent" : "menu sent; events unavailable",
    result: "ok",
    use_case: useCase,
  };
}

// Идущие события расширений (PER-669): сегодня — аукцион сообщества в онлайн-
// торгах, итогах, перерыве или финале. Торги открыты не больше чем у одного
// аукциона (PER-603), поэтому событие аукциона — одно. Отказ Auction меню не
// роняет: кнопка и строка событий пропадают, а запись границы называет
// деградацию.
async function currentEvents(
  ctx: UpdateContext,
  runtime: BotRuntime,
  person: Person,
  useCase: ProductUseCase,
): Promise<{ kind: "ok"; events: HubEvent[] } | { kind: "unavailable" }> {
  if (runtime.auction === undefined) return { kind: "ok", events: [] };
  const current = await runtime.auction.currentAuction(
    person,
    rpcCall(ctx, useCase),
  );
  if (current.kind !== "ok") return { kind: "unavailable" };
  const { auctionId, auction } = current;
  return auctionId === undefined ||
    auction === undefined ||
    !isAuctionEvent(auction)
    ? { kind: "ok", events: [] }
    : { kind: "ok", events: [{ kind: "auction", auctionId, auction }] };
}

const menuEventsBudgetMs = 1_500;

// Ответ работы или запасной, если работа не успела к сроку или отказала.
async function within<T>(
  work: Promise<T>,
  ms: number,
  fallback: T,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([work.catch(() => fallback), late]);
  } finally {
    clearTimeout(timer);
  }
}

// «События» (PER-669) — раздел под меню. Отказ Auction — кадр сбоя с
// «Повторить»: раздел только из событий и состоит.
async function openEvents(
  ctx: UpdateContext,
  runtime: BotRuntime,
  person: Person,
  useCase: ProductUseCase,
): Promise<BoundaryOutcome> {
  const events = await currentEvents(ctx, runtime, person, useCase);
  if (events.kind === "unavailable") {
    await showRefusal(ctx, unavailableText, exitRetry(toEvents.data));
    return {
      level: "error",
      message: "events rejected",
      result: "error",
      use_case: useCase,
      identity_id: person.identityId,
      error_category: "dependency_unavailable",
      error: "auction_unavailable",
    };
  }
  await showScreen(
    ctx,
    eventsScreen(
      events.events,
      runtime.communityTimeZone ?? "UTC",
      communityToday(ctx),
    ),
  );
  return {
    level: "info",
    message: "events sent",
    result: "ok",
    use_case: useCase,
  };
}

/**
 * «Подать заявку» под приветствием — единственное действие, которое ставит
 * заявку (PER-592, дополнение ADR-060 от 2026-10-12): `RequestAccess` в
 * очередь сообщества с именем для карточки модератора и кодом канала из
 * кнопки. Исход политики дерева тот же, что у прежнего входа на `/start`:
 * белый список, сработавший между приветствием и нажатием, открывает меню,
 * остальным — кадр ожидания, отказа или блокировки на месте приветствия.
 */
async function applyForHub(
  ctx: UpdateContext,
  runtime: BotRuntime,
  sourceCode: string | undefined,
): Promise<BoundaryOutcome> {
  const useCase: ProductUseCase = "find_meetup";
  const from = ctx.from;
  if (from === undefined) {
    return unexpectedOutcome("sender is missing", undefined, useCase);
  }
  const answer = await runtime.identity.requestAccess(
    hubAccessRequest(
      {
        ...toResolveIdentityInput(BigInt(from.id), from.username),
        firstName: from.first_name,
      },
      sourceCode === undefined
        ? undefined
        : { kind: "source", code: sourceCode },
    ),
    rpcCall(ctx, useCase),
  );
  if (answer.kind !== "answered") {
    // «Повторить» несёт ту же кнопку: заявка идемпотентна, и повтор с тем же
    // кодом канала второй заявки не поставит.
    await showRefusal(
      ctx,
      unavailableText,
      new InlineKeyboard().text(
        retryLabel,
        ctx.callbackQuery?.data ?? applyData,
      ),
    );
    return identityFailureOutcome(answer, useCase);
  }
  const entry = decideHubEntry(answer);
  if (entry.kind === "unknown-outcome") {
    return replyFailClosed(ctx, {
      level: "error",
      message: "identity answered an unknown access request outcome",
      result: "error",
      use_case: useCase,
      identity_id: entry.identityId,
      error_category: "invariant",
      error: "access_request_outcome_unspecified",
    });
  }
  ctx.commandsPerson = entry.person;
  if (entry.access !== "admitted") {
    return denyHubAccess(
      ctx,
      runtime,
      entry.access,
      entry.person,
      useCase,
      true,
    );
  }
  return openMenu(ctx, runtime, entry.person, useCase);
}

/**
 * Сообщение, которое бот не читает (PER-592): текст без ответа на вопрос,
 * незнакомая команда, файл. Есть открытый вопрос в этом чате — подсказка, как
 * на него ответить: реплай слетает в Web K и при нажатии мимо. Нет — куда
 * идти. Выход — «‹ Меню». Личность не разрешается: подсказке она не нужна.
 */
async function hintStray(
  ctx: UpdateContext,
  questions: Map<string, PendingInput>,
): Promise<BoundaryOutcome> {
  const prefix = `${ctx.chat?.id ?? "unknown"}:`;
  const open = [...questions.keys()].some((key) => key.startsWith(prefix));
  const hint = strayHintText(open);
  await showScreen(ctx, {
    id: "hint",
    text: `${heading(hint.lead)} ${escapeHtml(hint.rest)}`,
    keyboard: withNav(new InlineKeyboard(), toMenu),
    format: "HTML",
    delivery: "new",
  });
  return {
    level: "info",
    message: open ? "stray answer hinted" : "stray message hinted",
    result: "ok",
  };
}

// «Помощь» — корень раздела: текст о боте — тот же, что приветствие входа, —
// и команды строками.
async function openHelp(
  ctx: UpdateContext,
  runtime: BotRuntime,
  person: Person,
  useCase: ProductUseCase,
): Promise<BoundaryOutcome> {
  const result = await runtime.dispatcher.execute({
    identity: person,
    intent: "start",
  });
  if (result.kind !== "message") {
    return unexpectedOutcome(
      `unexpected start result ${result.kind}`,
      undefined,
      useCase,
    );
  }
  await showScreen(
    ctx,
    helpScreen(person, result.text, runtime.supportBotUsername),
  );
  return {
    level: "info",
    message: "help sent",
    result: "ok",
    use_case: useCase,
  };
}

async function openReleaseNotes(
  ctx: UpdateContext,
  runtime: BotRuntime,
  person: Person,
  action: { token?: string; part?: number },
  useCase: ProductUseCase,
): Promise<BoundaryOutcome> {
  const summaryId =
    action.token === undefined ? undefined : tokenToUuid(action.token);
  const result = await runtime.dispatcher.execute({
    identity: person,
    intent: "view-release-notes",
    ...(summaryId === undefined ? {} : { summaryId }),
    ...(action.part === undefined ? {} : { part: action.part }),
    ...rpcCall(ctx, useCase),
  });
  const retry = releasePostData(
    summaryId === undefined ? undefined : { summaryId, part: action.part ?? 1 },
  );
  if (result.kind === "release-post") {
    const screen = releasePostScreen(
      result,
      communityToday(ctx),
      runtime.communityTimeZone ?? "UTC",
    );
    if (screen === undefined) {
      await showRefusal(ctx, unavailableText, exitRetry(retry));
      return {
        level: "error",
        message: "release notes rejected",
        result: "error",
        use_case: useCase,
        error_category: "invariant",
        error: "release summary date",
      };
    }
    await showScreen(ctx, screen);
  } else if (result.kind === "release-empty") {
    await showScreen(ctx, releaseEmptyScreen());
  } else {
    await showRefusal(ctx, unavailableText, exitRetry(retry));
  }
  return screenBoundary(result, {
    ok: ["release-post", "release-empty"],
    okMessage: "release notes sent",
    rejectedMessage: "release notes rejected",
    useCase,
  });
}

/**
 * Ближайшая предстоящая сходка, видимая смотрящему: опубликованная, с датой не
 * раньше сегодняшнего дня сообщества, самая ранняя. Скрытые сходки, которые
 * видят автор и администратор, не в счёт: «ближайшая сходка» — та, что
 * объявлена сообществу.
 */
function nextMeetupOf(
  meetups: readonly MeetupSummary[],
  today: CommunityDay,
): MeetupSummary | undefined {
  let nearest: MeetupSummary | undefined;
  for (const meetup of meetups) {
    const day = meetup.schedule;
    if (meetup.visibility !== "visible" || day === undefined) continue;
    if (isBeforeDay(day, today)) continue;
    if (nearest?.schedule === undefined || isBeforeDay(day, nearest.schedule)) {
      nearest = meetup;
    }
  }
  return nearest;
}

// `/next` открывает карточку ближайшей сходки; нет ни одной — «Сходки» с их
// пустым текстом (решение владельца 10 октября 2026 года).
async function openNextMeetup(
  ctx: UpdateContext,
  runtime: BotRuntime,
  person: Person,
  useCase: ProductUseCase,
): Promise<BoundaryOutcome> {
  const list = await runtime.dispatcher.execute({
    identity: person,
    intent: "list-visible-meetups",
    ...rpcCall(ctx, useCase),
  });
  const nearest =
    list.kind === "meetup-list"
      ? nextMeetupOf(list.meetups, communityToday(ctx))
      : undefined;
  if (nearest === undefined) {
    await renderMeetupList(ctx, person, list);
    return screenBoundary(list, {
      ok: ["meetup-list"],
      okMessage: "meetup list sent",
      rejectedMessage: "meetup list rejected",
      useCase,
    });
  }
  const result = await runtime.dispatcher.execute({
    identity: person,
    intent: "view-meetup",
    meetupId: nearest.id,
    ...rpcCall(ctx, useCase),
  });
  await renderMeetupCard(
    ctx,
    result,
    ctx.callbackQuery !== undefined,
    runtime.presentation ?? "rich",
    canManageMeetups(person),
  );
  return screenBoundary(result, {
    ok: ["meetup-card"],
    okMessage: "meetup card sent",
    rejectedMessage: "meetup card rejected",
    useCase,
    meetupId: nearest.id,
  });
}

const meetupCategoryOrder: readonly MeetupCategory[] = [
  "changes",
  "material",
  "reminder",
  "organizer",
];

// Экран исхода подписки (дизайн-код, «Уведомления»): исход в заголовке,
// название сходки в кавычках, у подписки — пояснение, что будет приходить, и
// «Настроить уведомления» над выходом: настройки сходки — продолжение начатого.
// Выход — «‹ Сходка»; возврат из настроек ведёт к карточке, как
// всегда.
function subscriptionOutcomeScreen(
  token: string,
  title: string,
  subscribed: boolean,
  explanation: string | undefined,
): ShownScreen {
  const keyboard = new InlineKeyboard();
  if (subscribed) {
    keyboard.text("Настроить уведомления", `v1:notify:settings:${token}`);
  }
  return {
    id: "outcome",
    text: outcomeText(
      [
        subscribed ? "Подписка включена." : "Подписка выключена.",
        subscribed
          ? explanation
          : "Уведомления по этой сходке больше не придут.",
      ]
        .filter((part) => part !== undefined)
        .join(" "),
      meetupTitleLabel(title),
    ),
    keyboard: withNav(keyboard, toCard(token)),
    format: "HTML",
  };
}

// Перечень строится по действующим значениям, а не по умолчаниям продукта:
// человек, который раньше включил напоминание или выключил материалы, иначе
// прочёл бы неправду. Напоминание названо отдельно, потому что по умолчанию
// оно выключено и без подсказки его не найти. Снимок без какой-то категории
// пояснения не даёт: пропуск неотличим от «выключено», и «ничего не приходит»
// на пустом ответе было бы выдумкой.
function subscriptionExplanation(
  categories: readonly CategoryState<MeetupCategory>[],
): string | undefined {
  const known = meetupCategoryOrder
    .map((category) => categories.find((entry) => entry.category === category))
    .filter(
      (state): state is CategoryState<MeetupCategory> => state !== undefined,
    );
  if (known.length !== meetupCategoryOrder.length) return undefined;
  const enabled = known
    .filter((state) => state.enabled)
    .map((state) => categoryLabels[state.category].toLowerCase());
  if (enabled.length === 0) {
    return "По этой сходке сейчас ничего не приходит: все категории выключены. Включить их можно в «Уведомлениях сходки».";
  }
  const lines = [`По этой сходке будут приходить: ${enabled.join(", ")}.`];
  if (known.some((state) => state.category === "reminder" && !state.enabled)) {
    lines.push(
      "Напоминание перед началом выключено, включить его можно в «Уведомлениях сходки».",
    );
  }
  return lines.join(" ");
}

// Карточка, которую представление собирает из результата формы или команды —
// правки, публикации, смены статуса, — переносит сходку, того же автора, что и
// карточка просмотра, и аукцион, который к результату дописал диспетчер: так
// она не отличается от карточки, открытой из списка.
function cardFrom(result: {
  meetup: MeetupSnapshot;
  author?: MeetupAuthor;
  auction?: MeetupAuctionView;
}): Extract<ExecuteResult, { kind: "meetup-card" }> {
  return {
    kind: "meetup-card",
    meetup: result.meetup,
    ...(result.author === undefined ? {} : { author: result.author }),
    ...(result.auction === undefined ? {} : { auction: result.auction }),
  };
}

// Аукцион ленты, когда тело — лента: у карточки лота и хронологии свой экран,
// и лента в них не читается (тот же порядок, что у `auctionScreen`).
function feedAuctionOf(body: AuctionScreenBody): string | undefined {
  if (
    body.blocks.some(
      (block) => block.kind === "lot" || block.kind === "history",
    )
  ) {
    return undefined;
  }
  const feed = body.blocks.find(
    (block): block is Extract<AuctionBlock, { kind: "feed" }> =>
      block.kind === "feed",
  );
  return feed?.auctionId;
}

// Настоящий аккаунт победителя проданного лота (PER-648). Identity отдаёт его
// только держателю права вести аукцион, и остальным вызов не делается: экран
// всё равно остался бы с псевдонимом. Имя, которое уже является ником, тоже
// спрашивается: снимок ника в аукционе заморожен и может разойтись с
// Telegram, а организатору нужен свежий аккаунт. Отказ, недоступность и
// проданного лота без имени — поля нет, карточка показывает то, что дал
// Auction.
async function soldWinnerUsername(
  runtime: BotRuntime,
  viewer: Viewer,
  body: AuctionScreenBody,
): Promise<string | undefined> {
  const resolve = runtime.identity.resolveParticipantUsername;
  if (resolve === undefined || !canRunAuctions(viewer)) return undefined;
  const lot = body.blocks.find(
    (block): block is Extract<AuctionBlock, { kind: "lot" }> =>
      block.kind === "lot",
  );
  const winnerId =
    lot?.status.kind === "sold" ? lot.status.winnerId : undefined;
  if (winnerId === undefined || lot?.participantName === undefined) {
    return undefined;
  }
  const result = await resolve({ identityId: viewer.identityId }, winnerId);
  return result.kind === "resolved" && result.telegramUsername !== ""
    ? result.telegramUsername
    : undefined;
}

// «Добавить лот» в ленте — пока онлайн-неделя не открыта (PER-468). Статус
// аукциона лента пакета не несёт, его знает пульт, поэтому для ленты
// администратора бот читает пульт тем же бюджетом действия. Отказ и
// недоступность пульта ряд не убирают: отказ после вопроса — то, что было и
// раньше, а ленту ронять не за что.
async function auctionAcceptsLots(
  ctx: UpdateContext,
  runtime: BotRuntime,
  person: Person,
  auctionId: string,
): Promise<boolean> {
  const console = await runtime.dispatcher.execute({
    identity: person,
    intent: "view-auction-console",
    auctionId,
    ...rpcCall(ctx, "view_auction"),
  });
  return console.kind === "auction-console"
    ? acceptsLots(console.console.status)
    : true;
}

// Меню «Расширения» сходки (PER-605; ADR-064, дополнение 2026-10-12): сходка
// из Meetups и её аукцион из Auction. Отказ Auction меню не роняет — меню
// называет его с повтором; отказ Meetups — тот же кадр, что у карточки.
async function openMeetupExtensions(
  ctx: UpdateContext,
  runtime: BotRuntime,
  person: Person,
  token: string,
  useCase: ProductUseCase,
): Promise<BoundaryOutcome> {
  const meetupId = tokenToUuid(token);
  const result = await runtime.dispatcher.execute({
    identity: person,
    intent: "view-meetup-extensions",
    meetupId,
    ...rpcCall(ctx, useCase),
  });
  if (result.kind === "meetup-card") {
    // Пара «аукцион — сходка» запоминается здесь: из неё корень аукциона
    // берёт свой возврат «‹ Расширения».
    if (result.auction?.kind === "open") {
      ctx.auctionParents?.remember(result.auction.auctionId, result.meetup.id);
    }
    await showScreen(
      ctx,
      extensionsScreen({
        meetup: result.meetup,
        auction: result.auction,
        manageable: canRunAuctions(person),
      }),
    );
  } else {
    await renderMeetupCard(ctx, result, true, runtime.presentation ?? "rich");
  }
  // Меню показано, но без аукциона: отказ Auction — сбой соседа в записи
  // границы, а не успех.
  if (result.kind === "meetup-card" && result.auction?.kind === "unavailable") {
    return {
      level: "warn",
      message: "meetup extensions sent without the auction",
      result: "error",
      use_case: useCase,
      meetup_id: meetupId,
      identity_id: person.identityId,
      error_category: "dependency_unavailable",
      error: "auction_unavailable",
    };
  }
  return screenBoundary(result, {
    ok: ["meetup-card"],
    okMessage: "meetup extensions sent",
    rejectedMessage: "meetup extensions rejected",
    useCase,
    meetupId,
  });
}

// «Включить аукцион» в меню «Расширения» сходки (PER-307, PER-605). Край
// показывает и пропускает кнопку держателю права вести аукцион (PER-654), а
// команду решает Auction, спрашивая Meetups. Ключ команды рождается на нажатие, а аукцион сходки один при
// любом их числе: повторное нажатие отвечает тем же аукционом.
async function enableAuction(
  ctx: UpdateContext,
  runtime: BotRuntime,
  person: Person,
  token: string,
): Promise<BoundaryOutcome> {
  const useCase: ProductUseCase = "enable_auction";
  const meetupId = tokenToUuid(token);
  const result = await runtime.dispatcher.execute({
    identity: person,
    intent: "enable-auction",
    meetupId,
    opId: createUuidV7(),
    ...rpcCall(ctx, useCase),
  });
  if (result.kind === "auction-enabled") {
    ctx.auctionParents?.remember(result.auctionId, result.meetupId);
    // Исход — свой экран с кнопкой «Аукцион»: корень открывает она, а не этот
    // ответ, потому что read model Auction может ещё не увидеть аукцион.
    await showScreen(
      ctx,
      auctionEnabledScreen({
        meetupToken: token,
        auctionId: result.auctionId,
        alreadyExisted: result.alreadyExisted,
      }),
    );
    return {
      level: "info",
      message: result.alreadyExisted
        ? "auction already enabled"
        : "auction enabled",
      result: "ok",
      use_case: useCase,
      meetup_id: meetupId,
      identity_id: person.identityId,
    };
  }
  if (result.kind === "auction-refused") {
    const cancelled = result.reason === "meetup-cancelled";
    await showRefusal(
      ctx,
      cancelled ? auctionMeetupCancelledText : forbiddenText,
      exitToExtensions(token),
    );
    return {
      level: "warn",
      message: "auction enabling rejected",
      result: "error",
      use_case: useCase,
      meetup_id: meetupId,
      identity_id: person.identityId,
      error_category: cancelled ? "invariant" : "authorization",
      error: cancelled ? "meetup_cancelled" : "not_meetup_administrator",
    };
  }
  if (result.kind === "meetup-not-found") {
    await renderMeetupCard(ctx, result, true, runtime.presentation ?? "rich");
    return screenBoundary(result, {
      ok: [],
      okMessage: "auction enabled",
      rejectedMessage: "auction enabling rejected",
      useCase,
      meetupId,
    });
  }
  const forbidden =
    result.kind === "dependency-rejected" && result.reason === "forbidden";
  await showRefusal(
    ctx,
    forbidden ? forbiddenText : unavailableText,
    forbidden
      ? exitToExtensions(token)
      : exitRetry(`v1:manage:auction:${token}`),
  );
  return screenBoundary(result, {
    ok: [],
    okMessage: "auction enabled",
    rejectedMessage: "auction enabling rejected",
    useCase,
    meetupId,
  });
}

// Форма лота администратора (PER-319): кнопки «Добавить лот», «Изменить лот»
// и ряды экрана правки. Сюда доходит только администратор. Идентификатор
// нового лота рождается на нажатии и едет в кнопке вопроса ключом создания,
// поэтому ответ после рестарта и повторный ответ создают тот же лот.
async function handleLotFormCallback(
  ctx: UpdateContext,
  runtime: BotRuntime,
  questions: Map<string, PendingInput>,
  person: Person,
  action: Extract<
    CallbackAction,
    {
      kind:
        | "lot-new"
        | "lot-form"
        | "lot-ask"
        | "lot-step-mode"
        | "lot-skip"
        | "lot-keep-step"
        | "lot-image-remove"
        | "lot-image-remove-confirm"
        | "lot-scope"
        | "lot-set-retry"
        | "lot-copy"
        | "lot-remove"
        | "lot-remove-confirm";
    }
  >,
): Promise<BoundaryOutcome> {
  const useCase: ProductUseCase = "manage_lot";
  const sent = (message: string): BoundaryOutcome => ({
    level: "info",
    message,
    result: "ok",
    use_case: useCase,
    identity_id: person.identityId,
  });
  if (action.kind === "lot-new") {
    await askLotQuestion(ctx, questions, {
      question: {
        kind: "new",
        auctionId: tokenToUuid(action.auction),
        lotId: newLotId(createUuidV7()),
      },
    });
    return sent("lot title requested");
  }
  const lotId = tokenToUuid(action.lot);
  // «Оставить шаг» (PER-714): новая цена из кнопки с прежним шагом лота одной
  // командой. Лот читает юзкейс: шаг берётся из чтения. Ключ рождается на
  // нажатие, как у ответа на вопрос о шаге: условия Auction заменяет целиком,
  // и повтор даёт тот же итог.
  if (action.kind === "lot-keep-step") {
    const kept = await runtime.dispatcher.execute({
      identity: person,
      intent: "keep-lot-step",
      lotId,
      priceRubles: action.price,
      opId: createUuidV7(),
      ...setScope(action.set),
      ...rpcCall(ctx, useCase),
    });
    if (kept.kind === "lot-form") {
      await showScreen(ctx, lotSavedScreen(kept.lot, lotSavedNote.terms));
      return sent("lot price saved with the kept step");
    }
    if (kept.kind === "lot-set-applied") {
      await showScreen(ctx, lotSetAppliedScreen(kept.lot, kept));
      return sent("lot set price saved with the kept step");
    }
    // Шага у лота в чтении нет — снова выбор способа с той же ценой.
    if (kept.kind === "lot-step-mode") {
      await showScreen(
        ctx,
        lotStepModeScreen(kept.lot, kept.priceRubles, undefined, action.set),
      );
      return sent("lot step mode requested again");
    }
    // Auction не принял прежний шаг с новой ценой — вопрос о шаге с причиной.
    if (kept.kind === "lot-ask") {
      await askLotQuestion(ctx, questions, {
        question: kept.question,
        lot: kept.lot,
        error: kept.error,
      });
      return sent("lot step asked after the kept step was refused");
    }
    return showLotFailure(ctx, kept, {
      person,
      retry: ctx.callbackQuery?.data,
    });
  }
  // «Да, убрать фото» (PER-715): лот читает сам юзкейс — тексты карточки ему
  // нужны для правки. Отказ Auction — кадр отказа формы, а не сбоя.
  if (action.kind === "lot-image-remove-confirm") {
    const removed = await runtime.dispatcher.execute({
      identity: person,
      intent: "remove-lot-image",
      lotId,
      imagePrint: action.print,
      ...rpcCall(ctx, useCase),
    });
    if (removed.kind === "lot-form") {
      await showScreen(
        ctx,
        lotSavedScreen(removed.lot, lotSavedNote["image-removed"]),
      );
      return sent("lot photo removed");
    }
    // Фото сменилось после подтверждения: ничего не снято — исход с «Ввести
    // заново», который задаёт вопрос о фото с кнопкой для нового фото.
    if (removed.kind === "lot-ask") {
      await askLotQuestion(ctx, questions, {
        question: removed.question,
        lot: removed.lot,
        error: removed.error,
      });
      return sent("lot photo removal asked again: the photo changed");
    }
    return showLotFailure(ctx, removed, {
      person,
      retry: ctx.callbackQuery?.data,
    });
  }
  // «Да, удалить лот» (PER-716): ключ рождается на нажатие; повтор после
  // удаления Auction отвечает «лота в реестре нет», и исход тот же.
  if (action.kind === "lot-remove-confirm") {
    const removed = await runtime.dispatcher.execute({
      identity: person,
      intent: "remove-lot",
      lotId,
      opId: createUuidV7(),
      ...rpcCall(ctx, useCase),
    });
    if (removed.kind === "lot-removed") {
      await showScreen(ctx, lotRemovedScreen(removed));
      return sent(
        removed.already === true ? "lot already removed" : "lot removed",
      );
    }
    return showLotFailure(ctx, removed, {
      person,
      retry: ctx.callbackQuery?.data,
    });
  }
  // «Повторить для оставшихся» (PER-716): значение поля юзкейс берёт у лота и
  // разносит по сету заново.
  if (action.kind === "lot-set-retry") {
    const retried = await runtime.dispatcher.execute({
      identity: person,
      intent: "retry-lot-set",
      lotId,
      field: action.field,
      opId: createUuidV7(),
      ...rpcCall(ctx, useCase),
    });
    if (retried.kind === "lot-set-applied") {
      await showScreen(ctx, lotSetAppliedScreen(retried.lot, retried));
      return sent("lot set edit retried");
    }
    if (retried.kind === "lot-form") {
      await showScreen(ctx, lotFormScreen(retried.lot));
      return sent("lot form sent: nothing to spread over the set");
    }
    return showLotFailure(ctx, retried, {
      person,
      retry: ctx.callbackQuery?.data,
    });
  }
  // Способ шага выбран (PER-491): цена уже принята и едет в кнопке, поэтому
  // лот читать не нужно — спрашивается сам шаг.
  const result = await runtime.dispatcher.execute({
    identity: person,
    intent: "view-lot-form",
    lotId,
    ...rpcCall(ctx, useCase),
  });
  if (result.kind !== "lot-form") {
    return showLotFailure(ctx, result, {
      person,
      retry: ctx.callbackQuery?.data,
    });
  }
  if (action.kind === "lot-form") {
    await showScreen(ctx, lotFormScreen(result.lot));
    return sent("lot form sent");
  }
  const registry = result.lot.registry;
  // «Копировать» (PER-716): кнопка стоит, пока реестр открыт и лот вне сета,
  // но старая остаётся в чате. Реестр не прочитан — вопрос задаётся, а
  // решает ответ.
  if (action.kind === "lot-copy") {
    if (registry?.open === false) {
      return showLotFailure(
        ctx,
        { kind: "lot-refused", reason: "lots-frozen", lotId },
        { person },
      );
    }
    if (registry?.set !== undefined) {
      return showLotFailure(
        ctx,
        {
          kind: "lot-refused",
          reason: "lot-in-set",
          lotId,
          setName: registry.set.name,
        },
        { person },
      );
    }
    await askLotQuestion(ctx, questions, {
      question: { kind: "copies", lotId },
      lot: result.lot,
    });
    return sent("lot copies count requested");
  }
  // «Удалить лот» (PER-716): подтверждение, пока реестр открыт. Подделанное
  // «Да» после открытия недели получит отказ Auction.
  if (action.kind === "lot-remove") {
    if (registry?.open === false) {
      return showLotFailure(
        ctx,
        { kind: "lot-refused", reason: "removal-frozen", lotId },
        { person },
      );
    }
    await showScreen(ctx, lotRemoveConfirmScreen(result.lot));
    return sent("lot removal confirmation sent");
  }
  // Фото пропущено — цепочка нового лота кончилась (PER-618): тот же итог,
  // что после принятого фото. Вопрос удалён до чтения, итог — новым
  // сообщением.
  if (action.kind === "lot-skip") {
    await showScreen(ctx, lotSavedScreen(result.lot, lotSavedNote.ready));
    return sent("lot photo skipped");
  }
  // «Убрать фото» (PER-715): вопрос удалён до чтения, подтверждение — новым
  // сообщением. У проданного лота правок нет, а у лота, у которого фото уже
  // убрали, подтверждать нечего — открывается форма.
  if (action.kind === "lot-image-remove") {
    if (isSold(result.lot.terms)) {
      return showLotFailure(
        ctx,
        { kind: "lot-refused", reason: "lot-sold", lotId },
        { person },
      );
    }
    const { imagePrint } = result.lot;
    if (imagePrint === undefined) {
      await showScreen(ctx, lotFormScreen(result.lot));
      return sent("lot form sent: no photo to remove");
    }
    await showScreen(
      ctx,
      lotImageRemoveConfirmScreen({ ...result.lot, imagePrint }),
    );
    return sent("lot photo removal confirmation sent");
  }
  // Способ шага выбран (PER-491): цена едет в кнопке. Условия могли замерзнуть
  // между ценой и этим нажатием — отказ приходит здесь, до вопроса, а не после
  // ответа, как у ряда цены.
  if (action.kind === "lot-step-mode") {
    if (result.lot.terms.kind === "closed") {
      return showLotFailure(
        ctx,
        { kind: "lot-refused", reason: "terms-closed", lotId },
        { person },
      );
    }
    await askLotQuestion(ctx, questions, {
      question: {
        kind: "step",
        lotId,
        priceRubles: action.price,
        mode: action.mode,
        ...chained(action.chain),
        ...setScope(action.set),
      },
      lot: result.lot,
    });
    return sent("lot step requested");
  }
  // Рядов полей у проданного лота нет; старая кнопка получает отказ до
  // вопроса (решение владельца 15 октября 2026 года).
  if (isSold(result.lot.terms)) {
    return showLotFailure(
      ctx,
      { kind: "lot-refused", reason: "lot-sold", lotId },
      { person },
    );
  }
  // Ряд цены на экране правки стоит, пока условия открыты; старая кнопка под
  // лотом в торгах получает отказ до вопроса, а не после двух ответов.
  if (action.field === "price" && result.lot.terms.kind === "closed") {
    return showLotFailure(
      ctx,
      { kind: "lot-refused", reason: "terms-closed", lotId },
      { person },
    );
  }
  // Поле лота полного сета (PER-716): сначала выбор «Только этот лот» или
  // «Все лоты сета». Сет разобрали, пока висела кнопка, — вопрос одного лота.
  if (
    action.kind === "lot-scope" &&
    registry?.set !== undefined &&
    registry.set.size >= 2
  ) {
    await showScreen(
      ctx,
      lotScopeScreen(result.lot, registry.set, action.field),
    );
    return sent("lot edit scope requested");
  }
  const tail =
    action.kind === "lot-ask"
      ? { ...chained(action.chain), ...setScope(action.set) }
      : {};
  // Фото, как и тексты, меняется и после старта торгов до продажи (ADR-057). Кнопка
  // цепочки нового лота (PER-618) — «Ввести заново» под ней — задаёт вопрос
  // цепочки.
  await askLotQuestion(ctx, questions, {
    question:
      action.field === "price"
        ? { kind: "price", lotId, ...tail }
        : action.field === "image"
          ? { kind: "image", lotId, ...tail }
          : {
              kind: "text",
              field: action.field,
              lotId,
              ...setScope(action.kind === "lot-ask" ? action.set : undefined),
            },
    lot: result.lot,
  });
  return sent("lot field requested");
}

// Признак цепочки нового лота (PER-618) полем вопроса: нет — нет и поля.
function chained(chain: boolean | undefined): { chain?: true } {
  return chain === true ? { chain: true } : {};
}

// Хвост кнопки повтора вопроса формы лота: цепочка (PER-618) или правка
// всех лотов сета (PER-716).
function stepScope(step: { chain?: true; set?: true }): boolean | "set" {
  return step.set === true ? "set" : step.chain === true;
}

// Признак правки всех лотов сета (PER-716) полем вопроса или запроса.
function setScope(set: boolean | undefined): { set?: true } {
  return set === true ? { set: true } : {};
}

// Идёт ли вопрос цепочкой нового лота (PER-618).
function inChain(question: LotQuestion): boolean {
  return (
    question.kind !== "new" &&
    question.kind !== "text" &&
    question.kind !== "copies" &&
    question.chain === true
  );
}

// Правит ли вопрос все лоты сета (PER-716).
function inSet(question: LotQuestion): boolean {
  return (
    question.kind !== "new" &&
    question.kind !== "copies" &&
    question.set === true
  );
}

// Вопрос, который юзкейс вернул заново, остаётся в цепочке или в правке сета,
// если в ней был отвеченный: проверка цены признаков не читает и не
// возвращает.
function keepChain(question: LotQuestion, answered: LotQuestion): LotQuestion {
  const chain = inChain(answered);
  const set = inSet(answered);
  if (!chain && !set) return question;
  switch (question.kind) {
    case "price":
    case "step":
    case "image":
      return { ...question, ...chained(chain), ...setScope(set) };
    case "text":
      return { ...question, ...setScope(set) };
    case "new":
    case "copies":
      return question;
    default: {
      const _exhaustive: never = question;
      return _exhaustive;
    }
  }
}

// Лот глазами участника (PER-512): снимок читается правом администратора, как
// у формы, тело — `previewLot` аукционного дерева, а вёрстка и фото — та же
// доставка, что у карточки участника. Возврат — в форму.
async function handleLotPreviewCallback(
  ctx: UpdateContext,
  runtime: BotRuntime,
  lotPhotos: LotPhotos,
  person: Person,
  token: string,
): Promise<BoundaryOutcome> {
  const useCase: ProductUseCase = "manage_lot";
  // Без клиента Auction карточку нарисовать нечем: отказ до чтения лота и
  // без «Повторить», который не помог бы.
  if (runtime.auction === undefined) {
    return showLotFailure(
      ctx,
      { kind: "rejected", reason: "auction-not-configured" },
      { person },
    );
  }
  const lotId = tokenToUuid(token);
  const result = await runtime.dispatcher.execute({
    identity: person,
    intent: "view-lot-preview",
    lotId,
    ...rpcCall(ctx, useCase),
  });
  if (result.kind !== "lot-preview") {
    return showLotFailure(ctx, result, {
      person,
      retry: ctx.callbackQuery?.data,
    });
  }
  const ports = runtime.auction.screenPorts(rpcCall(ctx, useCase));
  const viewer = viewerOf(person);
  const body = await previewLot({
    auction: ports.auction,
    viewer,
    lot: result.lot,
  });
  const { note: photoNote } = await deliverAuctionScreen(ctx, {
    view: {
      body,
      rootParent: toMeetups,
      presentation: runtime.presentation ?? "rich",
      timeZone: runtime.communityTimeZone ?? "UTC",
      today: communityToday(ctx),
      preview: { name: "Изменить лот", data: lotFormData(token) },
    },
    lotPhotos,
    image: ports.image,
    viewer,
    logger: runtime.logger,
  });
  return {
    level: "info",
    message:
      photoNote === undefined
        ? "lot preview sent"
        : `lot preview sent; ${photoNote}`,
    result: "ok",
    use_case: useCase,
    identity_id: person.identityId,
  };
}

// `replaces` — номер прежнего вопроса: его закрывает новый, когда уже ушёл.
function askLotQuestion(
  ctx: UpdateContext,
  questions: Map<string, PendingInput>,
  ask: {
    question: LotQuestion;
    lot?: LotFormView | undefined;
    error?: LotAskError | undefined;
    maxImageBytes?: number | undefined;
    suggestedTiers?: LotTierView[] | undefined;
    replaces?: number | undefined;
    // Что уже сделано, строкой над вопросом цепочки нового лота (PER-618).
    lead?: string | undefined;
  },
): Promise<void> {
  const pending: PendingBody = {
    kind: "lot",
    question: ask.question,
    telegramUserId: ctx.from?.id ?? 0,
  };
  // Непринятый ответ — свой экран с «Ввести заново» (PER-472).
  if (ask.error !== undefined) {
    return refuseAnswer(
      ctx,
      questions,
      pending,
      lotAskErrorText(ask.error, ask),
      ask.replaces,
    );
  }
  // Фото в цепочке нового лота можно пропустить (PER-618), а у лота с фото —
  // убрать (PER-715): кнопка стоит над «Отменой» и, как она, уводит от
  // вопроса. У нового лота фото ещё нет, поэтому двух кнопок сразу не бывает.
  const photoAction =
    ask.question.kind !== "image"
      ? undefined
      : ask.question.chain === true
        ? {
            text: skipPhotoLabel,
            data: lotSkipData(uuidToToken(ask.question.lotId)),
          }
        : ask.lot?.hasImage === true
          ? {
              text: removePhotoLabel,
              data: lotImageRemoveData(uuidToToken(ask.question.lotId)),
            }
          : undefined;
  return askQuestion(
    ctx,
    questions,
    pending,
    lotQuestionText(ask.question, ask.lot, ask.lead),
    ask.replaces,
    photoAction,
  );
}

// Команда формы по шагу вопроса. Ключ команды создания — идентификатор самого
// лота: он один на вопрос, поэтому повторный ответ и ответ после рестарта
// Auction узнаёт как повтор `AddLot`, а не как вторую команду. Ключ условий
// торгов рождается на каждый ответ: в кнопку вопроса о шаге он не помещается,
// а условия Auction заменяет целиком, и повтор даёт тот же итог.
function lotAnswerRequest(
  question: Exclude<LotQuestion, { kind: "image" }>,
  value: string,
  call: { identity: Person } & RpcMetadata,
): ExecuteRequest {
  switch (question.kind) {
    case "new":
      return {
        ...call,
        intent: "create-lot",
        auctionId: question.auctionId,
        lotId: question.lotId,
        title: value,
        opId: question.lotId,
      };
    case "text":
      return {
        ...call,
        intent: "set-lot-text",
        lotId: question.lotId,
        field: question.field,
        value,
        ...setScope(question.set),
      };
    case "price":
      return {
        ...call,
        intent: "check-lot-price",
        lotId: question.lotId,
        value,
      };
    case "step":
      return {
        ...call,
        intent: "set-lot-terms",
        lotId: question.lotId,
        priceRubles: question.priceRubles,
        mode: question.mode,
        value,
        opId: createUuidV7(),
        ...setScope(question.set),
      };
    // Копии (PER-716): лоты и сет выведены из исходного лота, поэтому
    // повторный ответ после сбоя дозаводит недостающее.
    case "copies":
      return {
        ...call,
        intent: "copy-lot",
        lotId: question.lotId,
        value,
        opId: createUuidV7(),
      };
    default: {
      const _exhaustive: never = question;
      return _exhaustive;
    }
  }
}

// Итог ответа на вопрос формы лота (дизайн-код, «Доставка»): экран правки с
// заметкой одним новым сообщением, следующий вопрос либо тот же заново.
async function renderLotAnswer(
  ctx: UpdateContext,
  questions: Map<string, PendingInput>,
  result: ExecuteResult,
  answer: { person: Person; answered: LotQuestion; replyId: number },
): Promise<BoundaryOutcome> {
  const useCase: ProductUseCase = "manage_lot";
  const handled = (message: string): BoundaryOutcome => ({
    level: "info",
    message,
    result: "ok",
    use_case: useCase,
    identity_id: answer.person.identityId,
  });
  const chain = inChain(answer.answered);
  // Цепочка нового лота (PER-618): после названия — цена, после цены и шага —
  // фото. Лот, у которого условия уже заданы или закрыты, — повторный ответ на
  // вопрос о названии — цепочку не начинает: правка идёт экраном исхода.
  if (
    result.kind === "lot-form" &&
    answer.answered.kind === "new" &&
    result.lot.terms.kind === "unset"
  ) {
    await askLotQuestion(ctx, questions, {
      question: { kind: "price", lotId: result.lot.lotId, chain: true },
      lead: lotChainLead.created,
    });
    return handled("lot price requested in the chain");
  }
  if (result.kind === "lot-form" && chain && result.saved === "terms") {
    await askLotQuestion(ctx, questions, {
      question: { kind: "image", lotId: result.lot.lotId, chain: true },
      lead: lotChainLead.terms,
    });
    return handled("lot photo requested in the chain");
  }
  if (result.kind === "lot-set-applied") {
    await showScreen(ctx, lotSetAppliedScreen(result.lot, result));
    return handled("lot set edit applied");
  }
  if (result.kind === "lot-copies") {
    await showScreen(ctx, lotCopiesScreen(result.lot, result));
    return handled("lot copied into a set");
  }
  if (result.kind === "lot-form") {
    await showScreen(
      ctx,
      result.saved === undefined
        ? lotFormScreen(result.lot)
        : lotSavedScreen(
            result.lot,
            lotSavedNote[
              chain && result.saved === "image" ? "ready" : result.saved
            ],
          ),
    );
    return handled("lot form answer saved");
  }
  // Цена принята — спрашивается способ шага (PER-491) отдельным экраном:
  // вопрос о шаге предполагает текст, а способ — выбор кнопкой.
  if (result.kind === "lot-step-mode") {
    await showScreen(
      ctx,
      lotStepModeScreen(
        result.lot,
        result.priceRubles,
        chain,
        inSet(answer.answered),
      ),
    );
    return handled("lot step mode requested");
  }
  if (result.kind === "lot-ask") {
    await askLotQuestion(ctx, questions, {
      question: keepChain(result.question, answer.answered),
      lot: result.lot,
      error: result.error,
      maxImageBytes: result.maxImageBytes,
      suggestedTiers: result.suggestedTiers,
      replaces: answer.replyId,
    });
    return handled(
      result.error === undefined
        ? "lot form next step requested"
        : "lot form answer asked again",
    );
  }
  return showLotFailure(ctx, result, {
    person: answer.person,
    answered: answer.answered,
  });
}

// Ответ на вопрос о фото лота (PER-452). Фото скачивается здесь, на краю: путь
// файла даёт `getFile`, байты — порт скачивания, а юзкейс получает только
// байты. Не фото и альбом — тот же вопрос с причиной, без Auction. Telegram
// файл не отдал — тоже: фото можно прислать ещё раз, лот не менялся.
async function answerLotPhoto(
  ctx: UpdateContext,
  runtime: BotRuntime,
  questions: Map<string, PendingInput>,
  photos: { files: TelegramFiles; albums: SeenAlbums },
  answer: {
    person: Person;
    question: Extract<LotQuestion, { kind: "image" }>;
    replyId: number;
    answered: (result?: ExecuteResult) => Promise<void>;
  },
): Promise<BoundaryOutcome> {
  const useCase: ProductUseCase = "manage_lot";
  const identity = { identity_id: answer.person.identityId };
  const askAgain = async (error: LotAskError, message: string) => {
    await askLotQuestion(ctx, questions, {
      question: answer.question,
      error,
      replaces: answer.replyId,
    });
    return {
      level: "info",
      message,
      result: "ok",
      use_case: useCase,
      ...identity,
    } satisfies BoundaryOutcome;
  };
  const input = parseLotPhoto(ctx.message);
  if (input.kind === "album") {
    photos.albums.remember(input.group);
    return askAgain("photo-album", "lot photo album refused");
  }
  if (input.kind === "not-photo") {
    return askAgain("photo-needed", "lot photo answer asked again");
  }
  const downloaded = await downloadPhoto(ctx, photos.files, input.fileId);
  if (downloaded.kind === "failed") {
    await askLotQuestion(ctx, questions, {
      question: answer.question,
      error: "photo-unavailable",
      replaces: answer.replyId,
    });
    return {
      level: "warn",
      message: "lot photo download failed",
      result: "error",
      use_case: useCase,
      ...identity,
      error_category:
        downloaded.reason === "timeout" ? "timeout" : "dependency_unavailable",
      error: downloaded.cause.message,
    };
  }
  const result = await runtime.dispatcher.execute({
    identity: answer.person,
    intent: "set-lot-image",
    lotId: answer.question.lotId,
    image: downloaded.bytes,
    ...setScope(answer.question.set),
    ...rpcCall(ctx, useCase),
  });
  const outcome = await renderLotAnswer(ctx, questions, result, {
    person: answer.person,
    answered: answer.question,
    replyId: answer.replyId,
  });
  if (result.kind !== "lot-ask") await answer.answered(result);
  return outcome;
}

// Путь файла у Telegram, затем байты. Отказ `getFile` — тоже отказ скачивания:
// человеку он говорит одно и то же.
async function downloadPhoto(
  ctx: UpdateContext,
  files: TelegramFiles,
  fileId: string,
): Promise<FileDownload> {
  let path: string | undefined;
  try {
    path = (await ctx.api.getFile(fileId)).file_path;
  } catch (cause) {
    return {
      kind: "failed",
      reason: "unavailable",
      cause: new Error(
        `getFile failed: ${cause instanceof GrammyError ? cause.description : "unknown"}`,
      ),
    };
  }
  return path === undefined
    ? {
        kind: "failed",
        reason: "unavailable",
        cause: new Error("getFile answered without file_path"),
      }
    : files.download(path);
}

// Отказ формы лота: кадр с выходом туда, где видно текущее состояние. Сбой
// Auction на ответе оставляет вопрос открытым и просит прислать ответ ещё раз;
// на нажатии — предлагает повторить его.
async function showLotFailure(
  ctx: UpdateContext,
  result: ExecuteResult,
  context: {
    person: Person;
    retry?: string | undefined;
    answered?: LotQuestion;
  },
): Promise<BoundaryOutcome> {
  const useCase: ProductUseCase = "manage_lot";
  const identity = { identity_id: context.person.identityId };
  if (result.kind === "lot-refused") {
    const exit =
      result.reason === "not-administrator" ||
      result.reason === "auction-not-found"
        ? exitToMeetups()
        : result.reason === "lot-not-found"
          ? // Чтения Auction отстают от команды: лот, который форма только что
            // завела, они могут не знать и после окна ожидания юзкейса
            // (PER-471). Нажатие можно повторить.
            context.retry === undefined
            ? exitToMeetups()
            : exitRetry(context.retry)
          : result.lotId !== undefined
            ? withNav(new InlineKeyboard(), toLot(result.lotId))
            : result.auctionId !== undefined
              ? withNav(new InlineKeyboard(), toLots(result.auctionId))
              : exitToMeetups();
    await showRefusal(
      ctx,
      result.reason === "not-administrator"
        ? forbiddenText
        : result.reason === "lot-in-set" && result.setName !== undefined
          ? `Лот уже в сете «${result.setName}». Копии заводятся только у лота вне сета.`
          : lotRefusalText[result.reason],
      exit,
    );
    return {
      level: "warn",
      message: "lot form rejected",
      result: "error",
      use_case: useCase,
      ...identity,
      error_category:
        result.reason === "not-administrator"
          ? "authorization"
          : result.reason === "lot-not-found" ||
              result.reason === "auction-not-found"
            ? "visibility"
            : "invariant",
      error: result.reason.replaceAll("-", "_"),
    };
  }
  const forbidden =
    result.kind === "dependency-rejected" && result.reason === "forbidden";
  await showRefusal(
    ctx,
    forbidden
      ? forbiddenText
      : context.answered !== undefined && retryable(result)
        ? lotSaveRetryText
        : unavailableText,
    forbidden || context.retry === undefined
      ? exitToMeetups()
      : exitRetry(context.retry),
  );
  return {
    ...screenBoundary(result, {
      ok: [],
      okMessage: "lot form handled",
      rejectedMessage: "lot form rejected",
      useCase,
    }),
    ...identity,
  };
}

// «Включить аукцион» от человека без права вести аукцион (PER-654).
async function refuseEnableAuction(
  ctx: UpdateContext,
  person: Person,
  token: string,
): Promise<BoundaryOutcome> {
  await showRefusal(ctx, forbiddenText, exitToExtensions(token));
  return {
    level: "warn",
    message: "auction enabling rejected",
    result: "error",
    use_case: "enable_auction",
    identity_id: person.identityId,
    error_category: "authorization",
    error: "enable_auction_forbidden",
  };
}

// Кнопка или ответ формы лота от человека без права вести аукцион.
async function refuseLotForm(
  ctx: UpdateContext,
  person: Person,
): Promise<BoundaryOutcome> {
  await showRefusal(ctx, forbiddenText, exitToMeetups());
  return {
    level: "warn",
    message: "lot form rejected",
    result: "error",
    use_case: "manage_lot",
    identity_id: person.identityId,
    error_category: "authorization",
    error: "lot_form_forbidden",
  };
}

// Пульт аукциона администратора (PER-320). Сюда доходит только
// администратор. Своего состояния у пульта нет: каждое нажатие читает пульт
// у Auction заново, а ключ открытия недели рождается на подтверждении и едет
// в его «Да».
async function handleConsoleCallback(
  ctx: UpdateContext,
  runtime: BotRuntime,
  questions: Map<string, PendingInput>,
  person: Person,
  action: Extract<
    CallbackAction,
    {
      kind:
        | "console-view"
        | "console-week"
        | "console-raffle"
        | "console-raffle-remove"
        | "console-raffle-prize"
        | "console-raffle-prize-remove"
        | "console-final"
        | "console-final-time"
        | "console-final-time-remove"
        | "console-visibility"
        | "console-open"
        | "console-confirm"
        | "console-discard"
        | "console-discard-confirm"
        | "console-cancel"
        | "console-cancel-confirm"
        | "console-mark"
        | "console-lineup"
        | "console-lineup-confirm"
        | "console-start-final"
        | "console-next-lot"
        | "console-ask"
        | "console-close"
        | "console-close-confirm"
        | "console-windows"
        | "console-day-summary"
        | "console-window"
        | "console-window-ask"
        | "console-window-lot"
        | "console-window-remove"
        | "console-window-launch"
        | "console-window-launch-lot"
        | "console-window-launch-go"
        | "console-window-launch-page"
        | "console-sets"
        | "console-set-ask"
        | "console-set"
        | "console-set-lot"
        | "console-set-delete"
        | "console-set-delete-confirm";
    }
  >,
): Promise<BoundaryOutcome> {
  const useCase: ProductUseCase = "manage_auction";
  const auctionId = tokenToUuid(action.auction);
  const call = {
    identity: person,
    auctionId,
    ...rpcCall(ctx, useCase),
  };
  const render = (result: ExecuteResult, page = 0, sort = defaultConsoleSort) =>
    renderConsoleResult(ctx, runtime, result, {
      person,
      questions,
      page,
      sort,
      retry: ctx.callbackQuery?.data,
    });
  switch (action.kind) {
    case "console-view":
      return render(
        await runtime.dispatcher.execute({
          ...call,
          intent: "view-auction-console",
        }),
        action.page,
        action.sort,
      );
    case "console-week":
      // Можно ли ещё менять сроки, решает юзкейс: вопрос либо пульт с причиной.
      return render(
        await runtime.dispatcher.execute({
          ...call,
          intent: "ask-auction-week",
        }),
      );
    // Розыгрыш (PER-593): можно ли ещё менять момент, решает юзкейс. Ключ
    // снятия рождается на нажатие: конфигурацию Auction заменяет целиком, и
    // повтор даёт тот же итог.
    case "console-raffle":
      return render(
        await runtime.dispatcher.execute({
          ...call,
          intent: "ask-auction-raffle",
        }),
      );
    case "console-raffle-remove":
      return render(
        await runtime.dispatcher.execute({
          ...call,
          intent: "remove-auction-raffle",
          opId: createUuidV7(),
        }),
      );
    // Приз розыгрыша (PER-649): живёт рядом с моментом, поэтому и вопрос, и
    // снятие решает юзкейс по прочитанной конфигурации.
    case "console-raffle-prize":
      return render(
        await runtime.dispatcher.execute({
          ...call,
          intent: "ask-auction-raffle-prize",
        }),
      );
    case "console-raffle-prize-remove":
      return render(
        await runtime.dispatcher.execute({
          ...call,
          intent: "remove-auction-raffle-prize",
          opId: createUuidV7(),
        }),
      );
    case "console-final":
      return render(
        await runtime.dispatcher.execute({
          ...call,
          intent: "set-auction-final",
          final: action.final,
          opId: createUuidV7(),
        }),
      );
    // Ориентировочное время финала (PER-663): вопрос спрашивает момент, а
    // снятие идёт без вопроса — ключ рождается на нажатие, потому что
    // выставление и снятие под одним ключом — разные события Auction.
    case "console-final-time":
      return render(
        await runtime.dispatcher.execute({
          ...call,
          intent: "ask-auction-final-time",
        }),
      );
    case "console-final-time-remove":
      return render(
        await runtime.dispatcher.execute({
          ...call,
          intent: "remove-auction-final-time",
          opId: createUuidV7(),
        }),
      );
    case "console-visibility":
      return render(
        await runtime.dispatcher.execute({
          ...call,
          intent: "set-auction-visibility",
          published: action.published,
          opId: createUuidV7(),
        }),
      );
    case "console-open":
      // Подтверждение либо пульт с причиной решает юзкейс; ключ открытия
      // рождается здесь и уедет в «Да».
      return render(
        await runtime.dispatcher.execute({
          ...call,
          intent: "prepare-auction-week-start",
          opId: createUuidV7(),
        }),
      );
    case "console-confirm":
      return render(
        await runtime.dispatcher.execute({
          ...call,
          intent: "start-auction-week",
          opId: tokenToUuid(action.op),
        }),
      );
    case "console-discard":
      // Подтверждение либо пульт с причиной решает юзкейс; ключ удаления
      // рождается здесь и уедет в «Да».
      return render(
        await runtime.dispatcher.execute({
          ...call,
          intent: "prepare-auction-discard",
          opId: createUuidV7(),
        }),
      );
    case "console-discard-confirm":
      return render(
        await runtime.dispatcher.execute({
          ...call,
          intent: "discard-auction",
          opId: tokenToUuid(action.op),
        }),
      );
    case "console-cancel":
      // Подтверждение либо пульт с причиной решает юзкейс; ключ отмены
      // рождается здесь и уедет в «Да».
      return render(
        await runtime.dispatcher.execute({
          ...call,
          intent: "prepare-auction-cancel",
          opId: createUuidV7(),
        }),
      );
    case "console-cancel-confirm":
      return render(
        await runtime.dispatcher.execute({
          ...call,
          intent: "cancel-auction",
          opId: tokenToUuid(action.op),
        }),
      );
    case "console-mark":
      return render(
        await runtime.dispatcher.execute({
          ...call,
          intent: "mark-auction-finalist",
          lotId: tokenToUuid(action.lot),
          selected: action.selected,
          opId: createUuidV7(),
        }),
        action.page,
        action.sort,
      );
    // Состав финала (PER-619). Выбранный порядок едет в кнопках, ключ
    // объявления рождается на нажатие «Да»: повтор после принятого
    // объявления пульт узнаёт по статусу аукциона и к Auction не идёт.
    case "console-lineup":
      return render(
        await runtime.dispatcher.execute({
          ...call,
          intent: "order-final-lineup",
          ...(action.pick === undefined ? {} : { pick: action.pick }),
          page: action.page,
        }),
      );
    case "console-lineup-confirm":
      return render(
        await runtime.dispatcher.execute({
          ...call,
          intent: "freeze-final-lineup",
          pick: action.pick,
          opId: createUuidV7(),
        }),
      );
    // Финал ведущего (PER-337). Ключ начала финала и следующего лота
    // рождается на нажатие: повтор с новым ключом Auction называет отказом
    // словами состояния. Ключ закрытия рождается на подтверждении и едет в
    // «Да»: второе нажатие того же «Да» — повтор, а не вторая продажа.
    case "console-start-final":
      return render(
        await runtime.dispatcher.execute({
          ...call,
          intent: "start-auction-final",
          opId: createUuidV7(),
        }),
      );
    case "console-next-lot":
      return render(
        await runtime.dispatcher.execute({
          ...call,
          intent: "start-final-lot",
          opId: createUuidV7(),
        }),
      );
    case "console-ask":
      return render(
        await runtime.dispatcher.execute({
          ...call,
          intent: "ask-final-price",
          position: action.position,
        }),
      );
    case "console-close":
      return render(
        await runtime.dispatcher.execute({
          ...call,
          intent: "prepare-final-close",
          position: action.position,
          opId: createUuidV7(),
        }),
      );
    // «Счастливые часы» (PER-504). Ключ команды рождается на нажатие: окна
    // Auction заменяет вместе с конфигурацией, а кнопка лота несёт целевое
    // состояние, и повтор даёт тот же итог.
    case "console-windows":
      return render(
        await runtime.dispatcher.execute({
          ...call,
          intent: "view-step-windows",
        }),
      );
    case "console-day-summary":
      return render(
        await runtime.dispatcher.execute({
          ...call,
          intent: "view-day-summary",
        }),
      );
    case "console-window":
      return render(
        await runtime.dispatcher.execute({
          ...call,
          intent: "view-step-window",
          window: action.window,
          page: action.page,
        }),
      );
    case "console-window-ask":
      return render(
        await runtime.dispatcher.execute({
          ...call,
          intent: "ask-step-window",
        }),
      );
    case "console-window-lot":
      return render(
        await runtime.dispatcher.execute({
          ...call,
          intent: "set-step-window-lot",
          window: action.window,
          lotId: tokenToUuid(action.lot),
          selected: action.selected,
          opId: createUuidV7(),
        }),
      );
    case "console-window-remove":
      return render(
        await runtime.dispatcher.execute({
          ...call,
          intent: "remove-step-window",
          window: action.window,
          opId: createUuidV7(),
        }),
      );
    // Сеты лотов (PER-509). Ключ команды рождается на нажатие: кнопка лота
    // несёт целевое состояние, и повтор даёт тот же итог; «Да» удаления
    // называет сет номером и отпечатком, и ключ в 64 байта не помещается.
    case "console-sets":
      return render(
        await runtime.dispatcher.execute({ ...call, intent: "view-lot-sets" }),
      );
    case "console-set-ask":
      return render(
        await runtime.dispatcher.execute({ ...call, intent: "ask-lot-set" }),
      );
    case "console-set":
      return render(
        await runtime.dispatcher.execute({
          ...call,
          intent: "view-lot-set",
          set: action.set,
          page: action.page,
        }),
      );
    case "console-set-lot":
      return render(
        await runtime.dispatcher.execute({
          ...call,
          intent: "set-lot-set-lot",
          set: action.set,
          lotId: tokenToUuid(action.lot),
          selected: action.selected,
          opId: createUuidV7(),
        }),
      );
    case "console-set-delete":
      return render(
        await runtime.dispatcher.execute({
          ...call,
          intent: "prepare-lot-set-delete",
          set: action.set,
        }),
      );
    case "console-set-delete-confirm":
      return render(
        await runtime.dispatcher.execute({
          ...call,
          intent: "delete-lot-set",
          set: action.set,
          opId: createUuidV7(),
        }),
      );
    // Запуск окна сниженного шага по ходу торгов (PER-615). Ключ команды
    // рождается на нажатии «Запустить окно»: черновик едет в кнопке, и 64
    // байта на ключ не остаётся.
    case "console-window-launch":
      return render(
        await runtime.dispatcher.execute({
          ...call,
          intent: "ask-step-window-launch",
        }),
      );
    case "console-window-launch-lot":
      return render(
        await runtime.dispatcher.execute({
          ...call,
          intent: "set-step-window-launch-lot",
          draft: action.draft,
          lot: action.lot,
        }),
      );
    case "console-window-launch-page":
      return render(
        await runtime.dispatcher.execute({
          ...call,
          intent: "view-step-window-launch",
          draft: action.draft,
          page: action.page,
        }),
      );
    case "console-window-launch-go":
      return render(
        await runtime.dispatcher.execute({
          ...call,
          intent: "launch-step-window",
          draft: action.draft,
          opId: createUuidV7(),
        }),
      );
    case "console-close-confirm":
      return render(
        await runtime.dispatcher.execute({
          ...call,
          intent: "close-final-lot",
          position: action.position,
          opId: tokenToUuid(action.op),
          quote: action.quote,
          // Ключ нового подтверждения, если лот изменился после прежнего.
          freshOpId: createUuidV7(),
        }),
      );
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

// Аукцион с идущими торгами исход называет сходкой (PER-618), но Auction по
// аукциону сходку не отдаёт намеренно: её знает только память процесса —
// пара, которую бот видел в меню «Расширения». Название читается у Meetups от
// имени администратора; нет пары или чтение отказало — исход называет
// аукцион сроками недели.
async function withMeetupTitle(
  ctx: UpdateContext,
  runtime: BotRuntime,
  person: Person,
  holder: TradingHolder,
): Promise<TradingHolder> {
  const meetupId = ctx.auctionParents?.meetupOf(holder.auctionId);
  if (meetupId === undefined) return holder;
  try {
    const meetup = await runtime.dispatcher.execute({
      identity: person,
      intent: "view-meetup-extensions",
      meetupId,
      ...rpcCall(ctx, "manage_auction"),
    });
    return meetup.kind === "meetup-card"
      ? { ...holder, meetupTitle: meetup.meetup.title }
      : holder;
  } catch {
    return holder;
  }
}

// Исход пульта: экран пульта с исходом первой строкой, вопрос о сроках либо
// кадр отказа. `replyId` — ответ на вопрос о сроках: новый вопрос закрывает
// прежний, а сбой Auction оставляет его открытым.
async function renderConsoleResult(
  ctx: UpdateContext,
  runtime: BotRuntime,
  result: ExecuteResult,
  context: {
    person: Person;
    questions: Map<string, PendingInput>;
    page?: number;
    sort?: ConsoleSort;
    retry?: string | undefined;
    replyId?: number;
  },
): Promise<BoundaryOutcome> {
  const useCase: ProductUseCase = "manage_auction";
  const identity = { identity_id: context.person.identityId };
  const handled = (message: string): BoundaryOutcome => ({
    level: "info",
    message,
    result: "ok",
    use_case: useCase,
    ...identity,
  });
  const timeZone = runtime.communityTimeZone ?? "UTC";
  switch (result.kind) {
    case "auction-console": {
      // Переключатель финала подтверждает себя всплывающим текстом (P-08).
      if (result.toggled === true) {
        await ctx.waiting?.answer(
          finalToast(result.console.week?.final === true),
        );
      }
      const holder =
        result.holder === undefined
          ? undefined
          : await withMeetupTitle(ctx, runtime, context.person, result.holder);
      const view: ConsoleScreenView = {
        console: result.console,
        ...(result.note === undefined ? {} : { note: result.note }),
        ...(result.noteLot === undefined ? {} : { noteLot: result.noteLot }),
        ...(holder === undefined ? {} : { holder }),
        page: context.page ?? 0,
        sort: context.sort ?? defaultConsoleSort,
        timeZone,
        today: communityToday(ctx),
      };
      const sent = await showScreen(ctx, consoleScreen(view));
      // Пульт финала (PER-566): сообщение, в котором он оказался, правится
      // дальше по потоку аукциона. Без нового сообщения пульт остался в
      // нажатом — тот же экран или правка без ответа.
      const chatId = ctx.chat?.id;
      const pressed = ctx.callbackQuery?.message;
      const messageId =
        sent?.message_id ??
        (ctx.fresh === true ? undefined : pressed?.message_id);
      if (
        ctx.liveConsoles !== undefined &&
        chatId !== undefined &&
        messageId !== undefined
      ) {
        const kept = ctx.liveConsoles.shown(chatId, messageId, {
          person: context.person,
          view,
        });
        if (messageId === pressed?.message_id) ctx.liveConsoleShown = kept;
      }
      return handled(
        result.note === undefined
          ? "auction console sent"
          : `auction console sent: ${result.note}`,
      );
    }
    case "auction-week-confirm":
      await showScreen(
        ctx,
        weekConfirmScreen({
          console: result.console,
          opId: result.opId,
          opening: result.opening,
          idle: result.idle,
          timeZone,
          today: communityToday(ctx),
          ...(result.early === undefined ? {} : { early: result.early }),
        }),
      );
      return handled("auction week confirmation sent");
    case "auction-discard-confirm":
      await showScreen(ctx, discardConfirmScreen(result));
      return handled("auction discard confirmation sent");
    case "auction-cancel-confirm":
      await showScreen(ctx, cancelConfirmScreen(result));
      return handled("auction cancel confirmation sent");
    case "auction-discarded": {
      // Возврат — к сходке, у которой был аукцион: там снова «Включить
      // аукцион». После рестарта бот сходку может не знать.
      const meetupId = ctx.auctionParents?.meetupOf(result.auctionId);
      await showScreen(ctx, {
        id: "outcome",
        text: outcomeText(auctionDiscardedText),
        keyboard: withNav(
          new InlineKeyboard(),
          meetupId === undefined ? toMeetups : toCard(uuidToToken(meetupId)),
        ),
        format: "HTML",
      });
      return handled("auction discarded");
    }
    case "auction-week-ask":
      await askConsoleWeek(ctx, context.questions, {
        auctionId: result.auctionId,
        timeZone,
        week: result.week,
        error: result.error,
        window: result.window,
        replaces: context.replyId,
      });
      return handled(
        result.error === undefined
          ? "auction week requested"
          : "auction week asked again",
      );
    case "auction-raffle-ask":
      await askConsoleRaffle(ctx, context.questions, {
        auctionId: result.auctionId,
        timeZone,
        week: result.week,
        error: result.error,
        replaces: context.replyId,
      });
      return handled(
        result.error === undefined
          ? "auction raffle requested"
          : "auction raffle asked again",
      );
    case "auction-raffle-prize-ask":
      await askConsolePrize(ctx, context.questions, {
        auctionId: result.auctionId,
        prize: result.prize,
        error: result.error,
        replaces: context.replyId,
      });
      return handled(
        result.error === undefined
          ? "raffle prize requested"
          : "raffle prize asked again",
      );
    case "auction-final-time-ask":
      await askConsoleFinalTime(ctx, context.questions, {
        auctionId: result.auctionId,
        timeZone,
        finalAt: result.finalAt,
        error: result.error,
        replaces: context.replyId,
      });
      return handled(
        result.error === undefined
          ? "auction final time requested"
          : "auction final time asked again",
      );
    case "auction-day-summary":
      await showScreen(
        ctx,
        daySummaryScreen({
          auctionId: result.auctionId,
          day: result.day,
          today: communityToday(ctx),
          lots: result.lots,
          ...(runtime.auctionBotUsername === undefined
            ? {}
            : { auctionBotUsername: runtime.auctionBotUsername }),
        }),
      );
      return handled("auction day summary sent");
    case "step-windows":
      await showScreen(
        ctx,
        windowsScreen({
          console: result.console,
          note: result.note,
          launch: result.launch,
          timeZone,
          today: communityToday(ctx),
        }),
      );
      return handled(
        result.note === undefined
          ? "step windows sent"
          : `step windows sent: ${result.note.kind}`,
      );
    case "step-window-launch":
      // Переключатель лота подтверждает себя всплывающим текстом, как окно.
      if (result.toggled !== undefined) {
        await ctx.waiting?.answer(windowLotToast(result.toggled.selected));
      }
      await showScreen(
        ctx,
        launchScreen({
          console: result.console,
          draft: result.draft,
          at: result.at,
          timeZone,
          today: communityToday(ctx),
        }),
      );
      return handled("step window launch sent");
    case "step-window-launch-ask":
      await askConsoleLaunch(ctx, context.questions, {
        auctionId: result.auctionId,
        timeZone,
        week: result.week,
        error: result.error,
        lot: result.lot,
        other: result.other,
        replaces: context.replyId,
      });
      return handled(
        result.error === undefined
          ? "step window launch requested"
          : "step window launch asked again",
      );
    case "step-window":
      // Переключатель лота подтверждает себя всплывающим текстом, как финал.
      if (result.toggled !== undefined) {
        await ctx.waiting?.answer(windowLotToast(result.toggled.selected));
      }
      await showScreen(
        ctx,
        windowScreen({
          console: result.console,
          index: result.index,
          at: result.at,
          timeZone,
          today: communityToday(ctx),
        }),
      );
      return handled("step window sent");
    case "lot-sets":
      await showScreen(
        ctx,
        lotSetsScreen({ console: result.console, note: result.note }),
      );
      return handled(
        result.note === undefined
          ? "lot sets sent"
          : `lot sets sent: ${result.note.kind}`,
      );
    case "lot-set":
      // Переключатель лота подтверждает себя всплывающим текстом, как окно.
      if (result.toggled !== undefined) {
        await ctx.waiting?.answer(lotSetLotToast(result.toggled.selected));
      }
      await showScreen(
        ctx,
        lotSetScreen({
          console: result.console,
          index: result.index,
          at: result.at,
        }),
      );
      return handled("lot set sent");
    case "lot-set-delete-confirm":
      await showScreen(
        ctx,
        lotSetDeleteConfirmScreen({
          console: result.console,
          index: result.index,
        }),
      );
      return handled("lot set delete confirmation sent");
    case "lot-set-ask":
      await askConsoleSet(ctx, context.questions, {
        auctionId: result.auctionId,
        error: result.error,
        replaces: context.replyId,
      });
      return handled(
        result.error === undefined
          ? "lot set name requested"
          : "lot set name asked again",
      );
    case "step-window-ask":
      await askConsoleWindow(ctx, context.questions, {
        auctionId: result.auctionId,
        timeZone,
        week: result.week,
        error: result.error,
        window: result.window,
        replaces: context.replyId,
      });
      return handled(
        result.error === undefined
          ? "step window requested"
          : "step window asked again",
      );
    case "final-ask":
      await askFinalPrice(ctx, context.questions, {
        auctionId: result.auctionId,
        position: result.position,
        title: result.title,
        nextPrice: result.nextPrice,
        error: result.error,
        mustExceed: result.mustExceed,
        replaces: context.replyId,
      });
      return handled(
        result.error === undefined
          ? "final ask requested"
          : "final ask asked again",
      );
    case "final-close-confirm":
      await showScreen(ctx, closeConfirmScreen(result));
      return handled("final lot close confirmation sent");
    case "lineup-order":
      await showScreen(ctx, lineupOrderScreen(result));
      return handled(
        result.changed === true
          ? "final lineup order restarted"
          : "final lineup order sent",
      );
    case "lineup-confirm":
      await showScreen(ctx, lineupConfirmScreen(result));
      return handled("final lineup confirmation sent");
    case "final-lot-closed":
      await showScreen(ctx, closedScreen(result));
      return handled(
        result.closure.kind === "sold" ? "final lot sold" : "final lot unsold",
      );
    case "auction-console-refused":
      await showRefusal(
        ctx,
        result.reason === "not-administrator"
          ? forbiddenText
          : result.reason === "meetup-cancelled"
            ? consoleMeetupCancelledText
            : consoleMissingText,
        exitToMeetups(),
      );
      return {
        level: "warn",
        message: "auction console rejected",
        result: "error",
        use_case: useCase,
        ...identity,
        error_category:
          result.reason === "not-administrator"
            ? "authorization"
            : result.reason === "auction-not-found"
              ? "visibility"
              : "invariant",
        error: result.reason.replaceAll("-", "_"),
      };
    default: {
      const forbidden =
        result.kind === "dependency-rejected" && result.reason === "forbidden";
      await showRefusal(
        ctx,
        forbidden
          ? forbiddenText
          : context.replyId !== undefined && retryable(result)
            ? lotSaveRetryText
            : unavailableText,
        forbidden || context.retry === undefined
          ? exitToMeetups()
          : exitRetry(context.retry),
      );
      return {
        ...screenBoundary(result, {
          ok: [],
          okMessage: "auction console handled",
          rejectedMessage: "auction console rejected",
          useCase,
        }),
        ...identity,
      };
    }
  }
}

function askConsoleWeek(
  ctx: UpdateContext,
  questions: Map<string, PendingInput>,
  ask: {
    auctionId: string;
    timeZone: string;
    week?: AuctionWeek | undefined;
    error?: WeekAskError | undefined;
    window?: number | undefined;
    replaces?: number | undefined;
  },
): Promise<void> {
  const pending: PendingBody = {
    kind: "console-week",
    auctionId: ask.auctionId,
    telegramUserId: ctx.from?.id ?? 0,
  };
  // Непринятый ответ — свой экран с «Ввести заново» (PER-472).
  if (ask.error !== undefined) {
    return refuseAnswer(
      ctx,
      questions,
      pending,
      weekAskError(ask.error, ask.window),
      ask.replaces,
    );
  }
  return askQuestion(
    ctx,
    questions,
    pending,
    weekQuestionText(ask.timeZone, ask.week),
    ask.replaces,
  );
}

function askConsoleRaffle(
  ctx: UpdateContext,
  questions: Map<string, PendingInput>,
  ask: {
    auctionId: string;
    timeZone: string;
    week: AuctionWeek;
    error?: RaffleAskError | undefined;
    replaces?: number | undefined;
  },
): Promise<void> {
  const pending: PendingBody = {
    kind: "console-raffle",
    auctionId: ask.auctionId,
    telegramUserId: ctx.from?.id ?? 0,
  };
  // Непринятый ответ — свой экран с «Ввести заново» (PER-472).
  if (ask.error !== undefined) {
    return refuseAnswer(
      ctx,
      questions,
      pending,
      raffleAskErrorText[ask.error],
      ask.replaces,
    );
  }
  return askQuestion(
    ctx,
    questions,
    pending,
    raffleQuestionText(ask.timeZone, ask.week),
    ask.replaces,
  );
}

// Вопрос об ориентировочном времени финала (PER-663): момент в формате ввода
// хаба, текущее время — в подсказке.
function askConsoleFinalTime(
  ctx: UpdateContext,
  questions: Map<string, PendingInput>,
  ask: {
    auctionId: string;
    timeZone: string;
    finalAt?: string | undefined;
    error?: FinalTimeAskError | undefined;
    replaces?: number | undefined;
  },
): Promise<void> {
  const pending: PendingBody = {
    kind: "console-final-time",
    auctionId: ask.auctionId,
    telegramUserId: ctx.from?.id ?? 0,
  };
  // Непринятый ответ — свой экран с «Ввести заново» (PER-472).
  if (ask.error !== undefined) {
    return refuseAnswer(
      ctx,
      questions,
      pending,
      finalTimeAskErrorText[ask.error],
      ask.replaces,
    );
  }
  return askQuestion(
    ctx,
    questions,
    pending,
    finalTimeQuestionText(ask.timeZone, ask.finalAt),
    ask.replaces,
  );
}

// Вопрос о призе розыгрыша (PER-649): приз одной строкой, текущий — в подсказке.
function askConsolePrize(
  ctx: UpdateContext,
  questions: Map<string, PendingInput>,
  ask: {
    auctionId: string;
    prize?: string | undefined;
    error?: RafflePrizeAskError | undefined;
    replaces?: number | undefined;
  },
): Promise<void> {
  const pending: PendingBody = {
    kind: "console-raffle-prize",
    auctionId: ask.auctionId,
    telegramUserId: ctx.from?.id ?? 0,
  };
  // Непринятый ответ — свой экран с «Ввести заново» (PER-472).
  if (ask.error !== undefined) {
    return refuseAnswer(
      ctx,
      questions,
      pending,
      rafflePrizeAskErrorText[ask.error],
      ask.replaces,
    );
  }
  return askQuestion(
    ctx,
    questions,
    pending,
    rafflePrizeQuestionText(ask.prize),
    ask.replaces,
  );
}

function askConsoleWindow(
  ctx: UpdateContext,
  questions: Map<string, PendingInput>,
  ask: {
    auctionId: string;
    timeZone: string;
    week?: AuctionWeek | undefined;
    error?: WindowAskError | undefined;
    window?: number | undefined;
    replaces?: number | undefined;
  },
): Promise<void> {
  const pending: PendingBody = {
    kind: "console-window",
    auctionId: ask.auctionId,
    telegramUserId: ctx.from?.id ?? 0,
  };
  // Непринятый ответ — свой экран с «Ввести заново» (PER-472).
  if (ask.error !== undefined) {
    return refuseAnswer(
      ctx,
      questions,
      pending,
      windowAskErrorText(ask.error, ask),
      ask.replaces,
    );
  }
  return askQuestion(
    ctx,
    questions,
    pending,
    windowQuestionText(ask.timeZone, ask.week),
    ask.replaces,
  );
}

// Вопрос о названии нового сета лотов (PER-509): название одной строкой.
function askConsoleSet(
  ctx: UpdateContext,
  questions: Map<string, PendingInput>,
  ask: {
    auctionId: string;
    error?: "name-empty" | undefined;
    replaces?: number | undefined;
  },
): Promise<void> {
  const pending: PendingBody = {
    kind: "console-set",
    auctionId: ask.auctionId,
    telegramUserId: ctx.from?.id ?? 0,
  };
  // Непринятый ответ — свой экран с «Ввести заново» (PER-472).
  if (ask.error !== undefined) {
    return refuseAnswer(
      ctx,
      questions,
      pending,
      lotSetAskErrorText[ask.error],
      ask.replaces,
    );
  }
  return askQuestion(ctx, questions, pending, lotSetPrompt, ask.replaces);
}

// Вопрос о запуске окна по ходу торгов (PER-615): отказ приходит текстом
// формы — тем же, что у планирования окна.
function askConsoleLaunch(
  ctx: UpdateContext,
  questions: Map<string, PendingInput>,
  ask: {
    auctionId: string;
    timeZone: string;
    week?: AuctionWeek | undefined;
    error?: WindowAskError | undefined;
    lot?: string | undefined;
    other?: { from: string; until: string } | undefined;
    replaces?: number | undefined;
  },
): Promise<void> {
  const pending: PendingBody = {
    kind: "console-launch",
    auctionId: ask.auctionId,
    telegramUserId: ctx.from?.id ?? 0,
  };
  // Непринятый ответ — свой экран с «Ввести заново» (PER-472).
  if (ask.error !== undefined) {
    return refuseAnswer(
      ctx,
      questions,
      pending,
      windowAskErrorText(ask.error, {
        timeZone: ask.timeZone,
        week: ask.week,
        lot: ask.lot,
        other: ask.other,
      }),
      ask.replaces,
    );
  }
  return askQuestion(
    ctx,
    questions,
    pending,
    launchQuestionText(ask.timeZone, ask.week),
    ask.replaces,
  );
}

function askFinalPrice(
  ctx: UpdateContext,
  questions: Map<string, PendingInput>,
  ask: {
    auctionId: string;
    position: number;
    title?: string | undefined;
    nextPrice?: LotAmount | undefined;
    error?: FinalAskError | undefined;
    mustExceed?: LotAmount | undefined;
    replaces?: number | undefined;
  },
): Promise<void> {
  const pending: PendingBody = {
    kind: "final-ask",
    auctionId: ask.auctionId,
    position: ask.position,
    telegramUserId: ctx.from?.id ?? 0,
  };
  // Непринятый ответ — свой экран с «Ввести заново» (PER-472).
  if (ask.error !== undefined) {
    return refuseAnswer(
      ctx,
      questions,
      pending,
      finalAskErrorText(ask.error, ask.mustExceed),
      ask.replaces,
    );
  }
  return askQuestion(ctx, questions, pending, finalAskText(ask), ask.replaces);
}

// Кнопка или ответ пульта от человека без права вести аукцион.
async function refuseConsole(
  ctx: UpdateContext,
  person: Person,
): Promise<BoundaryOutcome> {
  await showRefusal(ctx, forbiddenText, exitToMeetups());
  return {
    level: "warn",
    message: "auction console rejected",
    result: "error",
    use_case: "manage_auction",
    identity_id: person.identityId,
    error_category: "authorization",
    error: "auction_console_forbidden",
  };
}

// Снятие участника с лота (PER-659, ADR-072). Сюда доходит только держатель
// права вести аукцион; право на снятие решает Auction у Meetups. Лот,
// человек и номер лота едут в кнопке, ключ снятия рождается на нажатие «Да».
async function handleRemovalCallback(
  ctx: UpdateContext,
  runtime: BotRuntime,
  questions: Map<string, PendingInput>,
  person: Person,
  action: Extract<
    CallbackAction,
    {
      kind:
        | "console-removal"
        | "console-removal-pick"
        | "console-removal-confirm";
    }
  >,
): Promise<BoundaryOutcome> {
  const useCase: ProductUseCase = "manage_auction";
  const call = { identity: person, ...rpcCall(ctx, useCase) };
  // «Повторить» после сбоя на «Да» ведёт к предпросмотру, а не к снятию:
  // снятие, ответ на которое потерялся, могло пройти.
  const retry =
    action.kind === "console-removal-confirm"
      ? removalPickData(action.lot, action.person)
      : ctx.callbackQuery?.data;
  const lotId = tokenToUuid(action.lot);
  const result = await runtime.dispatcher.execute(
    action.kind === "console-removal"
      ? { ...call, intent: "view-lot-removal", lotId, page: action.page }
      : action.kind === "console-removal-pick"
        ? {
            ...call,
            intent: "prepare-participant-removal",
            target: { lotId, participantId: tokenToUuid(action.person) },
          }
        : {
            ...call,
            intent: "remove-participant",
            target: { lotId, participantId: tokenToUuid(action.person) },
            version: action.version,
            opId: createUuidV7(),
          },
  );
  const handled = (message: string): BoundaryOutcome => ({
    level: "info",
    message,
    result: "ok",
    use_case: useCase,
    identity_id: person.identityId,
  });
  const clock = {
    timeZone: runtime.communityTimeZone ?? "UTC",
    today: communityToday(ctx),
  };
  switch (result.kind) {
    case "removal-people":
      await showScreen(ctx, removalPeopleScreen(result));
      return handled("lot removal people sent");
    case "removal-confirm":
      await showScreen(ctx, removalConfirmScreen({ ...result, ...clock }));
      return handled(
        result.changed === true
          ? "participant removal confirmation restarted"
          : "participant removal confirmation sent",
      );
    case "removal-outcome":
      await showScreen(ctx, removalOutcomeScreen({ ...result, ...clock }));
      return handled(
        result.note.kind === "refused"
          ? `participant removal refused: ${result.note.reason}`
          : result.note.kind === "removed"
            ? "participant removed"
            : "lot removal without participants",
      );
    default:
      return renderConsoleResult(ctx, runtime, result, {
        person,
        questions,
        retry,
      });
  }
}

// Счета аукциона (PER-321). Сюда доходит только держатель права вести
// аукцион; право на чтение и отметку решает Auction. Своего состояния нет:
// аукцион и счёт едут в кнопке, а ключ отметки рождается на нажатие «Да».
async function handleInvoicesCallback(
  ctx: UpdateContext,
  runtime: BotRuntime,
  questions: Map<string, PendingInput>,
  person: Person,
  action: Extract<
    CallbackAction,
    {
      kind:
        | "console-invoices"
        | "console-invoice"
        | "console-invoice-mark"
        | "console-invoice-mark-confirm"
        | "console-payment-text"
        | "console-payment-text-remove";
    }
  >,
): Promise<BoundaryOutcome> {
  const useCase: ProductUseCase = "manage_auction";
  const call = {
    identity: person,
    ...rpcCall(ctx, useCase),
    auctionId: tokenToUuid(action.auction),
  };
  // «Повторить» после сбоя на «Да» ведёт к подтверждению, а не к отметке:
  // отметка, ответ на которую потерялся, могла пройти.
  const retry =
    action.kind === "console-invoice-mark-confirm"
      ? consoleInvoiceMarkData(action.auction, action.invoice, action.mark)
      : ctx.callbackQuery?.data;
  const request = (): ExecuteRequest => {
    switch (action.kind) {
      case "console-invoices":
        return { ...call, intent: "view-auction-invoices", page: action.page };
      case "console-invoice":
        return {
          ...call,
          intent: "view-auction-invoice",
          invoiceId: tokenToUuid(action.invoice),
        };
      case "console-invoice-mark":
        return {
          ...call,
          intent: "prepare-invoice-mark",
          invoiceId: tokenToUuid(action.invoice),
          mark: action.mark,
        };
      case "console-invoice-mark-confirm":
        return {
          ...call,
          intent: "mark-invoice",
          invoiceId: tokenToUuid(action.invoice),
          mark: action.mark,
          opId: createUuidV7(),
        };
      // Текст оплаты (PER-322): вопрос спрашивает текст, а снятие идёт без
      // вопроса — ключ рождается на нажатие.
      case "console-payment-text":
        return { ...call, intent: "ask-auction-payment-text" };
      case "console-payment-text-remove":
        return {
          ...call,
          intent: "remove-auction-payment-text",
          opId: createUuidV7(),
        };
      default: {
        const _exhaustive: never = action;
        return _exhaustive;
      }
    }
  };
  const result = await runtime.dispatcher.execute(request());
  return renderInvoicesResult(ctx, runtime, result, {
    person,
    questions,
    retry,
  });
}

// Экраны счетов (PER-321) и вопрос о тексте оплаты (PER-322); остальное —
// исходы пульта: отказы и сбои рисуются, как у его команд.
async function renderInvoicesResult(
  ctx: UpdateContext,
  runtime: BotRuntime,
  result: ExecuteResult,
  context: {
    person: Person;
    questions: Map<string, PendingInput>;
    retry?: string | undefined;
    replyId?: number;
  },
): Promise<BoundaryOutcome> {
  const handled = (message: string): BoundaryOutcome => ({
    level: "info",
    message,
    result: "ok",
    use_case: "manage_auction",
    identity_id: context.person.identityId,
  });
  const clock = {
    timeZone: runtime.communityTimeZone ?? "UTC",
    today: communityToday(ctx),
  };
  switch (result.kind) {
    case "auction-invoices":
      await showScreen(ctx, invoicesScreen({ ...result, ...clock }));
      return handled(
        result.note === undefined
          ? "auction invoices sent"
          : `auction invoices sent: ${result.note}`,
      );
    case "auction-invoice":
      await showScreen(ctx, invoiceScreen({ ...result, ...clock }));
      return handled("auction invoice sent");
    case "invoice-mark-confirm":
      await showScreen(ctx, invoiceMarkConfirmScreen(result));
      return handled(`invoice ${result.mark} confirmation sent`);
    case "invoice-mark-outcome":
      await showScreen(ctx, invoiceMarkOutcomeScreen(result));
      return handled(`invoice ${result.mark}: ${result.note}`);
    case "invoice-missing":
      await showScreen(ctx, invoiceMissingScreen(result.auctionId));
      return handled("invoice not found");
    case "payment-text-ask":
      await askConsolePaymentText(ctx, context.questions, {
        auctionId: result.auctionId,
        error: result.error,
        replaces: context.replyId,
      });
      return handled(
        result.error === undefined
          ? "payment text requested"
          : "payment text asked again",
      );
    default:
      return renderConsoleResult(ctx, runtime, result, context);
  }
}

// Вопрос о тексте «Как оплатить и получить» (PER-322): свободный текст в
// несколько строк; текущий текст — на экране «Счета» над вопросом.
function askConsolePaymentText(
  ctx: UpdateContext,
  questions: Map<string, PendingInput>,
  ask: {
    auctionId: string;
    error?: PaymentTextAskError | undefined;
    replaces?: number | undefined;
  },
): Promise<void> {
  const pending: PendingBody = {
    kind: "console-payment-text",
    auctionId: ask.auctionId,
    telegramUserId: ctx.from?.id ?? 0,
  };
  // Непринятый ответ — свой экран с «Ввести заново» (PER-472).
  if (ask.error !== undefined) {
    return refuseAnswer(
      ctx,
      questions,
      pending,
      paymentTextAskErrorText[ask.error],
      ask.replaces,
    );
  }
  return askQuestion(ctx, questions, pending, paymentTextPrompt, ask.replaces);
}

// «Ставки зала» помощника (PER-565, ADR-070). Сюда доходит только держатель
// права вести аукцион; право на чтение и ставку решает Auction. Своего
// состояния нет: лот, человек и цена едут в кнопке, а ключ ставки рождается
// на нажатие «Да».
async function handleFloorCallback(
  ctx: UpdateContext,
  runtime: BotRuntime,
  questions: Map<string, PendingInput>,
  person: Person,
  action: Extract<
    CallbackAction,
    {
      kind:
        | "console-floor"
        | "console-floor-search"
        | "console-floor-pick"
        | "console-floor-confirm"
        | "console-floor-leader";
    }
  >,
): Promise<BoundaryOutcome> {
  const useCase: ProductUseCase = "manage_auction";
  const call = { identity: person, ...rpcCall(ctx, useCase) };
  // «Повторить» после сбоя на «Да» ведёт к подтверждению, а не к ставке:
  // ставка, ответ на которую потерялся, могла пройти (ADR-070 п. 5).
  const retry =
    action.kind === "console-floor-confirm"
      ? floorPickData(action.lot, action.person, action.minorUnits)
      : ctx.callbackQuery?.data;
  const render = (result: ExecuteResult) =>
    renderFloorResult(ctx, runtime, result, { person, questions, retry });
  switch (action.kind) {
    case "console-floor":
      return render(
        await runtime.dispatcher.execute({
          ...call,
          intent: "view-floor-bids",
          auctionId: tokenToUuid(action.auction),
          page: action.page,
        }),
      );
    case "console-floor-search":
      return render(
        await runtime.dispatcher.execute({
          ...call,
          intent: "ask-floor-search",
          auctionId: tokenToUuid(action.auction),
        }),
      );
    // Лидер — на своём месте с пометкой (решение владельца 20.10.2026):
    // нажатие отвечает подсказкой, экран остаётся, Auction не зовётся.
    case "console-floor-leader":
      await ctx.waiting?.answer(floorLeaderToast);
      ctx.liveFloorShown = true;
      return {
        level: "info",
        message: "floor leader press answered",
        result: "ok",
        use_case: useCase,
        identity_id: person.identityId,
      };
    case "console-floor-pick":
    case "console-floor-confirm": {
      const target = {
        lotId: tokenToUuid(action.lot),
        participantId: tokenToUuid(action.person),
        amount: { minorUnits: action.minorUnits, currency: lotCurrency },
      };
      return render(
        await runtime.dispatcher.execute(
          action.kind === "console-floor-pick"
            ? { ...call, intent: "prepare-floor-bid", target }
            : {
                ...call,
                intent: "place-floor-bid",
                target,
                opId: createUuidV7(),
              },
        ),
      );
    }
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

// Исход «Ставок зала»: экран людей, подтверждение, вопрос об имени либо кадр
// отказа пульта — отказы у экрана те же, что у пульта.
async function renderFloorResult(
  ctx: UpdateContext,
  runtime: BotRuntime,
  result: ExecuteResult,
  context: {
    person: Person;
    questions: Map<string, PendingInput>;
    retry?: string | undefined;
    replyId?: number;
  },
): Promise<BoundaryOutcome> {
  const handled = (message: string): BoundaryOutcome => ({
    level: "info",
    message,
    result: "ok",
    use_case: "manage_auction",
    identity_id: context.person.identityId,
  });
  switch (result.kind) {
    case "floor-bids": {
      const view: FloorScreenView = {
        floor: result.floor,
        page: result.page,
        ...(result.note === undefined ? {} : { note: result.note }),
        ...(result.search === undefined ? {} : { search: result.search }),
        ...(result.stale === true ? { stale: true } : {}),
      };
      const sent = await showScreen(ctx, floorScreen(view));
      // Экран правится дальше по потоку аукциона, как пульт ведущего.
      const chatId = ctx.chat?.id;
      const pressed = ctx.callbackQuery?.message;
      const messageId =
        sent?.message_id ??
        (ctx.fresh === true ? undefined : pressed?.message_id);
      if (
        ctx.liveFloors !== undefined &&
        chatId !== undefined &&
        messageId !== undefined
      ) {
        const kept = ctx.liveFloors.shown(chatId, messageId, {
          person: context.person,
          view,
        });
        if (messageId === pressed?.message_id) ctx.liveFloorShown = kept;
      }
      return handled(
        result.note === undefined
          ? "floor bids sent"
          : `floor bids sent: ${result.note.kind}`,
      );
    }
    case "floor-confirm":
      await showScreen(ctx, floorConfirmScreen(result));
      return handled("floor bid confirmation sent");
    case "floor-search-ask":
      await askQuestion(
        ctx,
        context.questions,
        {
          kind: "floor-search",
          auctionId: result.auctionId,
          telegramUserId: ctx.from?.id ?? 0,
        },
        escapeHtml(floorSearchQuestionText),
        context.replyId,
      );
      return handled("floor search requested");
    default:
      return renderConsoleResult(ctx, runtime, result, context);
  }
}

// Чтение «Ставок зала» вне update (PER-565): тот же юзкейс, что у «Обновить»,
// правами помощника, открывшего экран, с той же страницей людей.
async function readLiveFloor(
  runtime: BotRuntime,
  entry: LiveFloorEntry,
): Promise<LiveScreenRead<FloorScreenView>> {
  const result = await runtime.dispatcher.execute({
    identity: entry.person,
    auctionId: entry.auctionId,
    intent: "view-floor-bids",
    page: entry.view.page,
    requestId: createUuidV7(),
    useCase: "manage_auction",
  });
  switch (result.kind) {
    case "floor-bids":
      return {
        kind: "view",
        view: { floor: result.floor, page: result.page },
      };
    case "auction-console-refused":
      return { kind: "refused" };
    default:
      reportLiveConsoleFailure(runtime.logger, result.kind);
      return { kind: "failed" };
  }
}

// FAQ аукциона — экран оболочки хаба. Кнопка несёт аукцион, чтобы возврат не
// зависел от памяти процесса и повторно проходил общий шлюз аукционного дерева.
async function handleAuctionFaqCallback(
  ctx: UpdateContext,
  runtime: BotRuntime,
  auction: string,
  fromEvents: boolean,
): Promise<BoundaryOutcome> {
  const useCase: ProductUseCase = "view_auction";
  const data = auctionFaqData(auction, fromEvents);
  const identity = await resolvePerson(ctx, runtime, useCase, data);
  if (identity.kind === "failed") return identity.outcome;
  const denied = await denyHubAccessIfNeeded(
    ctx,
    runtime,
    identity,
    useCase,
    true,
  );
  if (denied !== undefined) return denied;

  await showScreen(
    ctx,
    auctionFaqScreen(runtime.faq ?? defaultFaq, auction, fromEvents),
  );
  return {
    level: "info",
    message: "auction FAQ screen sent",
    result: "ok",
    use_case: useCase,
    identity_id: identity.person.identityId,
  };
}

// Кнопка аукциона сходки (PER-307). Политика хаба идёт первой — кадры P-14 и
// P-17, как у любой кнопки, — затем шлюз пакета с поверхностью `hub`. Отказ
// Auction — кадр недоступности с повтором: экран не показывается без чтения.
async function handleAuctionCallback(
  ctx: UpdateContext,
  runtime: BotRuntime,
  data: string,
  lotPhotos: LotPhotos,
  delivery: {
    questions: Map<string, PendingInput>;
    // Ответ на вопрос листа ставки: на какое сообщение ответили и чем.
    answer?: { replyId: number; text?: string };
  },
): Promise<BoundaryOutcome> {
  const useCase: ProductUseCase = "view_auction";
  const identity = await resolvePerson(ctx, runtime, useCase, data);
  // Вход из «Событий» (PER-669): дерево разбирает кнопку без отметки, а
  // готовый экран её получает обратно — повтор после сбоя идёт исходной.
  const { data: treeData, entry } = auctionEntryOf(data);
  if (identity.kind === "failed") return identity.outcome;
  const denied = await denyHubAccessIfNeeded(
    ctx,
    runtime,
    identity,
    useCase,
    true,
  );
  if (denied !== undefined) return denied;
  const person = identity.person;
  if (runtime.auction === undefined) {
    await showRefusal(ctx, unavailableText, exitToMeetups());
    return {
      level: "error",
      message: "auction is not configured",
      result: "error",
      use_case: useCase,
      identity_id: person.identityId,
      error_category: "dependency_unavailable",
      error: "auction_not_configured",
    };
  }
  const resolved = packageIdentity(person, identity.blocked);
  const ports = runtime.auction.screenPorts(rpcCall(ctx, useCase));
  const { answer } = delivery;
  const input: AuctionUpdate["input"] =
    answer === undefined
      ? { kind: "callback", data: treeData }
      : {
          kind: "reply",
          data: treeData,
          ...(answer.text === undefined ? {} : { text: answer.text }),
        };
  let result: AuctionResult;
  try {
    result = await hubTradeCallback({
      ports: {
        // Личность уже разрешена этим update: шлюз её не перечитывает.
        identity: { resolveIdentity: () => Promise.resolve(resolved) },
        auction: ports.auction,
        operations: ports.operations,
        ...(runtime.favorites === undefined
          ? {}
          : { favorites: runtime.favorites(rpcCall(ctx, useCase)) }),
        ...(runtime.proxyExplainer === undefined
          ? {}
          : {
              proxyExplainer: runtime.proxyExplainer(rpcCall(ctx, useCase)),
            }),
      },
      identity: resolved,
      user: {
        telegramUserId: ctx.from?.id ?? 0,
        ...(ctx.from?.username === undefined
          ? {}
          : { telegramUsername: ctx.from.username }),
      },
      input,
    });
  } catch (cause) {
    // Лот, которого Auction не знает или который смотрящему не виден, —
    // NOT_FOUND у `GetLot`, им начинаются карточка, хронология и экран сета.
    // Лента на аукцион, которого нет, отвечает пустой страницей, так что её
    // отказ — всегда сбой.
    const parsed = parseAuctionCallback(treeData);
    const notFound =
      cause instanceof ConnectError &&
      cause.code === Code.NotFound &&
      parsed.ok &&
      (parsed.intent.kind === "lot" ||
        parsed.intent.kind === "set" ||
        parsed.intent.kind === "history" ||
        parsed.intent.kind === "follow" ||
        parsed.intent.kind === "unfollow");
    // Сбой на ответе вопроса оставляет вопрос открытым: повтор — тот же
    // ответ ещё раз, а «Повторить» с шагом вопроса сработало бы как «Отмена».
    await showRefusal(
      ctx,
      notFound ? "Лот не найден или больше недоступен." : unavailableText,
      notFound || answer !== undefined ? exitToMeetups() : exitRetry(data),
    );
    return {
      level: notFound ? "warn" : "error",
      message: "auction screen rejected",
      result: "error",
      use_case: useCase,
      identity_id: person.identityId,
      error_category: notFound
        ? "visibility"
        : cause instanceof ConnectError
          ? grpcFailureCategory(Code[cause.code])
          : "unexpected",
      ...(cause instanceof ConnectError ? { grpc_code: Code[cause.code] } : {}),
      error: errorText(cause),
    };
  }
  switch (result.kind) {
    case "denied": {
      // Политика хаба уже пропустила человека, поэтому отказ шлюза — расхождение
      // кругов, а не штатный путь; кадр тот же, что у политики хаба.
      const access = result.reason === "blocked" ? "blocked" : "pending";
      const frame = noAccessFrame(runtime, access);
      await showFrame(
        ctx,
        frame.id,
        hubAccessText(access, person.identityId, ctx.from?.username),
        frame.keyboard,
      );
      return hubAccessOutcome(access, person.identityId, useCase);
    }
    case "unreadable":
      await showRefusal(
        ctx,
        "Не получилось прочитать эту кнопку. Открой раздел заново.",
        exitToMeetups(),
      );
      return {
        level: "warn",
        message: "malformed auction callback data",
        result: "error",
        use_case: useCase,
        identity_id: person.identityId,
        error_category: "invariant",
        error: result.error.reason,
      };
    case "screen":
      break;
    default: {
      const _exhaustive: never = result;
      return unexpectedOutcome(String(_exhaustive), undefined, useCase);
    }
  }
  const canManage = canRunAuctions(person);
  // Статус нужен только ряду «Добавить лот»; читается он у пульта, который
  // Auction отдаёт держателю права вести аукцион.
  const feedAuctionId = canManage ? feedAuctionOf(result.body) : undefined;
  const canAddLots =
    feedAuctionId === undefined
      ? undefined
      : await auctionAcceptsLots(ctx, runtime, person, feedAuctionId);
  const winnerUsername = await soldWinnerUsername(
    runtime,
    viewerOf(person),
    result.body,
  );
  const view: AuctionView = {
    body: result.body,
    rootParent: rootParentOf(ctx, result.body, entry),
    entry,
    presentation: runtime.presentation ?? "rich",
    timeZone: runtime.communityTimeZone ?? "UTC",
    today: communityToday(ctx),
    // Пульт и входы в форму лота видит держатель права вести аукцион — того
    // же, что «Включить аукцион» (ADR-070, RFC-016).
    canManage,
    ...(canAddLots === undefined ? {} : { canAddLots }),
    ...(winnerUsername === undefined ? {} : { winnerUsername }),
  };
  const shown = auctionScreen(view);
  if (shown.asks === true) {
    // Вопрос — новым сообщением с режимом ответа; отвергнутый ответ задаёт
    // его заново, а прежний вопрос закрывается после нового.
    await askAuctionQuestion(
      ctx,
      delivery.questions,
      shown.screen,
      answer?.replyId,
    );
    return {
      level: "info",
      message: "auction question asked",
      result: "ok",
      use_case: useCase,
      identity_id: person.identityId,
    };
  }
  // Ответ принят: результат приходит одним новым сообщением, а «Отмена»
  // вопроса снимается.
  if (answer !== undefined) ctx.fresh = true;
  const delivered = await deliverAuctionScreen(ctx, {
    view,
    lotPhotos,
    image: ports.image,
    viewer: viewerOf(person),
    logger: runtime.logger,
  });
  const photoNote = delivered.note;
  // Карточка финала (PER-336): сообщение, в котором она оказалась, правится
  // дальше по потоку аукциона.
  const chatId = ctx.chat?.id;
  if (ctx.liveCards !== undefined && chatId !== undefined) {
    const live = liveCardOf(result.body, viewerOf(person));
    if (delivered.messageId !== undefined) {
      const kept = ctx.liveCards.shown(chatId, delivered.messageId, live);
      if (delivered.messageId === ctx.callbackQuery?.message?.message_id) {
        ctx.liveShown = kept;
      }
    }
  }
  if (answer !== undefined) {
    delivery.questions.delete(questionKey(ctx.chat?.id, answer.replyId));
    await closeQuestion(ctx, answer.replyId);
  }
  return {
    level: "info",
    message:
      photoNote === undefined
        ? "auction screen sent"
        : `auction screen sent; ${photoNote}`,
    result: "ok",
    use_case: useCase,
    identity_id: person.identityId,
  };
}

// Родитель корня аукциона: «События», если аукцион открыт из них (PER-669),
// иначе меню «Расширения» его сходки, если бот её видел, иначе «Сходки»
// (ADR-030, дополнение 2026-10-04; PER-605). Остальные экраны
// аукциона возвращают в корень сами: ему хватает идентификатора аукциона.
function rootParentOf(
  ctx: UpdateContext,
  body: AuctionScreenBody,
  entry: AuctionEntry,
): Parent {
  for (const block of body.blocks) {
    if (block.kind !== "root") continue;
    // Открыт из «Событий» — туда и возвращает (PER-669).
    if (entry === "events") return toEvents;
    const meetupId = ctx.auctionParents?.meetupOf(block.auctionId);
    return meetupId === undefined
      ? toMeetups
      : toExtensions(uuidToToken(meetupId));
  }
  return toMeetups;
}

// Доставка экрана аукциона (дизайн-код, «Показ фото лота»). Лента и карточка
// делят одно сообщение: rich-карточка правится на месте в обе стороны. Фото —
// из кэша `file_id` либо загрузкой байтов из Auction; загрузка — тот же вызов
// Bot API, что доставляет карточку, и обрывать его по времени нельзя.
// Изображение не получилось — карточка уходит без фото, а не пропадает.
// Возвращает пометку о деградации для записи границы и сообщение, в котором
// экран оказался.
async function deliverAuctionScreen(
  ctx: UpdateContext,
  input: {
    view: AuctionView;
    lotPhotos: LotPhotos;
    image: LotImagePort;
    viewer: Viewer;
    logger: Logger;
  },
): Promise<{ note?: string; messageId?: number }> {
  // Правка того же содержимого ответа не даёт: экран остался в нажатом
  // сообщении.
  const at = (sent: { message_id: number } | undefined) => {
    const messageId =
      sent?.message_id ?? ctx.callbackQuery?.message?.message_id;
    return messageId === undefined ? {} : { messageId };
  };
  const shownIn = async (
    note: string | undefined,
    screen: ShownScreen,
  ): Promise<{ note?: string; messageId?: number }> => ({
    ...(note === undefined ? {} : { note }),
    ...at(await showScreen(ctx, screen)),
  });
  const { lotPhotos } = input;
  const warn = (message: string, cause: unknown) =>
    input.logger.warn(message, {
      ...(ctx.requestId === undefined ? {} : { request_id: ctx.requestId }),
      error: errorText(cause),
    });
  const shown = auctionScreen(input.view);
  const key = shown.image;
  if (key === undefined) {
    return shownIn(undefined, shown.screen);
  }
  const withPhoto = (photo: ScreenPhoto) =>
    auctionScreen({ ...input.view, photo }).screen;
  const cached = lotPhotos.get(key);
  if (cached?.kind === "rejected") {
    return shownIn("lot image skipped: rejected earlier", shown.screen);
  }
  if (cached?.kind === "file") {
    const photo = withPhoto({ id: lotPhotoId, fileId: cached.fileId });
    try {
      return at(await showScreen(ctx, { ...photo, strict: true }));
    } catch (cause) {
      if (!rejectedFile(cause)) {
        // Отказ не про файл — сообщение не правится или Telegram моргнул:
        // запись остаётся, а экран идёт обычным путём края с тем же фото.
        return shownIn(undefined, photo);
      }
      // Telegram больше не принимает этот `file_id`: запись вытесняется, и
      // показ один раз повторяется загрузкой байтов.
      lotPhotos.delete(key);
      warn("cached lot photo rejected", cause);
    }
  }
  let bytes: Awaited<ReturnType<LotImagePort["getLotImage"]>>;
  try {
    bytes = await input.image.getLotImage({
      viewer: input.viewer,
      lotId: key.lotId,
    });
  } catch (cause) {
    // Бюджет действия исчерпан на изображении или Auction его не отдал:
    // карточка уходит без фото (дизайн-код, «Показ фото лота»).
    warn("lot image unavailable", cause);
    return shownIn("lot image unavailable", shown.screen);
  }
  // Ключ — версия самих байтов: изображение могли сменить между чтением
  // карточки и загрузкой, и старое фото не ляжет под новым ключом.
  const uploaded = { lotId: key.lotId, version: bytes.version };
  const upload = withPhoto({
    id: lotPhotoId,
    upload: new InputFile(bytes.content, "lot"),
  });
  const remember = (sent: { message_id: number } | undefined) => {
    const fileId = photoFileId(sent);
    if (fileId !== undefined) {
      lotPhotos.set(uploaded, { kind: "file", fileId });
    }
    return at(sent);
  };
  try {
    return remember(await showScreen(ctx, { ...upload, strict: true }));
  } catch (cause) {
    if (cause instanceof GrammyError && notEditable(cause.description)) {
      // Сообщение не правится — карточка уходит новым сообщением с той же
      // загрузкой: изображение тут ни при чём.
      return remember(await showScreen(ctx, { ...upload, delivery: "new" }));
    }
    // Telegram отверг сам запрос (400) — эта версия до рестарта больше не
    // грузится. Обрыв соединения, лимит и сбой Telegram отметки не
    // оставляют: следующее открытие лота грузит изображение снова. В обоих
    // случаях сообщение правится в карточку без фото обычной правкой.
    if (cause instanceof GrammyError && cause.error_code === 400) {
      lotPhotos.set(uploaded, { kind: "rejected" });
    }
    warn("lot image rejected by Telegram", cause);
    return shownIn("lot image rejected", shown.screen);
  }
}

// Чтение пульта ведущего вне update (PER-566): тот же юзкейс, что у
// «Обновить», правами ведущего, открывшего пульт. Страница и сортировка — те,
// что он видит.
async function readLiveConsole(
  runtime: BotRuntime,
  entry: LiveConsoleEntry,
): Promise<LiveConsoleRead> {
  const result = await runtime.dispatcher.execute({
    identity: entry.person,
    auctionId: entry.auctionId,
    intent: "view-auction-console",
    requestId: createUuidV7(),
    useCase: "manage_auction",
  });
  switch (result.kind) {
    case "auction-console":
      return {
        kind: "console",
        view: {
          console: result.console,
          page: entry.view.page,
          sort: entry.view.sort,
          timeZone: runtime.communityTimeZone ?? "UTC",
          today: (runtime.today ?? utcToday)(),
        },
      };
    case "auction-console-refused":
      return { kind: "refused" };
    default:
      reportLiveConsoleFailure(runtime.logger, result.kind);
      return { kind: "failed" };
  }
}

// Правка пульта ведущего вне update (PER-566): отказы Telegram разбираются
// так же, как у карточки финала.
async function editLiveConsole(
  api: Bot<UpdateContext>["api"],
  runtime: BotRuntime,
  entry: { chatId: number; messageId: number },
  screen: ShownScreen,
): Promise<LiveEditOutcome> {
  try {
    await api.editMessageText(entry.chatId, entry.messageId, screen.text, {
      ...screenMark(screen.id),
      reply_markup: screen.keyboard,
      ...(screen.format === "HTML" ? { parse_mode: "HTML" as const } : {}),
    });
    return { kind: "done" };
  } catch (cause) {
    return liveEditFailure(cause, (error) =>
      reportLiveEditFailure(runtime.logger, error),
    );
  }
}

// Правка карточки финала вне update (PER-336): та же оболочка, что у показа
// по нажатию. Фото — только из кэша `file_id`: загрузка байтов на каждой цене
// залпа съела бы и время, и лимит; без записи в кэше карточка правится без
// фото. Ряд «Изменить лот» — по правам смотрящего, с которыми карточку
// открыли.
async function editLiveLotCard(
  api: Bot<UpdateContext>["api"],
  input: {
    card: LiveCardEntry;
    body: AuctionScreenBody;
    runtime: BotRuntime;
    lotPhotos: LotPhotos;
  },
): Promise<LiveEditOutcome> {
  const { card, runtime } = input;
  const winnerUsername = await soldWinnerUsername(
    runtime,
    card.viewer,
    input.body,
  );
  const view: AuctionView = {
    body: input.body,
    rootParent: toMeetups,
    presentation: runtime.presentation ?? "rich",
    timeZone: runtime.communityTimeZone ?? "UTC",
    today: (runtime.today ?? utcToday)(),
    canManage: canRunAuctions(card.viewer),
    ...(winnerUsername === undefined ? {} : { winnerUsername }),
  };
  const shown = auctionScreen(view);
  const key = shown.image;
  const cached = key === undefined ? undefined : input.lotPhotos.get(key);
  const withPhoto =
    cached?.kind === "file"
      ? auctionScreen({
          ...view,
          photo: { id: lotPhotoId, fileId: cached.fileId },
        }).screen
      : undefined;
  const edit = (screen: ShownScreen) => {
    const other = {
      ...screenMark(screen.id),
      reply_markup: screen.keyboard,
      ...(screen.format === "HTML" ? { parse_mode: "HTML" as const } : {}),
    };
    return screen.format === "rich"
      ? api.editMessageText(
          card.chatId,
          card.messageId,
          {
            html: screen.text,
            ...(screen.media === undefined || screen.media.length === 0
              ? {}
              : {
                  media: screen.media.map((photo) => ({
                    id: photo.id,
                    media: {
                      type: "photo" as const,
                      media: "fileId" in photo ? photo.fileId : photo.upload,
                    },
                  })),
                }),
          },
          other,
        )
      : api.editMessageText(card.chatId, card.messageId, screen.text, other);
  };
  try {
    try {
      await edit(withPhoto ?? shown.screen);
    } catch (cause) {
      // Telegram больше не знает `file_id` из кэша: запись вытесняется, и
      // правка идёт без фото — иначе каждая следующая цена падала бы на нём же.
      if (
        withPhoto === undefined ||
        key === undefined ||
        !rejectedFile(cause)
      ) {
        throw cause;
      }
      input.lotPhotos.delete(key);
      await edit(shown.screen);
    }
    return { kind: "done" };
  } catch (cause) {
    return liveEditFailure(cause, (error) =>
      reportLiveEditFailure(runtime.logger, error),
    );
  }
}

// Описания отказов Bot API не закреплены контрактом: сравнение без учёта
// регистра и по известным написаниям — как у бота аукциона.
const REJECTED_FILE =
  /wrong (remote )?file identifier|file[_ ]reference|wrong file_id/i;

function rejectedFile(cause: unknown): boolean {
  return cause instanceof GrammyError && REJECTED_FILE.test(cause.description);
}

function notEditable(description: string): boolean {
  return (
    description.includes("message can't be edited") ||
    description.includes("message to edit not found")
  );
}

async function renderMeetupCard(
  ctx: UpdateContext,
  result: Awaited<ReturnType<Dispatcher["execute"]>>,
  edit: boolean,
  presentation: "rich" | "plain",
  manageable = false,
  note?: string,
): Promise<void> {
  if (result.kind === "meetup-not-found") {
    await showRefusal(
      ctx,
      "Сходка не найдена или больше недоступна.",
      withNav(new InlineKeyboard(), toMeetups),
      edit ? undefined : "new",
    );
    return;
  }
  if (result.kind === "meetup-card") {
    // Исход действия — свой экран (PER-472): карточку открывает «‹ Сходка».
    if (note !== undefined) {
      await showScreen(ctx, {
        id: "outcome",
        text: outcomeText(note, result.meetup.title),
        keyboard: exitToCard(uuidToToken(result.meetup.id)),
        format: "HTML",
        delivery: edit ? "auto" : "new",
      });
      return;
    }
    const view = {
      meetup: result.meetup,
      author: result.author,
      subscribed: result.subscribed,
      manageable,
      presentation,
      today: communityToday(ctx),
      ...(result.auction?.kind === "open" &&
      result.auction.auction !== undefined
        ? { auction: result.auction.auction }
        : {}),
      timeZone: ctx.communityTimeZone ?? "UTC",
    };
    const card = cardScreen(view);
    const delivery = edit ? "auto" : "new";
    try {
      await showScreen(ctx, { ...card, delivery });
    } catch (cause) {
      // Telegram отверг карточку с постерами — файл мог стать недоступным.
      // Сама карточка от постера не зависит и приходит без них. Повтор идёт
      // только на отказ запроса (400): сеть, лимит и остальное — не про фото,
      // и второе сообщение там дало бы дубль.
      const deliveryCause =
        cause instanceof ScreenDeliveryError ? cause.cause : cause;
      const telegramCause =
        deliveryCause instanceof AggregateError
          ? deliveryCause.cause
          : deliveryCause;
      if (
        card.media === undefined ||
        !(telegramCause instanceof GrammyError) ||
        telegramCause.error_code !== 400
      ) {
        throw cause;
      }
      ctx.postersRejected = telegramCause.description;
      await showScreen(ctx, {
        ...cardScreen({ ...view, posters: false }),
        delivery: "new",
      });
    }
    return;
  }
  await showRefusal(
    ctx,
    unavailableText,
    exitRetry("v1:nav:hub"),
    edit ? undefined : "new",
  );
}

// Оба кадра настроек живут в одном рендере: у них одна механика — список
// отметок, переключение на месте, ответ на нажатие уходит вместе с правкой — и
// различаются только словарём категорий, заголовком и кнопкой возврата.
async function renderNotificationSettings(
  ctx: UpdateContext,
  result: Awaited<ReturnType<Dispatcher["execute"]>>,
  retry: string,
  forbidden: string = forbiddenText,
): Promise<void> {
  if (result.kind === "global-notification-settings") {
    await showScreen(ctx, globalNotificationsScreen(result.categories));
    return;
  }
  if (result.kind === "meetup-notification-settings") {
    await showScreen(ctx, meetupNotificationsScreen(result));
    return;
  }
  await renderNotificationFailure(ctx, result, retry, forbidden);
}

function categoryForbiddenText(category: NotificationCategory): string {
  return accessRequestCategories.includes(category)
    ? accessRequestsForbiddenText
    : forbiddenText;
}

// Настройка у сходки сильнее общей, а снять её одной кнопкой контракт не даёт:
// напоминание, включённое у сходки отдельно, после общего выключения придёт.
function globalCategoryDisabledNote(category: NotificationCategory): string {
  if (category === "reminder") {
    return "Больше не присылаю напоминания, кроме сходок, где они включены отдельно: их выключают в уведомлениях сходки. Включить снова можно в настройках уведомлений.";
  }
  return `Больше не присылаю: ${categoryLabels[category].toLowerCase()}. Включить снова можно в настройках уведомлений.`;
}

// Изменения и снятие с публикации идут по одной категории, поэтому
// подтверждение говорит и о снятии: иначе его отсутствие стало бы сюрпризом.
const meetupCategoryDisabledNotes: Record<NotifiedMeetupCategory, string> = {
  changes:
    "Больше не присылаю по этой сходке изменения данных и статуса, включая снятие с публикации. Включить снова можно в уведомлениях сходки.",
  material:
    "Больше не присылаю по этой сходке новые материалы. Включить снова можно в уведомлениях сходки.",
  organizer:
    "Больше не присылаю по этой сходке сообщения организатора. Включить снова можно в уведомлениях сходки.",
};

function meetupCategoryDisabledNote(category: NotifiedMeetupCategory): string {
  return meetupCategoryDisabledNotes[category];
}

type CategoryDisabledConfirmation = {
  note: string;
  settings: { text: string; data: string };
};

async function confirmCategoryDisabled(
  ctx: UpdateContext,
  { note, settings }: CategoryDisabledConfirmation,
): Promise<void> {
  const message = ctx.callbackQuery?.message;
  const pressed = ctx.callbackQuery?.data;
  const current = message?.reply_markup?.inline_keyboard ?? [];
  // Подтверждение уже стоит, если нажатой кнопки под сообщением нет: она
  // снимается той же правкой, что дописывает заметку. Признак берётся из
  // клавиатуры, а не из текста: текст рассылки пишет автор, и совпадение с
  // заметкой в нём не должно глушить подтверждение.
  const confirmed = !current.some((row) =>
    row.some(
      (button) => "callback_data" in button && button.callback_data === pressed,
    ),
  );
  // Кнопки уведомления, кроме нажатой, остаются: «Открыть сходку» по-прежнему
  // нужна, а отключать уже нечего.
  const rows = current
    .map((row) =>
      row.filter(
        (button) =>
          !("callback_data" in button) || button.callback_data !== pressed,
      ),
    )
    .filter((row) => row.length > 0);
  const keyboard = InlineKeyboard.from(rows)
    .row()
    .text(settings.text, settings.data);
  const original =
    message !== undefined && "text" in message ? message.text : undefined;
  if (original === undefined) {
    await editScreen(ctx, "notification", note, keyboard);
    return;
  }
  const tail = `\n\n${note}`;
  if (confirmed) {
    await editScreen(ctx, "notification", original, keyboard);
  } else if (original.length + tail.length <= telegramTextLimit) {
    await editScreen(ctx, "notification", `${original}${tail}`, keyboard);
  } else {
    // Рассылка у предела длины: заметка под ней не поместится, и правка
    // текста получила бы 400. Текст остаётся, меняются кнопки, а заметка
    // приходит отдельным сообщением.
    await editScreen(ctx, "notification", original, keyboard);
    await ctx.reply(note);
  }
}

// Отказ Notifications отвечает кадром по природе отказа, а не одним «сбой на
// моей стороне»: бриф компонента обещает разные кадры, и «Повторить» на отказе
// по праву или на устаревшем экране не лечит ничего.
async function renderNotificationFailure(
  ctx: UpdateContext,
  result: Awaited<ReturnType<Dispatcher["execute"]>>,
  retry: string,
  forbidden: string = forbiddenText,
): Promise<void> {
  if (result.kind === "dependency-rejected" && result.reason === "forbidden") {
    await showRefusal(ctx, forbidden, exitToMeetups());
    return;
  }
  if (result.kind === "dependency-rejected" && result.reason === "invalid") {
    // Кнопка, которую сервис не принял, построена по устаревшему экрану:
    // перерисовка по текущему состоянию, а не повтор того же нажатия.
    await showRefusal(
      ctx,
      "Этот экран устарел. Открой настройки заново.",
      exitRetry(retry),
    );
    return;
  }
  if (result.kind === "dependency-rejected" && result.reason === "conflict") {
    await showRefusal(
      ctx,
      "Это уже сделано. Ничего не изменилось.",
      exitRetry(retry),
    );
    return;
  }
  await showRefusal(ctx, unavailableText, exitRetry(retry));
}

async function renderStateResult(
  ctx: UpdateContext,
  result: Awaited<ReturnType<Dispatcher["execute"]>>,
  presentation: "rich" | "plain",
): Promise<void> {
  // Отмена — исход своим экраном «Сходка отменена» с возвратом к карточке:
  // перерисованная карточка не говорила, что отмена прошла (прогон 14.10,
  // №103). Остальные смены состояния видны на самой карточке.
  if (result.kind === "meetup-state-changed" && result.action === "cancel") {
    await renderMeetupCard(
      ctx,
      cardFrom(result),
      true,
      presentation,
      true,
      "Сходка отменена.",
    );
    return;
  }
  if (result.kind === "published" || result.kind === "meetup-state-changed") {
    await renderMeetupCard(ctx, cardFrom(result), true, presentation, true);
    return;
  }
  if (result.kind === "meetup-state-unchanged") {
    const token = uuidToToken(result.meetup.id);
    const text =
      result.reason === "already-cancelled"
        ? "Сходка уже отменена. Повторно ничего не изменилось."
        : result.reason === "not-scheduled"
          ? "Отложенной публикации у сходки уже нет."
          : "Сходка уже скрыта из общего списка.";
    await showRefusal(ctx, text, exitToCard(token));
    return;
  }
  if (result.kind === "meetup-not-found") {
    await renderMeetupCard(ctx, result, true, presentation, true);
    return;
  }
  if (result.kind === "conflict" && result.action !== undefined) {
    // Исход — свой экран (PER-472): сходку перечитывает «‹ Сходка», и
    // действие человек повторяет по свежим данным.
    await showScreen(ctx, {
      id: "outcome",
      text: outcomeText(conflictText, meetupTitleLabel(result.meetup.title)),
      keyboard: exitToCard(uuidToToken(result.meetup.id)),
      format: "HTML",
    });
    return;
  }
  const text =
    result.kind === "dependency-rejected" && result.reason === "invalid"
      ? invalidMeetupText(result)
      : result.kind === "dependency-rejected" && result.reason === "forbidden"
        ? forbiddenText
        : unavailableText;
  await showRefusal(ctx, text, exitToMeetups());
}

async function denyHubAccessIfNeeded(
  ctx: UpdateContext,
  runtime: BotRuntime,
  identity: { person: Person; blocked: boolean },
  useCase: ProductUseCase | undefined,
  edit: boolean,
  // Код канала из ссылки `/start`: едет в кнопке «Подать заявку».
  sourceCode?: string,
): Promise<BoundaryOutcome | undefined> {
  const access = decideHubAccess(identity.person.rights, identity.blocked);
  if (access === "admitted") {
    return undefined;
  }
  return denyHubAccess(
    ctx,
    runtime,
    access,
    identity.person,
    useCase,
    edit,
    sourceCode,
  );
}

// Кадр ожидания допуска с адресом бота поддержки несёт одну кнопку-ссылку
// (PER-625, ADR-068): «?start=hub» говорит боту поддержки, откуда человек.
// Без адреса, а также у отказа и блокировки клавиатуры нет.
function noAccessFrame(
  runtime: BotRuntime,
  access: Exclude<HubAccess, "admitted" | "unapplied">,
): {
  id: "no-access" | "no-access-support";
  keyboard: InlineKeyboard;
} {
  if (access !== "pending" || runtime.supportBotUsername === undefined) {
    return { id: "no-access", keyboard: new InlineKeyboard() };
  }
  return {
    id: "no-access-support",
    keyboard: new InlineKeyboard().url(
      supportLabel,
      supportBotLink(runtime.supportBotUsername, "hub"),
    ),
  };
}

// Кадр отказа хаба без выхода: гостю намёк на бот аукциона не нужен, он там
// уже есть (RFC-015, С-4). Человеку без права, о заявке которого разрешение
// личности не знает, — приветствие с кнопкой «Подать заявку» (PER-592).
async function denyHubAccess(
  ctx: UpdateContext,
  runtime: BotRuntime,
  access: Exclude<HubAccess, "admitted">,
  person: Person,
  useCase: ProductUseCase | undefined,
  edit: boolean,
  sourceCode?: string,
): Promise<BoundaryOutcome> {
  if (access === "unapplied") {
    await showScreen(ctx, {
      id: "welcome",
      text: screenText(
        hubWelcome.title,
        ...hubWelcome.paragraphs.map(escapeHtml),
      ),
      keyboard: new InlineKeyboard().text(
        applyLabel,
        withSourceCode(applyData, sourceCode),
      ),
      format: "HTML",
      ...(edit ? {} : { delivery: "new" as const }),
    });
    return hubAccessOutcome(access, person.identityId, useCase);
  }
  const text = hubAccessText(access, person.identityId, ctx.from?.username);
  const frame = noAccessFrame(runtime, access);
  await showFrame(
    ctx,
    frame.id,
    text,
    frame.keyboard,
    edit ? undefined : "new",
  );
  return hubAccessOutcome(access, person.identityId, useCase);
}

function hubAccessOutcome(
  access: Exclude<HubAccess, "admitted">,
  identityId: string,
  useCase: ProductUseCase | undefined,
): BoundaryOutcome {
  return {
    level: "warn",
    message: "hub access denied",
    result: "error",
    ...(useCase === undefined ? {} : { use_case: useCase }),
    identity_id: identityId,
    error_category: "authorization",
    error: hubAccessErrors[access],
  };
}

async function resolvePerson(
  ctx: UpdateContext,
  runtime: BotRuntime,
  useCase?: ProductUseCase,
  retryCallback?: string,
): Promise<
  | { kind: "resolved"; person: Person; blocked: boolean }
  | { kind: "failed"; outcome: BoundaryOutcome }
> {
  const from = ctx.from;
  if (from === undefined) {
    return {
      kind: "failed",
      outcome: unexpectedOutcome("sender is missing", undefined, useCase),
    };
  }
  const resolved = await runtime.identity.resolve(
    toResolveIdentityInput(BigInt(from.id), from.username),
    rpcCall(ctx, useCase),
  );
  if (resolved.kind !== "resolved") {
    await showRefusal(
      ctx,
      unavailableText,
      retryCallback === undefined ? exitToMeetups() : exitRetry(retryCallback),
    );
    return {
      kind: "failed",
      outcome: identityFailureOutcome(resolved, useCase),
    };
  }
  const person = {
    identityId: resolved.identityId,
    rights: resolved.rights,
  };
  ctx.commandsPerson = person;
  return { kind: "resolved", person, blocked: resolved.blocked };
}

/// Прошедшая дата цифрами `ДДММГГГГЧЧММ` для данных кнопки подтверждения;
/// обратно её собирает разбор кнопки.
function pastScheduleDigits(value: MeetupSchedule): string {
  const pad = (part: number, width = 2) => String(part).padStart(width, "0");
  return `${pad(value.day)}${pad(value.month)}${pad(value.year, 4)}${pad(value.hours)}${pad(value.minutes)}`;
}

async function renderFormResult(
  ctx: UpdateContext,
  result: Awaited<ReturnType<Dispatcher["execute"]>>,
  questions: Map<string, PendingInput>,
  presentation: "rich" | "plain",
  // Экран, с которого назначают публикацию: нужен только вопросу о её моменте.
  origin: PublishOrigin = "status",
  // Вопрос о названии новой сходки: повтор вопроса сохраняет, откуда он задан.
  fresh?: NewMeetupOrigin,
): Promise<void> {
  // Дату по нажатию выбирают кнопками на экране без режима ответа. Вопрос
  // текстом остаётся ответу на вопрос: человек уже пишет, и ему нужен формат.
  const pressed = ctx.callbackQuery !== undefined;
  if (result.kind === "ask" || result.kind === "edit-ask") {
    const currentValue =
      result.field === "schedule"
        ? formatSchedule(result.meetup)
        : result.meetup[result.field] === ""
          ? "не задано"
          : result.meetup[result.field];
    if (result.field === "schedule" && pressed) {
      await showScreen(
        ctx,
        datePresetsScreen({
          picker: {
            token: uuidToToken(result.meetup.id),
            mode: result.kind === "edit-ask" ? "e" : "c",
          },
          today: communityToday(ctx),
          lead: [
            ...(result.kind === "edit-ask" ? [`Сейчас: ${currentValue}`] : []),
            ...(result.error === undefined ? [] : [result.error]),
          ].join("\n"),
        }),
      );
      return;
    }
    const pending: PendingBody = {
      kind: "meetup",
      mode: result.kind === "edit-ask" ? "edit" : "create",
      field: result.field,
      meetupId: result.meetup.id,
      ...(fresh === undefined ||
      result.kind !== "ask" ||
      result.field !== "title"
        ? {}
        : { fresh }),
      telegramUserId: ctx.from?.id ?? 0,
    };
    // Непринятый ответ — свой экран (PER-472): формат поля покажет вопрос за
    // «Ввести заново».
    if (result.error !== undefined) {
      await refuseAnswer(ctx, questions, pending, result.error);
      return;
    }
    const ask = formPrompts[result.field];
    await askQuestion(
      ctx,
      questions,
      pending,
      result.kind === "edit-ask" ? `Сейчас: ${currentValue}\n${ask}` : ask,
    );
    return;
  }
  if (result.kind === "conflict") {
    const stored = result.meetup;
    const lines = [
      conflictText,
      "",
      `Сейчас: ${stored.title}`,
      formatSchedule(stored),
      stored.venue,
      stored.description,
      ...(result.input === undefined
        ? []
        : ["", `Твоё значение: ${result.input}`]),
    ];
    // Публикация подтверждается повторно по обновлённым данным: кнопка снова
    // несёт снимок, который человек только что видел.
    if (result.field === undefined) {
      await showScreen(ctx, {
        id: "publish-confirm",
        text: `${refusalText(lines.join("\n"))}\n\nПроверь данные и подтверди публикацию ещё раз.`,
        keyboard: confirmKeyboard({
          yes: "Да, опубликовать",
          yesData: `v1:manage:publish:${uuidToToken(stored.id)}`,
          noData: `v1:view:${uuidToToken(stored.id)}`,
        }),
        format: "HTML",
        delivery: "new",
      });
      return;
    }
    if (result.field === "schedule" && pressed) {
      await showScreen(
        ctx,
        datePresetsScreen({
          picker: {
            token: uuidToToken(stored.id),
            mode: result.editing === true ? "e" : "c",
          },
          today: communityToday(ctx),
          lead: lines.join("\n"),
        }),
      );
      return;
    }
    // Правка поля: сохранённый ввод показан, но повторно не отправляется — его
    // вводят заново, уже по актуальным данным, за «Ввести заново» (PER-472).
    // Режим вопроса сохраняет ту же форму, в которой конфликт случился.
    await refuseAnswer(
      ctx,
      questions,
      {
        kind: "meetup",
        mode: result.editing === true ? "edit" : "create",
        field: result.field,
        meetupId: stored.id,
        telegramUserId: ctx.from?.id ?? 0,
      },
      lines.join("\n"),
    );
    return;
  }
  if (result.kind === "confirm-past-schedule") {
    // Кадр подтверждения, а не отказ: сходку с прошедшей датой завести можно,
    // но она сразу окажется в архиве, и чаще такая дата — опечатка (PER-342).
    const token = uuidToToken(result.meetup.id);
    const mode = result.editing === true ? "e" : "c";
    const value = formatLocalMoment(result.schedule);
    await showScreen(ctx, {
      id: "past-date-confirm",
      text: `${heading("Сохранить прошедшую дату?")}\n\nДата ${value} уже прошла. Сходка с этой датой сразу уйдёт в архив и не появится в «Сходках».`,
      // «Нет» задаёт вопрос о дате заново: человек чаще ошибся в дате, чем
      // передумал её менять.
      keyboard: confirmKeyboard({
        yes: "Да, сохранить дату",
        yesData: `v1:manage:past:${token}:${mode}:${pastScheduleDigits(result.schedule)}`,
        noData: `v1:manage:past-retry:${token}:${mode}`,
      }),
      format: "HTML",
    });
    return;
  }
  if (result.kind === "meetup-updated") {
    // После ответа текстом нажатого сообщения нет, и карточка приходит новой;
    // после выбора кнопкой она правит экран выбора на месте.
    await renderMeetupCard(
      ctx,
      cardFrom(result),
      true,
      presentation,
      true,
      [
        "Изменение сохранено.",
        changedField(result, communityToday(ctx)),
        result.archived === true
          ? "Дата сходки уже прошла, поэтому она в архиве, а не в «Сходках»."
          : undefined,
      ]
        .filter((part) => part !== undefined)
        .join(" "),
    );
    return;
  }
  // Старая кнопка «Создать сходку» несёт id уже созданной сходки: её ответ
  // ничего не переименовывает, а показывает, что сходка уже есть.
  if (result.kind === "meetup-exists") {
    await showScreen(ctx, {
      id: "outcome",
      text: outcomeText(
        "Эта сходка уже создана. Новую создаёт свежая кнопка «Создать сходку».",
        meetupTitleLabel(result.meetup.title),
      ),
      keyboard: exitToCard(uuidToToken(result.meetup.id)),
      format: "HTML",
    });
    return;
  }
  if (result.kind === "edit-unavailable") {
    await showRefusal(
      ctx,
      "Сходка уже отменена. Изменять её больше нельзя.",
      exitToCard(uuidToToken(result.meetup.id)),
    );
    return;
  }
  if (result.kind === "draft" && result.meetup.visibility === "visible") {
    // Ответ на вопрос формы пришёл после публикации: черновика уже нет.
    await renderMeetupCard(
      ctx,
      cardFrom(result),
      true,
      presentation,
      true,
      "Изменение сохранено.",
    );
    return;
  }
  if (result.kind === "draft") {
    await showScreen(
      ctx,
      draftScreen({
        meetup: result.meetup,
        presentation,
        today: communityToday(ctx),
      }),
    );
    return;
  }
  if (result.kind === "ask-publish-moment") {
    const current =
      result.meetup.publishAt === undefined
        ? ""
        : `Сейчас назначено: ${formatLocalMoment(result.meetup.publishAt)}\n`;
    if (pressed) {
      await showScreen(
        ctx,
        datePresetsScreen({
          picker: {
            token: uuidToToken(result.meetup.id),
            mode: origin === "draft" ? "d" : "p",
          },
          today: communityToday(ctx),
          lead: `${current}${result.retry === undefined ? "" : publishMomentRetryLead[result.retry]}`.trim(),
        }),
      );
      return;
    }
    const pending: PendingBody = {
      kind: "publish-moment",
      meetupId: result.meetup.id,
      origin,
      telegramUserId: ctx.from?.id ?? 0,
    };
    // Непринятый момент — свой экран с «Ввести заново» (PER-472).
    if (result.retry !== undefined) {
      await refuseAnswer(
        ctx,
        questions,
        pending,
        publishMomentRetryLead[result.retry],
      );
      return;
    }
    await askQuestion(
      ctx,
      questions,
      pending,
      `${current}${publishMomentPrompt}`,
    );
    return;
  }
  if (result.kind === "publication-scheduled") {
    // О самом срабатывании бот не рассказывает: уведомление о публикации —
    // блок Notifications. Здесь только подтверждение назначения.
    await renderMeetupCard(
      ctx,
      cardFrom(result),
      true,
      presentation,
      true,
      result.meetup.publishAt === undefined
        ? "Публикация назначена."
        : `Публикация назначена на ${formatLocalMoment(result.meetup.publishAt)}. До этого момента сходка остаётся скрытой.`,
    );
    return;
  }
  if (result.kind === "publication-unavailable") {
    // E-04: ответ по текущему состоянию, а не по экрану, с которого пришёл ввод.
    // FAILED_PRECONDITION назначения означает три причины, и различает их
    // перечитанный снимок, а не текст статуса: скрытая неотменённая сходка
    // получила отказ за пустое название (PER-457).
    const text =
      result.meetup.lifecycle === "cancelled"
        ? "Сходка отменена. Назначить ей публикацию нельзя."
        : result.meetup.visibility === "visible"
          ? "Сходка уже опубликована. Назначать публикацию больше не нужно."
          : result.meetup.title.trim() === ""
            ? untitledPublicationText
            : staleMeetupText;
    await renderMeetupCard(
      ctx,
      cardFrom(result),
      true,
      presentation,
      true,
      text,
    );
    return;
  }
  if (result.kind === "published") {
    // Результат нажатия — карточка правкой того же сообщения: одновременный
    // двойной клик пишет в него же. С прошедшей датой сходка сразу в архиве:
    // ответ не обещает её в списке «Сходках», где её нет (PER-342).
    const published =
      result.archived === true
        ? "Сходка опубликована. Её дата уже прошла, поэтому она сразу в архиве, а не в «Сходках»."
        : "Сходка опубликована. Теперь она видна в списке.";
    await renderMeetupCard(
      ctx,
      cardFrom(result),
      true,
      presentation,
      true,
      `${published} Ссылка для чата: ${meetupStartLink(ctx.me.username, result.meetup.id)}`,
    );
    return;
  }
  if (result.kind === "dependency-rejected") {
    await showRefusal(
      ctx,
      result.reason === "invalid"
        ? invalidMeetupText(result)
        : result.reason === "conflict"
          ? conflictText
          : result.reason === "forbidden"
            ? forbiddenText
            : unavailableText,
      exitToMeetups(),
      "new",
    );
  }
}

function removeExpiredQuestions(
  questions: Map<string, PendingInput>,
  now: number,
): void {
  for (const [key, question] of questions) {
    if (question.expiresAt <= now) questions.delete(key);
  }
}

// Тело ожидаемого ответа без срока жизни: срок ставит `askQuestion`.
type PendingBody = HubPendingInput extends infer Each
  ? Each extends HubPendingInput
    ? Omit<Each, "expiresAt">
    : never
  : never;

function stepOf(pending: PendingBody): QuestionStep {
  switch (pending.kind) {
    case "meetup":
      return {
        kind: "field",
        mode: pending.mode,
        token: uuidToToken(pending.meetupId),
        field: pending.field,
        ...(pending.fresh === undefined ? {} : { fresh: pending.fresh }),
      };
    case "publish-moment":
      return {
        kind: "publish-moment",
        token: uuidToToken(pending.meetupId),
        origin: pending.origin,
      };
    case "material-source":
      return {
        kind: "material-source",
        token: uuidToToken(pending.meetupId),
        version: pending.version,
      };
    case "material-title":
      return { kind: "material-title", token: uuidToToken(pending.meetupId) };
    case "broadcast-body":
      return pending.audience.kind === "meetup"
        ? { kind: "broadcast", token: uuidToToken(pending.audience.meetupId) }
        : { kind: "broadcast" };
    case "allowed-username":
      return { kind: "username" };
    case "administrator-username":
      return { kind: "administrator" };
    case "channel-code":
      return { kind: "channel-code" };
    case "channel-label":
      return { kind: "channel-label" };
    case "lot":
      return lotStepOf(pending.question);
    case "console-week":
      return { kind: "console-week", auction: uuidToToken(pending.auctionId) };
    case "console-raffle":
      return {
        kind: "console-raffle",
        auction: uuidToToken(pending.auctionId),
      };
    case "console-raffle-prize":
      return {
        kind: "console-raffle-prize",
        auction: uuidToToken(pending.auctionId),
      };
    case "console-final-time":
      return {
        kind: "console-final-time",
        auction: uuidToToken(pending.auctionId),
      };
    case "console-payment-text":
      return {
        kind: "console-payment-text",
        auction: uuidToToken(pending.auctionId),
      };
    case "console-window":
      return {
        kind: "console-window",
        auction: uuidToToken(pending.auctionId),
      };
    case "console-launch":
      return {
        kind: "console-launch",
        auction: uuidToToken(pending.auctionId),
      };
    case "console-set":
      return {
        kind: "console-set",
        auction: uuidToToken(pending.auctionId),
      };
    case "final-ask":
      return {
        kind: "final-ask",
        auction: uuidToToken(pending.auctionId),
        position: pending.position,
      };
    case "floor-search":
      return { kind: "floor-search", auction: uuidToToken(pending.auctionId) };
    default: {
      const _exhaustive: never = pending;
      return _exhaustive;
    }
  }
}

function lotStepOf(question: LotQuestion): QuestionStep {
  if (question.kind === "new") {
    return {
      kind: "lot-new",
      auction: uuidToToken(question.auctionId),
      key: newLotKey(question.lotId),
    };
  }
  const lot = uuidToToken(question.lotId);
  switch (question.kind) {
    case "text":
      return {
        kind: "lot-text",
        lot,
        field: question.field,
        ...setScope(question.set),
      };
    case "price":
      return {
        kind: "lot-price",
        lot,
        ...chained(question.chain),
        ...setScope(question.set),
      };
    case "step":
      return {
        kind: "lot-step",
        lot,
        price: question.priceRubles,
        mode: question.mode,
        ...chained(question.chain),
        ...setScope(question.set),
      };
    case "image":
      return {
        kind: "lot-image",
        lot,
        ...chained(question.chain),
        ...setScope(question.set),
      };
    case "copies":
      return { kind: "lot-copies", lot };
    default: {
      const _exhaustive: never = question;
      return _exhaustive;
    }
  }
}

function lotQuestionOf(
  step: Extract<QuestionStep, { kind: `lot-${string}` }>,
): LotQuestion {
  if (step.kind === "lot-new") {
    return {
      kind: "new",
      auctionId: tokenToUuid(step.auction),
      lotId: newLotIdOf(step.key),
    };
  }
  const lotId = tokenToUuid(step.lot);
  switch (step.kind) {
    case "lot-text":
      return { kind: "text", field: step.field, lotId, ...setScope(step.set) };
    case "lot-price":
      return {
        kind: "price",
        lotId,
        ...chained(step.chain),
        ...setScope(step.set),
      };
    case "lot-step":
      return {
        kind: "step",
        lotId,
        priceRubles: step.price,
        mode: step.mode,
        ...chained(step.chain),
        ...setScope(step.set),
      };
    case "lot-image":
      return {
        kind: "image",
        lotId,
        ...chained(step.chain),
        ...setScope(step.set),
      };
    case "lot-copies":
      return { kind: "copies", lotId };
    default: {
      const _exhaustive: never = step;
      return _exhaustive;
    }
  }
}

// Ожидаемый ответ по шагу из кнопки вопроса — то, что раньше жило только в
// памяти процесса. `telegramUserId` — спрашиваемый из той же кнопки, а не
// автор ответа: иначе после рестарта чужой ответ проходил бы проверку.
// Название материала по шагу не восстановить: источник файла в кнопку не
// помещается.
function pendingOf(
  step: QuestionStep,
  telegramUserId: number,
): PendingInput | undefined {
  const expiresAt = Date.now() + questionTtlMs;
  switch (step.kind) {
    case "field":
      return {
        kind: "meetup",
        mode: step.mode,
        field: step.field,
        meetupId: tokenToUuid(step.token),
        ...(step.fresh === undefined ? {} : { fresh: step.fresh }),
        telegramUserId,
        expiresAt,
      };
    case "publish-moment":
      return {
        kind: "publish-moment",
        meetupId: tokenToUuid(step.token),
        origin: step.origin,
        telegramUserId,
        expiresAt,
      };
    case "material-source":
      return {
        kind: "material-source",
        meetupId: tokenToUuid(step.token),
        version: step.version,
        telegramUserId,
        expiresAt,
      };
    case "material-title":
      return undefined;
    case "broadcast":
      return {
        kind: "broadcast-body",
        audience:
          step.token === undefined
            ? { kind: "community" }
            : { kind: "meetup", meetupId: tokenToUuid(step.token) },
        telegramUserId,
        expiresAt,
      };
    case "username":
      return { kind: "allowed-username", telegramUserId, expiresAt };
    case "administrator":
      return { kind: "administrator-username", telegramUserId, expiresAt };
    case "channel-code":
      return { kind: "channel-code", telegramUserId, expiresAt };
    case "channel-label":
      return undefined;
    case "lot-new":
    case "lot-text":
    case "lot-price":
    case "lot-step":
    case "lot-image":
    case "lot-copies":
      return {
        kind: "lot",
        question: lotQuestionOf(step),
        telegramUserId,
        expiresAt,
      };
    case "console-week":
      return {
        kind: "console-week",
        auctionId: tokenToUuid(step.auction),
        telegramUserId,
        expiresAt,
      };
    case "console-raffle":
      return {
        kind: "console-raffle",
        auctionId: tokenToUuid(step.auction),
        telegramUserId,
        expiresAt,
      };
    case "console-raffle-prize":
      return {
        kind: "console-raffle-prize",
        auctionId: tokenToUuid(step.auction),
        telegramUserId,
        expiresAt,
      };
    case "console-final-time":
      return {
        kind: "console-final-time",
        auctionId: tokenToUuid(step.auction),
        telegramUserId,
        expiresAt,
      };
    case "console-payment-text":
      return {
        kind: "console-payment-text",
        auctionId: tokenToUuid(step.auction),
        telegramUserId,
        expiresAt,
      };
    case "console-window":
      return {
        kind: "console-window",
        auctionId: tokenToUuid(step.auction),
        telegramUserId,
        expiresAt,
      };
    case "console-launch":
      return {
        kind: "console-launch",
        auctionId: tokenToUuid(step.auction),
        telegramUserId,
        expiresAt,
      };
    case "console-set":
      return {
        kind: "console-set",
        auctionId: tokenToUuid(step.auction),
        telegramUserId,
        expiresAt,
      };
    case "final-ask":
      return {
        kind: "final-ask",
        auctionId: tokenToUuid(step.auction),
        position: step.position,
        telegramUserId,
        expiresAt,
      };
    case "floor-search":
      return {
        kind: "floor-search",
        auctionId: tokenToUuid(step.auction),
        telegramUserId,
        expiresAt,
      };
    default: {
      const _exhaustive: never = step;
      return _exhaustive;
    }
  }
}

// Действие экрана: всё, что несёт кнопка, кроме самой «Отмены» под вопросом, —
// она сводится к действию экрана, с которого вопрос задан.
// Лента аукциона — не действие кнопки хаба: её рисует аукционное дерево под доменом
// `auc`, а сюда ведёт только «Отмена» вопроса о новом лоте.
type ScreenAction =
  | Exclude<CallbackAction, { kind: "question" }>
  | { kind: "lot-feed"; auction: string; trace?: never };

// Куда возвращает «Отмена»: экран, с которого вопрос задан.
function cancelTarget(step: QuestionStep): ScreenAction {
  switch (step.kind) {
    case "field":
      // Вопрос о названии новой сходки задан до черновика — из «Сходок» или
      // из группы «Сходки и объявления», туда «Отмена» и ведёт: черновика
      // нет (прогон 14.10, №14). Остальные вопросы формы создания заданы с
      // черновика, точечной правки — с карточки.
      if (step.fresh !== undefined) {
        return step.fresh === "meetups"
          ? { kind: "hub" }
          : { kind: "manage-group", group: "meetups" };
      }
      return step.mode === "create"
        ? { kind: "manage-draft", token: step.token }
        : { kind: "view-meetup", token: step.token };
    case "publish-moment":
      // Отложенную публикацию назначают из «Статуса» и с черновика.
      return step.origin === "draft"
        ? { kind: "manage-draft", token: step.token }
        : { kind: "manage-status", token: step.token };
    case "material-source":
    case "material-title":
      return { kind: "manage-materials", token: step.token };
    case "broadcast":
      return step.token === undefined
        ? { kind: "manage-menu" }
        : { kind: "view-meetup", token: step.token };
    case "username":
      return { kind: "community-usernames", page: 0 };
    case "administrator":
      return { kind: "administrators" };
    case "channel-code":
    case "channel-label":
      return { kind: "source-channels", page: 0 };
    case "lot-new":
      // Вопрос о названии задан из ленты аукциона: лота ещё нет.
      return { kind: "lot-feed", auction: step.auction };
    case "lot-text":
    case "lot-price":
    case "lot-step":
    case "lot-image":
    case "lot-copies":
      return { kind: "lot-form", lot: step.lot };
    case "console-week":
    case "console-raffle":
    case "console-raffle-prize":
    case "console-final-time":
    case "final-ask":
      // Вопросы о сроках, о розыгрыше, о призе, о времени финала и о цене
      // заданы с пульта аукциона.
      return {
        kind: "console-view",
        auction: step.auction,
        page: 0,
        sort: defaultConsoleSort,
      };
    case "console-window":
      // Вопрос о новом окне задан со «Счастливых часов».
      return { kind: "console-windows", auction: step.auction };
    case "floor-search":
      return { kind: "console-floor", auction: step.auction, page: 0 };
    case "console-launch":
      // Вопрос о запуске окна задан со «Счастливых часов».
      return { kind: "console-windows", auction: step.auction };
    case "console-set":
      // Вопрос о названии сета задан с «Сетов».
      return { kind: "console-sets", auction: step.auction };
    case "console-payment-text":
      // Вопрос о тексте оплаты задан со «Счетов».
      return { kind: "console-invoices", auction: step.auction, page: 0 };
    default: {
      const _exhaustive: never = step;
      return _exhaustive;
    }
  }
}

function questionStepOf(
  replied: unknown,
): { step: QuestionStep; askedBy: number | undefined } | undefined {
  const parsed = RepliedKeyboardSchema.safeParse(replied);
  if (!parsed.success) return undefined;
  for (const button of parsed.data.reply_markup.inline_keyboard.flat()) {
    const action = parseCallback(button.callback_data);
    if (action.kind === "question") {
      return { step: action.step, askedBy: action.askedBy };
    }
  }
  return undefined;
}

// Сбой сервиса, после которого тот же ответ стоит прислать ещё раз.
function retryable(result: ExecuteResult): boolean {
  return (
    result.kind === "dependency-rejected" &&
    (result.reason === "timeout" || result.reason === "unavailable")
  );
}

/**
 * Задаёт вопрос (дизайн-код, «Вопросы»): клиент сам открывает режим ответа, а
 * под вопросом стоит «Отмена» с его шагом. Экран, с которого вопрос задан,
 * теряет клавиатуру: в чате остаётся одно место, где можно действовать.
 * `replaces` — вопрос, на который человек ответил неудачно: он снимается только
 * после того, как ушёл новый, чтобы упавшая отправка не теряла шаг формы.
 */
async function askQuestion(
  ctx: UpdateContext,
  questions: Map<string, PendingInput>,
  pending: PendingBody,
  text: string,
  replaces?: number,
  // Кнопка над «Отменой», которая тоже уводит от вопроса: «Пропустить» фото
  // нового лота (PER-618).
  above?: { text: string; data: string },
): Promise<void> {
  if (ctx.callbackQuery !== undefined && ctx.pressedGone !== true) {
    await clearCallbackKeyboard(ctx);
  }
  const keyboard = new InlineKeyboard();
  if (above !== undefined) keyboard.text(above.text, above.data).row();
  keyboard.text(
    cancelLabel,
    questionData(stepOf(pending), pending.telegramUserId),
  );
  const prompt = await ctx.reply(text, {
    ...screenMark("question"),
    reply_markup: {
      force_reply: true,
      inline_keyboard: keyboard.inline_keyboard,
    },
  });
  if (replaces !== undefined) {
    questions.delete(questionKey(ctx.chat?.id, replaces));
    await closeQuestion(ctx, replaces);
  }
  // Запись в карте нужна названию материала и подписи рассылки: остальное
  // читается из кнопки вопроса и рестарт переживает.
  questions.set(questionKey(ctx.chat?.id, prompt.message_id), {
    ...pending,
    expiresAt: Date.now() + questionTtlMs,
    // `PendingBody` — тот же union без срока жизни: разворот его варианта с
    // `expiresAt` даёт вариант `PendingInput`, но TypeScript распределённый
    // `Omit` обратно в union не сводит.
  } as PendingInput);
  evictOldestQuestions(questions);
}

const retryAnswerLabel = "Ввести заново";

/**
 * Непринятый ответ на вопрос — свой экран (дизайн-код, «Экран исхода»,
 * PER-472): причина в заголовке, «Ввести заново» задаёт вопрос снова, возврат
 * ведёт туда, куда вела «Отмена». Прежний вопрос закрывается после отправки,
 * как у `askQuestion`.
 */
async function refuseAnswer(
  ctx: UpdateContext,
  questions: Map<string, PendingInput>,
  pending: PendingBody,
  reason: string,
  replaces?: number,
): Promise<void> {
  const step = stepOf(pending);
  await showScreen(ctx, {
    id: "outcome",
    text: outcomeText(reason),
    keyboard: withNav(
      new InlineKeyboard().text(retryAnswerLabel, reopenData(step)),
      answerParent(step),
    ),
    format: "HTML",
    delivery: "new",
  });
  if (replaces !== undefined) {
    questions.delete(questionKey(ctx.chat?.id, replaces));
    await closeQuestion(ctx, replaces);
  }
}

// Кнопка «Ввести заново» — то же действие, что открыло вопрос. Цепочка из двух
// вопросов начинается сначала: первый ответ жил в памяти процесса или уже
// принят командой.
function reopenData(step: QuestionStep): string {
  switch (step.kind) {
    case "field":
      // Сходки по вопросу «Создать сходку» ещё может не быть: «Ввести заново»
      // задаёт тот же вопрос с тем же id (прогон 14.10, №14).
      if (step.fresh !== undefined) {
        return `v1:manage:new:${step.token}${step.fresh === "meetups" ? ":s" : ""}`;
      }
      return step.mode === "create"
        ? `v1:manage:draft:${step.token}:${step.field}`
        : `v1:manage:field:${step.token}:${step.field}`;
    case "publish-moment":
      return step.origin === "draft"
        ? `v1:manage:publish-later:${step.token}:d`
        : `v1:manage:publish-later:${step.token}`;
    case "material-source":
    case "material-title":
      return `v1:mm:add:${step.token}`;
    case "broadcast":
      return step.token === undefined ? "v1:bc:c" : `v1:bc:m:${step.token}`;
    case "username":
      return "v1:community:allow";
    case "administrator":
      return "v1:ad:n";
    case "channel-code":
    case "channel-label":
      return "v1:sc:a";
    case "lot-new":
      return lotNewData(step.auction);
    case "lot-text":
      return lotAskData(step.lot, step.field, stepScope(step));
    // Вопрос цепочки нового лота (PER-618) повтор задаёт в цепочке: после
    // него она идёт дальше. Вопрос правки сета (PER-716) — тоже для сета.
    case "lot-price":
      return lotAskData(step.lot, "price", stepScope(step));
    // Цена уже в шаге, как в кнопке выбора способа (PER-491): повтор задаёт
    // тот же вопрос о шаге, а не цену заново.
    case "lot-step":
      return lotStepModeData(step.lot, step.price, step.mode, stepScope(step));
    case "lot-image":
      return lotAskData(step.lot, "image", stepScope(step));
    case "lot-copies":
      return lotCopyData(step.lot);
    case "console-week":
      return consoleWeekData(step.auction);
    case "console-raffle":
      return consoleRaffleData(step.auction);
    case "console-raffle-prize":
      return consoleRafflePrizeData(step.auction);
    case "console-final-time":
      return consoleFinalTimeData(step.auction);
    case "console-payment-text":
      return consolePaymentTextData(step.auction);
    case "console-window":
      return consoleWindowAskData(step.auction);
    case "console-launch":
      return consoleWindowLaunchData(step.auction);
    case "console-set":
      return consoleSetAskData(step.auction);
    case "final-ask":
      return consoleAskData(step.auction, step.position);
    case "floor-search":
      return floorSearchData(step.auction);
    default: {
      const _exhaustive: never = step;
      return _exhaustive;
    }
  }
}

// Возврат с экрана отказа — туда же, куда «Отмена» под вопросом.
function answerParent(step: QuestionStep): Parent {
  switch (step.kind) {
    case "field":
      if (step.fresh !== undefined) {
        return step.fresh === "meetups"
          ? toMeetups
          : manageItemParent("meetups");
      }
      return step.mode === "create"
        ? { name: "Сходка", data: `v1:manage:draft:${step.token}` }
        : toCard(step.token);
    case "publish-moment":
      return step.origin === "draft"
        ? { name: "Сходка", data: `v1:manage:draft:${step.token}` }
        : { name: "Статус", data: `v1:manage:status:${step.token}` };
    case "material-source":
    case "material-title":
      return toMaterials(step.token);
    case "broadcast":
      return step.token === undefined ? toManage : toCard(step.token);
    case "username":
      return { name: "Ники", data: "v1:cm:u" };
    case "administrator":
      return toAdministrators;
    case "channel-code":
    case "channel-label":
      return toSourceChannels;
    case "lot-new":
      return toLots(tokenToUuid(step.auction));
    case "lot-text":
    case "lot-price":
    case "lot-step":
    case "lot-image":
    case "lot-copies":
      return toLot(tokenToUuid(step.lot));
    case "console-week":
    case "console-raffle":
    case "console-raffle-prize":
    case "console-final-time":
    case "final-ask":
      return { name: "Пульт", data: consoleViewData(step.auction) };
    case "console-window":
      return {
        name: "Счастливые часы",
        data: consoleWindowsData(step.auction),
      };
    case "floor-search":
      return { name: floorTitle, data: floorData(step.auction) };
    case "console-launch":
      return {
        name: "Счастливые часы",
        data: consoleWindowsData(step.auction),
      };
    case "console-set":
      return { name: "Сеты", data: consoleSetsData(step.auction) };
    case "console-payment-text":
      return {
        name: invoicesLabel,
        data: consoleInvoicesData(step.auction),
      };
    default: {
      const _exhaustive: never = step;
      return _exhaustive;
    }
  }
}

/**
 * Вопрос листа ставки (PER-317) по правилам вопросов: новое сообщение с
 * режимом ответа, экран над ним теряет клавиатуру. Шаг и адресат — в «Отмене»
 * из тела пакета; карта помнит вопрос только ради уборки брошенного.
 */
async function askAuctionQuestion(
  ctx: UpdateContext,
  questions: Map<string, PendingInput>,
  screen: ShownScreen,
  replaces?: number,
): Promise<void> {
  if (ctx.callbackQuery !== undefined && ctx.pressedGone !== true) {
    await clearCallbackKeyboard(ctx);
  }
  const prompt = await ctx.reply(screen.text, {
    ...screenMark("question"),
    parse_mode: "HTML",
    reply_markup: {
      force_reply: true,
      inline_keyboard: screen.keyboard.inline_keyboard,
    },
  });
  if (replaces !== undefined) {
    questions.delete(questionKey(ctx.chat?.id, replaces));
    await closeQuestion(ctx, replaces);
  }
  questions.set(questionKey(ctx.chat?.id, prompt.message_id), {
    kind: "auction",
    telegramUserId: ctx.from?.id ?? 0,
    expiresAt: Date.now() + questionTtlMs,
  });
  evictOldestQuestions(questions);
}

// Шаг вопроса листа ставки из сообщения, на которое ответили: `callback_data`
// его «Отмены», если это вопрос домена `auc`.
function auctionQuestionOf(replied: unknown): string | undefined {
  const parsed = RepliedKeyboardSchema.safeParse(replied);
  if (!parsed.success) return undefined;
  return parsed.data.reply_markup.inline_keyboard
    .flat()
    .map((button) => button.callback_data)
    .find(
      (data): data is string =>
        typeof data === "string" &&
        isAuctionQuestion(auctionEntryOf(data).data),
    );
}

/** Момент публикации выбирают в режимах `p` и `d`; остальные — дата сходки. */
function publishOriginOf(mode: WhenMode): PublishOrigin | undefined {
  return mode === "p" ? "status" : mode === "d" ? "draft" : undefined;
}

// Тело ожидаемого ответа из записи карты: срок жизни вопрос получит заново.
function bodyOf(pending: HubPendingInput): PendingBody {
  const { expiresAt: _expiresAt, ...body } = pending;
  return body;
}

/** Удаляет сообщение нажатой кнопки; `false` — Telegram удалить не дал. */
async function deletePressed(ctx: UpdateContext): Promise<boolean> {
  try {
    await ctx.deleteMessage();
    return true;
  } catch {
    return false;
  }
}

// Брошенные вопросы: человек не ответил и не отменил, а пошёл дальше. Пока
// вопрос висит, мобильный клиент включает режим ответа на него при каждом
// входе в чат, а снимает его только удаление сообщения (зонд PER-443). Бот
// помнит вопросы в памяти процесса: после рестарта удалять нечего, и такие
// вопросы остаются. `except` — сообщение нажатой кнопки: с ним разбирается
// само нажатие.
async function dropOpenQuestions(
  ctx: UpdateContext,
  questions: Map<string, PendingInput>,
  except?: number,
): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;
  const prefix = `${chatId}:`;
  for (const key of [...questions.keys()]) {
    if (!key.startsWith(prefix)) continue;
    const messageId = Number(key.slice(prefix.length));
    if (messageId === except) continue;
    questions.delete(key);
    try {
      await ctx.api.deleteMessage(chatId, messageId);
    } catch {
      // Сообщение уже удалено или старше, чем Telegram даёт удалять.
    }
  }
}

// Вопрос, на который ответ принят, больше не ждёт: «Отмена» под ним снимается.
async function closeQuestion(
  ctx: UpdateContext,
  messageId: number,
): Promise<void> {
  if (ctx.chat === undefined) return;
  try {
    await ctx.api.editMessageReplyMarkup(ctx.chat.id, messageId, {
      reply_markup: new InlineKeyboard(),
    });
  } catch {
    // Вопрос прошлого релиза кнопки не несёт, и править у него нечего.
  }
}

function evictOldestQuestions(questions: Map<string, PendingInput>): void {
  while (questions.size > questionLimit) {
    const oldest = questions.keys().next().value;
    if (oldest === undefined) return;
    questions.delete(oldest);
  }
}

// Альбом приходит отдельным update на каждую фотографию, и все они отвечают
// на один вопрос. Отказ «нужна одна фотография» нужен один раз на альбом, а не
// по сообщению на снимок. Память процесса: после рестарта посреди альбома
// отказ придёт ещё раз, и это не теряет ничего.
type SeenAlbums = {
  seen(group: string): boolean;
  remember(group: string): void;
};

const albumMemory = 64;

function createSeenAlbums(): SeenAlbums {
  const seen = new Set<string>();
  return {
    seen(group) {
      return seen.has(group);
    },
    remember(group) {
      seen.add(group);
      if (seen.size > albumMemory) {
        const oldest = seen.values().next().value;
        if (oldest !== undefined) seen.delete(oldest);
      }
    },
  };
}

function communityToday(ctx: UpdateContext) {
  return (ctx.today ?? utcToday)();
}

// Метаданные вызова сервиса. Их собирают прямо перед вызовом, поэтому здесь
// же начинается ожидание человека: с этого момента идёт счёт до «печатает…»,
// а вызов получает общий дедлайн действия.
function rpcCall(ctx: UpdateContext, useCase?: ProductUseCase): RpcMetadata {
  ctx.waiting?.begin();
  return {
    ...(ctx.requestId === undefined ? {} : { requestId: ctx.requestId }),
    ...(useCase === undefined ? {} : { useCase }),
    ...(ctx.waiting === undefined
      ? {}
      : { deadlineAt: ctx.waiting.deadlineAt }),
  };
}

function callbackUseCase(
  kind:
    | "home"
    | "apply"
    | "settings"
    | "settings-extensions"
    | "settings-auction"
    | "meetup-extensions"
    | "help"
    | "release-notes"
    | "next"
    | "events"
    | "manage-group"
    | "hub"
    | "archive"
    | "outdated"
    | "view-meetup"
    | "manage-menu"
    | "manage-hidden"
    | "community"
    | "community-usernames"
    | "ask-allowed-username"
    | "community-member"
    | "ask-block-member"
    | "block-member"
    | "ask-demote-member"
    | "demote-member"
    | "remove-allowed-username"
    | "refused-applications"
    | "ask-reconsider"
    | "reconsider"
    | "grant-record"
    | "revoke-record"
    | "administrators"
    | "ask-appoint-administrator"
    | "confirm-appoint-administrator"
    | "decline-appoint-administrator"
    | "ask-dismiss-administrator"
    | "dismiss-administrator"
    | "source-channels"
    | "ask-source-channel"
    | "application-card"
    | "admit-application"
    | "ask-decline-application"
    | "decline-application"
    | "create-meetup"
    | "publish-meetup"
    | "manage-edit"
    | "manage-field"
    | "manage-draft"
    | "manage-status"
    | "enable-auction"
    | "lot-new"
    | "lot-form"
    | "lot-view"
    | "lot-ask"
    | "lot-step-mode"
    | "lot-skip"
    | "lot-keep-step"
    | "lot-image-remove"
    | "lot-image-remove-confirm"
    | "lot-scope"
    | "lot-set-retry"
    | "lot-copy"
    | "lot-remove"
    | "lot-remove-confirm"
    | "console-view"
    | "console-week"
    | "console-raffle"
    | "console-raffle-remove"
    | "console-raffle-prize"
    | "console-raffle-prize-remove"
    | "console-final"
    | "console-final-time"
    | "console-final-time-remove"
    | "console-visibility"
    | "console-open"
    | "console-confirm"
    | "console-discard"
    | "console-discard-confirm"
    | "console-cancel"
    | "console-cancel-confirm"
    | "console-mark"
    | "console-lineup"
    | "console-lineup-confirm"
    | "console-start-final"
    | "console-next-lot"
    | "console-ask"
    | "console-close"
    | "console-close-confirm"
    | "console-floor"
    | "console-floor-search"
    | "console-floor-pick"
    | "console-floor-confirm"
    | "console-floor-leader"
    | "console-removal"
    | "console-removal-pick"
    | "console-removal-confirm"
    | "console-windows"
    | "console-day-summary"
    | "console-invoices"
    | "console-invoice"
    | "console-invoice-mark"
    | "console-invoice-mark-confirm"
    | "console-payment-text"
    | "console-payment-text-remove"
    | "console-window"
    | "console-window-ask"
    | "console-window-lot"
    | "console-window-remove"
    | "console-window-launch"
    | "console-window-launch-lot"
    | "console-window-launch-go"
    | "console-window-launch-page"
    | "console-sets"
    | "console-set-ask"
    | "console-set"
    | "console-set-lot"
    | "console-set-delete"
    | "console-set-delete-confirm"
    | "manage-publish"
    | "manage-confirm-publish"
    | "manage-unpublish"
    | "manage-confirm-unpublish"
    | "manage-cancel"
    | "manage-confirm-cancel"
    | "notify-global"
    | "notify-set-global"
    | "notify-outbid"
    | "notify-set-outbid"
    | "notify-set-final"
    | "notify-set-live"
    | "notify-set-news"
    | "notify-disable-global"
    | "notify-disable-meetup"
    | "notify-settings"
    | "notify-subscription"
    | "notify-set-meetup"
    | "manage-hold"
    | "manage-confirm-hold"
    | "manage-publish-later"
    | "manage-unschedule"
    | "manage-confirm-unschedule"
    | "manage-confirm-past-schedule"
    | "manage-pick-day"
    | "manage-pick-schedule"
    | "manage-type-schedule"
    | "manage-retry-past-schedule"
    | "manage-materials"
    | "begin-attach-material"
    | "decline-attach-material"
    | "confirm-attach-material"
    | "remove-material"
    | "confirm-remove-material"
    | "open-material-file"
    | "begin-meetup-broadcast"
    | "begin-community-broadcast"
    | "confirm-meetup-broadcast"
    | "confirm-community-broadcast"
    | "cancel-broadcast",
): ProductUseCase {
  switch (kind) {
    case "view-meetup":
    case "meetup-extensions":
      return "view_meetup";
    case "manage-hidden":
      return "find_meetup";
    case "create-meetup":
    case "manage-draft":
    case "publish-meetup":
    case "manage-menu":
    case "manage-group":
      return "create_meetup";
    case "manage-edit":
    case "manage-field":
    case "manage-status":
    case "manage-publish":
    case "manage-confirm-publish":
    case "manage-unpublish":
    case "manage-confirm-unpublish":
    case "manage-cancel":
    case "manage-confirm-cancel":
    case "manage-hold":
    case "manage-confirm-hold":
    case "manage-publish-later":
    case "manage-unschedule":
    case "manage-confirm-unschedule":
    case "manage-confirm-past-schedule":
    case "manage-retry-past-schedule":
    case "manage-pick-day":
    case "manage-pick-schedule":
    case "manage-type-schedule":
    case "manage-materials":
    case "begin-attach-material":
    case "decline-attach-material":
    case "confirm-attach-material":
    case "remove-material":
    case "confirm-remove-material":
      return "update_meetup";
    case "open-material-file":
      return "view_meetup";
    case "begin-meetup-broadcast":
    case "begin-community-broadcast":
    case "confirm-meetup-broadcast":
    case "confirm-community-broadcast":
    case "cancel-broadcast":
      return "send_broadcast";
    case "refused-applications":
    case "ask-reconsider":
    case "reconsider":
    case "source-channels":
    case "ask-source-channel":
    case "application-card":
    case "admit-application":
    case "ask-decline-application":
    case "decline-application":
    case "community":
    case "community-usernames":
    case "ask-allowed-username":
    case "community-member":
    case "ask-block-member":
    case "block-member":
    case "ask-demote-member":
    case "demote-member":
    case "remove-allowed-username":
    case "grant-record":
    case "revoke-record":
    case "administrators":
    case "ask-appoint-administrator":
    case "confirm-appoint-administrator":
    case "decline-appoint-administrator":
    case "ask-dismiss-administrator":
    case "dismiss-administrator":
      return "manage_community";
    case "settings":
    case "settings-extensions":
    case "settings-auction":
    case "notify-global":
    case "notify-set-global":
    case "notify-outbid":
    case "notify-set-outbid":
    case "notify-set-final":
    case "notify-set-live":
    case "notify-set-news":
    case "notify-disable-global":
    case "notify-disable-meetup":
    case "notify-settings":
    case "notify-subscription":
    case "notify-set-meetup":
      return "manage_notifications";
    case "enable-auction":
      return "enable_auction";
    case "lot-new":
    case "lot-form":
    case "lot-view":
    case "lot-ask":
    case "lot-step-mode":
    case "lot-skip":
    case "lot-keep-step":
    case "lot-image-remove":
    case "lot-image-remove-confirm":
    case "lot-scope":
    case "lot-set-retry":
    case "lot-copy":
    case "lot-remove":
    case "lot-remove-confirm":
      return "manage_lot";
    case "console-view":
    case "console-week":
    case "console-raffle":
    case "console-raffle-remove":
    case "console-raffle-prize":
    case "console-raffle-prize-remove":
    case "console-final":
    case "console-visibility":
    case "console-open":
    case "console-confirm":
    case "console-discard":
    case "console-discard-confirm":
    case "console-cancel":
    case "console-cancel-confirm":
    case "console-mark":
    case "console-lineup":
    case "console-lineup-confirm":
    case "console-start-final":
    case "console-next-lot":
    case "console-ask":
    case "console-close":
    case "console-close-confirm":
    case "console-floor":
    case "console-floor-search":
    case "console-floor-pick":
    case "console-floor-confirm":
    case "console-floor-leader":
    case "console-removal":
    case "console-removal-pick":
    case "console-removal-confirm":
    case "console-windows":
    case "console-day-summary":
    case "console-invoices":
    case "console-invoice":
    case "console-invoice-mark":
    case "console-invoice-mark-confirm":
    case "console-payment-text":
    case "console-payment-text-remove":
    case "console-window":
    case "console-window-ask":
    case "console-window-lot":
    case "console-window-remove":
    case "console-window-launch":
    case "console-window-launch-lot":
    case "console-window-launch-go":
    case "console-window-launch-page":
    case "console-final-time":
    case "console-final-time-remove":
    case "console-sets":
    case "console-set-ask":
    case "console-set":
    case "console-set-lot":
    case "console-set-delete":
    case "console-set-delete-confirm":
      return "manage_auction";
    case "home":
    case "apply":
    case "help":
      return "find_meetup";
    case "release-notes":
      return "view_release_notes";
    case "hub":
    case "archive":
    case "outdated":
      return "find_meetup";
    case "next":
      return "view_meetup";
    case "events":
      return "view_auction";
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

// Назначения ключей из ответа: вид вопроса пульта, цена ведущего и
// идентификатор нового сета — у одного сообщения бывает и ключ команды, и id.
type AnswerKeyPurpose =
  | ConsoleQuestionPending["kind"]
  | "final-ask"
  | "console-set-id";

/**
 * `op_id` ответа на вопрос из самого сообщения Telegram (PER-699): чат,
 * `message_id` и назначение ключа. Повторная доставка того же сообщения даёт
 * тот же ключ, и Auction отвечает исходным исходом (ADR-047, окно `op_id`), а
 * новое сообщение — новый. Назначение разводит ключи разных команд одного
 * сообщения, а время UUIDv7 — дата сообщения, она у повтора та же.
 */
function answerOpId(
  message: { chat: { id: number }; message_id: number; date: number },
  purpose: AnswerKeyPurpose,
): string {
  return uuidV7Of(
    `hub-bot:${purpose}:${message.chat.id}:${message.message_id}`,
    message.date * 1000,
  );
}

function questionKey(chatId: number | undefined, messageId: number): string {
  return `${chatId ?? "unknown"}:${messageId}`;
}
// Экран границы кончается либо отрисовкой, либо отказом. Разбор отказа везде
// один и тот же, поэтому вызывающий называет только те kind, которые считает
// успехом своего экрана; всё остальное — отказ зависимости или дефект.
type BoundaryScreen = {
  ok: readonly ExecuteResult["kind"][];
  okMessage: string;
  rejectedMessage: string;
  useCase: ProductUseCase;
  meetupId?: string;
};

function screenBoundary(
  result: ExecuteResult,
  screen: BoundaryScreen,
): BoundaryOutcome {
  const meetup =
    screen.meetupId === undefined ? {} : { meetup_id: screen.meetupId };
  // Карточка ушла без строки аукциона, потому что Auction не ответил
  // (PER-594): человек видит верную карточку, но для записи границы это
  // сбой соседа, а не успех, — иначе его не отличить от сходки без аукциона.
  if (result.kind === "meetup-card" && result.auction?.kind === "unavailable") {
    return {
      level: "warn",
      message: `${screen.okMessage} without the auction`,
      result: "error",
      use_case: screen.useCase,
      ...meetup,
      error_category: "dependency_unavailable",
      error: "auction_unavailable",
    };
  }
  if (result.kind === "meetup-not-found") {
    return {
      level: "warn",
      message: "meetup not visible",
      result: "error",
      use_case: screen.useCase,
      ...meetup,
      error_category: "visibility",
      error: "meetup_not_visible",
    };
  }
  // Вопрос формы, заданный заново из-за отказа Meetups, — для человека шаг
  // формы, а для записи границы — отказ с кодом и текстом сервиса (PER-397).
  if (
    (result.kind === "ask" || result.kind === "edit-ask") &&
    "rejected" in result
  ) {
    return {
      level: "warn",
      message: screen.rejectedMessage,
      result: "error",
      use_case: screen.useCase,
      ...meetup,
      error_category: "invariant",
      ...rejectionFields(result.rejected),
    };
  }
  if (screen.ok.includes(result.kind)) {
    return {
      level: "info",
      message: screen.okMessage,
      result: "ok",
      use_case: screen.useCase,
      ...meetup,
    };
  }
  // Конфликт версий — не сбой зависимости и не неожиданность: запрос собран
  // верно, но показанный снимок устарел. Человеку уходит текущая карточка, а в
  // записи границы отказ отличим от отказа по праву собственным error.
  if (result.kind === "conflict") {
    return {
      level: "warn",
      message: screen.rejectedMessage,
      result: "error",
      use_case: screen.useCase,
      ...meetup,
      error_category: "invariant",
      error: "version_conflict",
    };
  }
  if (result.kind === "dependency-rejected") {
    return {
      level: "warn",
      message: screen.rejectedMessage,
      result: "error",
      use_case: screen.useCase,
      ...meetup,
      error_category: dependencyCategory(result.reason),
      ...(result.reason === "invalid"
        ? rejectionFields(result.cause)
        : { error: result.reason }),
    };
  }
  return {
    level: "error",
    message: screen.rejectedMessage,
    result: "error",
    use_case: screen.useCase,
    ...meetup,
    error_category: "unexpected",
    error: result.kind === "rejected" ? result.reason : result.kind,
  };
}

// Недоступность зависимости и отвергнутый ею вызов — разные отказы: первый
// проходит по повтору, второй никогда. Человеку в обоих случаях уходит один и
// тот же fail-closed ответ, различие живёт в записи границы.
function identityFailureOutcome(
  resolved:
    | { kind: "unavailable"; cause: unknown }
    | { kind: "rejected"; code: string; cause: unknown },
  useCase?: ProductUseCase,
): BoundaryOutcome {
  if (resolved.kind === "rejected") {
    return {
      level: "error",
      message: "identity rejected the request",
      result: "error",
      ...(useCase === undefined ? {} : { use_case: useCase }),
      error_category: grpcFailureCategory(resolved.code),
      grpc_code: resolved.code,
      error: errorText(resolved.cause),
    };
  }
  return {
    level: "error",
    message: "identity unavailable",
    result: "error",
    ...(useCase === undefined ? {} : { use_case: useCase }),
    error_category: unavailableCategory(resolved.cause),
    error: errorText(resolved.cause),
  };
}

// Кадр не повторяет действие: юзкейс мог уже успешно изменить состояние.
// Отказ самого кадра не запускает восстановление снова.
async function replyScreenFailure({
  ctx,
  cause,
  previous,
  useCase,
}: {
  ctx: UpdateContext;
  cause: unknown;
  previous: BoundaryOutcome | undefined;
  useCase: ProductUseCase | undefined;
}): Promise<BoundaryOutcome> {
  const outcome: BoundaryOutcome =
    previous?.result === "error"
      ? { ...previous, reply_error: errorText(cause) }
      : unexpectedOutcome(
          cause,
          undefined,
          useCase,
          previous?.meetup_id,
          previous?.identity_id,
        );
  try {
    await showRefusal(
      ctx,
      "Не получилось показать экран. Это на моей стороне.\n\nОткрой раздел заново и проверь состояние перед повтором действия.",
      exitToMeetups(),
      // Предыдущая попытка могла снять клавиатуру. Snapshot callback ещё
      // содержит её: правка того же кадра была бы ошибочно пропущена.
      "new",
    );
  } catch (replyCause) {
    if (outcome.result === "error") {
      return {
        ...outcome,
        reply_error: [outcome.reply_error, errorText(replyCause)]
          .filter(Boolean)
          .join("; "),
      };
    }
  }
  return outcome;
}

// Отказ самого ответа человеку нельзя терять: раньше outcome присваивался до
// await, поэтому catch видел его непустым и 403 от Bot API не попадал ни в
// запись границы, ни в bot.catch.
async function replyFailClosed(
  ctx: UpdateContext,
  outcome: BoundaryOutcome,
): Promise<BoundaryOutcome> {
  try {
    await showRefusal(ctx, unavailableText, exitToMeetups());
    return outcome;
  } catch (cause) {
    return await replyScreenFailure({
      ctx,
      cause,
      previous: outcome,
      useCase: outcome.use_case,
    });
  }
}

// Некоторые вопросы и подтверждения ещё идут прямо через Context. Ошибки
// доставки от grammY ловим и для них, не принимая отказ ack за отказ экрана.
function isScreenDeliveryFailure(cause: unknown): boolean {
  return (
    cause instanceof ScreenDeliveryError ||
    cause instanceof HttpError ||
    (cause instanceof GrammyError && /^(send|editMessage)/.test(cause.method))
  );
}

function unexpectedOutcome(
  cause: unknown,
  fallback?: unknown,
  useCase?: ProductUseCase,
  meetupId?: string,
  identityId?: string,
): BoundaryOutcome {
  const outcome: BoundaryOutcome = {
    level: "error",
    message: "update handler failed",
    result: "error",
    error_category: "unexpected",
    error: errorText(cause),
  };
  if (useCase !== undefined) {
    outcome.use_case = useCase;
  }
  if (meetupId !== undefined) {
    outcome.meetup_id = meetupId;
  }
  if (identityId !== undefined) {
    outcome.identity_id = identityId;
  }
  const stack = errorStack(cause) ?? errorStack(fallback);
  if (stack !== undefined) {
    outcome.stack = stack;
  }
  return outcome;
}

function writeBoundary(
  logger: Logger,
  ctx: UpdateContext,
  outcome: BoundaryOutcome,
): void {
  const fields: LogFields = {
    operation: boundaryOperation(ctx),
    result: outcome.result,
  };
  if (ctx.requestId !== undefined && ctx.requestId !== "") {
    fields.request_id = ctx.requestId;
  }
  if (outcome.identity_id !== undefined) {
    fields.identity_id = outcome.identity_id;
  }
  if (ctx.startedAt !== undefined) {
    fields.duration_us = elapsedUs(ctx.startedAt);
  }
  if (outcome.use_case !== undefined) {
    fields.use_case = outcome.use_case;
  }
  if (outcome.meetup_id !== undefined) {
    fields.meetup_id = outcome.meetup_id;
  }
  if (ctx.postersRejected !== undefined) {
    fields.posters_error = ctx.postersRejected;
  }
  if (outcome.result === "error") {
    countFailure(outcome.error_category);
    markUpdateFailed(ctx.updateSpan, outcome.error_category);
    fields.error_category = outcome.error_category;
    fields.error = outcome.error;
    if (outcome.stack !== undefined) {
      fields.stack = outcome.stack;
    }
    if (outcome.grpc_code !== undefined) {
      fields.grpc_code = outcome.grpc_code;
    }
    if (outcome.reply_error !== undefined) {
      fields.reply_error = outcome.reply_error;
    }
  }
  // Отказ ответа на нажатие действие не отменяет, но в записи остаётся: без
  // него «кнопка крутилась до лимита» не отличить от обычного успеха.
  const answerError = ctx.waiting?.answerError;
  if (answerError !== undefined && fields.reply_error === undefined) {
    fields.reply_error = answerError;
  }
  logger[outcome.level](outcome.message, fields);
}

function boundaryOperation(ctx: UpdateContext): "message" | "callback_query" {
  return ctx.update.callback_query === undefined ? "message" : "callback_query";
}

function grpcFailureCategory(code: string): FailureCategory {
  switch (code) {
    case "PermissionDenied":
    case "Unauthenticated":
      return "authorization";
    case "DeadlineExceeded":
      return "timeout";
    case "Unavailable":
      return "dependency_unavailable";
    case "InvalidArgument":
    case "FailedPrecondition":
    case "Aborted":
    case "AlreadyExists":
    case "NotFound":
    case "OutOfRange":
      return "invariant";
    default:
      return "unexpected";
  }
}

function dependencyCategory(reason: string): FailureCategory {
  switch (reason) {
    case "forbidden":
      return "authorization";
    case "invalid":
    case "conflict":
      return "invariant";
    case "timeout":
      return "timeout";
    default:
      return "dependency_unavailable";
  }
}

function unavailableCategory(cause: unknown): FailureCategory {
  const text = errorText(cause).toLowerCase();
  return text.includes("deadline") || text.includes("timeout")
    ? "timeout"
    : "dependency_unavailable";
}

// Код gRPC — в том же виде, что у отказа Identity (`InvalidArgument`), а текст
// сервиса — в `error`: здесь его единственное место (PER-397).
function rejectionFields(cause: unknown): {
  error: string;
  grpc_code?: string;
} {
  return cause instanceof ConnectError
    ? { error: cause.rawMessage, grpc_code: Code[cause.code] }
    : { error: errorText(cause) };
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function errorStack(cause: unknown): string | undefined {
  if (
    cause instanceof Error &&
    cause.stack !== undefined &&
    cause.stack !== ""
  ) {
    return cause.stack;
  }
  return undefined;
}

function elapsedUs(started: bigint): number {
  return Number((process.hrtime.bigint() - started) / 1000n);
}
