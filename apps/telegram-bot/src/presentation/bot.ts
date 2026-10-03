import { randomUUID } from "node:crypto";
import { Code, ConnectError } from "@connectrpc/connect";
import { Bot, InlineKeyboard } from "grammy";
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
import { countFailure, type FailureCategory } from "../failures.js";
import {
  type CommunityAdministrator,
  type CommunitySnapshot,
  type IdentityAdminResult,
  type IdentityResolver,
  type OrganizerResolver,
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
import { parseBroadcastPreview } from "./broadcast-input.js";
import type { NavScreen } from "./commands.js";
import {
  parseEditQuestion,
  parsePublishMomentQuestion,
} from "./edit-question.js";
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
  type NotifiedMeetupCategory,
  parseCallback,
  type QuestionStep,
  questionData,
  traceCallback,
} from "./parse-callback.js";
import { parseUpdate } from "./parse-update.js";
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
  refusalText,
  retryLabel,
  toCard,
  toCommunity,
  toManage,
  toMaterials,
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
import {
  dayPresetKeyboard,
  type ScheduleQuestion,
  schedulePrompt,
  timePresetKeyboard,
  timePresetText,
} from "./screens/schedule-presets.js";
import {
  clearCallbackKeyboard,
  type ShownScreen,
  screenMark,
  showScreen,
} from "./screens/show.js";
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
    Partial<CommunityAdministrator> &
    Partial<OrganizerResolver> &
    Partial<TelegramRecipientResolver>;
  logger: Logger;
  tracing: Tracing;
  presentation?: "rich" | "plain";
  environment?: TelegramEnvironment;
  // Сегодняшний день сообщества: по нему экран решает, в каком списке стоит
  // сходка, и называет год у даты. Тот же источник, что у формы.
  today?: CommunityToday;
};

export const defaultTelegramEnvironment: TelegramEnvironment = "prod";

/**
 * Разбирает значение `TELEGRAM_BOT_ENVIRONMENT`. Отсутствие переменной — это
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

// Отказ Meetups по самой команде человеку показывается кадром, а не текстом
// сервиса: код gRPC и текст уходят в запись границы (PER-397). FAILED_PRECONDITION —
// состояние сходки не допускает действия (E-04); INVALID_ARGUMENT на кнопке —
// неверную команду собрал бот, и это сбой на нашей стороне (E-05).
function invalidMeetupText(result: { precondition?: true }): string {
  return result.precondition === true ? staleMeetupText : unavailableText;
}
const formPrompts: Record<FormField, string> = {
  title: "Как называется сходка?",
  schedule: schedulePrompt,
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
const managementForbiddenText = "Управление сходками доступно администратору.";
const communityForbiddenText =
  "Управлять составом сообщества может только администратор.";
type ProductUseCase =
  | "create_meetup"
  | "update_meetup"
  | "find_meetup"
  | "view_meetup"
  | "manage_community"
  | "manage_notifications"
  | "send_broadcast";
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
type PendingInput =
  | PendingQuestion
  | PendingPublishMoment
  | PendingUsername
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
  // Сегодняшний день сообщества для этого update.
  today?: CommunityToday;
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
  bot.use((ctx, next) => {
    const requestId = randomUUID();
    ctx.requestId = requestId;
    ctx.startedAt = process.hrtime.bigint();
    ctx.today = runtime.today ?? utcToday;
    // Спан открывается в первом middleware: всё, что ниже, включая вызовы Bot
    // API и gRPC, становится его потомком.
    return traceUpdate({ tracing: runtime.tracing, ctx, requestId, next });
  });
  bot.on("callback_query:data", (ctx) =>
    handleCallback(ctx, runtime, questions),
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
    // её не видит, а вопрос остаётся ждать настоящего ответа.
    const command = parsed.kind === "start" || parsed.kind === "screen";
    const replyId = command
      ? undefined
      : ctx.message?.reply_to_message?.message_id;
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
    const repliedEntities =
      repliedMessage !== undefined && "entities" in repliedMessage
        ? repliedMessage.entities
        : undefined;
    const recoveredEdit =
      storedPending === undefined && repliedMessage?.from?.id === ctx.me.id
        ? parseEditQuestion(repliedEntities)
        : undefined;
    const recoveredMoment =
      storedPending === undefined && repliedMessage?.from?.id === ctx.me.id
        ? parsePublishMomentQuestion(repliedEntities)
        : undefined;
    // Шаг вопроса лежит в его кнопке «Отмена» и возвращается с ответом: так
    // вопрос переживает рестарт. Маркер шага в тексте — вопросы прошлого
    // релиза, они читаются ещё один релиз.
    const askedStep =
      storedPending === undefined && repliedMessage?.from?.id === ctx.me.id
        ? questionStepOf(repliedMessage)
        : undefined;
    const pending: PendingInput | undefined =
      storedPending ??
      (askedStep === undefined
        ? undefined
        : pendingOf(askedStep, ctx.from?.id ?? 0)) ??
      (recoveredEdit !== undefined
        ? {
            kind: "meetup" as const,
            mode: "edit" as const,
            field: recoveredEdit.field,
            meetupId: tokenToUuid(recoveredEdit.token),
            telegramUserId: ctx.from?.id ?? 0,
            expiresAt: Date.now() + questionTtlMs,
          }
        : recoveredMoment !== undefined
          ? {
              kind: "publish-moment" as const,
              meetupId: tokenToUuid(recoveredMoment.token),
              telegramUserId: ctx.from?.id ?? 0,
              expiresAt: Date.now() + questionTtlMs,
            }
          : undefined);
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
      await answered(result);
      await renderFormResult(
        ctx,
        result,
        questions,
        runtime.presentation ?? "rich",
      );
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
      await answered(result);
      await renderFormResult(
        ctx,
        result,
        questions,
        runtime.presentation ?? "rich",
      );
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
    if (
      replyId !== undefined &&
      ctx.message?.reply_to_message?.from?.id === ctx.me.id
    ) {
      useCase = "create_meetup";
      // Название материала по кнопке вопроса не восстановить — источник файла
      // жил в памяти процесса. Выход ведёт к материалам той же сходки.
      await showRefusal(
        ctx,
        askedStep?.kind === "material-title"
          ? "Этот вопрос уже устарел. Прикрепи материал заново."
          : "Этот вопрос уже устарел. Открой актуальное меню и повтори действие.",
        askedStep?.kind === "material-title"
          ? withNav(new InlineKeyboard(), toMaterials(askedStep.token))
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
      identityId: resolved.identityId,
      globalRoles: resolved.globalRoles,
    };
    const denied = await denyHubAccessIfNeeded(
      ctx,
      { person: identity, blocked: resolved.blocked },
      useCase,
      false,
    );
    if (denied !== undefined) {
      outcome = denied;
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
): Promise<void> {
  let outcome: BoundaryOutcome | undefined;
  let useCase: ProductUseCase | undefined;
  // Ответ на нажатие уходит вместе с результатом, а не до похода к сервисам:
  // пока его нет, клиент сам крутит индикатор на кнопке (дизайн-код,
  // «Ожидание»). Отвечает первый видимый вызов Bot API либо `finish` ниже.
  const waiting = startWaiting(ctx);
  ctx.waiting = waiting;
  try {
    const pressed = parseCallback(ctx.callbackQuery?.data);
    // «Отмена» под вопросом: вопрос правится в экран, с которого задан. Дальше
    // нажатие идёт как обычная кнопка этого экрана.
    const action: ScreenAction =
      pressed.kind === "question" ? cancelTarget(pressed.step) : pressed;
    if (pressed.kind === "question") {
      const asked = ctx.callbackQuery?.message?.message_id;
      if (asked !== undefined) {
        questions.delete(questionKey(ctx.chat?.id, asked));
      }
    }
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
    ctx.fresh = action.trace === true;
    useCase = callbackUseCase(action.kind);
    // Вопрос о прошедшей дате задают и в форме создания, и в правке: сценарий
    // тот же, что у ответа текстом, который его породил.
    if (
      (action.kind === "manage-confirm-past-schedule" ||
        action.kind === "manage-retry-past-schedule" ||
        action.kind === "manage-pick-day" ||
        action.kind === "manage-pick-schedule") &&
      !action.editing
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
        action.kind === "ask-allowed-username") &&
      !isAdministrator(person)
    ) {
      await showRefusal(
        ctx,
        action.kind === "manage-menu"
          ? managementForbiddenText
          : communityForbiddenText,
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
        material.source.fileId,
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
            : undefined;
      if (toast !== undefined) await waiting.answer(toast);
      await renderCommunity(
        ctx,
        runtime,
        person,
        action.kind === "admit-member"
          ? pendingView(action.next)
          : action.kind === "block-member"
            ? viewOfOrigin(action.origin)
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
        await renderFormResult(
          ctx,
          { kind: "ask", field: action.field, meetup },
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
        // Кадр подтверждения одноразовый: после любого ответа его кнопки
        // снимаются, иначе старое «Сохранить дату» откатило бы дату позже.
        await clearCallbackKeyboard(ctx);
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
      } else if (action.kind === "manage-publish-later") {
        await renderFormResult(
          ctx,
          { kind: "ask-publish-moment", meetup },
          questions,
          runtime.presentation ?? "rich",
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
      // Заготовки правят сам вопрос: день сменяется временем на месте, и шаг
      // формы остаётся в кнопке «Отмена». Сервис здесь не нужен.
      const question = scheduleQuestion(action.token, action.editing);
      const today = communityToday(ctx);
      await showScreen(
        ctx,
        action.picked === undefined
          ? {
              id: "question",
              text: schedulePrompt,
              keyboard: dayPresetKeyboard(question, today),
            }
          : {
              id: "question",
              text: timePresetText(action.picked.day, today),
              keyboard: timePresetKeyboard(question, action.picked.digits),
            },
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
    if (
      action.kind === "manage-confirm-past-schedule" ||
      action.kind === "manage-pick-schedule"
    ) {
      // Кнопки снимаются до команды: второе нажатие того же кадра или нажатие
      // после «Ввести другую» не должно переписать дату ещё раз.
      await clearCallbackKeyboard(ctx);
      // Кнопка времени — ответ на вопрос: вопрос под ней больше не ждёт.
      const pressed = ctx.callbackQuery?.message?.message_id;
      if (action.kind === "manage-pick-schedule" && pressed !== undefined) {
        questions.delete(questionKey(ctx.chat?.id, pressed));
      }
      const meetupId = tokenToUuid(action.token);
      const result = await runtime.dispatcher.execute({
        identity: person,
        intent: action.editing ? "update-meetup-field" : "set-meetup-field",
        field: "schedule",
        value: action.value,
        meetupId,
        ...(action.kind === "manage-confirm-past-schedule"
          ? { confirmedPast: true as const }
          : {}),
        ...rpcCall(ctx, useCase),
      });
      await renderFormResult(
        ctx,
        result,
        questions,
        runtime.presentation ?? "rich",
      );
      outcome = screenBoundary(result, {
        ok: [
          "ask",
          "edit-ask",
          "draft",
          "meetup-updated",
          "edit-unavailable",
          "confirm-past-schedule",
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
      await renderNotificationSettings(ctx, result, "v1:notify:global");
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
            ? forbiddenText
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

async function sendStoredMaterialFile(
  ctx: UpdateContext,
  fileId: string,
  title: string,
): Promise<{ kind: "sent" } | { kind: "failed"; cause: unknown }> {
  try {
    await ctx.replyWithDocument(fileId, { caption: title });
    return { kind: "sent" };
  } catch (documentCause) {
    try {
      await ctx.replyWithPhoto(fileId, { caption: title });
      return { kind: "sent" };
    } catch (photoCause) {
      return {
        kind: "failed",
        cause: new AggregateError(
          [documentCause, photoCause],
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
  result: IdentityAdminResult<unknown>,
  identityId: string,
): BoundaryOutcome {
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
function showFrame(
  ctx: UpdateContext,
  id: "refusal" | "broadcast-result" | "no-access",
  text: string,
  keyboard: InlineKeyboard,
  delivery?: "new",
): Promise<void> {
  return showScreen(ctx, {
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
function editScreen(
  ctx: UpdateContext,
  id: ScreenId,
  text: string,
  keyboard: InlineKeyboard,
  parseMode?: "HTML",
): Promise<void> {
  return showScreen(ctx, {
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
    await showScreen(ctx, {
      ...cardScreen({
        meetup: result.meetup,
        author: result.author,
        subscribed: result.subscribed,
        manageable,
        note,
        presentation,
        today: communityToday(ctx),
      }),
      delivery: edit ? "auto" : "new",
    });
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
): Promise<void> {
  if (result.kind === "global-notification-settings") {
    await showScreen(ctx, globalNotificationsScreen(result.categories));
    return;
  }
  if (result.kind === "meetup-notification-settings") {
    await showScreen(ctx, meetupNotificationsScreen(result));
    return;
  }
  await renderNotificationFailure(ctx, result, retry);
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
): Promise<void> {
  if (result.kind === "dependency-rejected" && result.reason === "forbidden") {
    await showRefusal(ctx, forbiddenText, menuOnly());
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
  const text = hubAccessText(
    access,
    identity.person.identityId,
    ctx.from?.username,
  );
  await showFrame(
    ctx,
    "no-access",
    text,
    new InlineKeyboard(),
    edit ? undefined : "new",
  );
  return hubAccessOutcome(access, identity.person.identityId, useCase);
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
): Promise<void> {
  if (result.kind === "ask" || result.kind === "edit-ask") {
    const currentValue =
      result.field === "schedule"
        ? formatSchedule(result.meetup)
        : result.meetup[result.field] === ""
          ? "не задано"
          : result.meetup[result.field];
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
        : ["", `Ваше значение: ${result.input}`]),
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
      delivery: "new",
    });
    return;
  }
  if (result.kind === "meetup-updated") {
    await renderMeetupCard(
      ctx,
      cardFrom(result),
      false,
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
      "new",
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
      false,
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
    const text =
      result.meetup.lifecycle === "cancelled"
        ? "Сходка отменена. Назначить ей публикацию нельзя."
        : "Сходка уже опубликована. Назначать публикацию больше не нужно.";
    await renderMeetupCard(
      ctx,
      cardFrom(result),
      false,
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
      return { kind: "publish-moment", token: uuidToToken(pending.meetupId) };
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
    default: {
      const _exhaustive: never = pending;
      return _exhaustive;
    }
  }
}

// Ожидаемый ответ по шагу из кнопки вопроса — то, что раньше жило только в
// памяти процесса. Название материала по шагу не восстановить: источник файла
// в кнопку не помещается.
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
      return { kind: "manage-status", token: step.token };
    case "material-source":
    case "material-title":
      return { kind: "manage-materials", token: step.token };
    case "broadcast":
      return step.token === undefined
        ? { kind: "manage-menu" }
        : { kind: "view-meetup", token: step.token };
    case "username":
      return { kind: "community-usernames", page: 0 };
    default: {
      const _exhaustive: never = step;
      return _exhaustive;
    }
  }
}

function questionStepOf(replied: unknown): QuestionStep | undefined {
  const keyboard = (
    replied as { reply_markup?: { inline_keyboard?: unknown } } | undefined
  )?.reply_markup?.inline_keyboard;
  if (!Array.isArray(keyboard)) return undefined;
  for (const button of keyboard.flat()) {
    const action = parseCallback(
      (button as { callback_data?: unknown } | undefined)?.callback_data,
    );
    if (action.kind === "question") return action.step;
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
  if (ctx.callbackQuery !== undefined) {
    await clearCallbackKeyboard(ctx);
  }
  // Вопрос о дате несёт заготовки дня над «Отменой»; остальные — её одну.
  const keyboard =
    pending.kind === "meetup" && pending.field === "schedule"
      ? dayPresetKeyboard(
          scheduleQuestion(
            uuidToToken(pending.meetupId),
            pending.mode === "edit",
          ),
          communityToday(ctx),
        )
      : new InlineKeyboard().text(cancelLabel, questionData(stepOf(pending)));
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
  } as PendingInput);
  evictOldestQuestions(questions);
}

function scheduleQuestion(token: string, editing: boolean): ScheduleQuestion {
  return {
    token,
    mode: editing ? "e" : "c",
    cancelData: questionData({
      kind: "field",
      mode: editing ? "edit" : "create",
      token,
      field: "schedule",
    }),
  };
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
    | "create-meetup"
    | "publish-meetup"
    | "manage-edit"
    | "manage-field"
    | "manage-draft"
    | "manage-status"
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
