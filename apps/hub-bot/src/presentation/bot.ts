import { randomUUID } from "node:crypto";
import { Code, ConnectError } from "@connectrpc/connect";
import {
  type AuctionResult,
  type AuctionScreenBody,
  type LotImagePort,
  parseAuctionCallback,
  type Viewer,
} from "@solguficky/auction-bot-ui";
import { Bot, GrammyError, InlineKeyboard, InputFile } from "grammy";
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
} from "../application/hub-access.js";
import {
  type CommunityToday,
  formatLocalMoment,
  formatSchedule,
  utcToday,
} from "../application/meetup-form.js";
import type {
  BroadcastAudience,
  ExecuteResult,
  FormField,
  MeetupAuthor,
  MeetupStateAction,
  Person,
  PublishMomentRetry,
} from "../application/types.js";
import { startExecuteRequest } from "../application/types.js";
import { type AuctionScreens, viewerOf } from "../auction/port.js";
import { countFailure, type FailureCategory } from "../failures.js";
import {
  type ApplicationAdministrator,
  type ApplicationCursor,
  type ApplicationModerator,
  type ApplicationQueueRead,
  type CommunityAdministrator,
  type CommunitySnapshot,
  type IdentityAdminResult,
  type IdentityResolver,
  type OrganizerResolver,
  type ReconsiderResult,
  type RefusedApplication,
  type RoleRequester,
  type SourceChannel,
  type SourceChannelAdministrator,
  type TelegramRecipientResolver,
  toResolveIdentityInput,
} from "../identity/port.js";
import type { LogFields, Logger } from "../logging.js";
import type {
  MeetupMaterialSource,
  MeetupSchedule,
  MeetupSnapshot,
} from "../meetups/port.js";
import type {
  CategoryState,
  MeetupCategory,
  NotificationCategory,
} from "../notifications/port.js";
import type { RpcMetadata } from "../rpc-metadata.js";
import type { Tracing } from "../tracing.js";
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
import type { NavScreen } from "./commands.js";
import { decideHubEntry, hubRoleRequest } from "./hub-entry.js";
import { createLotPhotos, type LotPhotos } from "./lot-photos.js";
import {
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
import {
  classifySendFailure,
  telegramTextLimit,
} from "./notification-message.js";
import {
  type CallbackAction,
  type CardCursor,
  type NotifiedMeetupCategory,
  type PublishOrigin,
  parseCallback,
  type QuestionStep,
  questionData,
  traceCallback,
  type WhenMode,
} from "./parse-callback.js";
import { parseUpdate } from "./parse-update.js";
import { RepliedKeyboardSchema } from "./schemas.js";
import {
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
import type { ScreenId } from "./screens/catalog.js";
import {
  type CommunityView,
  closeAccessConfirmScreen,
  communityScreen,
  viewOfOrigin,
} from "./screens/community.js";
import {
  cancelLabel,
  confirmKeyboard,
  escapeHtml,
  heading,
  menuOnly,
  type Parent,
  refusalText,
  retryLabel,
  toCard,
  toCommunity,
  toManage,
  toMaterials,
  toSourceChannels,
  toUpcoming,
  withNav,
} from "./screens/kit.js";
import {
  archiveScreen,
  cardScreen,
  draftScreen,
  editFieldsScreen,
  hiddenScreen,
  materialsScreen,
  materialTitle,
  meetupTitleLabel,
  stateConfirmScreen,
  statusScreen,
  upcomingScreen,
} from "./screens/meetup.js";
import { isAdministrator, manageScreen, menuScreen } from "./screens/menu.js";
import {
  categoryLabels,
  globalNotificationsScreen,
  meetupNotificationsScreen,
  toggleToast,
} from "./screens/notifications.js";
import { reconsiderConfirmScreen, refusedScreen } from "./screens/refused.js";
import {
  datePresetsScreen,
  scheduleTypePrompt,
} from "./screens/schedule-presets.js";
import {
  clearCallbackKeyboard,
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
  markUpdateFailed,
  type TracedContext,
  traceUpdate,
} from "./tracing.js";
import { startWaiting, type Waiting } from "./waiting.js";

// Среда Telegram: `test` уводит вызовы Bot API на выделенную тестовую
// инфраструктуру (ADR-046). Значения совпадают с опцией grammY, чтобы между
// переменной окружения и клиентом не появилось второго словаря.
export type TelegramEnvironment = "prod" | "test";

export type BotRuntime = {
  token: string;
  dispatcher: Dispatcher;
  identity: IdentityResolver &
    RoleRequester &
    Partial<CommunityAdministrator> &
    Partial<ApplicationAdministrator> &
    Partial<SourceChannelAdministrator> &
    Partial<ApplicationModerator> &
    Partial<OrganizerResolver> &
    Partial<TelegramRecipientResolver>;
  logger: Logger;
  tracing: Tracing;
  presentation?: "rich" | "plain";
  environment?: TelegramEnvironment;
  // Имя бота аукциона без «@»: экран каналов собирает по нему вторую ссылку
  // `s_<код>`. Нет — экран отдаёт только ссылку в бот хаба.
  auctionBotUsername?: string;
  // Сегодняшний день сообщества: по нему экран решает, в каком списке стоит
  // сходка, и называет год у даты. Тот же источник, что у формы.
  today?: CommunityToday;
  // Экраны аукциона сходки (PER-307): порты общего пакета поверх клиента
  // Auction. Нет — кнопки домена `auc` отвечают кадром недоступности.
  auction?: AuctionScreens;
  // Пояс, в котором человек читает дедлайн лота; тот же, что у Meetups.
  communityTimeZone?: string;
  // Память процесса: тесты подставляют свою, чтобы проверить рестарт.
  auctionParents?: AuctionParents;
  lotPhotos?: LotPhotos;
};

export const defaultTelegramEnvironment: TelegramEnvironment = "prod";

/**
 * Разбирает значение `HUB_BOT_ENVIRONMENT`. Отсутствие переменной — это
 * продакшн; любое неизвестное значение — `undefined`, а не молчаливый откат к
 * умолчанию: опечатка в переменной должна останавливать процесс, а не уводить
 * его в другую среду.
 */
export function parseTelegramEnvironment(
  raw: string | undefined,
): TelegramEnvironment | undefined {
  if (raw === undefined || raw === "") {
    return defaultTelegramEnvironment;
  }
  return raw === "prod" || raw === "test" ? raw : undefined;
}

const unavailableText = `Не получилось загрузить данные. Это на моей стороне.

Попробуй ещё раз через минуту.`;
// FAILED_PRECONDITION не говорит, что именно мешает: сходку отменили, пока
// экран висел, или у черновика нет названия для публикации. Кадр не утверждает
// ни то, ни другое, а ведёт к карточке, где видно текущее состояние (E-04).
const staleMeetupText =
  "Сейчас это действие недоступно. Открой сходку заново и проверь её состояние и название.";
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
// Категорию запросов доступа сервис показывает и даёт менять только
// администратору. Нажатие из старого уведомления или экрана настроек после
// потери роли получает `PERMISSION_DENIED`, и ответ называет причину, а не
// одно «недоступно».
const accessRequestsForbiddenText =
  "Запросы доступа настраивает только администратор.";
const managementForbiddenText = "Управление сходками доступно администратору.";
const communityForbiddenText =
  "Управлять составом сообщества может только администратор.";
const refusedForbiddenText =
  "Пересматривать отказы может только администратор.";
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
  | "enable_auction";
const questionTtlMs = 60 * 60 * 1_000;
const questionLimit = 1_000;
const publishMomentPrompt =
  "Когда опубликовать сходку? Напиши дату и время по времени сообщества: ДД.ММ.ГГГГ ЧЧ:ММ";
// Прошедший момент — отдельный отказ со своим текстом, а не «не разобрал
// дату»: ввод понят, но время уже наступило (E-02, открытый вопрос раскадровки).
const publishMomentRetryText: Record<PublishMomentRetry, string> = {
  unparsed: "Не получилось разобрать дату. Напиши, например: 21.09.2026 19:30",
  past: "Это время уже прошло или его нельзя назначить по времени сообщества. Назначь публикацию на момент в будущем: ДД.ММ.ГГГГ ЧЧ:ММ",
  conflict: `${conflictText}\n\n${publishMomentPrompt}`,
};

// То же над экраном выбора даты: там формат ввода не нужен, дату жмут кнопкой.
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
  telegramUserId: number;
  expiresAt: number;
};
type PendingUsername = {
  kind: "allowed-username";
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
type PendingInput =
  | PendingQuestion
  | PendingPublishMoment
  | PendingUsername
  | PendingChannelCode
  | PendingChannelLabel
  | PendingMaterialInput
  | PendingMaterialTitle
  | PendingBroadcastBody;

type UpdateContext = TracedContext & {
  requestId?: string;
  startedAt?: bigint;
  // Ожидание этого update: ответ на нажатие, индикатор и бюджет сервисов.
  waiting?: Waiting;
  // Кнопка стояла под следом: экран приходит новым сообщением.
  fresh?: boolean;
  // Сообщение нажатой кнопки удалено: править и снимать у него нечего.
  pressedGone?: boolean;
  // Сегодняшний день сообщества для этого update.
  today?: CommunityToday;
  // Telegram отверг карточку с постерами, и она ушла без них: причина едет в
  // запись границы, иначе деградация оператору не видна.
  postersRejected?: string;
  // Сходки аукционов, которые бот видел: родитель ленты лотов.
  auctionParents?: AuctionParents;
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
  // Среда передаётся всегда, а не только для `test`: умолчание живёт в одном
  // месте, и отсутствие поля не читается как «grammY решит сам».
  const bot = new Bot<UpdateContext>(runtime.token, {
    client: { environment: runtime.environment ?? defaultTelegramEnvironment },
  });
  const questions = new Map<string, PendingInput>();
  const auctionParents = runtime.auctionParents ?? createAuctionParents();
  const lotPhotos = runtime.lotPhotos ?? createLotPhotos();
  bot.use((ctx, next) => {
    const requestId = randomUUID();
    ctx.requestId = requestId;
    ctx.startedAt = process.hrtime.bigint();
    ctx.today = runtime.today ?? utcToday;
    ctx.auctionParents = auctionParents;
    // Спан открывается в первом middleware: всё, что ниже, включая вызовы Bot
    // API и gRPC, становится его потомком.
    return traceUpdate({ tracing: runtime.tracing, ctx, requestId, next });
  });
  bot.on("callback_query:data", (ctx) =>
    handleCallback(ctx, runtime, questions, lotPhotos),
  );
  bot.on("message", (ctx) => handleMessage(ctx, runtime, questions));
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
): Promise<void> {
  let outcome: BoundaryOutcome | undefined;
  let useCase: ProductUseCase | undefined;
  const waiting = startWaiting(ctx);
  ctx.waiting = waiting;
  try {
    const parsed = parseUpdate(ctx.update, ctx.me.username);
    // Команда меню, выбранная, пока клиент держит режим ответа на вопрос,
    // приходит ответом на него. Это команда, а не значение поля: разбор ответа
    // её не видит. Человек ушёл от вопроса, и брошенный вопрос удаляется:
    // иначе клиент держал бы режим ответа на него и дальше.
    const command = parsed.kind === "start" || parsed.kind === "screen";
    const replyId = command
      ? undefined
      : ctx.message?.reply_to_message?.message_id;
    // Сначала удаление: вычищенный по сроку вопрос карта уже не назовёт, и
    // его сообщение осталось бы держать режим ответа.
    if (command) await dropOpenQuestions(ctx, questions);
    removeExpiredQuestions(questions, Date.now());
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
      const denied = await denyHubAccessIfNeeded(ctx, identity, useCase, false);
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
      const denied = await denyHubAccessIfNeeded(ctx, identity, useCase, false);
      if (denied !== undefined) {
        outcome = denied;
        return;
      }
      if (!identity.person.globalRoles.includes("admin")) {
        await answered();
        await showRefusal(ctx, materialForbiddenText, menuOnly());
        outcome = materialForbiddenOutcome(identity.person, pending.meetupId);
        return;
      }
      if (pending.kind === "material-source") {
        const source = parseMaterialInput(ctx.message);
        if (source === undefined) {
          await askQuestion(
            ctx,
            questions,
            pending,
            "На это сообщение нельзя дать ссылку: источник скрыт или пересылка из него запрещена. Пришли ответом на это сообщение пересланное сообщение с доступным источником, фотографию или документ.",
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
        await askQuestion(
          ctx,
          questions,
          pending,
          "Название должно быть текстом от 1 до 200 символов. Напиши короткое название.",
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
      const denied = await denyHubAccessIfNeeded(ctx, identity, useCase, false);
      if (denied !== undefined) {
        outcome = denied;
        return;
      }
      if (!identity.person.globalRoles.includes("admin")) {
        await answered();
        await showRefusal(
          ctx,
          broadcastForbiddenText[audience.kind],
          menuOnly(),
        );
        outcome = broadcastForbiddenOutcome(identity.person, meetupId);
        return;
      }
      // Фото, стикер и прочее без текста — тот же пустой ввод: рассылка несёт
      // только текст автора, а вопрос остаётся ждать настоящего ответа.
      const checked = checkBroadcastBody(ctx.message?.text ?? "");
      if (checked.kind !== "ok") {
        await askQuestion(
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
      await sendBroadcastConfirmation(
        ctx,
        audience,
        checked.body,
        pending.meetupTitle,
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
      if (!isAdministrator(identity.person)) {
        await answered();
        await showRefusal(ctx, sourceChannelsForbiddenText, menuOnly());
        outcome = sourceChannelsForbiddenOutcome(identity.person);
        return;
      }
      const answer = ctx.message.text.trim();
      if (pending.kind === "channel-code") {
        // Код проверяется до вопроса о подписи: иначе отказ Identity пришёл бы
        // только после второго ответа, и подпись пришлось бы набирать заново.
        const valid = isSourceChannelCode(answer);
        await askQuestion(
          ctx,
          questions,
          valid
            ? {
                kind: "channel-label",
                code: answer,
                telegramUserId: pending.telegramUserId,
              }
            : bodyOf(pending),
          valid ? channelLabelPrompt : channelCodeRetryPrompt,
          replyId,
        );
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
        await askQuestion(
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
        await showRefusal(ctx, sourceChannelsForbiddenText, menuOnly());
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
          await askQuestion(
            ctx,
            questions,
            pending,
            "Это не похоже на ник Telegram. Пришли его ещё раз, с @ или без.",
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
      const denied = await denyHubAccessIfNeeded(ctx, identity, useCase, false);
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
        ...rpcCall(ctx, useCase),
      });
      await renderFormResult(
        ctx,
        result,
        questions,
        runtime.presentation ?? "rich",
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
        pending.kind === "channel-code" ||
        pending.kind === "channel-label" ||
        pending.kind === "publish-moment") &&
      ctx.message?.text === undefined
    ) {
      useCase =
        pending.kind === "allowed-username" ||
        pending.kind === "channel-code" ||
        pending.kind === "channel-label"
          ? "manage_community"
          : pending.kind === "meetup" && pending.mode === "create"
            ? "create_meetup"
            : "update_meetup";
      if (ctx.from?.id === pending.telegramUserId) {
        const asked =
          repliedMessage !== undefined && "text" in repliedMessage
            ? repliedMessage.text
            : undefined;
        await askQuestion(
          ctx,
          questions,
          bodyOf(pending),
          asked === undefined || asked.startsWith(textNeededHint)
            ? (asked ?? textNeededHint)
            : `${textNeededHint}\n${asked}`,
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
            : "Этот вопрос уже устарел. Открой актуальное меню и повтори действие.",
        askedStep?.kind === "material-title"
          ? withNav(new InlineKeyboard(), toMaterials(askedStep.token))
          : askedStep?.kind === "channel-label"
            ? withNav(new InlineKeyboard(), toSourceChannels)
            : menuOnly(),
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
    if (parsed.kind === "ignored") {
      outcome = {
        level: "info",
        message: "update ignored",
        result: "ok",
      };
      return;
    }
    const deepLink = "deepLink" in parsed ? parsed.deepLink : undefined;
    useCase =
      parsed.kind === "screen"
        ? navScreenUseCase(parsed.screen)
        : deepLink?.kind === "meetup"
          ? "view_meetup"
          : "find_meetup";
    // `/start` и `/menu` — вход на поверхность (ADR-060): вместо разрешения
    // личности бот зовёт `RequestRole` с кругом хаба, и Identity гасит белый
    // список или ставит заявку. Личность по-прежнему разрешается один раз на
    // update. Команда экрана — обычное действие: на ней только проверка роли.
    let identity: Person;
    let access: HubAccess;
    if (parsed.kind === "start") {
      const answered = await runtime.identity.requestRole(
        hubRoleRequest(parsed, deepLink),
        rpcCall(ctx, useCase),
      );
      if (answered.kind !== "answered") {
        outcome = await replyFailClosed(
          ctx,
          identityFailureOutcome(answered, useCase),
        );
        return;
      }
      const entry = decideHubEntry(answered);
      if (entry.kind === "unknown-outcome") {
        outcome = await replyFailClosed(ctx, {
          level: "error",
          message: "identity answered an unknown role request outcome",
          result: "error",
          use_case: useCase,
          identity_id: entry.identityId,
          error_category: "invariant",
          error: "role_request_outcome_unspecified",
        });
        return;
      }
      identity = entry.person;
      access = entry.access;
    } else {
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
      identity = {
        identityId: resolved.identityId,
        globalRoles: resolved.globalRoles,
      };
      access = decideHubAccess(resolved.globalRoles, resolved.blocked);
    }
    if (access !== "admitted") {
      outcome = await denyHubAccess(ctx, access, identity, useCase, false);
      return;
    }
    // Команда меню проходит тот же путь, что /start, — Identity и политику
    // поверхности, — и открывает тот же экран, что и кнопка с тем же именем.
    if (parsed.kind === "screen") {
      outcome = await openNavScreen(
        ctx,
        runtime,
        identity,
        parsed.screen,
        useCase,
      );
      return;
    }
    const result = await runtime.dispatcher.execute(
      deepLink?.kind === "meetup"
        ? {
            identity,
            intent: "view-meetup",
            meetupId: tokenToUuid(deepLink.payload.slice(2)),
            ...rpcCall(ctx, "view_meetup"),
          }
        : startExecuteRequest(identity, deepLink),
    );
    if (
      result.kind === "meetup-card" ||
      result.kind === "meetup-not-found" ||
      result.kind === "dependency-rejected" ||
      result.kind === "rejected"
    ) {
      await renderMeetupCard(
        ctx,
        result,
        false,
        runtime.presentation ?? "rich",
        identity.globalRoles.includes("admin"),
      );
      outcome = screenBoundary(result, {
        ok: ["meetup-card"],
        okMessage: "meetup card sent",
        rejectedMessage: "meetup card rejected",
        useCase,
      });
      return;
    }
    switch (result.kind) {
      case "message":
        await showScreen(ctx, menuScreen(identity, result.text));
        outcome = {
          level: "info",
          message: "start reply sent",
          result: "ok",
          use_case: "find_meetup",
        };
        return;
      case "ask":
      case "edit-ask":
      case "draft":
      case "confirm-past-schedule":
      case "published":
      case "ask-publish-moment":
      case "publication-scheduled":
      case "publication-unavailable":
      case "meetup-updated":
      case "meetup-state-changed":
      case "meetup-state-unchanged":
      case "edit-unavailable":
      case "conflict":
      case "material-attached":
      case "material-removed":
      case "broadcast-accepted":
      case "meetup-list":
      case "meetup-notification-settings":
      case "global-notification-settings":
      case "archived-meetup-list":
      case "auction-enabled":
      case "auction-refused":
        outcome = {
          level: "error",
          message: "unexpected form result",
          result: "error",
          use_case: "find_meetup",
          error_category: "unexpected",
          error: result.kind,
        };
        return;
      default: {
        const _exhaustive: never = result;
        outcome = {
          level: "error",
          message: "unhandled dispatcher result",
          result: "error",
          use_case: "find_meetup",
          error_category: "unexpected",
          error: String(_exhaustive),
        };
      }
    }
  } catch (cause) {
    if (outcome === undefined) {
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
    // Кнопки домена `auc` пишет и разбирает общий пакет аукциона (ADR-044):
    // до разбора хаба они не доходят.
    const data = ctx.callbackQuery?.data ?? "";
    if (isAuctionCallback(data)) {
      useCase = "view_auction";
      await dropOpenQuestions(
        ctx,
        questions,
        ctx.callbackQuery?.message?.message_id,
      );
      outcome = await handleAuctionCallback(ctx, runtime, data, lotPhotos);
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
    if (pressed.kind === "question") {
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
        "Не получилось прочитать эту кнопку. Открой актуальное меню.",
        menuOnly(),
      );
      return;
    }
    ctx.fresh = action.trace === true || ctx.pressedGone === true;
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
    const retryCallback =
      action.kind === "outdated"
        ? "v1:nav:hub"
        : (ctx.callbackQuery?.data ?? "v1:nav:hub");
    const identity = await resolvePerson(ctx, runtime, useCase, retryCallback);
    if (identity.kind === "failed") {
      outcome = identity.outcome;
      return;
    }
    const denied = await denyHubAccessIfNeeded(ctx, identity, useCase, true);
    if (denied !== undefined) {
      outcome = denied;
      return;
    }
    const person = identity.person;
    // Вход в управление и вопрос о нике видит только администратор, но старая
    // кнопка остаётся в чате. Меню сервиса за собой не имеет, а вопрос отказал бы
    // лишь после набора ответа, поэтому отказ приходит здесь. Остальные кнопки
    // меню, кроме объявления с его вопросом, бот пропускает: право на них решают
    // Meetups и Identity (PER-396). Отказ приходит правкой, как любой экран.
    if (
      (action.kind === "manage-menu" ||
        action.kind === "ask-allowed-username" ||
        action.kind === "source-channels" ||
        action.kind === "ask-source-channel") &&
      !isAdministrator(person)
    ) {
      await showRefusal(
        ctx,
        action.kind === "manage-menu"
          ? managementForbiddenText
          : action.kind === "ask-allowed-username"
            ? communityForbiddenText
            : sourceChannelsForbiddenText,
        menuOnly(),
      );
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
        // без версии проверяет это сама, так что здесь он ещё на месте:
        // подтверждение повторяется со свежей версией.
        const material = result.meetup.materials.find(
          (candidate) => candidate.id === materialId,
        );
        await showScreen(
          ctx,
          removeConfirmScreen({
            token: action.token,
            materialToken: action.materialToken,
            version: result.meetup.version,
            title: material === undefined ? "" : materialTitle(material, 1),
            note: `${conflictText} Проверь данные и подтверди действие ещё раз.`,
          }),
        );
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
      const canManageMaterials = person.globalRoles.includes("admin");
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
        await renderMaterialManagement(
          ctx,
          current.meetup,
          canManageMaterials,
          0,
          "Не прикреплено.",
        );
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
    if (
      action.kind === "community" ||
      action.kind === "community-pending" ||
      action.kind === "community-admitted" ||
      action.kind === "community-usernames"
    ) {
      const result = await renderCommunity(
        ctx,
        runtime,
        person,
        action.kind === "community"
          ? { kind: "root" }
          : action.kind === "community-pending"
            ? pendingView(action.cursor)
            : action.kind === "community-admitted"
              ? { kind: "admitted", page: action.page }
              : { kind: "usernames", page: action.page },
      );
      outcome = adminOutcome(result, person.identityId);
      return;
    }
    if (action.kind === "ask-block-member") {
      const result = await readCommunity(ctx, runtime, person);
      const origin = viewOfOrigin(action.origin);
      if (result.kind !== "ok") {
        await showCommunityRefusal(ctx, result, origin);
      } else {
        const identityId = tokenToUuid(action.token);
        const member = result.value.members.find(
          (candidate) => candidate.identityId === identityId,
        );
        if (member === undefined) {
          // Человека закрыли с другого экрана, пока этот был открыт.
          await waiting.answer("Этого человека уже нет в списке.");
          await showScreen(ctx, communityScreen(result.value, origin));
        } else {
          await showScreen(
            ctx,
            closeAccessConfirmScreen(member, action.origin),
          );
        }
      }
      outcome = adminOutcome(result, person.identityId);
      return;
    }
    if (
      action.kind === "refused-applications" ||
      action.kind === "ask-reconsider"
    ) {
      const result = await readRefused(ctx, runtime, person);
      if (result.kind !== "ok") {
        await showRefusedRefusal(ctx, result);
      } else if (action.kind === "refused-applications") {
        await showScreen(
          ctx,
          refusedScreen(result.value, action.page, communityToday(ctx)),
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
            refusedScreen(result.value, action.page, communityToday(ctx)),
          );
        } else {
          await showScreen(
            ctx,
            reconsiderConfirmScreen(application, action.page),
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
                ? "Это может только администратор."
                : "Не получилось сохранить. Попробуй ещё раз.";
      await waiting.answer(toast);
      await renderRefused(ctx, runtime, person, action.page);
      outcome = adminOutcome(result, person.identityId);
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
        queueCursor(action.cursor, "at"),
      );
      if (result.kind !== "ok") {
        await showApplicationRefusal(ctx, result);
      } else {
        const card = result.value.card;
        if (
          card?.application.applicationId === tokenToUuid(action.cursor.token)
        ) {
          await showScreen(ctx, declineConfirmScreen(card.application));
        } else {
          // Заявку решил другой администратор, пока карточка висела: исход
          // назовёт только решение, а вопрос о нём уже не к месту.
          await waiting.answer("Эту заявку уже решили.");
          await showApplicationQueue(ctx, result.value, true);
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
            ? "Это может только администратор."
            : "Решение не подтвердилось. Карточка перечитана заново.",
      );
      // Решённая заявка уступает место следующей. Неподтверждённое решение
      // перечитывает ту же: уйди очередь дальше, отказ выглядел бы принятым.
      await renderApplicationCard(
        ctx,
        runtime,
        person,
        queueCursor(action.cursor, result.kind === "ok" ? "after" : "at"),
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
      action.kind === "admit-member" ||
      action.kind === "block-member" ||
      action.kind === "remove-allowed-username"
    ) {
      const result =
        action.kind === "admit-member"
          ? runtime.identity.admit === undefined
            ? {
                kind: "unavailable" as const,
                cause: new Error("community administration is not configured"),
              }
            : await runtime.identity.admit(
                person,
                tokenToUuid(action.token),
                rpcCall(ctx, "manage_community"),
              )
          : action.kind === "block-member"
            ? runtime.identity.block === undefined
              ? {
                  kind: "unavailable" as const,
                  cause: new Error(
                    "community administration is not configured",
                  ),
                }
              : await runtime.identity.block(
                  person,
                  tokenToUuid(action.token),
                  rpcCall(ctx, "manage_community"),
                )
            : runtime.identity.removeAllowedUsername === undefined
              ? {
                  kind: "unavailable" as const,
                  cause: new Error(
                    "community administration is not configured",
                  ),
                }
              : await runtime.identity.removeAllowedUsername(
                  person,
                  action.username,
                  rpcCall(ctx, "manage_community"),
                );
      // Чем кончилось нажатие, говорит ответ на него: экран после действия
      // показывает уже следующего человека или ту же страницу.
      const toast =
        result.kind === "ok"
          ? result.value
            ? action.kind === "admit-member"
              ? "Человек допущен."
              : action.kind === "block-member"
                ? "Доступ закрыт."
                : "Ник убран."
            : "Состояние уже было актуальным."
          : result.kind === "invalid"
            ? "Изменение не сохранилось. Состав перечитан заново."
            : result.kind === "forbidden"
              ? "Это может только администратор."
              : "Не получилось сохранить. Попробуй ещё раз.";
      await waiting.answer(toast);
      // Отказ оставляет на экране того же человека: уйди очередь к следующему,
      // несохранённое решение выглядело бы принятым.
      const saved = result.kind === "ok";
      await renderCommunity(
        ctx,
        runtime,
        person,
        action.kind === "admit-member"
          ? pendingView(saved ? action.next : action.token)
          : action.kind === "block-member"
            ? saved || action.origin.kind === "admitted"
              ? viewOfOrigin(action.origin)
              : pendingView(action.token)
            : { kind: "usernames", page: action.page },
      );
      outcome = adminOutcome(result, person.identityId);
      // Допущенный ждёт на экране «заявка ждёт проверки» и сам о решении не
      // узнает. Пишем ему только о настоящей смене состояния: повторное
      // нажатие по уже допущенному второго сообщения не шлёт. Экран
      // администратора уходит раньше: сообщение — побочный результат, и
      // медленный Identity или Telegram не должны его задерживать.
      if (
        action.kind === "admit-member" &&
        result.kind === "ok" &&
        result.value
      ) {
        const failure = await notifyAdmitted(
          ctx,
          runtime,
          tokenToUuid(action.token),
          rpcCall(ctx, "manage_community"),
        );
        if (failure !== undefined) {
          outcome = {
            level: "warn",
            message: "admitted member not notified",
            result: "error",
            use_case: "manage_community",
            identity_id: person.identityId,
            error_category: failure.category,
            error: failure.error,
          };
        }
      }
      return;
    }
    if (action.kind === "home") {
      const result = await runtime.dispatcher.execute({
        identity: person,
        intent: "start",
      });
      if (result.kind === "message") {
        await showScreen(ctx, menuScreen(person, result.text));
        outcome = {
          level: "info",
          message: "start screen sent",
          result: "ok",
          use_case: useCase,
        };
      } else {
        outcome = unexpectedOutcome(
          `unexpected start result ${result.kind}`,
          undefined,
          useCase,
        );
      }
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
        person.globalRoles.includes("admin"),
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
      } else if (action.kind === "manage-publish") {
        // Публикация — единственное действие статуса, которое не перечитывает
        // сходку в юзкейсе: устаревшую кнопку разбираем по снимку выше, иначе
        // домен ответит FailedPrecondition и человек увидит кадр недоступности
        // вместо причины отказа.
        const result = await runtime.dispatcher.execute({
          identity: person,
          intent: "publish-meetup",
          meetupId,
          ...rpcCall(ctx, useCase),
        });
        await renderStateResult(ctx, result, runtime.presentation ?? "rich");
        outcome = screenBoundary(result, {
          ok: ["published"],
          okMessage: "meetup published",
          rejectedMessage: "meetup republish rejected",
          useCase,
          meetupId,
        });
        return;
      } else {
        // Все действия смены состояния живут в «Статусе», и отказ от
        // подтверждения возвращает туда.
        await showScreen(
          ctx,
          stateConfirmScreen({
            action: stateActionByCallback[action.kind],
            meetup,
            back: `v1:manage:status:${token}`,
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
      // «Другая дата»: экран выбора уступает место вопросу. Он удаляется, а не
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
      if (!person.globalRoles.includes("admin")) {
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
      await showFrame(
        ctx,
        "broadcast-result",
        "Не отправлено. Текст никуда не ушёл.",
        action.token === undefined
          ? withNav(new InlineKeyboard(), toManage)
          : exitToCard(action.token),
      );
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
      await showScreen(ctx, manageScreen(person, uuidToToken(createUuidV7())));
      outcome = {
        level: "info",
        message: "manage menu sent",
        result: "ok",
        use_case: useCase,
      };
      return;
    }
    if (action.kind === "create-meetup") {
      const meetupId = tokenToUuid(action.token);
      const result = await runtime.dispatcher.execute({
        identity: person,
        intent: "create-meetup",
        meetupId,
        ...rpcCall(ctx, useCase),
      });
      await renderFormResult(
        ctx,
        result,
        questions,
        runtime.presentation ?? "rich",
      );
      outcome = screenBoundary(result, {
        ok: ["ask", "draft", "published"],
        okMessage: "meetup form step sent",
        rejectedMessage: "meetup form step rejected",
        useCase,
        meetupId,
      });
      return;
    }
    if (action.kind === "publish-meetup") {
      const meetupId = tokenToUuid(action.token);
      const result = await runtime.dispatcher.execute({
        identity: person,
        intent: "publish-meetup",
        meetupId,
        ...rpcCall(ctx, useCase),
      });
      if (result.kind === "published" && result.repeated === true) {
        // Повтор (E-09) и устаревший предпросмотр (E-04): карточка по текущему
        // состоянию вместо второго «Сходка создана».
        await renderMeetupCard(
          ctx,
          cardFrom(result),
          true,
          runtime.presentation ?? "rich",
          true,
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
          menuOnly(),
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
            text: "Уведомления сходки",
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
          menuOnly(),
          "new",
        );
      } else {
        await showRefusal(
          ctx,
          result.kind === "dependency-rejected" && result.reason === "forbidden"
            ? forbiddenText
            : unavailableText,
          menuOnly(),
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
    // Подписка меняет карточку, а не открывает кадр настроек: действие живёт в
    // P-04, и человек обязан остаться там же с обновлённой кнопкой.
    if (action.kind === "notify-subscription") {
      const meetupId = tokenToUuid(action.token);
      const result = await runtime.dispatcher.execute({
        identity: person,
        intent: "set-meetup-subscription",
        meetupId,
        subscribed: action.subscribed,
        ...rpcCall(ctx, useCase),
      });
      if (result.kind === "meetup-card" || result.kind === "meetup-not-found") {
        // Заметка разовая: она отвечает на нажатие и при следующем открытии
        // карточки не повторяется, чтобы подписанному не читать её каждый раз.
        // Поэтому решение принимает этот обработчик, а не рендер карточки.
        const note =
          result.kind === "meetup-card" &&
          result.subscribed === true &&
          result.categories !== undefined
            ? subscriptionNote(result.categories)
            : undefined;
        await renderMeetupCard(
          ctx,
          result,
          true,
          runtime.presentation ?? "rich",
          person.globalRoles.includes("admin"),
          note,
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
    if (action.kind === "manage-auction") {
      outcome = await enableAuction(ctx, runtime, person, action.token);
      return;
    }
    const _exhaustive: never = action;
    outcome = unexpectedOutcome(
      `unhandled callback ${_exhaustive}`,
      undefined,
      useCase,
    );
  } catch (cause) {
    if (outcome === undefined) {
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
// состоянию, чужая роль — отказ по праву. Иначе кадр предлагал бы подтвердить
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
  if (!person.globalRoles.includes("admin")) {
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

// Подтверждение удаления: исчезнет только привязка, оригинал остаётся. `note`
// — почему вопрос задан снова.
function removeConfirmScreen(confirm: {
  token: string;
  materialToken: string;
  version: number;
  title: string;
  note?: string;
}): ShownScreen {
  return {
    id: "material-remove-confirm",
    text: [
      ...(confirm.note === undefined ? [] : [escapeHtml(confirm.note), ""]),
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
      danger: true,
    }),
    format: "HTML",
  };
}

// Файл уходит тем видом, каким записан. Второй вид остаётся запасным: у файла,
// прикреплённого до PER-443, вид не записан, и фото среди них читается
// документом.
async function sendStoredMaterialFile(
  ctx: UpdateContext,
  source: Extract<MeetupMaterialSource, { kind: "file" }>,
  title: string,
): Promise<{ kind: "sent" } | { kind: "failed"; cause: unknown }> {
  const other = { caption: title };
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

// Кадры рассылки. Числа получателей в них нет намеренно: `BroadcastAccepted`
// подтверждает приём, а не доставку (docs/architecture/integration.md), и кадр
// называет круг адресатов словами, а не цифрой, которую прочли бы как «дошло».
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

// Предпросмотр — сам текст отдельным сообщением, без заголовка и разметки:
// ровно тот текст автора, что уйдёт получателям (заголовок и кнопки канал
// добавит при доставке), и ровно то, что кнопка подтверждения потом прочтёт
// обратно. Кадр подтверждения отвечает на него и несёт ключ рассылки.
async function sendBroadcastConfirmation(
  ctx: UpdateContext,
  audience: BroadcastAudience,
  body: string,
  meetupTitle: string | undefined,
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
    `${heading(question)}\n\n${escapeHtml(recipients)}\n\n${broadcastIrreversibleText}`,
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
        danger: true,
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

function pendingView(cursor: string | undefined): CommunityView {
  return cursor === undefined
    ? { kind: "pending" }
    : { kind: "pending", cursor: tokenToUuid(cursor) };
}

function readCommunity(
  ctx: UpdateContext,
  runtime: BotRuntime,
  actor: Person,
): Promise<IdentityAdminResult<CommunitySnapshot>> {
  return runtime.identity.community === undefined
    ? Promise.resolve({
        kind: "unavailable" as const,
        cause: new Error("community administration is not configured"),
      })
    : runtime.identity.community(actor, rpcCall(ctx, "manage_community"));
}

// Отказ возвращает на уровень выше экрана, который не открылся: с корня — в
// управление, с подэкрана — в состав.
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
      view.kind === "root" ? toManage : toCommunity,
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
  const result = await readCommunity(ctx, runtime, actor);
  if (result.kind !== "ok") {
    await showCommunityRefusal(ctx, result, view);
    return result;
  }
  await showScreen(ctx, communityScreen(result.value, view, notice));
  return result;
}

function readRefused(
  ctx: UpdateContext,
  runtime: BotRuntime,
  actor: Person,
): Promise<IdentityAdminResult<readonly RefusedApplication[]>> {
  return runtime.identity.refusedApplications === undefined
    ? Promise.resolve({
        kind: "unavailable" as const,
        cause: new Error("application administration is not configured"),
      })
    : runtime.identity.refusedApplications(
        actor,
        rpcCall(ctx, "manage_community"),
      );
}

// Список открывается из управления, туда и возвращает отказ.
function showRefusedRefusal(
  ctx: UpdateContext,
  result: Exclude<IdentityAdminResult<unknown>, { kind: "ok" }>,
): Promise<void> {
  return showRefusal(
    ctx,
    result.kind === "forbidden" ? refusedForbiddenText : unavailableText,
    withNav(new InlineKeyboard(), toManage),
  );
}

async function renderRefused(
  ctx: UpdateContext,
  runtime: BotRuntime,
  actor: Person,
  page: number,
): Promise<void> {
  const result = await readRefused(ctx, runtime, actor);
  if (result.kind !== "ok") {
    await showRefusedRefusal(ctx, result);
    return;
  }
  await showScreen(ctx, refusedScreen(result.value, page, communityToday(ctx)));
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

// Курсор очереди из кнопки. `after` — следующая заявка за этой. `at` — эта же,
// если она ещё открыта: тот же момент и предшествующий UUID, и сравнение
// «(момент, id) больше курсора» начинает ровно с неё. Момент на миллисекунду
// раньше тут не годится: у двух заявок одной миллисекунды он вернул бы первую.
function queueCursor(
  cursor: CardCursor,
  from: "after" | "at",
): ApplicationCursor {
  const applicationId = tokenToUuid(cursor.token);
  return {
    createdAtMs: cursor.createdAtMs,
    applicationId:
      from === "after" ? applicationId : previousUuid(applicationId),
  };
}

function previousUuid(uuid: string): string {
  const value = BigInt(`0x${uuid.replaceAll("-", "")}`);
  // Нулевого UUIDv7 не бывает; на нём курсор просто начнёт с момента.
  const hex = (value === 0n ? 0n : value - 1n).toString(16).padStart(32, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function readApplicationQueue(
  ctx: UpdateContext,
  runtime: BotRuntime,
  actor: Person,
  after: ApplicationCursor | undefined,
): Promise<IdentityAdminResult<ApplicationQueueRead>> {
  return runtime.identity.readApplicationQueue === undefined
    ? Promise.resolve({
        kind: "unavailable" as const,
        cause: new Error("application moderation is not configured"),
      })
    : runtime.identity.readApplicationQueue(
        actor,
        after,
        rpcCall(ctx, "manage_community"),
      );
}

// Карточка открывается из управления, туда и возвращает отказ.
function showApplicationRefusal(
  ctx: UpdateContext,
  result: Exclude<IdentityAdminResult<unknown>, { kind: "ok" }>,
): Promise<void> {
  return showRefusal(
    ctx,
    result.kind === "forbidden" ? applicationsForbiddenText : unavailableText,
    withNav(new InlineKeyboard(), toManage),
  );
}

async function showApplicationQueue(
  ctx: UpdateContext,
  read: ApplicationQueueRead,
  afterCursor: boolean,
): Promise<void> {
  await showScreen(
    ctx,
    read.card === undefined
      ? applicationQueueEndScreen(read.total, afterCursor)
      : applicationCardScreen(read.card, read.total, Date.now()),
  );
}

async function renderApplicationCard(
  ctx: UpdateContext,
  runtime: BotRuntime,
  actor: Person,
  after: ApplicationCursor | undefined,
): Promise<IdentityAdminResult<ApplicationQueueRead>> {
  const result = await readApplicationQueue(ctx, runtime, actor, after);
  if (result.kind !== "ok") {
    await showApplicationRefusal(ctx, result);
    return result;
  }
  await showApplicationQueue(ctx, result.value, after !== undefined);
  return result;
}

// Сообщение о допуске — побочный результат действия администратора, а не его
// часть: допуск уже сохранён, поэтому отказ Identity или Telegram его не
// отменяет и возвращается причиной для записи границы. Получатель, которого
// нет, который заблокирован или сам заблокировал бота, — ожидаемый исход, как
// в доставке уведомлений: писать ему некуда, и сбоем это не считается.
// Повтора нет: у бота нет хранилища под отложенное сообщение (ADR-030), а
// человек и без него попадает в продукт следующим /start.
async function notifyAdmitted(
  ctx: UpdateContext,
  runtime: BotRuntime,
  identityId: string,
  meta: RpcMetadata,
): Promise<{ category: FailureCategory; error: string } | undefined> {
  const resolver = runtime.identity.resolveTelegramUserId;
  if (resolver === undefined) {
    return {
      category: "unexpected",
      error: "telegram recipient resolution is not configured",
    };
  }
  const recipient = await resolver(identityId, meta);
  if (recipient.kind === "not-found" || recipient.kind === "blocked") {
    return undefined;
  }
  if (recipient.kind === "unavailable") {
    return {
      category: "dependency_unavailable",
      error: `recipient ${errorText(recipient.cause)}`,
    };
  }
  if (recipient.kind === "rejected") {
    return { category: "unexpected", error: `recipient ${recipient.code}` };
  }
  try {
    // Личный чат с человеком имеет id самого человека, как в доставке.
    await ctx.api.sendMessage(
      Number(recipient.telegramUserId),
      "Доступ открыт: теперь тебе видны сходки сообщества.",
      {
        ...screenMark("access-opened"),
        reply_markup: new InlineKeyboard().text(
          "Ближайшие сходки",
          traceCallback("v1:nav:hub"),
        ),
      },
    );
    return undefined;
  } catch (cause) {
    const sent = classifySendFailure(cause);
    if (sent.kind === "bot-blocked") return undefined;
    return {
      category:
        sent.kind === "rejected" ? "unexpected" : "dependency_unavailable",
      error: errorText(cause),
    };
  }
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

async function renderMeetupList(
  ctx: UpdateContext,
  result: Awaited<ReturnType<Dispatcher["execute"]>>,
  page = 0,
): Promise<void> {
  if (result.kind === "meetup-list") {
    await showScreen(
      ctx,
      upcomingScreen(result.meetups, page, communityToday(ctx)),
    );
    return;
  }
  if (result.kind === "dependency-rejected" || result.kind === "rejected") {
    await renderMeetupListFailure(ctx, "v1:nav:hub");
  }
}

// «Ближайшие сходки» и «Скрытые сходки» читают один и тот же список, поэтому и
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
      hiddenScreen(result.meetups, page, communityToday(ctx)),
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
  id: "refusal" | "broadcast-result" | "no-access",
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

/** Выход к карточке сходки: `[‹ Сходка] [Меню]`. */
function exitToCard(token: string): InlineKeyboard {
  return withNav(new InlineKeyboard(), toCard(token));
}

/** Повтор после сбоя и выход: `[Повторить]` и `[Меню]`. */
function exitRetry(data: string): InlineKeyboard {
  return menuOnly(new InlineKeyboard().text(retryLabel, data));
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

// Экраны, куда ведут и кнопки навигации, и команды меню. Кнопка правит своё
// сообщение, команда отвечает новым — это решает editScreen, а не вызывающий.
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
      await renderMeetupList(ctx, result, page);
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
      await renderNotificationSettings(ctx, result, "v1:notify:global");
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

function navScreenUseCase(screen: NavScreen): ProductUseCase {
  switch (screen) {
    case "hub":
    case "archive":
      return "find_meetup";
    case "notify-global":
      return "manage_notifications";
    default: {
      const _exhaustive: never = screen;
      return _exhaustive;
    }
  }
}

const meetupCategoryOrder: readonly MeetupCategory[] = [
  "changes",
  "material",
  "reminder",
  "organizer",
];

// Перечень строится по действующим значениям, а не по умолчаниям продукта:
// человек, который раньше включил напоминание или выключил материалы, иначе
// прочёл бы неправду. Напоминание названо отдельно, потому что по умолчанию
// оно выключено и без подсказки его не найти. Снимок без какой-то категории
// заметки не даёт: пропуск неотличим от «выключено», и «ничего не приходит»
// на пустом ответе было бы выдумкой.
function subscriptionNote(
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
    return "Подписка включена, но по этой сходке сейчас ничего не приходит: все категории выключены. Включить их можно в «Уведомлениях сходки».";
  }
  const lines = [
    `Подписка включена. По этой сходке будут приходить: ${enabled.join(", ")}.`,
  ];
  if (known.some((state) => state.category === "reminder" && !state.enabled)) {
    lines.push(
      "Напоминание перед началом выключено, включить его можно в «Уведомлениях сходки».",
    );
  }
  return lines.join(" ");
}

// Карточка, которую представление собирает из результата команды — правки,
// публикации, смены статуса, — несёт того же автора, что и карточка просмотра.
function cardFrom(result: {
  meetup: MeetupSnapshot;
  author?: MeetupAuthor;
}): Extract<ExecuteResult, { kind: "meetup-card" }> {
  return result.author === undefined
    ? { kind: "meetup-card", meetup: result.meetup }
    : { kind: "meetup-card", meetup: result.meetup, author: result.author };
}

// «Включить аукцион» на карточке сходки (PER-307). Право решает Auction,
// спрашивая Meetups; край кнопку только показывает администратору. Ключ
// команды рождается на нажатие, а аукцион сходки один при любом их числе:
// повторное нажатие отвечает тем же аукционом.
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
    const note = result.alreadyExisted
      ? "Аукцион у этой сходки уже включён."
      : "Аукцион включён. Лоты появятся в нём, когда их добавят.";
    if (result.card === undefined) {
      // Аукцион включён, а карточку перечитать не вышло: человек узнаёт об
      // итоге и открывает сходку сам, а не видит сбой и не жмёт повтор.
      await showRefusal(ctx, note, exitToCard(token));
    } else {
      await renderMeetupCard(
        ctx,
        result.card,
        true,
        runtime.presentation ?? "rich",
        isAdministrator(person),
        note,
      );
    }
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
    await showRefusal(ctx, forbiddenText, exitToCard(token));
    return {
      level: "warn",
      message: "auction enabling rejected",
      result: "error",
      use_case: useCase,
      meetup_id: meetupId,
      identity_id: person.identityId,
      error_category: "authorization",
      error: "not_meetup_administrator",
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
    forbidden ? exitToCard(token) : exitRetry(`v1:manage:auction:${token}`),
  );
  return screenBoundary(result, {
    ok: [],
    okMessage: "auction enabled",
    rejectedMessage: "auction enabling rejected",
    useCase,
    meetupId,
  });
}

// Кнопка аукциона сходки (PER-307). Политика хаба идёт первой — кадры P-14 и
// P-17, как у любой кнопки, — затем шлюз пакета с поверхностью `hub`. Отказ
// Auction — кадр недоступности с повтором: экран не показывается без чтения.
async function handleAuctionCallback(
  ctx: UpdateContext,
  runtime: BotRuntime,
  data: string,
  lotPhotos: LotPhotos,
): Promise<BoundaryOutcome> {
  const useCase: ProductUseCase = "view_auction";
  const identity = await resolvePerson(ctx, runtime, useCase, data);
  if (identity.kind === "failed") return identity.outcome;
  const denied = await denyHubAccessIfNeeded(ctx, identity, useCase, true);
  if (denied !== undefined) return denied;
  const person = identity.person;
  if (runtime.auction === undefined) {
    await showRefusal(ctx, unavailableText, menuOnly());
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
  let result: AuctionResult;
  try {
    result = await hubTradeCallback({
      ports: {
        // Личность уже разрешена этим update: шлюз её не перечитывает.
        identity: { resolveIdentity: () => Promise.resolve(resolved) },
        auction: ports.auction,
      },
      identity: resolved,
      data,
    });
  } catch (cause) {
    // Лот, которого Auction не знает или который смотрящему не виден, —
    // NOT_FOUND у `GetLot`, им начинаются и карточка, и хронология. Лента на
    // аукцион, которого нет, отвечает пустой страницей, так что её отказ —
    // всегда сбой.
    const parsed = parseAuctionCallback(data);
    const notFound =
      cause instanceof ConnectError &&
      cause.code === Code.NotFound &&
      parsed.ok &&
      (parsed.intent.kind === "lot" || parsed.intent.kind === "history");
    await showRefusal(
      ctx,
      notFound ? "Лот не найден или больше недоступен." : unavailableText,
      notFound ? menuOnly() : exitRetry(data),
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
      await showFrame(
        ctx,
        "no-access",
        hubAccessText(access, person.identityId, ctx.from?.username),
        new InlineKeyboard(),
      );
      return hubAccessOutcome(access, person.identityId, useCase);
    }
    case "unreadable":
      await showRefusal(
        ctx,
        "Не получилось прочитать эту кнопку. Открой актуальное меню.",
        menuOnly(),
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
  const view: AuctionView = {
    body: result.body,
    feedParent: feedParentOf(ctx, result.body),
    presentation: runtime.presentation ?? "rich",
    timeZone: runtime.communityTimeZone ?? "UTC",
    today: communityToday(ctx),
  };
  const photoNote = await deliverAuctionScreen(ctx, {
    view,
    lotPhotos,
    image: ports.image,
    viewer: viewerOf(person),
    logger: runtime.logger,
  });
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

// Родитель ленты: сходка аукциона, если бот её видел, иначе «Ближайшие»
// (ADR-030, дополнение 2026-10-04).
function feedParentOf(ctx: UpdateContext, body: AuctionScreenBody): Parent {
  for (const block of body.blocks) {
    if (block.kind !== "feed") continue;
    const meetupId = ctx.auctionParents?.meetupOf(block.auctionId);
    return meetupId === undefined ? toUpcoming : toCard(uuidToToken(meetupId));
  }
  return toUpcoming;
}

// Доставка экрана аукциона (дизайн-код, «Показ фото лота»). Лента и карточка
// делят одно сообщение: rich-карточка правится на месте в обе стороны. Фото —
// из кэша `file_id` либо загрузкой байтов из Auction; загрузка — тот же вызов
// Bot API, что доставляет карточку, и обрывать его по времени нельзя.
// Изображение не получилось — карточка уходит без фото, а не пропадает.
// Возвращает пометку о деградации для записи границы.
async function deliverAuctionScreen(
  ctx: UpdateContext,
  input: {
    view: AuctionView;
    lotPhotos: LotPhotos;
    image: LotImagePort;
    viewer: Viewer;
    logger: Logger;
  },
): Promise<string | undefined> {
  const { lotPhotos } = input;
  const warn = (message: string, cause: unknown) =>
    input.logger.warn(message, {
      ...(ctx.requestId === undefined ? {} : { request_id: ctx.requestId }),
      error: errorText(cause),
    });
  const shown = auctionScreen(input.view);
  const key = shown.image;
  if (key === undefined) {
    await showScreen(ctx, shown.screen);
    return undefined;
  }
  const withPhoto = (photo: ScreenPhoto) =>
    auctionScreen({ ...input.view, photo }).screen;
  const cached = lotPhotos.get(key);
  if (cached?.kind === "rejected") {
    await showScreen(ctx, shown.screen);
    return "lot image skipped: rejected earlier";
  }
  if (cached?.kind === "file") {
    const photo = withPhoto({ id: lotPhotoId, fileId: cached.fileId });
    try {
      await showScreen(ctx, { ...photo, strict: true });
      return undefined;
    } catch (cause) {
      if (!rejectedFile(cause)) {
        // Отказ не про файл — сообщение не правится или Telegram моргнул:
        // запись остаётся, а экран идёт обычным путём края с тем же фото.
        await showScreen(ctx, photo);
        return undefined;
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
    await showScreen(ctx, shown.screen);
    return "lot image unavailable";
  }
  // Ключ — версия самих байтов: изображение могли сменить между чтением
  // карточки и загрузкой, и старое фото не ляжет под новым ключом.
  const uploaded = { lotId: key.lotId, version: bytes.version };
  const upload = withPhoto({
    id: lotPhotoId,
    upload: new InputFile(bytes.content, "lot"),
  });
  const remember = (sent: unknown) => {
    const fileId = photoFileId(sent);
    if (fileId !== undefined) {
      lotPhotos.set(uploaded, { kind: "file", fileId });
    }
  };
  try {
    remember(await showScreen(ctx, { ...upload, strict: true }));
    return undefined;
  } catch (cause) {
    if (cause instanceof GrammyError && notEditable(cause.description)) {
      // Сообщение не правится — карточка уходит новым сообщением с той же
      // загрузкой: изображение тут ни при чём.
      remember(await showScreen(ctx, { ...upload, delivery: "new" }));
      return undefined;
    }
    // Telegram отверг сам запрос (400) — эта версия до рестарта больше не
    // грузится. Обрыв соединения, лимит и сбой Telegram отметки не
    // оставляют: следующее открытие лота грузит изображение снова. В обоих
    // случаях сообщение правится в карточку без фото обычной правкой.
    if (cause instanceof GrammyError && cause.error_code === 400) {
      lotPhotos.set(uploaded, { kind: "rejected" });
    }
    warn("lot image rejected by Telegram", cause);
    await showScreen(ctx, shown.screen);
    return "lot image rejected";
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
      withNav(new InlineKeyboard(), toUpcoming),
      edit ? undefined : "new",
    );
    return;
  }
  if (result.kind === "meetup-card") {
    // Пара «аукцион — сходка» запоминается с каждой карточки, где аукцион
    // виден: из неё лента лотов берёт свой возврат «‹ Сходка».
    if (result.auction?.kind === "open") {
      ctx.auctionParents?.remember(result.auction.auctionId, result.meetup.id);
    }
    const view = {
      meetup: result.meetup,
      author: result.author,
      subscribed: result.subscribed,
      auction: result.auction,
      manageable,
      note,
      presentation,
      today: communityToday(ctx),
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
      if (
        card.media === undefined ||
        !(cause instanceof GrammyError) ||
        cause.error_code !== 400
      ) {
        throw cause;
      }
      ctx.postersRejected = cause.description;
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
  return category === "access" ? accessRequestsForbiddenText : forbiddenText;
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
    await showRefusal(ctx, forbidden, menuOnly());
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
    await showScreen(
      ctx,
      stateConfirmScreen({
        action: result.action,
        meetup: result.meetup,
        back: `v1:manage:status:${uuidToToken(result.meetup.id)}`,
        note: `${conflictText} Проверь данные и подтверди действие ещё раз.`,
      }),
    );
    return;
  }
  const text =
    result.kind === "dependency-rejected" && result.reason === "invalid"
      ? invalidMeetupText(result)
      : result.kind === "dependency-rejected" && result.reason === "forbidden"
        ? forbiddenText
        : unavailableText;
  await showRefusal(ctx, text, menuOnly());
}

async function denyHubAccessIfNeeded(
  ctx: UpdateContext,
  identity: { person: Person; blocked: boolean },
  useCase: ProductUseCase | undefined,
  edit: boolean,
): Promise<BoundaryOutcome | undefined> {
  const access = decideHubAccess(identity.person.globalRoles, identity.blocked);
  if (access === "admitted") {
    return undefined;
  }
  return denyHubAccess(ctx, access, identity.person, useCase, edit);
}

async function denyHubAccess(
  ctx: UpdateContext,
  access: Exclude<HubAccess, "admitted">,
  person: Person,
  useCase: ProductUseCase | undefined,
  edit: boolean,
): Promise<BoundaryOutcome> {
  const text = hubAccessText(access, person.identityId, ctx.from?.username);
  await showFrame(
    ctx,
    "no-access",
    text,
    new InlineKeyboard(),
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
      retryCallback === undefined ? menuOnly() : exitRetry(retryCallback),
    );
    return {
      kind: "failed",
      outcome: identityFailureOutcome(resolved, useCase),
    };
  }
  return {
    kind: "resolved",
    person: {
      identityId: resolved.identityId,
      globalRoles: resolved.globalRoles,
    },
    blocked: resolved.blocked,
  };
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
    // Отказ Meetups причины не называет, поэтому рядом с ним стоит сам вопрос
    // поля: без него человек теряет формат даты и не знает, что вводить.
    const ask =
      "rejected" in result && result.error !== undefined
        ? `${result.error}\n${formPrompts[result.field]}`
        : (result.error ?? formPrompts[result.field]);
    const prompt =
      result.kind === "edit-ask" ? `Сейчас: ${currentValue}\n${ask}` : ask;
    await askQuestion(
      ctx,
      questions,
      {
        kind: "meetup",
        mode: result.kind === "edit-ask" ? "edit" : "create",
        field: result.field,
        meetupId: result.meetup.id,
        telegramUserId: ctx.from?.id ?? 0,
      },
      prompt,
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
    // вводят заново, уже по актуальным данным. Режим вопроса сохраняет ту же
    // форму (создание или редактирование), в которой конфликт случился.
    await askQuestion(
      ctx,
      questions,
      {
        kind: "meetup",
        mode: result.editing === true ? "edit" : "create",
        field: result.field,
        meetupId: stored.id,
        telegramUserId: ctx.from?.id ?? 0,
      },
      `${result.editing === true ? "Сейчас: " : ""}${lines.join("\n")}\n\n${formPrompts[result.field]}`,
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
      text: `${heading("Сохранить прошедшую дату?")}\n\nДата ${value} уже прошла. Сходка с этой датой сразу уйдёт в архив и не появится в «Ближайших сходках».`,
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
      result.archived === true
        ? "Изменение сохранено. Дата сходки уже прошла, поэтому она в архиве, а не в «Ближайших сходках»."
        : "Изменение сохранено.",
    );
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
    const prompt =
      result.retry === undefined
        ? publishMomentPrompt
        : publishMomentRetryText[result.retry];
    await askQuestion(
      ctx,
      questions,
      {
        kind: "publish-moment",
        meetupId: result.meetup.id,
        origin,
        telegramUserId: ctx.from?.id ?? 0,
      },
      `${current}${prompt}`,
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
    // ответ не обещает её в списке «Ближайших», где её нет (PER-342).
    const published =
      result.archived === true
        ? "Сходка опубликована. Её дата уже прошла, поэтому она сразу в архиве, а не в «Ближайших сходках»."
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
      menuOnly(),
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
type PendingBody = PendingInput extends infer Each
  ? Each extends PendingInput
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
    case "channel-code":
      return { kind: "channel-code" };
    case "channel-label":
      return { kind: "channel-label" };
    default: {
      const _exhaustive: never = pending;
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
    case "channel-code":
      return { kind: "channel-code", telegramUserId, expiresAt };
    case "channel-label":
      return undefined;
    default: {
      const _exhaustive: never = step;
      return _exhaustive;
    }
  }
}

// Действие экрана: всё, что несёт кнопка, кроме самой «Отмены» под вопросом, —
// она сводится к действию экрана, с которого вопрос задан.
type ScreenAction = Exclude<CallbackAction, { kind: "question" }>;

// Куда возвращает «Отмена»: экран, с которого вопрос задан.
function cancelTarget(step: QuestionStep): ScreenAction {
  switch (step.kind) {
    case "field":
      // Вопрос формы создания задан с черновика, точечной правки — с карточки.
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
    case "channel-code":
    case "channel-label":
      return { kind: "source-channels", page: 0 };
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
): Promise<void> {
  if (ctx.callbackQuery !== undefined && ctx.pressedGone !== true) {
    await clearCallbackKeyboard(ctx);
  }
  const keyboard = new InlineKeyboard().text(
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

/** Момент публикации выбирают в режимах `p` и `d`; остальные — дата сходки. */
function publishOriginOf(mode: WhenMode): PublishOrigin | undefined {
  return mode === "p" ? "status" : mode === "d" ? "draft" : undefined;
}

// Тело ожидаемого ответа из записи карты: срок жизни вопрос получит заново.
function bodyOf(pending: PendingInput): PendingBody {
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

function communityToday(ctx: UpdateContext) {
  return (ctx.today ?? utcToday)();
}

function createUuidV7(): string {
  const bytes = Buffer.from(randomUUID().replaceAll("-", ""), "hex");
  let time = BigInt(Date.now());
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(time & 0xffn);
    time >>= 8n;
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
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
    | "hub"
    | "archive"
    | "outdated"
    | "view-meetup"
    | "manage-menu"
    | "manage-hidden"
    | "community"
    | "community-pending"
    | "community-admitted"
    | "community-usernames"
    | "ask-allowed-username"
    | "admit-member"
    | "ask-block-member"
    | "block-member"
    | "remove-allowed-username"
    | "refused-applications"
    | "ask-reconsider"
    | "reconsider"
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
    | "manage-auction"
    | "manage-publish"
    | "manage-unpublish"
    | "manage-confirm-unpublish"
    | "manage-cancel"
    | "manage-confirm-cancel"
    | "notify-global"
    | "notify-set-global"
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
      return "view_meetup";
    case "manage-hidden":
      return "find_meetup";
    case "create-meetup":
    case "manage-draft":
    case "publish-meetup":
    case "manage-menu":
      return "create_meetup";
    case "manage-edit":
    case "manage-field":
    case "manage-status":
    case "manage-publish":
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
    case "community-pending":
    case "community-admitted":
    case "community-usernames":
    case "ask-allowed-username":
    case "admit-member":
    case "ask-block-member":
    case "block-member":
    case "remove-allowed-username":
      return "manage_community";
    case "notify-global":
    case "notify-set-global":
    case "notify-disable-global":
    case "notify-disable-meetup":
    case "notify-settings":
    case "notify-subscription":
    case "notify-set-meetup":
      return "manage_notifications";
    case "manage-auction":
      return "enable_auction";
    case "home":
    case "hub":
    case "archive":
    case "outdated":
      return "find_meetup";
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
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

// Отказ самого ответа человеку нельзя терять: раньше outcome присваивался до
// await, поэтому catch видел его непустым и 403 от Bot API не попадал ни в
// запись границы, ни в bot.catch.
async function replyFailClosed(
  ctx: UpdateContext,
  outcome: BoundaryOutcome,
): Promise<BoundaryOutcome> {
  try {
    await showRefusal(ctx, unavailableText, menuOnly());
    return outcome;
  } catch (cause) {
    if (outcome.result === "error") {
      return { ...outcome, reply_error: errorText(cause) };
    }
    return outcome;
  }
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
